# BackTrack — Autonomous Mode (No CI/CD Required)

BackTrack can detect deployments and trigger rollbacks **without any CI/CD pipeline integration**. It does this through a three-tier detection system that watches your infrastructure directly.

## How it works

```
Tier 1 — CI/CD push     POST /deployment/notify     (optional, fastest)
Tier 2 — Infra streams  K8s Watch API / docker events  (automatic)
Tier 3 — Reconciliation Polls every 60s             (missed-event fallback)
```

When a new deployment is detected from any tier, BackTrack:
1. Creates a new PENDING version snapshot
2. Resets anomaly counters for that service
3. Begins the stability window (default 10 minutes)
4. Triggers rollback automatically if anomalies appear within the window

## Quick start

### Docker mode

```bash
# Bring up the stack — no env vars required
docker compose -f docker-compose.hub.yml up -d
```

BackTrack streams `docker events` and detects any container that starts with a **different image** than the last-seen one. No CI/CD needed.

### Kubernetes mode

```bash
# Point BackTrack at your cluster namespace
export BACKTRACK_MODE=kubernetes
export BACKTRACK_K8S_NAMESPACE=production

docker compose -f docker-compose.hub.yml up -d
```

BackTrack watches the Kubernetes Deployment API and fires on every increment of the `deployment.kubernetes.io/revision` annotation. Rollouts triggered by `kubectl apply`, `helm upgrade`, ArgoCD, Flux, or any other tool are all detected automatically.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `BACKTRACK_MODE` | auto-detect | `docker` or `kubernetes` |
| `BACKTRACK_K8S_NAMESPACE` | `default` | Namespace to watch (K8s mode) |
| `BACKTRACK_TARGET` | _(all services)_ | Limit monitoring to one service |
| `BACKTRACK_STABLE_SECONDS` | `600` | Seconds of clean metrics before marking STABLE |
| `BACKTRACK_ROLLBACK_ENABLED` | `true` | Set `false` to detect without rolling back |
| `BACKTRACK_SCRAPE_INTERVAL` | `10` | Metric scrape frequency in seconds |

## Git SHA tracking without CI/CD

BackTrack automatically extracts the git commit SHA from OCI standard image labels when present:

```dockerfile
# In your Dockerfile
LABEL org.opencontainers.image.revision=$GIT_SHA
```

If the label is not present, BackTrack falls back to the image digest (`sha256:abc123…`) as a stable deployment identifier.

## Reconciliation — catching missed events

The watch streams reconnect automatically after failure, but deployments that happen while BackTrack is offline are caught by the reconciliation loop, which runs every 60 seconds and compares the current infra state to the last-known state.

The first reconcile run is delayed 90 seconds after startup to let the watch streams seed their initial state, preventing false-positive deployment events on boot.

## Monitoring multiple services

In Kubernetes mode with no `BACKTRACK_TARGET` set, BackTrack monitors **all deployments** in the configured namespace automatically. New deployments that appear after startup will be detected by the reconciliation loop within 60 seconds.

In Docker mode, set `BACKTRACK_TARGET` to a comma-separated list of container names, or use the dashboard's **Add Connection** flow to specify services.

## Checking detection status

```bash
# See all version snapshots (PENDING / STABLE / ROLLED_BACK)
curl http://localhost:8847/versions | jq .

# See deployment watcher logs
docker logs backtrack-agent --follow | grep -E "deployment|DeploymentWatcher"
```

## Troubleshooting

**"No deployments detected"**
- Kubernetes: check that the agent can reach the API server (`kubectl get deployments` inside the agent container)
- Docker: verify `/var/run/docker.sock` is mounted in the agent container

**"Reconciliation fires on every cycle"**
- This means the watch stream is not seeding its state correctly — check agent logs for watch stream errors

**"Rollback triggers immediately after deploy"**
- Increase `BACKTRACK_STABLE_SECONDS` to give your service more time to warm up
- Or set `BACKTRACK_ROLLBACK_ENABLED=false` temporarily to observe without acting
