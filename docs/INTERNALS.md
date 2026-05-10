# BackTrack — Internals Reference

Complete operator and developer knowledge base. Every port, config, data flow, workaround, and limitation.

---

## Table of Contents

1. [Ports & Networking](#1-ports--networking)
2. [Environment Variables](#2-environment-variables)
3. [Data Persistence](#3-data-persistence)
4. [Agent Startup & Reconfigure Flow](#4-agent-startup--reconfigure-flow)
5. [TSD Internals & Timing](#5-tsd-internals--timing)
6. [LSI Internals & Timing](#6-lsi-internals--timing)
7. [Rollback Flow](#7-rollback-flow)
8. [kubectl Commands Used Internally](#8-kubectl-commands-used-internally)
9. [Docker SDK Calls](#9-docker-sdk-calls)
10. [Dashboard API Routes](#10-dashboard-api-routes)
11. [Limitations — What BackTrack Cannot Do](#11-limitations--what-backtrack-cannot-do)
12. [Key File Locations](#12-key-file-locations)
13. [Operational Checklists](#13-operational-checklists)

---

## 1. Ports & Networking

| Port | Service | Direction | Defined In | Notes |
|------|---------|-----------|-----------|-------|
| `3847` | backtrack-dashboard | External (host) | `docker-compose.yml:10` | Next.js frontend |
| `8847` | backtrack-agent | Internal + External | `agent/Dockerfile EXPOSE` | FastAPI server |

**Inter-service communication (Docker Compose):**
- Dashboard → Agent: `http://backtrack-agent:8847` (service name resolution on internal bridge network)
- Set via `BACKTRACK_AGENT_URL=http://backtrack-agent:8847` in `docker-compose.yml:12`

**From source (no Docker):**
- Dashboard defaults to `http://127.0.0.1:8847` (NOT `localhost`) — avoids IPv6 conflict
- Defined in `backtrack-dashboard/src/app/api/agent/route.ts:3`

**IPv6 port conflict (common issue):**
- `kubectl port-forward` on dual-stack systems binds to `::1:<port>`, not `127.0.0.1:<port>`
- Symptom: agent returns 404 despite uvicorn running correctly
- Detect: `ss -tlnp | grep 8847` — look for both `0.0.0.0:8847` (uvicorn) and `[::1]:8847` (kubectl)
- Fix option A: kill the port-forward `kill <kubectl-pid>`
- Fix option B: use `kubectl port-forward --address=127.0.0.1 ...`
- Fix option C: set `BACKTRACK_AGENT_URL=http://127.0.0.1:8847` explicitly

**How to change the agent port:**
1. `docker-compose.yml`: change `"8847:8847"` to `"<newhost>:<newcontainer>"`
2. Dashboard service env: update `BACKTRACK_AGENT_URL=http://backtrack-agent:<newport>`
3. Update `agent/Dockerfile EXPOSE` and uvicorn CMD

---

## 2. Environment Variables

### Agent (`backtrack-agent/src/config.py`)

| Variable | Default | Effect | What breaks if missing |
|---|---|---|---|
| `BACKTRACK_TARGET` | `""` | Container name (Docker) or deployment name (K8s). Blank = auto-discover all K8s deployments | Agent starts idle, warns, no services monitored |
| `BACKTRACK_IMAGE_TAG` | `"unknown"` | Tag for rollback snapshot reference | Rollback history shows "unknown" |
| `BACKTRACK_MODE` | auto-detect | Force `kubernetes` or `docker`. Auto-detects from service account path | Wrong mode on hybrid systems |
| `BACKTRACK_K8S_NAMESPACE` | `"default"` | K8s namespace for pod discovery and metric scraping | Uses "default" |
| `BACKTRACK_K8S_LABEL_SELECTOR` | `""` | Override pod label selector. Default: `app={BACKTRACK_TARGET}` | Nothing |
| `BACKTRACK_ROLLBACK_ENABLED` | `"true"` | Set `"false"` to disable auto-rollback (manual only) | Nothing |
| `BACKTRACK_ROLLBACK_COOLDOWN` | `"120"` | Seconds before next auto-rollback allowed | Nothing |
| `BACKTRACK_SCRAPE_INTERVAL` | `"10"` | Seconds between TSD metric collections | Nothing |
| `BACKTRACK_STABLE_SECONDS` | `"600"` | Clean seconds before version marked STABLE | Nothing |
| `BACKTRACK_TSD_IQR_MULTIPLIER` | `"3.0"` | TSD drift sensitivity. Lower = more sensitive, more alerts | Nothing |
| `BACKTRACK_LSI_SCORE_MULTIPLIER` | `"2.0"` | LSI anomaly threshold multiplier | Nothing |
| `BACKTRACK_SVD_SIMILARITY_THRESHOLD` | `"0.55"` | SVD cosine similarity cutoff. Raise to reduce LSI false positives | Nothing |
| `BACKTRACK_CORPUS_SIZE` | `"200"` | Log lines collected before LSI model fits | Nothing |
| `BACKTRACK_BASELINE_WINDOWS` | `"10"` | Scoring windows before LSI baseline locks | Nothing |
| `BACKTRACK_WINDOW_SECONDS` | `"30"` | LSI scoring window duration in seconds | Nothing |
| `BACKTRACK_DATA_DIR` | `"/data"` | Where versions.json and rollback_log.json are written | Nothing (uses /data) |

**Mode auto-detection logic (`config.py:30-38`):**
```python
if BACKTRACK_MODE in ("kubernetes", "k8s"): return "kubernetes"
if os.path.exists("/var/run/secrets/kubernetes.io/serviceaccount"): return "kubernetes"
return "docker"
```

### Dashboard

| Variable | Default | Where Set | Effect |
|---|---|---|---|
| `BACKTRACK_AGENT_URL` | `http://127.0.0.1:8847` | `docker-compose.yml:12` or `.env.local` | Agent endpoint for all proxy calls |
| `GITHUB_TOKEN` | `""` | `docker-compose.yml:13` or `.env` | GitHub PAT for deployment history panel. Blank = panel disabled |
| `NODE_ENV` | `production` | `Dockerfile:18` | Next.js mode |
| `PORT` | `3847` | `Dockerfile:19` | Next.js listen port |
| `HOSTNAME` | `0.0.0.0` | `Dockerfile:20` | Next.js bind address |

---

## 3. Data Persistence

### Docker Compose Volume: `backtrack-data`

| Mount Point | Container | Contents | Survives |
|---|---|---|---|
| `/data` | backtrack-agent | `versions.json`, `rollback_log.json` | `docker compose restart` ✅ |
| `/.backtrack` | backtrack-dashboard | `connections.json` | `docker compose restart` ✅ |

Both destroyed by: `docker compose down -v`

### File Schemas

**`/.backtrack/connections.json`** — written on every Connect click
```json
[{
  "id": "uuid",
  "status": "connected",
  "createdAt": "ISO8601",
  "appName": "microservice-demo",
  "platform": "kubernetes",
  "architecture": "microservices",
  "clusterName": "production-us-east",
  "namespace": "default",
  "prometheusUrl": "",
  "githubRepo": "owner/repo",
  "githubBranch": "main",
  "githubToken": "ghp_...",
  "discoveredServices": [{
    "name": "frontend",
    "namespace": "default",
    "status": "running",
    "ports": ["80"],
    "source": "kubernetes"
  }]
}]
```

**`/data/versions.json`** — snapshot per agent startup or reconfigure
```json
[{
  "id": "uuid",
  "timestamp": "ISO8601",
  "image_tag": "v1.2.3",
  "status": "PENDING|STABLE|ROLLED_BACK",
  "tsd_baseline": {"cpu_percent": 0.0, "memory_mb": 0.0, "latency_ms": 0.0, "error_rate_percent": 0.0},
  "lsi_baseline": 0.0
}]
```

**`/data/rollback_log.json`** — one entry per rollback trigger
```json
[{
  "id": "uuid",
  "timestamp": "ISO8601",
  "reason": "TSD+LSI anomaly on frontend for 3 cycles",
  "from_tag": "v1.3.0",
  "to_tag": "v1.2.3",
  "mode": "kubernetes",
  "success": true
}]
```

### Reset All State
```bash
docker compose down -v   # destroys backtrack-data volume — IRREVERSIBLE
docker compose up -d
```

---

## 4. Agent Startup & Reconfigure Flow

### Startup Sequence (`main.py:136-156`)
1. Load `BacktrackConfig` singleton from env vars
2. `config.log_startup_summary()` — prints config table to stdout
3. Create `VersionStore(image_tag=config.image_tag)` + `RollbackExecutor(version_store)`
4. `await _discover_services()` → returns `[(service_name, label_selector)]`
5. For each service: `TSDCollector(service_name, label_selector)` + `LSICollector(...)`, start both
6. `asyncio.create_task(polling_loop())` — background loop

### Service Discovery Logic (`main.py:50-82`)

```
Docker mode + BACKTRACK_TARGET set:
  → [(target, "")]

K8s mode + BACKTRACK_TARGET set:
  → [(target, BACKTRACK_K8S_LABEL_SELECTOR or f"app={target}")]

K8s mode + no target:
  → kubectl get deployments -n {namespace} -o jsonpath
  → [(name, f"app={name}") for name in deployments]
  → Timeout: 15 seconds
```

### Reconfigure Endpoint (`POST /reconfigure`)

```json
{
  "target": "microservice-demo",
  "mode": "kubernetes",
  "namespace": "default",
  "image_tag": "v1.3.0",
  "services": ["frontend", "checkoutservice", "cartservice"]
}
```

What it does:
1. Updates `config.target`, `config.k8s_namespace`, `config.image_tag` in-place
2. Stops + removes all existing collectors
3. Clears `consecutive_anomaly_counts`, `clean_seconds_map`, `rollback_cooldown_until`
4. If `services[]` provided (K8s mode): creates per-service collectors with `app=<svc>` selectors
5. Otherwise runs `_discover_services()` again
6. No restart needed — hot-reload

### What Happens on Dashboard Connect

```
User clicks Connect →
  1. POST /api/connections
       → discovers services via kubectl/docker
       → saves connection to connections.json
       → returns { discoveredServices: [...] }

  2. POST /api/agent?path=reconfigure
       → body: { target, mode, namespace, services: [all discovered names] }
       → agent creates per-service TSD+LSI collectors

  3. POST /api/agent/env
       → writes backtrack-agent/.env for next cold start
```

### Polling Loop (`main.py:88-133`)

Runs every `BACKTRACK_SCRAPE_INTERVAL` (10s default):
- For each monitored service: check `tsd.is_drifting()` + `lsi.is_anomalous()`
- Anomaly count increments; at **3 consecutive cycles** → triggers rollback
- On clean cycle: count resets; `clean_seconds` increments
- After `BACKTRACK_STABLE_SECONDS` (600s) clean → marks version STABLE

---

## 5. TSD Internals & Timing

### Warm-up

| Milestone | Time |
|---|---|
| First metric collected | Immediate on `.start()` |
| STL decomposition begins | 2 min (12 readings × 10s) |
| Drift detection active | 2 min |
| Version marked STABLE | 10 min clean operation |

### STL Parameters (`tsd.py:221`)
- `period=6` (one seasonal cycle = 6 readings)
- `robust=True` (resistant to outliers)
- Outputs: `seasonal`, `trend`, `residual` arrays — all stored and exposed via `/metrics`

### Drift Detection Logic (`tsd.py:241-276`)
```
For each metric (cpu, memory, latency, error_rate):
  baseline = residuals[:-3]            # all except last 3
  q1, q3 = percentile(baseline, [25, 75])
  iqr = q3 - q1
  skip if iqr < 1e-6                   # flat series (no meaningful variance)
  threshold = tsd_iqr_multiplier × iqr  # default 3×
  drifting = all(abs(r) > threshold for r in residuals[-3:])
  if drifting: return True
```

Returns True if **any single metric** has 3 consecutive residuals above threshold.

### Metric Sources

| Metric | Docker | Kubernetes |
|---|---|---|
| CPU % | Docker SDK stats (cpu_delta / system_delta × cpus × 100) | `kubectl top pods -l app={name}` → millicores ÷ 10 |
| Memory MB | Docker stats (usage - cache) ÷ 1048576 | kubectl top Mi/Ki/Gi parsed |
| Latency ms | HTTP probe: `{service}:8080/health`, `:8080/`, `:80/` (5s timeout) | Same |
| Error rate | Always 0.0 | Always 0.0 |

**Error rate is always 0** — only Prometheus `http_requests_total` can provide it.

### Evaluation Metrics (`tsd.get_evaluation()`)
- `drift_events_total`: total anomaly trigger events
- `drift_sustained`: events that lasted 3+ cycles (TP estimate)
- `drift_spikes`: events that resolved in <3 cycles (FP estimate)
- `estimated_precision`: sustained ÷ total

---

## 6. LSI Internals & Timing

### Warm-up

| Milestone | Time |
|---|---|
| Log tailing starts | Immediate |
| Corpus filled (200 lines) | Depends on log volume (~3 min for active services) |
| Model fitted (TF-IDF + SVD) | Immediate after 200 lines |
| Baseline locked (10 windows × 30s) | 5+ min after model fit |
| Anomaly detection active | After baseline locked |

### Model Architecture

```
Raw log line
  → Keyword fast-path (exact substring match)
     → ERROR: error, exception, failed, crash, traceback, fatal
     → WARN:  warning, deprecated, slow, retry, timeout, retrying
     → INFO:  started, ready, connected, success, listening, ok

  If no keyword match + model fitted:
     → TF-IDF vectorize (max 5000 features)
     → TruncatedSVD transform (K=50 components)
     → Cosine similarity to 4 centroids (INFO/WARN/ERROR/NOVEL)
     → Label = best match if score > SVD_SIMILARITY_THRESHOLD (0.55)
     → Else: NOVEL
```

Keyword takes priority when matched.

### Anomaly Scoring (`tsd.py:276-311`)

Per 30-second window:
```
score = (ERROR×3 + NOVEL×5 + WARN×1) / total_lines_in_window
anomalous = score > max(1.5, lsi_score_multiplier × baseline_mean)
```

- Absolute floor: 1.5 (catches high error rates even with inflated baselines)
- Relative threshold: `2.0 × baseline_mean` (default)

### Log Tailing

| Mode | Method | Timeout | Retry |
|---|---|---|---|
| Docker | `container.logs(stream=True, follow=True, tail=0)` | Never (stream) | Falls back to 20-line poll every 10s |
| K8s | `kubectl logs --follow --tail=50 --prefix` | 15s per readline | Restarts with 3s backoff |

### Reducing False Positives

If LSI is triggering too often:
1. Raise `BACKTRACK_SVD_SIMILARITY_THRESHOLD` (try 0.70, then 0.80)
2. Raise `BACKTRACK_LSI_SCORE_MULTIPLIER` (try 2.5 or 3.0)
3. Raise `BACKTRACK_BASELINE_WINDOWS` (more windows = higher baseline = less sensitive)

---

## 7. Rollback Flow

### Trigger Conditions

| Trigger | Source | Threshold |
|---|---|---|
| Auto-rollback | Polling loop | 3 consecutive anomaly cycles |
| Manual rollback | Dashboard "Rollback" button | Immediate |
| API trigger | `POST /rollback/trigger` | Immediate |

Auto-rollback cooldown: 120s (configurable). Prevents rollback loops.

### Kubernetes Rollback (`rollback/route.ts` + `executor.py`)

```
1. kubectl get deployment {name} -o jsonpath={.spec.replicas}
   → if replicas = 0: kubectl scale deployment {name} --replicas=1

2. kubectl rollout undo deployment/{name} -n {ns} [--to-revision=N]

3. kubectl rollout status deployment/{name} --timeout=90s

4. Check for existing Service:
   - NodePort exists → return http://localhost:{nodePort}
   - ClusterIP exists → patch to NodePort → return URL
   - No service → kubectl expose deployment --type=NodePort → return URL

5. Return { ok, output, rolloutStatus, accessUrl }
```

### Docker Rollback (`executor.py:87-107`)

```
1. client.containers.get(config.target)
2. Preserve: container.attrs["HostConfig"]["NetworkMode"]
3. container.stop() + container.remove()
4. client.containers.run(stable.image_tag, detach=True,
                         name=config.target,
                         network_mode=preserved_network_mode)
```

Docker rollback uses the last STABLE snapshot's `image_tag`. If no STABLE snapshot exists, rollback aborts with "No stable version found".

### Version Lifecycle

```
Agent starts / reconfigures
  → Creates PENDING snapshot

10 minutes clean operation (no anomalies)
  → PENDING → STABLE
  → Baseline locked into snapshot

Rollback triggered
  → Current PENDING → ROLLED_BACK
  → Executes rollback to last STABLE
```

---

## 8. kubectl Commands Used Internally

| Command | Where | Timeout | Purpose |
|---|---|---|---|
| `kubectl get deployments -n {ns} -o jsonpath=...` | `main.py:67-74` | 15s | Discover all deployments on startup |
| `kubectl top pods -n {ns} -l {selector} --no-headers` | `tsd.py:148-156` | 10s | TSD metrics per scrape |
| `kubectl logs -n {ns} -l {selector} --follow --tail=50 --prefix` | `lsi.py:128-135` | 15s/line | LSI log tailing (continuous) |
| `kubectl get pods -n {ns} --no-headers -o custom-columns=...` | `overview/route.ts` | default | Live pod status for dashboard |
| `kubectl top pods -n {ns} --no-headers` | `overview/route.ts` | default | All pods CPU/memory for dashboard |
| `kubectl get svc {name} -n {ns} -o jsonpath=...` | `rollback/route.ts` | default | Check existing service type |
| `kubectl get deployment {name} -o jsonpath={.spec.replicas}` | `rollback/route.ts`, `executor.py` | default | Check replica count before rollback |
| `kubectl rollout undo deployment/{name} -n {ns}` | `executor.py:122`, `rollback/route.ts:88` | — | Execute rollback |
| `kubectl rollout status deployment/{name} --timeout=90s` | `rollback/route.ts:105` | 90s | Wait for rollout completion |
| `kubectl scale deployment {name} --replicas=1 -n {ns}` | `executor.py:133`, `rollback/route.ts:78` | default | Restore 0-replica deployments |
| `kubectl expose deployment {name} --type=NodePort --port={p}` | `rollback/route.ts:165` | default | Create NodePort service |
| `kubectl patch svc {name} -p '{"spec":{"type":"NodePort"}}'` | `rollback/route.ts:148` | default | Patch ClusterIP to NodePort |
| `kubectl get svc {name} -o jsonpath={.spec.type}:...` | `rollback/route.ts:134` | default | Get NodePort number |
| `kubectl get svc -n {ns} -o json` | `connections/route.ts:29` | default | Service discovery |
| `kubectl get pods -n {ns} -o json` | `connections/route.ts:48` | default | Pod discovery |
| `kubectl get endpoints -n {ns} -o json` | `connections/route.ts:68` | default | Endpoint health check |

**kubeconfig:** Auto-detected from `~/.kube/config`. In Docker must mount: `~/.kube:/root/.kube:ro`

**metrics-server:** Required for `kubectl top`. Without it, TSD metrics are all 0. Install:
```bash
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
```

---

## 9. Docker SDK Calls

All use `docker.from_env()` which reads `DOCKER_HOST` env var or defaults to `/var/run/docker.sock`.

| Call | File | Purpose |
|---|---|---|
| `client.containers.get(name)` | `tsd.py:107`, `lsi.py:107`, `executor.py:92` | Get container by exact name |
| `container.stats(stream=False)` | `tsd.py:108` | Single CPU/memory snapshot |
| `container.logs(stream=True, follow=True, tail=0)` | `lsi.py:108` | Real-time log stream |
| `container.logs(tail=20)` | `lsi.py:167` | Fallback: last 20 lines |
| `container.stop()` + `container.remove()` | `executor.py:97-98` | Pre-rollback cleanup |
| `client.containers.run(image, ...)` | `executor.py:101` | Start container with previous image |
| `docker ps --format "{{json .}}"` | `connections/route.ts:156` | Service discovery |

**Container name must be exact.** `docker.containers.get("my-app")` raises `NotFound` if container is named `my-app-1`.

---

## 10. Dashboard API Routes

| Route | Method | Purpose | Agent call? |
|---|---|---|---|
| `/api/agent?path=<p>` | GET | Proxy to agent `/health`, `/config`, `/metrics`, `/lsi`, `/versions`, `/services`, `/rollback/history` | YES |
| `/api/agent?path=<p>` | POST | Proxy to agent `/rollback/trigger`, `/reconfigure`, `/fault/*` | YES |
| `/api/connections` | GET | List saved connections | NO |
| `/api/connections` | POST | Discover services + save connection | NO (runs kubectl/docker) |
| `/api/dashboard/overview` | GET | Aggregate health + metrics (polled every 10s) | YES (for anomaly signals) |
| `/api/rollback` | POST | K8s rollout undo or Docker rollback via agent | YES (Docker only) |
| `/api/deployments/history` | GET | Rollout history + GitHub commits | NO |
| `/api/terminal` | POST | Execute arbitrary shell command | NO |
| `/api/prometheus/query` | GET | PromQL proxy with Bearer auth | NO (external Prometheus) |
| `/api/metrics/mttr` | GET/POST | MTTR tracking | NO |
| `/api/metrics/detection` | GET/POST | Confusion matrix + test runs | YES (fetches agent eval) |

**Agent proxy allowed paths (`agent/route.ts:23`, `:70`):**
- GET: `health`, `config`, `metrics`, `lsi`, `versions`, `services`, `rollback/history`, `fault/status`
- POST: `rollback/trigger`, `reconfigure`, `fault/inject/crash`, `fault/inject/latency`, `fault/inject/logs`, `fault/reset`

**Overview health aggregation (`overview/route.ts`):**
1. List all connections
2. For each service: run `kubectl top` + `kubectl get pods` (status)
3. If Prometheus URL set: query 5 PromQL variants per metric (CPU, memory, request rate)
4. Fetch agent `/services` → get TSD drift + LSI anomaly flags
5. Backfill agent TSD metrics if kubectl/Prometheus returns 0
6. Flag anomalies: down=critical, memory>120MiB=warning, agent signals=critical/high

---

## 11. Limitations — What BackTrack Cannot Do

| Limitation | Root Cause | Workaround |
|---|---|---|
| **Request rate** without Prometheus | No HTTP counter instrumentation | Install kube-prometheus-stack |
| **Error rate** measurement | Requires `http_requests_total` metric | Install Prometheus |
| **Ground truth** confusion matrix | No external labeling | Use "Add Test Run" on `/metrics` page |
| **Host port-forward** from containers | Container network isolation | Use NodePort (auto-created on rollback) |
| **Cross-namespace** monitoring | One namespace per connection | Add multiple connections |
| **Historical log** analysis | Only tails current logs | No workaround (by design) |
| **Coordinated multi-service** rollback | Per-service executors | Manual sequencing |
| **Prometheus on port 9090** | Different from agent port (8847) | No conflict |
| **Non-standard label selectors** | Assumes `app=<name>` | Set `BACKTRACK_K8S_LABEL_SELECTOR` |
| **Windows container** rollback | Docker SDK stop/remove not tested | Unknown |
| **Private Prometheus** without token | Needs Bearer auth | Add token in Connect modal Prometheus URL field |
| **Multiple simultaneous rollbacks** | Single rollback_executor per agent | Cooldown prevents; serialize manually |
| **Rollback to specific commit** | K8s: uses `--to-revision`; Docker: needs image tag | Pass revision in rollback request |

---

## 12. Key File Locations

### Agent (`backtrack-agent/`)

| File | Purpose |
|---|---|
| `src/main.py` | FastAPI app, `@app.on_event("startup")`, polling loop, all HTTP endpoints |
| `src/config.py` | `BacktrackConfig` singleton — all env var reads, mode auto-detection |
| `src/versions.py` | `VersionStore` — PENDING→STABLE→ROLLED_BACK lifecycle, file I/O |
| `src/collectors/tsd.py` | `TSDCollector` — STL decomposition, drift detection, metric scraping |
| `src/collectors/lsi.py` | `LSICollector` — TF-IDF+SVD model, log tailing, classification, scoring |
| `src/rollback/executor.py` | `RollbackExecutor` — Docker SDK or kubectl rollback, log appending |
| `requirements.txt` | Python dependencies (fastapi, sklearn, statsmodels, docker, aiohttp) |
| `Dockerfile` | Python 3.11-slim + curl + kubectl + pip install |
| `.env.example` | All env vars with comments |

### Dashboard (`backtrack-dashboard/`)

| File | Purpose |
|---|---|
| `src/app/api/agent/route.ts` | Agent HTTP proxy — GET/POST, allowed path whitelist |
| `src/app/api/connections/route.ts` | Service discovery — `discoverKubernetesServices()`, `discoverDockerServices()` |
| `src/app/api/dashboard/overview/route.ts` | Health aggregation — PromQL queries, kubectl fallback, anomaly generation |
| `src/app/api/rollback/route.ts` | Rollback — replica restore, `kubectl rollout undo`, NodePort creation, MTTR log |
| `src/app/api/metrics/detection/route.ts` | Confusion matrix — aggregates from agent eval + manual test runs |
| `src/lib/monitoring-store.ts` | `connections.json` read/write, `global.__backtrackStore` cache |
| `src/lib/monitoring-types.ts` | All TypeScript types (`AppConnection`, `DashboardService`, `DashboardAnomaly`) |
| `src/lib/command.ts` | `runCommand()` — spawns child processes (kubectl, docker) |
| `src/app/components/Nav.tsx` | Connect modal — form fields, reconfigure call, env write |
| `.env.example` | Dashboard env vars |

### Orchestration

| File | Purpose |
|---|---|
| `docker-compose.yml` | Port mapping, volumes, healthcheck, depends_on, env pass-through |
| `.env.example` | Root env template (what goes in `.env` next to docker-compose.yml) |
| `backtrack-agent/Dockerfile` | Agent image build |
| `backtrack-dashboard/Dockerfile` | Dashboard multi-stage build (builder → runner with kubectl + docker CLI) |
| `backtrack-agent/.dockerignore` | Excludes `.venv/`, `__pycache__/`, etc. from build context |

---

## 13. Operational Checklists

### Before `docker compose up`

- [ ] Set `BACKTRACK_TARGET` in `.env` (container name or K8s deployment)
- [ ] Set `BACKTRACK_IMAGE_TAG` for rollback reference
- [ ] K8s mode: mount `~/.kube:/root/.kube:ro` in both services
- [ ] K8s mode: verify metrics-server is installed (`kubectl top nodes`)
- [ ] K8s mode: verify pods have `app=<name>` labels (`kubectl get pods --show-labels`)
- [ ] No other process on host port 8847 (agent) or 3847 (dashboard)

### Verify Agent Is Working

```bash
curl http://127.0.0.1:8847/health
# → {"status":"ok","mode":"kubernetes","uptime_seconds":42,"monitored_services":["frontend","checkoutservice",...]}

curl http://127.0.0.1:8847/services
# → [{"name":"frontend","is_drifting":false,"is_anomalous":false,"readings_count":12,"lsi_fitted":false}]

curl "http://127.0.0.1:8847/metrics?service=frontend"
# → {"current":{"cpu_percent":1.1,...},"readings_count":12,...}
```

### Warm-up Status Check

```bash
curl http://127.0.0.1:8847/services | python3 -m json.tool
```

- `readings_count >= 12` → TSD active
- `lsi_fitted: true` → LSI model fitted (corpus full)
- `is_anomalous` stable at false → baseline locked

### Common Debug Commands

```bash
# Agent logs
docker compose logs -f backtrack-agent

# Dashboard logs
docker compose logs -f backtrack-dashboard

# Check port conflicts
ss -tlnp | grep -E "8847|3847"

# Inspect persisted connections
cat ~/.backtrack/connections.json 2>/dev/null || docker compose exec backtrack-dashboard cat /.backtrack/connections.json

# Rollback history
curl http://127.0.0.1:8847/rollback/history

# Version snapshots
curl http://127.0.0.1:8847/versions

# Reset everything
docker compose down -v && docker compose up -d
```

### Tuning for Your Environment

**Too many false positives (TSD):**
```env
BACKTRACK_TSD_IQR_MULTIPLIER=5.0   # Was 3.0
```

**Too many false positives (LSI):**
```env
BACKTRACK_SVD_SIMILARITY_THRESHOLD=0.70   # Was 0.55
BACKTRACK_LSI_SCORE_MULTIPLIER=3.0        # Was 2.0
```

**Slow corpus build (LSI):**
```env
BACKTRACK_CORPUS_SIZE=50     # Was 200 — fits faster, less accurate
BACKTRACK_BASELINE_WINDOWS=5  # Was 10 — locks baseline after 2.5 min instead of 5
```

**Rollback too aggressive:**
```env
BACKTRACK_ROLLBACK_ENABLED=false   # Disable auto-rollback, manual only
BACKTRACK_ROLLBACK_COOLDOWN=300    # 5 min between rollbacks (was 120s)
```
