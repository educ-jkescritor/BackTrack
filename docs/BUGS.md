# BackTrack — Bug Report & Fix Backlog

Scanned: 2026-05-03. Covers Python agent, Next.js API routes, frontend UI, and infrastructure.
Prioritized for uniform behavior across respondents.

---

## CRITICAL — Breaks functionality for all respondents

### 1. K8s mode: no kubeconfig mount → kubectl has no credentials
**File:** `docker-compose.yml`
**Issue:** Both `backtrack-dashboard` and `backtrack-agent` services are missing kubeconfig volume mount. kubectl inside containers has no credentials. K8s mode completely non-functional out of the box.
**Fix:** Add to both services in `docker-compose.yml`:
```yaml
volumes:
  - ~/.kube:/root/.kube:ro
```

---

### 2. `versions.py:85-88` — Snapshot pruning broken (reference equality)
**File:** `backtrack-agent/src/versions.py:85-88`
**Issue:**
```python
self.snapshots = [s for s in self.snapshots if s not in to_remove]
```
`s not in to_remove` uses object reference equality on dataclasses — always evaluates to `True`. Old snapshots are never deleted. Storage and memory grow unbounded across all respondent sessions.
**Fix:** Use ID-based comparison:
```python
remove_ids = {id(s) for s in to_remove}
self.snapshots = [s for s in self.snapshots if id(s) not in remove_ids]
```

---

### 3. `versions.py:103-106` — `get_last_stable()` returns oldest stable, not newest
**File:** `backtrack-agent/src/versions.py:103-106`
**Issue:** Iterates snapshots in insertion order and returns the first STABLE hit. If snapshots are `[STABLE_v1, PENDING, STABLE_v2]`, rollback targets `v1` not `v2`. Wrong version restored.
**Fix:** Snapshots list should be newest-first, OR sort before iterating:
```python
for snap in sorted(self.snapshots, key=lambda s: s.timestamp, reverse=True):
    if snap.status == "STABLE":
        return snap
```

---

### 4. `tsd.py` — Zero-variance metrics suppress anomalies silently
**File:** `backtrack-agent/src/collectors/tsd.py`
**Issue:** IQR of a flat series (constant CPU = 0%) equals 0. `threshold = iqr_multiplier × 0 = 0`. Guard `threshold > 0` then prevents anomaly detection. A crashed container producing 0% CPU forever never triggers rollback.
**Fix:** When IQR = 0 but residuals are non-zero, treat as drift. Separate the zero-IQR skip from the threshold check.

---

### 5. `lsi.py:241` — Vectorizer crash on empty log corpus
**File:** `backtrack-agent/src/collectors/lsi.py:241`
**Issue:** If a container produces zero log lines during warmup, `vectorizer.fit_transform([])` gets an empty corpus. Calling `transform()` on an unfitted vectorizer raises `ValueError`. Agent crashes on startup for any quiet container.
**Fix:** Guard corpus length before fitting:
```python
if len(self.corpus) < 2:
    return  # not enough data to fit model
```

---

### 6. `rollback/executor.py:101-106` — Docker rollback restores bare container
**File:** `backtrack-agent/src/rollback/executor.py:101-106`
**Issue:**
```python
client.containers.run(image, detach=True, name=config.target, network_mode=network_mode)
```
No port mappings, environment variables, or volumes copied from the original container. App starts but is non-functional. Respondents think rollback succeeded but the app is broken.
**Fix:** Capture and replay original `HostConfig` from container inspect before stopping it.

---

### 7. `KubernetesTerminal.tsx:67` — Hardcoded cluster name "production-us-east"
**File:** `backtrack-dashboard/src/app/anomalies/KubernetesTerminal.tsx:67`
**Issue:** Terminal header always shows `production-us-east` regardless of which cluster the user actually connected. Respondents running kubectl commands can misidentify the target cluster. Dangerous.
**Fix:** Pass the connected cluster name as a prop from the connection store.

---

### 8. `main.py:155` — Polling loop task not tracked, crashes silently
**File:** `backtrack-agent/src/main.py:155`
**Issue:**
```python
asyncio.create_task(polling_loop())  # reference dropped immediately
```
If polling loop crashes (OOM, unhandled exception), it silently dies. Agent HTTP endpoints keep responding as "healthy" but monitoring has stopped. Undetectable without reading logs.
**Fix:**
```python
_polling_task = asyncio.create_task(polling_loop())
# add done callback to log crash and optionally restart
_polling_task.add_done_callback(lambda t: logger.error("Polling loop exited: %s", t.exception()) if t.exception() else None)
```

