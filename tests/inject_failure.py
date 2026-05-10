#!/usr/bin/env python3
"""
Backtrack — Failure Injection & Benchmarking Script.

Each fault type maps to specific signals that TSD or LSI detect:

  TSD detectors
  ─────────────
  tsd-cpu-spike     Sustained CPU spike          → TSD raw-history spike (5× IQR above baseline)
  tsd-memory-leak   Monotonically growing memory → TSD memory-leak path (6 consecutive increases, >15% baseline)
  tsd-latency       HTTP probe timeout (>2 s)    → error_rate=100% + latency anomaly
  tsd-crash         Container exit(non-zero)     → immediate rollback, no 3-cycle wait

  LSI detectors
  ─────────────
  lsi-error-flood   ERROR/FATAL log lines        → LSI score × 3 per line
  lsi-warn-flood    WARN/timeout/retry lines     → LSI score × 1 per line, accumulates
  lsi-novel-logs    Semantically alien patterns  → LSI NOVEL score × 5 (SVD reconstruction error)

  Both detectors
  ──────────────
  combined          Error logs + CPU burn + slow HTTP → TSD + LSI fire simultaneously

Usage:
  python tests/inject_failure.py [--fault-type TYPE] [options]

Options:
  --fault-type TYPE          One of the fault types above (prompted interactively if omitted)
  --mode docker|kubernetes   Runtime to target (auto-detected from agent if omitted)
  --target NAME              Container/Deployment name
  --namespace NS             Kubernetes namespace [default: default]
  --agent-url URL            BackTrack agent URL [default: http://localhost:8847]
  --dashboard-url URL        BackTrack dashboard URL [default: http://localhost:3847]
  --skip-agent               Skip agent polling; just inject, wait, then restore
  --restore-wait SECONDS     Hold duration when --skip-agent [default: 120]
  --output FILE              Results path [default: tests/results_app1.json]
  --app-name NAME            Label for results [default: test-app-1]
  --github-repo OWNER/REPO   GitHub repo (auto-detected if omitted)
  --github-branch BRANCH     Branch [default: main]
  --github-token TOKEN       GitHub PAT (falls back to GITHUB_TOKEN env var)
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from typing import Optional

try:
    import requests
except ImportError:
    print("ERROR: Install dependencies first: pip install requests")
    sys.exit(1)

POLL_INTERVAL = 5    # seconds between agent polls
MAX_WAIT      = 900  # 15 minutes max wait for detection + rollback


# ── Fault catalogue ────────────────────────────────────────────────────────────

FAULT_CATALOGUE: dict[str, dict] = {
    "tsd-cpu-spike": {
        "description": "Sustained CPU spike → TSD raw-history spike (5× IQR above baseline)",
        "detects":     ["TSD"],
        # Docker: busy-loop threads keep Flask alive for HTTP probe (no error_rate spike)
        "docker_app": (
            "import threading, time\n"
            "from flask import Flask\n"
            "app = Flask(__name__)\n\n"
            "def burn():\n"
            "    while True: pass\n\n"
            "for _ in range(2):\n"
            "    threading.Thread(target=burn, daemon=True).start()\n\n"
            "@app.route('/')\n"
            "@app.route('/health')\n"
            "def ok(): return 'ok', 200\n\n"
            "app.run(host='0.0.0.0', port=80)\n"
        ),
        # K8s: busybox infinite loop pegs one core
        "k8s_image":   "busybox:latest",
        "k8s_command": ["sh", "-c", "while true; do :; done"],
    },

    "tsd-memory-leak": {
        "description": "Monotonically growing memory → TSD memory-leak (6 consecutive increases, >15% above baseline)",
        "detects":     ["TSD"],
        "docker_app": (
            "import threading, time\n"
            "from flask import Flask\n"
            "app = Flask(__name__)\n"
            "leak = []\n\n"
            "def grow():\n"
            "    while True:\n"
            "        leak.append(bytearray(10 * 1024 * 1024))\n"
            "        print(f'[INFO] memory: {len(leak) * 10} MB allocated', flush=True)\n"
            "        time.sleep(4)\n\n"
            "threading.Thread(target=grow, daemon=True).start()\n\n"
            "@app.route('/')\n"
            "@app.route('/health')\n"
            "def ok(): return 'ok', 200\n\n"
            "app.run(host='0.0.0.0', port=80)\n"
        ),
        # K8s: python image allocates 10 MB every 4 s
        "k8s_image":   "python:3.11-slim",
        "k8s_command": [
            "python3", "-c",
            (
                "import time\n"
                "leak = []\n"
                "while True:\n"
                "    leak.append(bytearray(10 * 1024 * 1024))\n"
                "    print(f'[INFO] memory: {len(leak)*10} MB allocated', flush=True)\n"
                "    time.sleep(4)\n"
            ),
        ],
    },

    "tsd-latency": {
        "description": "HTTP probe timeout (>2 s response) → TSD error_rate=100% + latency anomaly",
        "detects":     ["TSD"],
        # Docker: all endpoints sleep 5 s → probe times out → latency=0, error_rate=100%
        "docker_app": (
            "import time\n"
            "from flask import Flask\n"
            "app = Flask(__name__)\n\n"
            "@app.route('/')\n"
            "@app.route('/health')\n"
            "def slow():\n"
            "    time.sleep(5)  # exceeds 2s probe timeout\n"
            "    return 'slow', 503\n\n"
            "app.run(host='0.0.0.0', port=80)\n"
        ),
        # K8s: no HTTP server running → probe finds nothing → error_rate=100%
        "k8s_image":   "busybox:latest",
        "k8s_command": ["sh", "-c", "while true; do echo '[INFO] running (no HTTP)'; sleep 30; done"],
    },

    "tsd-crash": {
        "description": "Container exit(non-zero) → TSD crash detection → immediate rollback (no 3-cycle wait)",
        "detects":     ["TSD"],
        # Docker: crash-looping busybox (no build needed) — see inject_failure_docker
        # K8s: exit 1 → K8s restart policy triggers repeated restarts
        "k8s_image":   "busybox:latest",
        "k8s_command": ["sh", "-c", "echo '[ERROR] fatal crash — exiting'; exit 1"],
    },

    "lsi-error-flood": {
        "description": "Rapid ERROR/FATAL log lines → LSI anomaly score (× 3 weight per error line)",
        "detects":     ["LSI"],
        "docker_app": (
            "import threading, time\n"
            "from flask import Flask\n"
            "app = Flask(__name__)\n\n"
            "def spew():\n"
            "    while True:\n"
            "        print('[ERROR] fatal: connection refused — db unreachable', flush=True)\n"
            "        print('[ERROR] exception: NullPointerException in PaymentService.process()', flush=True)\n"
            "        print('[FATAL] crash: segfault at 0x0 in core.so', flush=True)\n"
            "        print('[ERROR] HTTP 503 upstream timeout after 30s', flush=True)\n"
            "        time.sleep(0.5)\n\n"
            "threading.Thread(target=spew, daemon=True).start()\n\n"
            "@app.route('/')\n"
            "@app.route('/health')\n"
            "def ok(): return 'ok', 200\n\n"
            "app.run(host='0.0.0.0', port=80)\n"
        ),
        "k8s_image":   "busybox:latest",
        "k8s_command": [
            "sh", "-c",
            (
                "while true; do "
                "echo '[ERROR] fatal: connection refused -- db unreachable'; "
                "echo '[ERROR] exception: NullPointerException in PaymentService.process()'; "
                "echo '[FATAL] crash: segfault at 0x0 in core.so'; "
                "echo '[ERROR] HTTP 503 upstream timeout after 30s'; "
                "sleep 0.5; done"
            ),
        ],
    },

    "lsi-warn-flood": {
        "description": "WARN/retry/timeout log lines → LSI warning accumulation (× 1 weight) — informational only, no rollback",
        "detects":     ["LSI"],
        "triggers_rollback": False,
        "docker_app": (
            "import threading, time\n"
            "from flask import Flask\n"
            "app = Flask(__name__)\n\n"
            "def warn():\n"
            "    i = 0\n"
            "    while True:\n"
            "        print(f'[WARN] timeout: retry #{i} connecting to order-service', flush=True)\n"
            "        print('[WARNING] deprecated: /v1/checkout endpoint — retrying with /v2', flush=True)\n"
            "        print('[WARN] slow response: 4500ms latency on recommendation-service', flush=True)\n"
            "        print('[WARN] retrying: circuit breaker open for payment-service', flush=True)\n"
            "        i += 1\n"
            "        time.sleep(0.7)\n\n"
            "threading.Thread(target=warn, daemon=True).start()\n\n"
            "@app.route('/')\n"
            "@app.route('/health')\n"
            "def ok(): return 'ok', 200\n\n"
            "app.run(host='0.0.0.0', port=80)\n"
        ),
        "k8s_image":   "busybox:latest",
        "k8s_command": [
            "sh", "-c",
            (
                "i=0; while true; do "
                "echo \"[WARN] timeout: retry #$i connecting to order-service\"; "
                "echo '[WARNING] deprecated: /v1/checkout endpoint -- retrying with /v2'; "
                "echo '[WARN] slow response: 4500ms latency on recommendation-service'; "
                "echo '[WARN] retrying: circuit breaker open for payment-service'; "
                "i=$((i+1)); sleep 0.7; done"
            ),
        ],
    },

    "lsi-novel-logs": {
        "description": "Semantically alien log patterns → LSI NOVEL classification (× 5 weight) — informational only, no rollback",
        "detects":     ["LSI"],
        "triggers_rollback": False,
        "docker_app": (
            "import threading, time, random, string\n"
            "from flask import Flask\n"
            "app = Flask(__name__)\n\n"
            "def novel():\n"
            "    while True:\n"
            "        addr = random.randint(0x7fff0000, 0x7fffffff)\n"
            "        h1 = ''.join(random.choices('0123456789abcdef', k=32))\n"
            "        h2 = ''.join(random.choices('0123456789abcdef', k=24))\n"
            "        b64 = ''.join(random.choices(string.ascii_letters + string.digits + '+/', k=44))\n"
            "        print(f'SEGV 0x{h1} at rip=0x{addr:016x}', flush=True)\n"
            "        print(f'coredump: {h2}== offset 0x{addr:08x}', flush=True)\n"
            "        print(f'stack: {b64}==', flush=True)\n"
            "        time.sleep(0.4)\n\n"
            "threading.Thread(target=novel, daemon=True).start()\n\n"
            "@app.route('/')\n"
            "@app.route('/health')\n"
            "def ok(): return 'ok', 200\n\n"
            "app.run(host='0.0.0.0', port=80)\n"
        ),
        "k8s_image":   "busybox:latest",
        "k8s_command": [
            "sh", "-c",
            (
                "while true; do "
                "echo \"SEGV 0x$(cat /proc/sys/kernel/random/uuid | tr -d -) at rip=0x7fff$(cat /proc/sys/kernel/random/uuid | tr -d - | head -c 8)\"; "
                "echo \"coredump: $(cat /proc/sys/kernel/random/uuid | tr -d -)AA== offset 0x$(cat /proc/sys/kernel/random/uuid | tr -d - | head -c 8)\"; "
                "sleep 0.4; done"
            ),
        ],
    },

    # ── LSI specific error-pattern faults ──────────────────────────────────────
    # Each maps to one of the known patterns in LSICollector._extract_error_patterns.

    "lsi-connection-refused": {
        "description": "Connection refused errors → LSI pattern 'Connection Refused - Dependency unavailable'",
        "detects":     ["LSI"],
        "docker_app": (
            "import threading, time\n"
            "from flask import Flask\n"
            "app = Flask(__name__)\n\n"
            "def spew():\n"
            "    while True:\n"
            "        print('[ERROR] connection refused: dial tcp 10.0.0.5:5432 connect: connection refused', flush=True)\n"
            "        print('[ERROR] failed to connect to redis: connection refused (host=redis:6379)', flush=True)\n"
            "        print('[ERROR] grpc: failed to connect to db-service: connection refused after 3 retries', flush=True)\n"
            "        time.sleep(0.8)\n\n"
            "threading.Thread(target=spew, daemon=True).start()\n\n"
            "@app.route('/')\n"
            "@app.route('/health')\n"
            "def ok(): return 'ok', 200\n\n"
            "app.run(host='0.0.0.0', port=80)\n"
        ),
        "k8s_image":   "busybox:latest",
        "k8s_command": [
            "sh", "-c",
            (
                "while true; do "
                "echo '[ERROR] connection refused: dial tcp 10.0.0.5:5432 connect: connection refused'; "
                "echo '[ERROR] failed to connect to redis: connection refused (host=redis:6379)'; "
                "echo '[ERROR] grpc: failed to connect to db-service: connection refused after 3 retries'; "
                "sleep 0.8; done"
            ),
        ],
    },

    "lsi-timeout": {
        "description": "Timeout errors (ERROR level) → LSI pattern 'Timeout - Slow response or network issue'",
        "detects":     ["LSI"],
        "docker_app": (
            "import threading, time\n"
            "from flask import Flask\n"
            "app = Flask(__name__)\n\n"
            "def spew():\n"
            "    while True:\n"
            "        print('[ERROR] timeout: context deadline exceeded after 30s waiting for db-service', flush=True)\n"
            "        print('[ERROR] request timeout: grpc call to recommendation-service timed out after 5000ms', flush=True)\n"
            "        print('[ERROR] connection timeout: failed to reach payment-service:8080 in 10s', flush=True)\n"
            "        time.sleep(0.8)\n\n"
            "threading.Thread(target=spew, daemon=True).start()\n\n"
            "@app.route('/')\n"
            "@app.route('/health')\n"
            "def ok(): return 'ok', 200\n\n"
            "app.run(host='0.0.0.0', port=80)\n"
        ),
        "k8s_image":   "busybox:latest",
        "k8s_command": [
            "sh", "-c",
            (
                "while true; do "
                "echo '[ERROR] timeout: context deadline exceeded after 30s waiting for db-service'; "
                "echo '[ERROR] request timeout: grpc call to recommendation-service timed out after 5000ms'; "
                "echo '[ERROR] connection timeout: failed to reach payment-service:8080 in 10s'; "
                "sleep 0.8; done"
            ),
        ],
    },

    "lsi-oom": {
        "description": "Out-of-memory errors → LSI pattern 'Out of Memory - Resource exhaustion'",
        "detects":     ["LSI"],
        "docker_app": (
            "import threading, time\n"
            "from flask import Flask\n"
            "app = Flask(__name__)\n\n"
            "def spew():\n"
            "    while True:\n"
            "        print('[ERROR] java.lang.OutOfMemoryError: Java heap space — cannot allocate 524288 bytes', flush=True)\n"
            "        print('[ERROR] fatal: out of memory — runtime requested 1073741824 bytes', flush=True)\n"
            "        print('[ERROR] OOM killer invoked: out of memory condition, process terminated', flush=True)\n"
            "        time.sleep(0.8)\n\n"
            "threading.Thread(target=spew, daemon=True).start()\n\n"
            "@app.route('/')\n"
            "@app.route('/health')\n"
            "def ok(): return 'ok', 200\n\n"
            "app.run(host='0.0.0.0', port=80)\n"
        ),
        "k8s_image":   "busybox:latest",
        "k8s_command": [
            "sh", "-c",
            (
                "while true; do "
                "echo '[ERROR] java.lang.OutOfMemoryError: Java heap space -- cannot allocate 524288 bytes'; "
                "echo '[ERROR] fatal: out of memory -- runtime requested 1073741824 bytes'; "
                "echo '[ERROR] OOM killer invoked: out of memory condition, process terminated'; "
                "sleep 0.8; done"
            ),
        ],
    },

    "lsi-null-pointer": {
        "description": "Null-pointer / nil-dereference errors → LSI pattern 'Null Pointer - Code defect'",
        "detects":     ["LSI"],
        "docker_app": (
            "import threading, time\n"
            "from flask import Flask\n"
            "app = Flask(__name__)\n\n"
            "def spew():\n"
            "    while True:\n"
            "        print('[ERROR] NullPointerException: cannot invoke getId() on null reference in UserService.java:87', flush=True)\n"
            "        print('[ERROR] null pointer dereference: attempt to read field userId on null object', flush=True)\n"
            "        print('[ERROR] java.lang.NullPointerException at OrderService.process(OrderService.java:142)', flush=True)\n"
            "        time.sleep(0.8)\n\n"
            "threading.Thread(target=spew, daemon=True).start()\n\n"
            "@app.route('/')\n"
            "@app.route('/health')\n"
            "def ok(): return 'ok', 200\n\n"
            "app.run(host='0.0.0.0', port=80)\n"
        ),
        "k8s_image":   "busybox:latest",
        "k8s_command": [
            "sh", "-c",
            (
                "while true; do "
                "echo '[ERROR] NullPointerException: cannot invoke getId() on null reference in UserService.java:87'; "
                "echo '[ERROR] null pointer dereference: attempt to read field userId on null object'; "
                "echo '[ERROR] java.lang.NullPointerException at OrderService.process(OrderService.java:142)'; "
                "sleep 0.8; done"
            ),
        ],
    },

    "lsi-permission-denied": {
        "description": "Auth / authorization failures → LSI pattern 'Permission Denied - Authorization issue'",
        "detects":     ["LSI"],
        "docker_app": (
            "import threading, time\n"
            "from flask import Flask\n"
            "app = Flask(__name__)\n\n"
            "def spew():\n"
            "    while True:\n"
            "        print('[ERROR] permission denied: user api-service lacks WRITE access on orders table', flush=True)\n"
            "        print('[ERROR] authorization failed: permission denied for resource /admin/users (403)', flush=True)\n"
            "        print('[ERROR] forbidden: permission denied for operation DeleteBucket on storage-service', flush=True)\n"
            "        time.sleep(0.8)\n\n"
            "threading.Thread(target=spew, daemon=True).start()\n\n"
            "@app.route('/')\n"
            "@app.route('/health')\n"
            "def ok(): return 'ok', 200\n\n"
            "app.run(host='0.0.0.0', port=80)\n"
        ),
        "k8s_image":   "busybox:latest",
        "k8s_command": [
            "sh", "-c",
            (
                "while true; do "
                "echo '[ERROR] permission denied: user api-service lacks WRITE access on orders table'; "
                "echo '[ERROR] authorization failed: permission denied for resource /admin/users (403)'; "
                "echo '[ERROR] forbidden: permission denied for operation DeleteBucket on storage-service'; "
                "sleep 0.8; done"
            ),
        ],
    },

    "lsi-not-found": {
        "description": "404 / missing-resource errors → LSI pattern 'Not Found - Missing resource'",
        "detects":     ["LSI"],
        "docker_app": (
            "import threading, time\n"
            "from flask import Flask\n"
            "app = Flask(__name__)\n\n"
            "def spew():\n"
            "    while True:\n"
            "        print('[ERROR] 404 not found: resource /api/v1/orders/99999 does not exist', flush=True)\n"
            "        print('[ERROR] not found: product SKU-4892 missing from catalog service', flush=True)\n"
            "        print('[ERROR] ResourceNotFoundError: user uid-8842 not found in user-service', flush=True)\n"
            "        time.sleep(0.8)\n\n"
            "threading.Thread(target=spew, daemon=True).start()\n\n"
            "@app.route('/')\n"
            "@app.route('/health')\n"
            "def ok(): return 'ok', 200\n\n"
            "app.run(host='0.0.0.0', port=80)\n"
        ),
        "k8s_image":   "busybox:latest",
        "k8s_command": [
            "sh", "-c",
            (
                "while true; do "
                "echo '[ERROR] 404 not found: resource /api/v1/orders/99999 does not exist'; "
                "echo '[ERROR] not found: product SKU-4892 missing from catalog service'; "
                "echo '[ERROR] ResourceNotFoundError: user uid-8842 not found in user-service'; "
                "sleep 0.8; done"
            ),
        ],
    },

    "lsi-deadlock": {
        "description": "Deadlock / concurrency errors → LSI pattern 'Deadlock - Concurrency issue'",
        "detects":     ["LSI"],
        "docker_app": (
            "import threading, time\n"
            "from flask import Flask\n"
            "app = Flask(__name__)\n\n"
            "def spew():\n"
            "    while True:\n"
            "        print('[ERROR] deadlock detected: transaction lock timeout on orders table after 30s', flush=True)\n"
            "        print('[ERROR] deadlock: goroutine 142 waiting on mutex held by goroutine 87', flush=True)\n"
            "        print('[ERROR] deadlock: cycle detected in lock dependency graph — aborting transaction', flush=True)\n"
            "        time.sleep(0.8)\n\n"
            "threading.Thread(target=spew, daemon=True).start()\n\n"
            "@app.route('/')\n"
            "@app.route('/health')\n"
            "def ok(): return 'ok', 200\n\n"
            "app.run(host='0.0.0.0', port=80)\n"
        ),
        "k8s_image":   "busybox:latest",
        "k8s_command": [
            "sh", "-c",
            (
                "while true; do "
                "echo '[ERROR] deadlock detected: transaction lock timeout on orders table after 30s'; "
                "echo '[ERROR] deadlock: goroutine 142 waiting on mutex held by goroutine 87'; "
                "echo '[ERROR] deadlock: cycle detected in lock dependency graph -- aborting transaction'; "
                "sleep 0.8; done"
            ),
        ],
    },

    "lsi-panic": {
        "description": "Go/Rust-style panic logs → LSI pattern 'Panic - Critical application crash'",
        "detects":     ["LSI"],
        "docker_app": (
            "import threading, time\n"
            "from flask import Flask\n"
            "app = Flask(__name__)\n\n"
            "def spew():\n"
            "    while True:\n"
            "        print('panic: runtime error: index out of range [4] with length 3', flush=True)\n"
            "        print('goroutine 1 [running]:', flush=True)\n"
            "        print('main.processOrder(0xc0001b6000, 0x1)', flush=True)\n"
            "        print('\\t/app/main.go:142 +0x1c4', flush=True)\n"
            "        print('[ERROR] panic: interface conversion: interface {} is nil, not *Order', flush=True)\n"
            "        time.sleep(1.0)\n\n"
            "threading.Thread(target=spew, daemon=True).start()\n\n"
            "@app.route('/')\n"
            "@app.route('/health')\n"
            "def ok(): return 'ok', 200\n\n"
            "app.run(host='0.0.0.0', port=80)\n"
        ),
        "k8s_image":   "busybox:latest",
        "k8s_command": [
            "sh", "-c",
            (
                "while true; do "
                "echo 'panic: runtime error: index out of range [4] with length 3'; "
                "echo 'goroutine 1 [running]:'; "
                "echo 'main.processOrder(0xc0001b6000, 0x1)'; "
                "echo '[ERROR] panic: interface conversion: interface {} is nil, not *Order'; "
                "sleep 1.0; done"
            ),
        ],
    },

    "lsi-http-500": {
        "description": "HTTP 500 internal server errors → LSI pattern 'HTTP 500 - Internal server error'",
        "detects":     ["LSI"],
        "docker_app": (
            "import threading, time\n"
            "from flask import Flask\n"
            "app = Flask(__name__)\n\n"
            "def spew():\n"
            "    i = 0\n"
            "    while True:\n"
            "        print(f'[ERROR] 500 POST /api/v1/checkout {(i%400)+50}ms — internal server error in PaymentHandler', flush=True)\n"
            "        print('[ERROR] HTTP 500: upstream service failed — unexpected error in order-service', flush=True)\n"
            "        print(f'[ERROR] 500 GET /api/v1/cart/{i} {(i%300)+100}ms — unhandled exception', flush=True)\n"
            "        i += 1\n"
            "        time.sleep(0.6)\n\n"
            "threading.Thread(target=spew, daemon=True).start()\n\n"
            "@app.route('/')\n"
            "@app.route('/health')\n"
            "def ok(): return 'ok', 200\n\n"
            "app.run(host='0.0.0.0', port=80)\n"
        ),
        "k8s_image":   "busybox:latest",
        "k8s_command": [
            "sh", "-c",
            (
                "i=0; while true; do "
                "echo \"[ERROR] 500 POST /api/v1/checkout $((i%400+50))ms -- internal server error in PaymentHandler\"; "
                "echo '[ERROR] HTTP 500: upstream service failed -- unexpected error in order-service'; "
                "echo \"[ERROR] 500 GET /api/v1/cart/$i $((i%300+100))ms -- unhandled exception\"; "
                "i=$((i+1)); sleep 0.6; done"
            ),
        ],
    },

    "lsi-http-503": {
        "description": "HTTP 503 service unavailable → LSI pattern 'HTTP 503 - Service unavailable'",
        "detects":     ["LSI"],
        "docker_app": (
            "import threading, time\n"
            "from flask import Flask\n"
            "app = Flask(__name__)\n\n"
            "def spew():\n"
            "    while True:\n"
            "        print('[ERROR] HTTP 503 Service Unavailable: circuit breaker open for payment-service', flush=True)\n"
            "        print('[ERROR] upstream returned 503: recommendation-service temporarily unavailable', flush=True)\n"
            "        print('[ERROR] 503 GET /api/v1/recommendations 1204ms — service unavailable', flush=True)\n"
            "        time.sleep(0.6)\n\n"
            "threading.Thread(target=spew, daemon=True).start()\n\n"
            "@app.route('/')\n"
            "@app.route('/health')\n"
            "def ok(): return 'ok', 200\n\n"
            "app.run(host='0.0.0.0', port=80)\n"
        ),
        "k8s_image":   "busybox:latest",
        "k8s_command": [
            "sh", "-c",
            (
                "while true; do "
                "echo '[ERROR] HTTP 503 Service Unavailable: circuit breaker open for payment-service'; "
                "echo '[ERROR] upstream returned 503: recommendation-service temporarily unavailable'; "
                "echo '[ERROR] 503 GET /api/v1/recommendations 1204ms -- service unavailable'; "
                "sleep 0.6; done"
            ),
        ],
    },

    "lsi-http-429": {
        "description": "HTTP 429 rate-limit errors → LSI pattern 'HTTP 429 - Rate limit exceeded'",
        "detects":     ["LSI"],
        "docker_app": (
            "import threading, time\n"
            "from flask import Flask\n"
            "app = Flask(__name__)\n\n"
            "def spew():\n"
            "    i = 0\n"
            "    while True:\n"
            "        print(f'[WARN] HTTP 429 Too Many Requests: rate limit exceeded for client 10.0.1.{i%254+1}', flush=True)\n"
            "        print('[ERROR] 429 POST /api/v1/checkout 12ms — rate limited (1250 req/min > 1000 limit)', flush=True)\n"
            "        print('[WARN] rate limiter: 429 response to api-gateway — backing off for 5s', flush=True)\n"
            "        i += 1\n"
            "        time.sleep(0.6)\n\n"
            "threading.Thread(target=spew, daemon=True).start()\n\n"
            "@app.route('/')\n"
            "@app.route('/health')\n"
            "def ok(): return 'ok', 200\n\n"
            "app.run(host='0.0.0.0', port=80)\n"
        ),
        "k8s_image":   "busybox:latest",
        "k8s_command": [
            "sh", "-c",
            (
                "i=0; while true; do "
                "echo \"[WARN] HTTP 429 Too Many Requests: rate limit exceeded for client 10.0.1.$((i%254+1))\"; "
                "echo '[ERROR] 429 POST /api/v1/checkout 12ms -- rate limited (1250 req/min > 1000 limit)'; "
                "echo '[WARN] rate limiter: 429 response to api-gateway -- backing off for 5s'; "
                "i=$((i+1)); sleep 0.6; done"
            ),
        ],
    },

    "lsi-traceback": {
        "description": "Python traceback floods → LSI classifies 'traceback' keyword as ERROR (weight × 3)",
        "detects":     ["LSI"],
        "docker_app": (
            "import threading, time\n"
            "from flask import Flask\n"
            "app = Flask(__name__)\n\n"
            "def spew():\n"
            "    while True:\n"
            "        print('Traceback (most recent call last):', flush=True)\n"
            "        print('  File \"/app/service.py\", line 142, in process_request', flush=True)\n"
            "        print('    result = db.query(order_id)', flush=True)\n"
            "        print('  File \"/app/db.py\", line 87, in query', flush=True)\n"
            "        print('    raise DatabaseError(\"connection lost\")', flush=True)\n"
            "        print('DatabaseError: connection lost to postgres:5432', flush=True)\n"
            "        time.sleep(1.0)\n\n"
            "threading.Thread(target=spew, daemon=True).start()\n\n"
            "@app.route('/')\n"
            "@app.route('/health')\n"
            "def ok(): return 'ok', 200\n\n"
            "app.run(host='0.0.0.0', port=80)\n"
        ),
        "k8s_image":   "busybox:latest",
        "k8s_command": [
            "sh", "-c",
            (
                "while true; do "
                "echo 'Traceback (most recent call last):'; "
                "echo '  File \"/app/service.py\", line 142, in process_request'; "
                "echo '    result = db.query(order_id)'; "
                "echo '  File \"/app/db.py\", line 87, in query'; "
                "echo '    raise DatabaseError(\"connection lost\")'; "
                "echo 'DatabaseError: connection lost to postgres:5432'; "
                "sleep 1.0; done"
            ),
        ],
    },

    "combined": {
        "description": "Error logs + CPU burn + slow HTTP → triggers both TSD (CPU spike + latency) and LSI (error flood)",
        "detects":     ["TSD", "LSI"],
        "docker_app": (
            "import threading, time\n"
            "from flask import Flask\n"
            "app = Flask(__name__)\n\n"
            "def burn(): \n"
            "    while True: pass\n\n"
            "def spew():\n"
            "    while True:\n"
            "        print('[ERROR] fatal: connection refused — db unreachable', flush=True)\n"
            "        print('[FATAL] crash: segfault at 0x0 in core.so', flush=True)\n"
            "        time.sleep(0.5)\n\n"
            "for _ in range(2):\n"
            "    threading.Thread(target=burn, daemon=True).start()\n"
            "threading.Thread(target=spew, daemon=True).start()\n\n"
            "@app.route('/')\n"
            "@app.route('/health')\n"
            "def slow():\n"
            "    time.sleep(4)\n"
            "    return 'degraded', 503\n\n"
            "app.run(host='0.0.0.0', port=80)\n"
        ),
        # K8s: tight loop naturally pegs CPU + ERROR logs
        "k8s_image":   "busybox:latest",
        "k8s_command": [
            "sh", "-c",
            (
                "while true; do "
                "echo '[ERROR] fatal: connection refused -- db unreachable'; "
                "echo '[FATAL] crash: segfault at 0x0 in core.so'; "
                "done"
            ),
        ],
    },
}


def _fault_menu() -> str:
    """Interactively prompt the user to pick a fault type."""
    items = list(FAULT_CATALOGUE.items())
    print("\nAvailable fault types:\n")
    col_w = max(len(k) for k in FAULT_CATALOGUE) + 2
    for i, (key, val) in enumerate(items, 1):
        detects = "+".join(val["detects"])
        print(f"  [{i}] {key:<{col_w}}  [{detects:>7}]  {val['description']}")
    print()
    while True:
        raw = input("Select fault type (number or name): ").strip()
        if raw.isdigit():
            idx = int(raw) - 1
            if 0 <= idx < len(items):
                return items[idx][0]
            print(f"  Enter 1–{len(items)}")
        elif raw in FAULT_CATALOGUE:
            return raw
        else:
            print(f"  Unknown fault type '{raw}'. Enter a number or one of: {', '.join(FAULT_CATALOGUE)}")


# ── Agent helpers ──────────────────────────────────────────────────────────────

def wait_for_health(agent_url: str) -> dict:
    print("[1/10] Checking BackTrack agent health…")
    resp = requests.get(f"{agent_url}/health", timeout=5)
    resp.raise_for_status()
    data = resp.json()
    assert data["status"] == "ok", f"Agent not healthy: {data}"
    print(f"  OK — mode={data.get('mode')}, uptime={data.get('uptime_seconds')}s")
    return data


def check_stable_version(agent_url: str) -> dict:
    print("[2/10] Checking for STABLE version snapshot…")
    resp = requests.get(f"{agent_url}/versions", timeout=5)
    versions = resp.json()
    stable = [v for v in versions if v["status"] == "STABLE"]
    if not stable:
        print("  WARNING: No STABLE snapshot yet — rollback may not trigger.")
        return versions[0] if versions else {}
    print(f"  OK — {len(stable)} STABLE snapshot(s), latest: {stable[0]['image_tag']}")
    return stable[0]


def get_initial_rollback_count(agent_url: str) -> int:
    try:
        return len(requests.get(f"{agent_url}/rollback/history", timeout=5).json())
    except Exception:
        return 0


def poll_for_detection(agent_url: str, fault_type: str) -> float:
    """Poll until the expected detector(s) fire for this fault type.

    For LSI faults that do not trigger rollback (warn-flood, novel-logs),
    polls is_anomalous (full score) to confirm the injector is working, but
    the agent will NOT roll back — only is_error_anomalous drives rollback.
    """
    spec        = FAULT_CATALOGUE[fault_type]
    detects     = spec["detects"]
    triggers_rb = spec.get("triggers_rollback", True)
    check_tsd   = "TSD" in detects
    check_lsi   = "LSI" in detects
    is_crash    = fault_type == "tsd-crash"

    note = ""
    if check_lsi and not triggers_rb:
        note = " — informational only, rollback will NOT trigger"
    signals_desc = "+".join(detects) + (" (crash → immediate)" if is_crash else "") + note
    print(f"[5/10] Polling for anomaly detection [{signals_desc}]…")

    start = time.time()
    while time.time() - start < MAX_WAIT:
        try:
            metrics = requests.get(f"{agent_url}/metrics", timeout=5).json()
            lsi     = requests.get(f"{agent_url}/lsi",     timeout=5).json()
            drifting       = metrics.get("is_drifting",       False)
            anomalous      = lsi.get("is_anomalous",          False)  # full score (display)
            error_anomalous = lsi.get("is_error_anomalous",   False)  # ERROR-only (rollback)
            crashed        = metrics.get("has_crashed",        False)
            elapsed        = time.time() - start

            status_parts = []
            if check_tsd or is_crash:
                status_parts.append(f"drifting={drifting}")
                if is_crash:
                    status_parts.append(f"crashed={crashed}")
            if check_lsi:
                if triggers_rb:
                    status_parts.append(f"error_anomalous={error_anomalous}")
                else:
                    status_parts.append(f"anomalous={anomalous} (info only)")
                status_parts.append(f"lsi_score={lsi.get('current_score', 0):.4f}")
                status_parts.append(f"error_score={lsi.get('error_score', 0):.4f}")
            status_parts.append(f"readings={metrics.get('readings_count', 0)}")
            print(f"  [{elapsed:.0f}s] {', '.join(status_parts)}")

            if is_crash and crashed:
                print(f"[6/10] CRASH DETECTED in {elapsed:.1f}s")
                return elapsed

            # For informational LSI faults: detect the full anomaly signal (not error-only)
            lsi_signal = anomalous if not triggers_rb else error_anomalous

            if check_tsd and check_lsi:
                if drifting and lsi_signal:
                    print(f"[6/10] ANOMALY DETECTED (TSD+LSI) in {elapsed:.1f}s")
                    return elapsed
            elif check_tsd:
                if drifting:
                    print(f"[6/10] ANOMALY DETECTED (TSD) in {elapsed:.1f}s")
                    return elapsed
            elif check_lsi:
                if lsi_signal:
                    label = "LOG ANOMALY (informational)" if not triggers_rb else "LSI ERROR ANOMALY"
                    print(f"[6/10] {label} DETECTED in {elapsed:.1f}s")
                    return elapsed

        except Exception as e:
            print(f"  Poll error: {e}")
        time.sleep(POLL_INTERVAL)

    print("  WARNING: Max wait exceeded without detection.")
    return -1


def poll_for_rollback(agent_url: str, initial_count: int) -> float:
    print("[7/10] Waiting for rollback execution…")
    start = time.time()
    while time.time() - start < MAX_WAIT:
        try:
            history = requests.get(f"{agent_url}/rollback/history", timeout=5).json()
            if len(history) > initial_count:
                entry = history[0]
                t = time.time() - start
                print(
                    f"  Rollback: {entry.get('from_tag')} → {entry.get('to_tag')} "
                    f"(success={entry.get('success')}) in {t:.1f}s"
                )
                return t
        except Exception as e:
            print(f"  Poll error: {e}")
        time.sleep(POLL_INTERVAL)
    print("  WARNING: No rollback detected within timeout.")
    return -1


def poll_for_recovery(agent_url: str) -> float:
    print("[8/10] Waiting for ROLLED_BACK status…")
    start = time.time()
    while time.time() - start < MAX_WAIT:
        try:
            versions = requests.get(f"{agent_url}/versions", timeout=5).json()
            if any(v["status"] == "ROLLED_BACK" for v in versions):
                t = time.time() - start
                print(f"  ROLLED_BACK entry found in {t:.1f}s")
                return t
        except Exception as e:
            print(f"  Poll error: {e}")
        time.sleep(POLL_INTERVAL)
    print("  WARNING: No ROLLED_BACK status within timeout.")
    return -1


# ── Docker mode ────────────────────────────────────────────────────────────────

def _require_docker():
    try:
        import docker  # type: ignore
        return docker.from_env()
    except ImportError:
        print("ERROR: pip install docker")
        sys.exit(1)
    except Exception as e:
        print(f"ERROR: Could not connect to Docker daemon: {e}")
        sys.exit(1)


def build_fault_image_docker(fault_type: str) -> str:
    """Build a Docker image for the fault type. Returns the image tag."""
    spec = FAULT_CATALOGUE[fault_type]
    if "docker_app" not in spec:
        return ""  # crash uses busybox directly

    tag = f"backtrack-fault-{fault_type}:latest"
    print(f"[4a/10] Building {tag}…")

    dockerfile = (
        "FROM python:3.11-slim\n"
        "RUN pip install flask --quiet\n"
        "COPY app.py /app.py\n"
        'CMD ["python", "/app.py"]\n'
    )
    with tempfile.TemporaryDirectory() as d:
        with open(os.path.join(d, "Dockerfile"), "w") as f:
            f.write(dockerfile)
        with open(os.path.join(d, "app.py"), "w") as f:
            f.write(spec["docker_app"])
        import docker as _docker  # type: ignore
        client = _docker.from_env()
        image, _ = client.images.build(path=d, tag=tag, rm=True)
    print(f"  OK — built {image.tags}")
    return tag


def inject_failure_docker(client, target: str, fault_type: str) -> dict:
    """
    Replace the target container with a fault image.
    For tsd-crash: replaces with a crash-looping busybox (no build).
    Returns original container config dict for later restoration.
    """
    print(f"[4b/10] Docker: replacing '{target}' with fault={fault_type}…")
    original: dict = {
        "image": "unknown",
        "network_mode": "bridge",
        "port_bindings": {},
        "env": [],
        "binds": [],
        "fault_type": fault_type,
    }
    try:
        c = client.containers.get(target)
        hc = c.attrs.get("HostConfig", {})
        cc = c.attrs.get("Config", {})
        if c.image.tags:
            original["image"] = c.image.tags[0]
        original["network_mode"] = hc.get("NetworkMode", "bridge")
        original["port_bindings"] = hc.get("PortBindings") or {}
        original["env"] = cc.get("Env") or []
        original["binds"] = hc.get("Binds") or []
        c.stop(timeout=5)
        c.remove()
    except Exception:
        print(f"  Warning: container '{target}' not found — starting fresh")

    if fault_type == "tsd-crash":
        # Crash-loop: busybox exits 1 immediately, restart policy keeps incrementing restartCount
        # which TSD picks up as a crash signal.
        subprocess.run(["docker", "pull", "busybox:latest"], capture_output=True)
        client.containers.run(
            "busybox:latest",
            command=["sh", "-c", "echo '[ERROR] fatal crash — exiting'; exit 1"],
            detach=True,
            name=target,
            network_mode=original["network_mode"],
            restart_policy={"Name": "on-failure", "MaximumRetryCount": 20},
        )
        injected_tag = "busybox:latest (crash-loop)"
    else:
        tag = build_fault_image_docker(fault_type)
        client.containers.run(
            tag,
            detach=True,
            name=target,
            network_mode=original["network_mode"],
        )
        injected_tag = tag

    print(f"  OK — fault container running (was: {original['image']}, now: {injected_tag})")
    return original


def restore_docker(client, target: str, original: dict) -> None:
    """Remove the fault container if BackTrack didn't already, then restore original config."""
    fault_type = original.get("fault_type", "")
    bad_prefix = "backtrack-fault-" if fault_type != "tsd-crash" else "busybox"

    try:
        c = client.containers.get(target)
        current_tag = c.image.tags[0] if c.image.tags else ""
        if fault_type == "tsd-crash":
            # For crash, only clean up if the crash-looper is still running
            if "busybox" not in current_tag:
                return
        else:
            if "backtrack-fault" not in current_tag:
                return  # already restored by BackTrack
        print(f"  Cleanup: stopping fault container '{target}'…")
        c.stop(timeout=5)
        c.remove()
    except Exception as e:
        print(f"  Cleanup warning: {e}")
        return

    original_image = original.get("image", "unknown")
    if not original_image or original_image == "unknown":
        print("  Warning: original image unknown — skipping restore.")
        return

    run_kwargs: dict = {
        "detach": True,
        "name": target,
        "network_mode": original.get("network_mode", "bridge"),
    }
    if original.get("env"):
        run_kwargs["environment"] = original["env"]
    if original.get("binds"):
        run_kwargs["volumes"] = original["binds"]
    port_bindings = original.get("port_bindings") or {}
    if port_bindings:
        ports_map: dict = {}
        for container_port, host_ports in port_bindings.items():
            for hp in (host_ports or []):
                host = hp.get("HostPort", "")
                if host:
                    ports_map[container_port] = int(host)
        if ports_map:
            run_kwargs["ports"] = ports_map

    try:
        client.containers.run(original_image, **run_kwargs)
        print(f"  OK — '{target}' restored to {original_image}")
    except Exception as e:
        print(f"  Restore error: {e}")


