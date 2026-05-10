---
name: Bug Fix Session 2026-05-04
description: 30-bug audit fix session; tracks pre-fixed bugs in dirty files vs. bugs applied this session
type: project
---

## Already fixed in dirty git files before session

Bugs 1-9, 11-12, 14-23, 25-26, 28, 30 were already applied in the dirty files
(lsi.py, tsd.py, executor.py, main.py, docker-compose.yml, Dockerfile,
monitoring-store.ts, Nav.tsx, page.tsx, anomalies/page.tsx, metrics/page.tsx,
RecentDeployment.tsx, overview/route.ts, rollback/route.ts, history/route.ts,
detection/route.ts).

**Why:** Previous fix pass already addressed these; the dirty git state confirmed the fixes.

## Applied this session

- **Bug 10** (monitoring-store.ts write lock): Added `_writeLock` promise chain to
  `registerConnection()` via `writeConnectionsQueued()`.
- **Bug 13** (hardcoded 12 in anomalies/page.tsx): Agent `/health` now exposes
  `min_readings: MIN_READINGS_FOR_STL`; frontend reads it and uses `minReadings` state.
- **Bug 24** (Date.now() ID collisions): Changed `RollbackEvent.id` and `RollbackToast.id`
  types from `number` to `string`; both creation sites now use `crypto.randomUUID()`.
  Updated `onDismiss` signatures in RollbackEventCard, RollbackToast, RecentDeployment, page.tsx.
- **Bug 27** (Dockerfile hardcoded port): Added `ARG AGENT_PORT=8847 / ENV AGENT_PORT`
  and changed CMD to shell form to expand `${AGENT_PORT}`.
- **Bug 29** (CPU% not normalized by core count): Added `_refresh_cluster_cpu()` async
  function that queries `kubectl get nodes` for allocatable CPUs (cached 5 min).
  `_scrape_kubernetes` now divides total millicores by cluster core count.

**How to apply:** `npm run build` in `backtrack-dashboard/` must pass cleanly — it does.