---

## HIGH — Inconsistent behavior across respondents

### 9. `Nav.tsx:47` — Prometheus URL defaults to `localhost:9090`
**File:** `backtrack-dashboard/src/app/components/Nav.tsx:47`
**Issue:** Default form value is `http://localhost:9090`. In K8s, Prometheus runs at `http://prometheus.monitoring.svc:9090` or similar. Respondents who don't notice this get zero metrics with no error — only silent fallback to `kubectl top`.
**Fix:** Default to empty string with placeholder text explaining the K8s in-cluster URL pattern.

---

### 10. `monitoring-store.ts` — No file lock on `connections.json`
**File:** `backtrack-dashboard/src/lib/monitoring-store.ts`
**Issue:** `registerConnection()` uses read-modify-write without any locking. Concurrent Connect clicks (or simultaneous API calls) cause last-write-wins data loss.
**Fix:** Use a mutex or serialize writes via a queue. At minimum, use atomic rename-write pattern.

---

### 11. `deployments/history/route.ts:195` — Wrong condition includes unrelated ReplicaSets
**File:** `backtrack-dashboard/src/app/api/deployments/history/route.ts:195`
**Issue:**
```typescript
if (owner && owner.name !== serviceName) continue;  // wrong
// should be:
if (!owner || owner.name !== serviceName) continue;
```
When `owner` is `undefined`, condition is `false` — the item is NOT skipped. Returns ReplicaSets from unrelated deployments. Version history is polluted with other apps' deployments.

---

### 12. `lsi.py:305-307` — LSI baseline locks early and drifts stale
**File:** `backtrack-agent/src/collectors/lsi.py:305-307`
**Issue:** Baseline locks after the first `BASELINE_WINDOWS` scores and never updates. After hours of operation, the locked baseline no longer reflects current log patterns. False positives and false negatives both increase over time.
**Fix:** Implement sliding window baseline (rolling mean over last N windows) instead of one-time lock.

---

### 13. `anomalies/page.tsx:233` — STL warmup progress hardcoded to 12
**File:** `backtrack-dashboard/src/app/anomalies/page.tsx:233`
**Issue:**
```tsx
{tsd.readings_count}/12   // hardcoded
{12 - tsd.readings_count} more readings needed
```
Hardcoded value doesn't match `BACKTRACK_SCRAPE_INTERVAL` or agent's actual minimum readings. Progress bar stops at wrong percentage for respondents using non-default intervals.
**Fix:** Expose `min_readings` from agent `/health` or `/metrics` endpoint and use it in the UI.

---

### 14. `tsd.py:106-107` — Docker SDK client created per scrape, never closed
**File:** `backtrack-agent/src/collectors/tsd.py:106-107`
**Issue:**
```python
client = docker.from_env()  # new client every 10s
```
File descriptor leak — fails after hours with `Too many open files`. Only affects Docker-mode respondents in long sessions.
**Fix:** Create `docker.from_env()` client once in `__init__` and reuse it.

---

### 15. `rollback/executor.py:111` — Multi-key label selector crashes rollback
**File:** `backtrack-agent/src/rollback/executor.py:111`
**Issue:**
```python
name = config.target or config.k8s_label_selector.split("=")[-1]
```
`"tier=backend,env=prod".split("=")[-1]` → `"prod"`. `kubectl rollout undo deployment/prod` fails silently. Respondents with complex label selectors get silent rollback failure.
**Fix:** Parse the first key-value pair only, or require `BACKTRACK_TARGET` to be set explicitly for rollback.

---

### 16. `api/metrics/detection/route.ts` — Confusion matrix TN/FN always 0
**File:** `backtrack-dashboard/src/app/api/metrics/detection/route.ts`
**Issue:** `tsdAgg.tn` and `tsdAgg.fn` are never populated. Precision/Recall/F1/Accuracy calculations are mathematically incorrect. The `/metrics` page shows wrong numbers to every respondent.
**Fix:** Either compute TN/FN from agent evaluation data or clearly mark them as "not available" in the UI rather than displaying derived-but-wrong values.

---