# ── Kubernetes mode ────────────────────────────────────────────────────────────

def _kubectl(*args: str, namespace: str = "default") -> subprocess.CompletedProcess:
    return subprocess.run(["kubectl", *args, "-n", namespace], capture_output=True, text=True)


def _require_kubectl() -> None:
    r = subprocess.run(["kubectl", "version", "--client"], capture_output=True, text=True)
    if r.returncode != 0:
        print("ERROR: kubectl not found or not configured.")
        sys.exit(1)


def k8s_get_deployment_info(target: str, namespace: str) -> dict:
    r = _kubectl(
        "get", "deployment", target, "-o",
        "jsonpath={.spec.template.spec.containers[0].name}|"
        "{.spec.template.spec.containers[0].image}|"
        "{.spec.replicas}",
        namespace=namespace,
    )
    if r.returncode != 0:
        raise RuntimeError(f"kubectl get deployment/{target} failed: {r.stderr.strip()}")
    parts = r.stdout.strip().split("|")
    return {
        "container": parts[0] if len(parts) > 0 else target,
        "image":     parts[1] if len(parts) > 1 else "unknown",
        "replicas":  int(parts[2]) if len(parts) > 2 and parts[2].isdigit() else 1,
    }


def inject_failure_kubernetes(target: str, namespace: str, fault_type: str) -> dict:
    """Patch the target Deployment with the fault spec for the chosen fault type."""
    print(f"[4/10] Kubernetes: patching '{target}' in '{namespace}' with fault={fault_type}…")
    _require_kubectl()
    info = k8s_get_deployment_info(target, namespace)
    print(f"  Current — image: {info['image']}, container: {info['container']}, replicas: {info['replicas']}")

    spec = FAULT_CATALOGUE[fault_type]
    image   = spec["k8s_image"]
    command = spec["k8s_command"]

    patch = {
        "spec": {
            "template": {
                "spec": {
                    "containers": [{
                        "name":            info["container"],
                        "image":           image,
                        "imagePullPolicy": "IfNotPresent",
                        "command":         command,
                        "readinessProbe":  None,
                        "livenessProbe":   None,
                    }]
                }
            }
        }
    }
    r = subprocess.run(
        ["kubectl", "patch", "deployment", target, "-n", namespace,
         "--patch", json.dumps(patch)],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        raise RuntimeError(f"kubectl patch failed: {r.stderr.strip()}")
    print(f"  OK — deployment patched: image={image}")
    return info


def restore_kubernetes(target: str, namespace: str, info: dict, fault_type: str) -> None:
    """If deployment is still running the fault spec, undo and wait for rollout."""
    fault_images = {FAULT_CATALOGUE[ft]["k8s_image"] for ft in FAULT_CATALOGUE}
    try:
        current = k8s_get_deployment_info(target, namespace)
        if current["image"] not in fault_images:
            return  # already restored by BackTrack agent
        print(f"  Cleanup: running kubectl rollout undo deployment/{target}…")
        r = subprocess.run(
            ["kubectl", "rollout", "undo", f"deployment/{target}", "-n", namespace],
            capture_output=True, text=True,
        )
        if r.returncode != 0:
            print(f"  Cleanup error: {r.stderr.strip()}")
            return
        status = subprocess.run(
            ["kubectl", "rollout", "status", f"deployment/{target}",
             "-n", namespace, "--timeout=120s"],
            capture_output=True, text=True,
        )
        if status.returncode == 0:
            print(f"  OK — deployment/{target} restored: {status.stdout.strip()}")
        else:
            print(f"  Warning: rollout status timed out: {status.stderr.strip()}")
    except Exception as e:
        print(f"  Cleanup warning: {e}")


# ── GitHub CI/CD provisions ────────────────────────────────────────────────────

def _gh_headers(token: Optional[str]) -> dict:
    h = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
    if token:
        h["Authorization"] = f"Bearer {token}"
    return h


def detect_github_config(dashboard_url: str) -> dict:
    try:
        resp = requests.get(f"{dashboard_url}/api/connections", timeout=5)
        if not resp.ok:
            return {}
        for conn in resp.json().get("connections", []):
            if conn.get("githubRepo"):
                return {
                    "repo":   conn["githubRepo"],
                    "branch": conn.get("githubBranch") or "main",
                    "token":  conn.get("githubToken") or os.environ.get("GITHUB_TOKEN", ""),
                }
    except Exception:
        pass
    return {}


def github_head_commit(repo: str, branch: str, token: Optional[str]) -> str:
    try:
        r = requests.get(
            f"https://api.github.com/repos/{repo}/commits/{branch}",
            headers=_gh_headers(token), timeout=10,
        )
        if r.ok:
            return r.json().get("sha", "")[:7]
    except Exception:
        pass
    return ""


def github_last_run(repo: str, branch: str, token: Optional[str]) -> dict:
    try:
        r = requests.get(
            f"https://api.github.com/repos/{repo}/actions/runs?branch={branch}&per_page=1",
            headers=_gh_headers(token), timeout=10,
        )
        if r.ok:
            runs = r.json().get("workflow_runs", [])
            if runs:
                run = runs[0]
                return {
                    "id":         run["id"],
                    "name":       run["name"],
                    "status":     run["status"],
                    "conclusion": run.get("conclusion"),
                    "head_sha":   run["head_sha"][:7],
                    "url":        run["html_url"],
                }
    except Exception:
        pass
    return {}


def github_snapshot(label: str, repo: str, branch: str, token: Optional[str]) -> dict:
    commit = github_head_commit(repo, branch, token)
    run    = github_last_run(repo, branch, token)
    run_desc = f"{run.get('name', '?')} ({run.get('conclusion') or run.get('status', '?')})" if run else "—"
    print(f"  GitHub [{label}]: commit={commit or '?'}, workflow={run_desc}")
    return {"commit_sha": commit, "workflow_run": run}


# ── Output ─────────────────────────────────────────────────────────────────────

def write_results(results: dict, output_file: str) -> None:
    print(f"[9/10] Writing results to {output_file}…")
    os.makedirs(os.path.dirname(os.path.abspath(output_file)), exist_ok=True)
    with open(output_file, "w") as f:
        json.dump(results, f, indent=2)
    print("  OK — results saved.")


def print_summary(results: dict) -> None:
    d  = results["detection_time_seconds"]
    rb = results["rollback_time_seconds"]
    fault_type  = results.get("fault_type", "unknown")
    detects     = "+".join(FAULT_CATALOGUE.get(fault_type, {}).get("detects", ["?"]))
    description = FAULT_CATALOGUE.get(fault_type, {}).get("description", "")

    print("\n[10/10] ══════════════════════════════════════════════════════")
    print("  BACKTRACK BENCHMARK RESULTS")
    print("  ══════════════════════════════════════════════════════════")
    print(f"  App:             {results['app']}")
    print(f"  Mode:            {results['mode']}")
    print(f"  Fault type:      {fault_type}  [{detects}]")
    print(f"  Description:     {description}")
    print(f"  Inject time:     {results['deploy_time']}")
    print(f"  Detection time:  {d:.1f}s  {'✓' if 0 < d < 300 else ('✗' if d > 0 else '—')}")
    print(f"  Rollback time:   {rb:.1f}s  {'✓' if 0 < rb < 120 else ('✗' if rb > 0 else '—')}")
    print(f"  Total time:      {results['total_time_seconds']:.1f}s")
    print(f"  Image before:    {results['image_tag_before']}")
    print(f"  Image after:     {results['image_tag_after']}")
    if results.get("github"):
        gh   = results["github"]
        pre  = gh.get("pre_fault", {})
        post = gh.get("post_rollback", {})
        pre_run  = pre.get("workflow_run", {})
        post_run = post.get("workflow_run", {})
        print(f"  ── GitHub CI/CD ({gh.get('repo')}@{gh.get('branch')}) ──")
        print(f"  Pre-fault SHA:   {pre.get('commit_sha') or '—'}")
        print(f"  Post-rollback:   {post.get('commit_sha') or '—'}")
        if pre_run:
            print(f"  CI before:       {pre_run.get('name', '?')} → {pre_run.get('conclusion') or pre_run.get('status', '?')}")
        if post_run:
            print(f"  CI after:        {post_run.get('name', '?')} → {post_run.get('conclusion') or post_run.get('status', '?')}")
        if (pre.get("commit_sha") and post.get("commit_sha")
                and pre["commit_sha"] == post["commit_sha"]):
            print("  ✓ Commit SHA unchanged — no unintended new deploy during test.")
    print("  ══════════════════════════════════════════════════════════\n")


# ── Main ───────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description="BackTrack failure injection benchmark")
    parser.add_argument(
        "--fault-type",
        choices=list(FAULT_CATALOGUE),
        metavar="TYPE",
        help=(
            "Fault type to inject. Choices: "
            + ", ".join(FAULT_CATALOGUE)
            + ". Prompted interactively if omitted."
        ),
    )
    parser.add_argument("--mode", choices=["docker", "kubernetes"])
    parser.add_argument("--target", default="app")
    parser.add_argument("--namespace", default="default")
    parser.add_argument("--agent-url", default="http://localhost:8847")
    parser.add_argument("--dashboard-url", default="http://localhost:3847")
    parser.add_argument("--skip-agent", action="store_true")
    parser.add_argument("--restore-wait", type=int, default=120)
    parser.add_argument("--output", default="tests/results_app1.json")
    parser.add_argument("--app-name", default="test-app-1")
    parser.add_argument("--github-repo", default="")
    parser.add_argument("--github-branch", default="")
    parser.add_argument("--github-token", default="")
    args = parser.parse_args()

    # ── Choose fault type ──────────────────────────────────────────────────────
    fault_type = args.fault_type or _fault_menu()
    spec = FAULT_CATALOGUE[fault_type]
    print(f"\n  Fault type : {fault_type}")
    print(f"  Detects    : {'+'.join(spec['detects'])}")
    print(f"  Description: {spec['description']}\n")

    # ── Step 1: agent health + mode detection ──────────────────────────────────
    if args.skip_agent:
        if not args.mode:
            print("ERROR: --mode is required with --skip-agent")
            sys.exit(1)
        mode = args.mode
        initial_count = 0
        print(f"[1/10] Skipping agent health check (--skip-agent). Mode: {mode}")
        print("[2/10] Skipping stable-version check (--skip-agent).")
    else:
        health = wait_for_health(args.agent_url)
        mode   = args.mode or health.get("mode", "docker")
        print(f"  Using mode: {mode}")
        check_stable_version(args.agent_url)
        initial_count = get_initial_rollback_count(args.agent_url)

    # ── GitHub: resolve config ─────────────────────────────────────────────────
    gh_repo   = args.github_repo
    gh_branch = args.github_branch
    gh_token  = args.github_token or os.environ.get("GITHUB_TOKEN", "")

    if not gh_repo:
        detected = detect_github_config(args.dashboard_url)
        if detected:
            gh_repo   = detected.get("repo", "")
            gh_branch = gh_branch or detected.get("branch", "main")
            gh_token  = gh_token  or detected.get("token", "")
            print(f"  Auto-detected GitHub: {gh_repo}@{gh_branch}")

    gh_branch    = gh_branch or "main"
    gh_token_opt = gh_token or None

    github_pre: dict = {}
    if gh_repo:
        print("[3a/10] GitHub CI/CD snapshot (pre-fault)…")
        github_pre = github_snapshot("pre-fault", gh_repo, gh_branch, gh_token_opt)

    # ── Step 3: record injection time ─────────────────────────────────────────
    deploy_time = datetime.now(timezone.utc).isoformat()
    print(f"[3/10] Injection start: {deploy_time}")

    # ── Step 4: inject failure ─────────────────────────────────────────────────
    original_image  = "unknown"
    k8s_info:   dict = {}
    docker_original: dict = {}
    docker_client        = None

    if mode == "kubernetes":
        k8s_info       = inject_failure_kubernetes(args.target, args.namespace, fault_type)
        original_image = k8s_info.get("image", "unknown")
        injected_image = f"{FAULT_CATALOGUE[fault_type]['k8s_image']} ({fault_type})"
    else:
        docker_client   = _require_docker()
        docker_original = inject_failure_docker(docker_client, args.target, fault_type)
        original_image  = docker_original.get("image", "unknown")
        injected_image  = f"backtrack-fault-{fault_type}:latest"

    benchmark_start = time.time()

    # ── Steps 5-8: detection → rollback → recovery ────────────────────────────
    if args.skip_agent:
        print(
            f"[5-8/10] Holding fault for {args.restore_wait}s (--skip-agent). "
            f"Agent needs ≥3 scrape cycles (~30s) to detect most faults."
        )
        for remaining in range(args.restore_wait, 0, -10):
            print(f"  {remaining}s remaining…")
            time.sleep(min(10, remaining))
        detection_time = rollback_time = recovery_time = -1
    else:
        detection_time = poll_for_detection(args.agent_url, fault_type)
        if spec.get("triggers_rollback", True):
            rollback_time = poll_for_rollback(args.agent_url, initial_count)
            recovery_time = poll_for_recovery(args.agent_url)
        else:
            print("[6-7/10] Skipping rollback/recovery poll — this fault type is informational only (no rollback expected).")
            rollback_time = recovery_time = -1

    total_time = time.time() - benchmark_start

    # ── Cleanup: restore if BackTrack didn't fully roll back ───────────────────
    if mode == "kubernetes":
        restore_kubernetes(args.target, args.namespace, k8s_info, fault_type)
    elif docker_client is not None:
        restore_docker(docker_client, args.target, docker_original)

    # ── GitHub post-rollback snapshot ─────────────────────────────────────────
    github_post: dict = {}
    if gh_repo:
        print("[8a/10] GitHub CI/CD snapshot (post-rollback)…")
        github_post = github_snapshot("post-rollback", gh_repo, gh_branch, gh_token_opt)

    # ── Step 9: write results ─────────────────────────────────────────────────
    results: dict = {
        "app":                    args.app_name,
        "mode":                   mode,
        "fault_type":             fault_type,
        "fault_detects":          spec["detects"],
        "deploy_time":            deploy_time,
        "detection_time_seconds": round(detection_time, 2),
        "rollback_time_seconds":  round(rollback_time,  2),
        "recovery_time_seconds":  round(recovery_time,  2),
        "total_time_seconds":     round(total_time,     2),
        "false_positives":        0,
        "image_tag_before":       original_image,
        "image_tag_after":        injected_image,
    }
    if gh_repo:
        results["github"] = {
            "repo":          gh_repo,
            "branch":        gh_branch,
            "pre_fault":     github_pre,
            "post_rollback": github_post,
        }

    write_results(results, args.output)
    print_summary(results)


if __name__ == "__main__":
    main()
