# BackTrack — Docker Hub Quick Start

Pull and run BackTrack from Docker Hub — no source code needed.

---

## Prerequisites

- Docker + Docker Compose installed
- A running application (Docker containers or Kubernetes cluster)

---

## Step 1 — Download the Compose File

> **Windows note:** Use **Command Prompt** or **Git Bash** for this command. In PowerShell, `curl` is an alias for `Invoke-WebRequest`, which may behave differently with `-O`.

```bash
mkdir backtrack && cd backtrack

curl -O https://raw.githubusercontent.com/KenMarzan/BackTrack/main/docker-compose.hub.yml
```

No `.env` file required — all defaults work out of the box.

---

## Step 2 — Start BackTrack

```bash
docker compose -f docker-compose.hub.yml up -d
```

Both containers start in ~10 seconds. Check status:

```bash
docker compose -f docker-compose.hub.yml ps
```

Both should show `Up (healthy)`.

---

## Step 3 — Open the Dashboard

```
http://localhost:3847
```

---

## Step 4 — Connect Your Application

Click **Configure Cluster** (top-right) and fill in the form:

### Docker mode

| Field | What to enter |
|---|---|
| Application name | Your Docker Compose project name, or any container name |
| Platform | `Docker` |
| Architecture | `Microservices` (multiple containers) or `Monolith` (single container) |
| Prometheus URL | Optional — `http://host.docker.internal:<port>` if your app exposes Prometheus |

> **How discovery works:** BackTrack searches by Docker Compose project label first, then by container name/image match. You don't need to type exact container names — typing the compose project name finds all services automatically.

> **Prometheus URL:** Use `host.docker.internal` instead of `localhost` — e.g. `http://host.docker.internal:9091`. Inside Docker, `localhost` refers to the container, not your machine.

### Kubernetes mode

| Field | What to enter |
|---|---|
| Application name | Any label for this cluster |
| Platform | `Kubernetes` |
| Namespace | Your deployment namespace (default: `default`) |
| Prometheus URL | Optional — your cluster's Prometheus endpoint |

**Required:** Mount your kubeconfig into both containers. Uncomment these lines in `docker-compose.hub.yml`:

```yaml
# In both backtrack-dashboard and backtrack-agent services:
volumes:
  - ~/.kube:/root/.kube:ro
```

Then restart:

```bash
docker compose -f docker-compose.hub.yml down
docker compose -f docker-compose.hub.yml up -d
```

> **Important:** Your kubeconfig must use a cluster address reachable from inside Docker — not `127.0.0.1` or `localhost`. Use the actual cluster IP or hostname. Check with:
> ```bash
> kubectl cluster-info
> ```
> If it shows `127.0.0.1`, you need to use the container/node IP instead.

> **Kubernetes TSD metrics** require `metrics-server` to be installed in your cluster. Without it, CPU/memory will show as 0 but anomaly detection via logs (LSI) still works. Install with:
> ```bash
> kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
> ```

Click **Test Connection** first to confirm services are found, then **Connect**.

---

## Step 5 — Verify Everything Works

After connecting:

| What to check | Where |
|---|---|
| Services listed | Dashboard → Active Containers |
| CPU/Memory data | Dashboard → Container Health charts (appears within 10s) |
| Agent online | Anomalies page → green "Agent Online" badge |
| TSD metrics | Anomalies page → service detail → TSD tab (needs ~2 min) |
| LSI log analysis | Anomalies page → service detail → LSI tab (fills from log history immediately) |

---

## Optional — GitHub Token

To enable the deployment history panel, add your token to `docker-compose.hub.yml`:

```yaml
environment:
  - GITHUB_TOKEN=ghp_your_token_here
```

Then restart: `docker compose -f docker-compose.hub.yml up -d`

---

## Updating to the Latest Version

```bash
docker compose -f docker-compose.hub.yml pull
docker compose -f docker-compose.hub.yml down
docker compose -f docker-compose.hub.yml up -d
```

---

## Troubleshooting

| Issue | Fix |
|---|---|
| `Agent Offline` badge | Check agent logs: `docker compose -f docker-compose.hub.yml logs backtrack-agent` |
| No services found | Verify containers are running: `docker ps`. Make sure app name matches compose project name or container name. |
| CPU/Memory shows 0 (Docker) | Docker socket not accessible. Check: `docker compose -f docker-compose.hub.yml exec backtrack-agent docker ps` |
| CPU/Memory shows 0 (Kubernetes) | `metrics-server` not installed. LSI log analysis still works. |
| Prometheus URL not working | Use `http://host.docker.internal:<port>` not `http://localhost:<port>` |
| Kubeconfig errors | Ensure kubeconfig uses a non-localhost cluster address. Mount: `~/.kube:/root/.kube:ro` |
| `Permission denied` on docker.sock | Add your user to the docker group: `sudo usermod -aG docker $USER` then log out and back in |
| Agent container unhealthy | Usually a slow start — wait 30s. Check: `docker compose -f docker-compose.hub.yml logs backtrack-agent \| tail -20` |
| Only one connection per platform | By design — connecting a new Docker app replaces the previous Docker connection. Each platform keeps one active cluster. |

---

### Dashboard port confusion (3847 vs 3000)

If the dashboard doesn't open at `http://localhost:3847` and you see references to port `3000`, it's usually because you're running the Next.js dev server (which defaults to `3000`) instead of the production image, or a stale container/image is listening on a different port.

Quick checks:

```bash
docker compose -f docker-compose.hub.yml ps
docker compose -f docker-compose.hub.yml logs backtrack-dashboard --tail 100
```

If running from source, start the dev server on `3847` explicitly:

```bash
PORT=3847 npm run dev
```

To force a fresh production image from Docker Hub:

```bash
docker compose -f docker-compose.hub.yml down
docker compose -f docker-compose.hub.yml pull
docker compose -f docker-compose.hub.yml up -d --force-recreate --build
```

Do not set `PORT=3000` for the production image; BackTrack production uses port `3847`.

## Useful Endpoints

```bash
# Agent health + monitored services
curl http://localhost:8847/health
curl http://localhost:8847/services

# Rollback history
curl http://localhost:8847/rollback/history
```

---

## Support

- **GitHub Issues**: https://github.com/KenMarzan/BackTrack/issues
