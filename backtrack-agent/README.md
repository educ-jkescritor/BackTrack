# Backtrack

**Backtrack detects and automatically rolls back production runtime errors within 5 minutes of deployment.** It works as a sidecar container that monitors any containerized application — zero code changes required.

## How It Works

### TSD — Time Series Decomposition

Backtrack scrapes CPU, memory, latency, and error rate metrics every 10 seconds. It uses **STL (Seasonal-Trend decomposition using LOESS)** from `statsmodels` to break each metric time series into trend, seasonal, and residual components. The residual component is the anomaly signal — a spike after a new deploy means the metric is behaving in a way that cannot be explained by any known pattern. An anomaly is flagged when the residual exceeds 3× the interquartile range of the baseline distribution for 3 consecutive readings.

### LSI — Latent Semantic Indexing

Backtrack tails container logs in real time and builds a **TF-IDF term-document matrix** from the log corpus. It applies **TruncatedSVD** (Singular Value Decomposition) to find latent semantic topics, then classifies each log line as INFO, WARN, ERROR, or NOVEL by cosine similarity to seed centroids. NOVEL means the log line doesn't match any known pattern — a strong signal for new, unseen error types. An LSI anomaly score is computed per 30-second window; if it exceeds 2× the baseline mean, it's flagged.

When **both TSD and LSI** detect anomalies for 3 consecutive cycles, Backtrack automatically rolls back to the last known stable version.

## Prerequisites

- **Docker 24+** and **docker compose v2**, OR
- **kubectl** with cluster access (Kubernetes mode)

## Setup — Docker Compose (3 steps)

1. Copy `docker-compose.with-backtrack.yml` into your project
2. Set these env vars in your `.env`:
   ```
   BACKTRACK_TARGET=your-service-name
   BACKTRACK_IMAGE_TAG=$(git rev-parse --short HEAD)
   ```
3. Run:
   ```bash
   docker compose -f docker-compose.with-backtrack.yml up -d
   ```

## Setup — Kubernetes (3 steps)

1. Apply the sidecar manifest:
   ```bash
   kubectl apply -f k8s/backtrack-sidecar.yaml
   ```
2. Set the label selector:
   ```
   BACKTRACK_K8S_LABEL_SELECTOR=app=your-app
   ```
3. Verify:
   ```bash
   curl http://<pod-ip>:8847/health
   ```

## Dashboard

Open **http://localhost:3847** for the real-time dashboard with:
- `/dashboard` — TSD metric cards with residual sparklines
- `/logs` — LSI score chart + live classified log feed
- `/versions` — Snapshot history + rollback log

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BACKTRACK_TARGET` | *(required)* | Docker container name to monitor |
| `BACKTRACK_IMAGE_TAG` | `unknown` | Current deployed image tag (set by CI) |
| `BACKTRACK_K8S_NAMESPACE` | `default` | Kubernetes namespace |
| `BACKTRACK_K8S_LABEL_SELECTOR` | *(empty)* | K8s label selector (e.g. `app=myapp`) |
| `BACKTRACK_SCRAPE_INTERVAL` | `10` | Metrics scrape interval (seconds) |
| `BACKTRACK_TSD_IQR_MULTIPLIER` | `3.0` | TSD anomaly sensitivity (lower = more sensitive) |
| `BACKTRACK_LSI_SCORE_MULTIPLIER` | `2.0` | LSI anomaly sensitivity |
| `BACKTRACK_ROLLBACK_ENABLED` | `true` | Enable/disable automatic rollback |

## Troubleshooting

1. **Agent not starting**: Check that `/var/run/docker.sock` is mounted (Docker mode) or K8s service account token is available.
2. **No metrics data**: Ensure `BACKTRACK_TARGET` matches your container name exactly. Run `docker ps` to verify.
3. **LSI not fitting**: The classifier needs 200 log lines before fitting. Wait for the container to produce enough logs.
4. **False rollbacks**: Increase `BACKTRACK_TSD_IQR_MULTIPLIER` (e.g. to 4.0) to reduce sensitivity.
5. **Rollback not triggering**: Verify `BACKTRACK_ROLLBACK_ENABLED=true` and that at least one STABLE snapshot exists (requires 10 minutes of clean operation).

## API Endpoints

| Endpoint | Method | Returns |
|----------|--------|---------|
| `/health` | GET | Status, mode, uptime |
| `/config` | GET | All active configuration values |
| `/metrics` | GET | TSD readings, residuals, drift status |
| `/lsi` | GET | LSI score, window counts, anomaly status |
| `/versions` | GET | Version snapshots (newest first) |
| `/rollback/history` | GET | Rollback event log |
| `/rollback/trigger` | POST | Manually trigger rollback |