### 17. `page.tsx:46` — Dashboard polling hammers agent on error with no backoff
**File:** `backtrack-dashboard/src/app/page.tsx:46`
**Issue:** On agent unavailability, `/api/dashboard/overview` is called every 10s forever with no backoff. Flood of failed requests can mask real recovery events.
**Fix:** Implement exponential backoff: on repeated errors, increase interval (e.g. 10s → 20s → 40s → 60s max).

---

## MEDIUM — Degrades experience but doesn't break core function

| # | File | Issue | Fix |
|---|---|---|---|
| 18 | `metrics/page.tsx:164` | Test run form only resets label+notes; timestamps stale on next submit | Reset all form fields including timestamps after submit |
| 19 | `metrics/page.tsx:182` | MTTR form not reset after submit; stale data repopulates on reopen | Call full form state reset on submit success |
| 20 | `anomalies/page.tsx:247` | "Loading…" persists forever if agent healthy but `/metrics` endpoint fails | Add timeout + error state distinct from loading state |
| 21 | `RecentDeployment.tsx:61` | `hasLoadedRef` never resets — no loading indicator on cluster reconnect | Reset `hasLoadedRef` on `backtrack:connection-updated` event |
| 22 | `overview/route.ts:406` | Memory anomaly threshold hardcoded at 120 MiB | Make configurable via env var `BACKTRACK_MEMORY_THRESHOLD_MIB` |
| 23 | `overview/route.ts:382` | Request rate uses hardcoded `1/10` scrape interval | Read from `BACKTRACK_SCRAPE_INTERVAL` env var |
| 24 | `page.tsx:71,104` | `Date.now()` IDs collide on simultaneous rollbacks — silently drops events | Use `crypto.randomUUID()` instead |
| 25 | `rollback/route.ts:142` | LoadBalancer type uses `localhost` as access URL | Use external IP from `kubectl get svc` output |
| 26 | `main.py:262` | `/reconfigure` writes to `os.environ` — not thread-safe under concurrent requests | Use a lock or pass values through config object instead |
| 27 | `agent/Dockerfile:19` | Port 8847 hardcoded in CMD — can't override without image rebuild | Add `ARG AGENT_PORT=8847` and use `${AGENT_PORT}` in CMD |
| 28 | `monitoring-store.ts:46-63` | Legacy connections with missing `workload` field normalized to "unknown" service | Add explicit migration for legacy schema fields |
| 29 | `tsd.py:182` | CPU % not normalized by core count — meaningless across different cluster sizes | Normalize against cluster CPU capacity |
| 30 | `main.py:88-89` | Bare `except Exception` in polling loop swallows all errors including dict mutation errors | Log specific exception types; reset stale anomaly counts when service disappears |

---

## Priority Fix Order (for respondent uniformity)

| Priority | Item | File | Impact |
|---|---|---|---|
| 1 | K8s kubeconfig mount | `docker-compose.yml` | K8s mode 100% broken |
| 2 | `get_last_stable()` order | `versions.py:103` | Rollback to wrong version |
| 3 | Docker rollback missing env/ports | `rollback/executor.py` | Rollback leaves broken container |
| 4 | Zero-variance anomaly suppression | `tsd.py` | Crashed containers never detected |
| 5 | LSI crash on empty corpus | `lsi.py:241` | Agent crashes on quiet containers |
| 6 | Snapshot pruning broken | `versions.py:85` | Unbounded memory/storage growth |
| 7 | Polling loop task untracked | `main.py:155` | Silent monitoring stop |
| 8 | Terminal hardcoded cluster name | `KubernetesTerminal.tsx:67` | Wrong cluster identity shown |
| 9 | Prometheus URL default localhost | `Nav.tsx:47` | K8s metrics silently zero |
| 10 | Confusion matrix TN/FN zero | `metrics/detection/route.ts` | Metrics page always wrong |
| 11 | ReplicaSet history filter condition | `deployments/history/route.ts:195` | Polluted version history |
| 12 | Docker client leak | `tsd.py:106` | File descriptor exhaustion |
| 13 | LSI baseline never updates | `lsi.py:305` | Threshold drift over hours |
| 14 | Multi-key selector rollback crash | `rollback/executor.py:111` | Silent rollback failure |
| 15 | No polling backoff on error | `page.tsx:46` | Floods closed connections |
