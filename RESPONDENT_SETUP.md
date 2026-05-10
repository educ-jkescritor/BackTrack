# BackTrack — Respondent Setup Guide

Two ways to run BackTrack: **Docker Hub** (recommended, no setup) or **from GitHub source**.

---

## Option A — Docker Hub (Recommended)

No Node.js, Python, or build tools required. Just Docker.

### Prerequisites

- Docker + Docker Compose installed
- Your application is already running

### 1. Download compose file

```bash
mkdir backtrack && cd backtrack
curl -O https://raw.githubusercontent.com/KenMarzan/BackTrack/main/docker-compose.hub.yml
```

### 2. Start BackTrack

```bash
docker compose -f docker-compose.hub.yml up -d
```

### 3. Open dashboard

```
http://localhost:3847
```

### 4. Connect your application

Click **Configure Cluster** (top-right) and fill in:

**Docker mode:**

| Field | Value |
|---|---|
| Application name | Your Docker Compose project name or container name |
| Platform | `Docker` |
| Architecture | `Microservices` or `Monolith` |
| Prometheus URL | Optional — `http://host.docker.internal:<port>` |

**Kubernetes mode:**

| Field | Value |
|---|---|
| Application name | Any label |
| Platform | `Kubernetes` |
| Namespace | Your namespace (e.g. `default`) |

For Kubernetes, first uncomment the kubeconfig mount in `docker-compose.hub.yml`:
```yaml
# In both services, uncomment:
- ~/.kube:/root/.kube:ro
```
Then restart: `docker compose -f docker-compose.hub.yml down && docker compose -f docker-compose.hub.yml up -d`

> **Note:** Kubeconfig must use a cluster address reachable from inside Docker — not `127.0.0.1`. Check `kubectl cluster-info` and use the actual IP.

Click **Test Connection** → confirm services appear → **Connect**.

---

## Option B — From GitHub Source

### Prerequisites

| Tool | Version |
|---|---|
| Node.js | 20+ |
| Python | 3.10+ |
| Docker CLI | any (for Docker mode) |
| kubectl | any (for Kubernetes mode) |

### 1. Clone

```bash
git clone https://github.com/KenMarzan/BackTrack.git
cd BackTrack
```

### 2. Start the dashboard

```bash
cd backtrack-dashboard
npm install
npm run dev
```

Open **http://localhost:3847**

### 3. Start the agent

Open a second terminal:

```bash
cd BackTrack/backtrack-agent
python3 -m venv .venv
source .venv/bin/activate       # Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn src.main:app --host 0.0.0.0 --port 8847
```

Keep this terminal open — agent must stay running.

### 4. Connect your application

Same as Option A Step 4 — click **Configure Cluster** in the dashboard.

---

## Verification Checklist

| Check | Where | Expected |
|---|---|---|
| Dashboard loads | http://localhost:3847 | BackTrack UI visible |
| Services appear | Dashboard → Active Containers | Your app's containers listed |
| CPU/Memory data | Dashboard → Container Health | Numbers populate within 10s |
| Agent online | Anomalies page | Green "Agent Online" badge |
| TSD metrics | Anomalies → service → TSD tab | Data after ~2 min |
| LSI log stream | Anomalies → service → LSI tab | Corpus fills quickly from log history |

---

## Anomaly Detection Timing

| Milestone | Time |
|---|---|
| CPU/Memory metrics | ~10 seconds |
| LSI corpus builds | Seconds (loads from log history) |
| TSD drift detection ready | ~2 minutes (12 readings) |
| LSI classification active | ~2–3 minutes (after corpus fits) |
| Version marked STABLE | 10 minutes of clean operation |
| Auto-rollback triggers | 3 consecutive anomaly cycles (~30–90s) |

---

## Troubleshooting

**No services found after connecting**
- Docker: `docker ps` — confirm containers are running
- Make sure app name matches the Docker Compose project name or a container name
- Kubernetes: `kubectl get pods -n <namespace>` — confirm pods exist

**Agent Offline badge**
- Source install: confirm agent terminal is still running on port 8847
- Hub install: `docker compose -f docker-compose.hub.yml logs backtrack-agent`
- Test: `curl http://localhost:8847/health`

**CPU/Memory shows 0 (Docker mode)**
- Hub install: Docker socket not accessible in container — check `docker compose -f docker-compose.hub.yml exec backtrack-agent docker ps`
- Source install: Docker CLI must be in PATH — `which docker`

**CPU/Memory shows 0 (Kubernetes mode)**
- `metrics-server` not installed in cluster — log analysis (LSI) still works without it
- Install: `kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml`

**Prometheus URL not working (Hub install)**
- Use `http://host.docker.internal:<port>` not `http://localhost:<port>`

**TSD/LSI panels empty after 5+ minutes**
- Source: verify agent is running — check the terminal
- Both: verify Configure Cluster was clicked and showed discovered services
- Check: `curl http://localhost:8847/services`

**Rollback not triggering**
- Check `BACKTRACK_ROLLBACK_ENABLED` is not `false`
- Both TSD drift AND LSI anomaly must occur for 3 consecutive cycles
- View history: `curl http://localhost:8847/rollback/history`
