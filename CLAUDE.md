# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repo Structure

```
BackTrack/
├── backtrack-dashboard/   # Next.js frontend
├── backtrack-agent/       # Python backend agent
├── docker-compose.yml     # Root orchestration
└── docs/
```

## Commands

Run from `backtrack-dashboard/`:

```bash
npm run dev       # Start dev server (http://localhost:3847)
npm run build     # Production build
npm run start     # Start production server
npm run lint      # Run ESLint
```

No test suite is configured.

## Architecture Overview

BackTrack is a **local-first Kubernetes/Docker observability dashboard** built with Next.js 16 App Router, React 19, TypeScript 5, and Tailwind CSS 4.

### Data Flow

1. **Connection Setup**: User configures cluster via the Nav modal → `POST /api/connections` → discovers services via `kubectl`/`docker` CLI → persists to `.backtrack/connections.json`
2. **Dashboard Polling**: `backtrack-dashboard/src/app/page.tsx` polls `GET /api/dashboard/overview` every 10 seconds
3. **Metrics Aggregation**: Overview route queries Prometheus PromQL → falls back to `kubectl top pods` → falls back to 0 if unavailable
4. **Anomaly View**: `backtrack-dashboard/src/app/anomalies/page.tsx` displays anomalies with an integrated xterm.js terminal that forwards commands to `POST /api/terminal`
5. **Cross-component refresh**: `Nav.tsx` dispatches custom DOM event `backtrack:connection-updated` after a connection change; `page.tsx` subscribes to trigger re-fetch

### Key Modules

| Path | Role |
|------|------|
| `backtrack-dashboard/src/lib/monitoring-store.ts` | File-based + in-memory (Node global) store for connections; reads/writes `.backtrack/connections.json` |
| `backtrack-dashboard/src/lib/monitoring-types.ts` | All shared TypeScript types (`AppConnection`, `DiscoveredService`, `DashboardService`, `DashboardAnomaly`) |
| `backtrack-dashboard/src/app/api/connections/route.ts` | Service discovery via `child_process.spawn` (kubectl/docker); deduplicates by `(appName, namespace, platform)` |
| `backtrack-dashboard/src/app/api/dashboard/overview/route.ts` | Aggregates health + metrics across all connections; hardcoded thresholds: down → critical, memory > 120 MiB → warning |
| `backtrack-dashboard/src/app/api/prometheus/query/route.ts` | PromQL proxy — forwards queries with Bearer token auth |
| `backtrack-dashboard/src/app/api/terminal/route.tsx` | Executes arbitrary shell commands via `child_process.exec` (10 MB buffer); no allowlist |

### Health Evaluation (Kubernetes)

The overview route uses **dual signals**: `up{}` (pod-level) AND `probe_success{}` (blackbox TCP probe). A service is "down" only if both return 0 or are unavailable.

### Connection Store

`monitoring-store.ts` uses a Node.js global (`global.__backtrackStore`) as an in-memory cache backed by synchronous file I/O to `.backtrack/connections.json`. The file is auto-created if missing. Legacy connection schemas are normalized on read.

## Path Alias

`@/*` resolves to `./src/*` (configured in `tsconfig.json`).
