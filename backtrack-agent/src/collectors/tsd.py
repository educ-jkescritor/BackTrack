"""
TSD Collector — Time Series Decomposition using STL (Seasonal-Trend decomposition using LOESS).

Scrapes CPU %, memory MB, HTTP latency ms, HTTP error rate % every scrape_interval seconds.
Uses Docker SDK stats API (Docker mode) or Kubernetes metrics API (K8s mode).
Stores rolling deque of last 36 readings (6 minutes at 10s intervals).
After 12 readings, runs STL decomposition on each metric series.
Detects anomalies when residual > 3×IQR for 3 consecutive readings.
"""
import asyncio
import collections
import logging
import os
import time
from typing import Optional

import numpy as np

from src.config import config
from src.collectors.k8s_pod_cache import pod_cache

logger = logging.getLogger("backtrack.tsd")

# Increased to 1 hour of data — STL requires meaningful seasonal data.
# With scrape_interval=10s: 360 readings = 60 minutes.
DEQUE_SIZE = int(os.getenv("BACKTRACK_DEQUE_SIZE", "360"))
# STL warmup: default 12 for backward compatibility; set BACKTRACK_STL_MIN_READINGS=60
# in production for statistically valid decomposition (10× STL_PERIOD).
MIN_READINGS_FOR_STL = int(os.getenv("BACKTRACK_STL_MIN_READINGS", "12"))
# STL period: 36 = 6-minute seasonality at 10s intervals (e.g., health-check cycle).
STL_PERIOD = int(os.getenv("BACKTRACK_STL_PERIOD", "36"))

# Per-metric trend slope thresholds — dimensionally correct per metric unit.
TREND_THRESHOLDS: dict[str, float] = {
    "cpu":        float(os.getenv("BACKTRACK_TREND_CPU",        "0.5")),   # % per reading
    "memory":     float(os.getenv("BACKTRACK_TREND_MEMORY",     "2.0")),   # MB per reading
    "latency":    float(os.getenv("BACKTRACK_TREND_LATENCY",    "10.0")),  # ms per reading
    "error_rate": float(os.getenv("BACKTRACK_TREND_ERROR_RATE", "0.1")),   # % per reading
}

# ── Shared Docker stats cache ────────────────────────────────────────────────
# One `docker stats --no-stream` call serves all TSDCollectors instead of N calls.
_stats_cache: dict[str, dict[str, float]] = {}  # name → {cpu, mem_mb}
_stats_cache_at: float = 0.0
_stats_refresh_lock: Optional[asyncio.Lock] = None
_monitored_containers: set[str] = set()  # only stats these names, not all containers

_cluster_cpu_cores: float = 0.0  # total allocatable CPU cores across all nodes
_cluster_cpu_fetched_at: float = 0.0


async def _refresh_cluster_cpu() -> float:
    """Return total allocatable CPU cores across all nodes (cached for 5 minutes)."""
    global _cluster_cpu_cores, _cluster_cpu_fetched_at
    now = time.monotonic()
    if _cluster_cpu_cores > 0 and now - _cluster_cpu_fetched_at < 300:
        return _cluster_cpu_cores
    try:
        proc = await asyncio.create_subprocess_exec(
            "kubectl", "get", "nodes",
            "-o", "jsonpath={range .items[*]}{.status.allocatable.cpu}{'\\n'}{end}",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=10)
        if proc.returncode == 0:
            total = 0.0
            for line in stdout.decode().strip().splitlines():
                line = line.strip()
                if not line:
                    continue
                if line.endswith("m"):
                    total += float(line[:-1]) / 1000.0
                else:
                    try:
                        total += float(line)
                    except ValueError:
                        pass
            if total > 0:
                _cluster_cpu_cores = total
                _cluster_cpu_fetched_at = now
    except Exception:
        pass
    return _cluster_cpu_cores if _cluster_cpu_cores > 0 else 1.0


def _get_stats_lock() -> asyncio.Lock:
    global _stats_refresh_lock
    if _stats_refresh_lock is None:
        _stats_refresh_lock = asyncio.Lock()
    return _stats_refresh_lock


async def _refresh_docker_stats(max_age: float = 5.0) -> None:
    """Refresh the shared stats cache (at most once per max_age seconds)."""
    global _stats_cache, _stats_cache_at
    now = time.monotonic()
    if now - _stats_cache_at < max_age:
        return
    async with _get_stats_lock():
        if time.monotonic() - _stats_cache_at < max_age:
            return  # another coroutine refreshed while we waited
        try:
            # Only stat the containers we're actually monitoring — avoids scanning
            # every container on the host which is slow when many are running.
            targets = list(_monitored_containers)
            cmd = ["docker", "stats", "--no-stream", "--format",
                   "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}"] + targets
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=15)
            if proc.returncode == 0:
                cache: dict[str, dict[str, float]] = {}
                for line in stdout.decode().strip().splitlines():
                    parts = line.split("\t")
                    if len(parts) < 3:
                        continue
                    name = parts[0].strip()
                    try:
                        cpu = float(parts[1].replace("%", "").strip())
                    except ValueError:
                        cpu = 0.0
                    mem_str = parts[2].split("/")[0].strip()
                    cache[name] = {"cpu": cpu, "mem_mb": _parse_mem_to_mb(mem_str)}
                _stats_cache = cache
                _stats_cache_at = time.monotonic()
        except Exception:
            logger.warning("docker stats refresh failed")


def _parse_mem_to_mb(raw: str) -> float:
    raw = raw.strip()
    for suffix, factor in (
        ("GiB", 1024.0), ("MiB", 1.0), ("kB", 1 / 1024.0),
        ("MB", 1.0), ("GB", 1024.0), ("KB", 1 / 1024.0), ("B", 1 / 1048576.0),
    ):
        if raw.endswith(suffix):
            try:
                return float(raw[: -len(suffix)]) * factor
            except ValueError:
                return 0.0
    try:
        return float(raw) / 1048576.0
    except ValueError:
        return 0.0


class TSDCollector:
    """Collects metrics and runs STL decomposition to detect anomalies."""

    def __init__(self, service_name: str = "", label_selector: str = "") -> None:
        self.service_name = service_name or config.target
        self.label_selector = label_selector or config.k8s_label_selector

        self.cpu_history: collections.deque[float] = collections.deque(maxlen=DEQUE_SIZE)
        self.memory_history: collections.deque[float] = collections.deque(maxlen=DEQUE_SIZE)
        self.latency_history: collections.deque[float] = collections.deque(maxlen=DEQUE_SIZE)
        self.error_rate_history: collections.deque[float] = collections.deque(maxlen=DEQUE_SIZE)

        self.current_cpu: float = 0.0
        self.current_memory: float = 0.0
        self.current_latency: float = 0.0
        self.current_error_rate: float = 0.0

        self.residuals: dict[str, list[float]] = {
            "cpu": [], "memory": [], "latency": [], "error_rate": [],
        }
        self.seasonal: dict[str, list[float]] = {
            "cpu": [], "memory": [], "latency": [], "error_rate": [],
        }
        self.trend: dict[str, list[float]] = {
            "cpu": [], "memory": [], "latency": [], "error_rate": [],
        }

        self._total_readings: int = 0  # unbounded scrape counter for TN estimation

        # Drift event tracking for precision/recall estimation
        # sustained_drift = drift that persisted 3+ consecutive cycles (confirmed signal)
        # spike_drift = drift that appeared then resolved in <3 cycles (likely noise)
        self._drift_events_total: int = 0
        self._drift_sustained: int = 0   # confirmed: 3+ consecutive anomaly cycles
        self._drift_consecutive: int = 0  # current run length
        self._per_metric_drifts: dict[str, int] = {
            "cpu": 0, "memory": 0, "latency": 0, "error_rate": 0, "restarts": 0,
        }

        # Container restart / crash tracking
        self._last_restart_count: int = -1   # -1 = not yet fetched
        self._restart_increased: bool = False  # True for one scrape cycle after a restart
        self._last_exit_code: int = 0
        self._last_container_status: str = ""  # running / exited / restarting / etc.

        # Modified Z-score analysis (per-metric, updated each decomposition cycle)
        self.z_scores: dict[str, float] = {
            "cpu": 0.0, "memory": 0.0, "latency": 0.0, "error_rate": 0.0,
        }
        self.trend_directions: dict[str, str] = {
            "cpu": "UNKNOWN", "memory": "UNKNOWN", "latency": "UNKNOWN", "error_rate": "UNKNOWN",
        }
        self.tsd_confidence: float = 0.0
        self.tsd_status: dict[str, str] = {
            "cpu": "INSUFFICIENT_DATA", "memory": "INSUFFICIENT_DATA",
            "latency": "INSUFFICIENT_DATA", "error_rate": "INSUFFICIENT_DATA",
        }

        self._running = False
        self._task: Optional[asyncio.Task] = None
        self._docker_client = None  # reused across scrapes to avoid fd leak
        self._http_session: Optional["aiohttp.ClientSession"] = None  # persistent latency probe session

        # Cached drift result — separates mutation (collect loop) from query (HTTP handlers).
        # is_drifting() reads this; _update_drift_state() writes it.
        # None = collect loop has not run yet; fall back to computing on demand.
        self._cached_drifting: Optional[bool] = None

    async def start(self) -> None:
        """Start the background collection loop."""
        self._running = True
        _monitored_containers.add(self.service_name)
        self._task = asyncio.create_task(self._collect_loop())
        logger.info("TSD collector started for %s (interval=%ds)", self.service_name, config.scrape_interval)

    def reset(self) -> None:
        """Clear all accumulated history after a rollback so the collector re-baselines cleanly."""
        self.cpu_history.clear()
        self.memory_history.clear()
        self.latency_history.clear()
        self.error_rate_history.clear()
        for d in (self.residuals, self.seasonal, self.trend):
            for k in d:
                d[k] = []
        self.z_scores = {k: 0.0 for k in self.z_scores}
        self.trend_directions = {k: "UNKNOWN" for k in self.trend_directions}
        self.tsd_confidence = 0.0
        self.tsd_status = {k: "INSUFFICIENT_DATA" for k in self.tsd_status}
        self._drift_consecutive = 0
        self._cached_drifting = None
        self._restart_increased = False
        self._last_restart_count = -1
        logger.info("TSD collector reset for %s after rollback", self.service_name)

    async def stop(self) -> None:
        """Stop the background collection loop."""
        self._running = False
        _monitored_containers.discard(self.service_name)
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        if self._http_session and not self._http_session.closed:
            await self._http_session.close()
        logger.info("TSD collector stopped.")

    async def _collect_loop(self) -> None:
        """Main scrape loop — runs every scrape_interval seconds."""
        while self._running:
            try:
                await self._scrape()
                await self._check_restarts()
                self._total_readings += 1
                n = len(self.cpu_history)
                if n >= MIN_READINGS_FOR_STL:
                    self._decompose()
                elif n >= 4:
                    # EWMA anomaly check during warmup — no STL minimum required
                    self._ewma_anomaly_check()
                # Update cached drift state — ONLY from the collect loop, never from HTTP handlers
                self._cached_drifting = self._update_drift_state()
            except Exception:
                logger.exception("Error in TSD collect loop")
            await asyncio.sleep(config.scrape_interval)

    async def _scrape(self) -> None:
        """Scrape metrics from Docker or Kubernetes."""
        if config.mode == "docker":
            await self._scrape_docker()
        else:
            await self._scrape_kubernetes()

    async def _scrape_docker(self) -> None:
        """Read from the shared docker stats cache (one CLI call serves all collectors)."""
        await _refresh_docker_stats(max_age=config.scrape_interval * 0.8)
        entry = _stats_cache.get(self.service_name, {})
        self.current_cpu = entry.get("cpu", 0.0)
        self.current_memory = entry.get("mem_mb", 0.0)
        self.current_latency = await self._probe_latency()
        # Error rate derived from latency probe result: 100% if probe failed (service unreachable),
        # 0% if probe succeeded. More nuanced than a flat zero.
        self.current_error_rate = 100.0 if self.current_latency == 0.0 else 0.0

        self.cpu_history.append(self.current_cpu)
        self.memory_history.append(self.current_memory)
        self.latency_history.append(self.current_latency)
        self.error_rate_history.append(self.current_error_rate)

    async def _scrape_kubernetes(self) -> None:
        """Scrape metrics using kubectl top pods. Match by service name in pod name
        rather than relying on label selectors which may not match exactly."""
        try:
            # When pod cache is available, check pod existence before running kubectl top.
            if pod_cache.available:
                cached_pods = pod_cache.get_pods_for_service(
                    self.service_name, config.k8s_namespace
                )
                if not cached_pods:
                    self.current_cpu = 0.0
                    self.current_memory = 0.0
                    self.current_latency = await self._probe_latency()
                    self.current_error_rate = 100.0 if self.current_latency == 0.0 else 0.0
                    self.cpu_history.append(self.current_cpu)
                    self.memory_history.append(self.current_memory)
                    self.latency_history.append(self.current_latency)
                    self.error_rate_history.append(self.current_error_rate)
                    return
                allowed_pods = {p.lower() for p in cached_pods}
            else:
                allowed_pods = None

            # Fetch ALL pod metrics in the namespace, then filter by name match.
            # This is more robust than -l <selector> because:
            #  - Online Boutique-style pods may use multiple labels (app, app.kubernetes.io/name)
            #  - Selector mismatch silently returns nothing, hiding the issue
            proc = await asyncio.create_subprocess_exec(
                "kubectl", "top", "pods",
                "-n", config.k8s_namespace,
                "--no-headers",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=10)
            if proc.returncode != 0:
                err = stderr.decode("utf-8", errors="replace").strip() if stderr else "no output"
                logger.warning(
                    "kubectl top failed for %s (rc=%d): %s — install metrics-server in your cluster",
                    self.service_name, proc.returncode, err[:300],
                )
            lines = stdout.decode().strip().splitlines()

            # Match pods: prefer exact prefix (frontend-7bc9d) over substring (internal-frontend).
            needle = self.service_name.lower().replace(".", "-")
            total_cpu = 0.0
            total_mem = 0.0
            count = 0
            for line in lines:
                parts = line.split()
                if len(parts) < 3:
                    continue
                pod_name = parts[0].lower()
                # When cache is available, only count pods confirmed running by cache.
                if allowed_pods is not None:
                    if pod_name not in allowed_pods:
                        continue
                else:
                    # Exact prefix match prevents "api" matching "internal-api"
                    is_match = (pod_name == needle
                                or pod_name.startswith(needle + "-")
                                or (needle in pod_name))
                    if not is_match:
                        continue
                # CPU is like "25m" (millicores) or "0"
                cpu_str = parts[1].rstrip("m")
                cpu_val = float(cpu_str) / 1000.0 if "m" in parts[1] else float(cpu_str)
                # Memory is like "128Mi" or "64Ki"
                mem_str = parts[2]
                if mem_str.endswith("Mi"):
                    mem_val = float(mem_str[:-2])
                elif mem_str.endswith("Ki"):
                    mem_val = float(mem_str[:-2]) / 1024.0
                elif mem_str.endswith("Gi"):
                    mem_val = float(mem_str[:-2]) * 1024.0
                else:
                    mem_val = float(mem_str) / (1024 * 1024)
                total_cpu += cpu_val
                total_mem += mem_val
                count += 1

            if count > 0:
                cluster_cores = await _refresh_cluster_cpu()
                self.current_cpu = (total_cpu / cluster_cores) * 100.0
            else:
                self.current_cpu = 0.0
            self.current_memory = total_mem if count > 0 else 0.0
            self.current_latency = await self._probe_latency()
            self.current_error_rate = 100.0 if self.current_latency == 0.0 else 0.0

        except Exception as exc:
            logger.warning("K8s metrics scrape failed for %s: %s", self.service_name, exc)
            self.current_cpu = 0.0
            self.current_memory = 0.0
            self.current_latency = 0.0
            self.current_error_rate = 100.0  # scrape failure = service unreachable

        self.cpu_history.append(self.current_cpu)
        self.memory_history.append(self.current_memory)
        self.latency_history.append(self.current_latency)
        self.error_rate_history.append(self.current_error_rate)

    async def _get_http_session(self) -> "aiohttp.ClientSession":
        """Return a persistent aiohttp session, creating one if needed."""
        import aiohttp
        if self._http_session is None or self._http_session.closed:
            # 2s timeout — if service doesn't respond in 2s, latency = 0 and we move on.
            # Sequential 5s probes across 3 URLs was worst-case 15s, exceeding scrape_interval.
            self._http_session = aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=2)
            )
        return self._http_session

    async def _probe_latency(self) -> float:
        """Time a request to the target's health endpoint (ms).

        Probes three candidate URLs in parallel rather than sequentially,
        returns the latency of the first successful response.
        """
        import asyncio as _aio
        urls = [
            f"http://{self.service_name}:8080/health",
            f"http://{self.service_name}:8080/",
            f"http://{self.service_name}:80/",
        ]
        session = await self._get_http_session()

        async def _try(url: str) -> float:
            try:
                t0 = time.monotonic()
                async with session.get(url) as resp:
                    await resp.read()
                return (time.monotonic() - t0) * 1000.0
            except Exception:
                return 0.0

        results = await _aio.gather(*[_try(u) for u in urls], return_exceptions=False)
        for r in results:
            if isinstance(r, float) and r > 0:
                return r
        return 0.0

    async def _check_restarts(self) -> None:
        """Check container restart count and exit code each scrape cycle."""
        if config.mode == "docker":
            await self._check_docker_restarts()
        else:
            await self._check_k8s_restarts()

    async def _check_docker_restarts(self) -> None:
        try:
            proc = await asyncio.create_subprocess_exec(
                "docker", "inspect", "--format",
                "{{.RestartCount}} {{.State.ExitCode}} {{.State.Status}}",
                self.service_name,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=5)
            if proc.returncode != 0:
                self._restart_increased = False
                return
            parts = stdout.decode().strip().split()
            if len(parts) < 2:
                self._restart_increased = False
                return
            restart_count = int(parts[0])
            exit_code = int(parts[1])
            status = parts[2] if len(parts) > 2 else ""
            crash_detected = False

            # Case 1: restart count increased (restart policy = on-failure / always)
            if self._last_restart_count >= 0 and restart_count > self._last_restart_count:
                logger.warning(
                    "CRASH DETECTED on %s: restarts %d→%d exit_code=%d",
                    self.service_name, self._last_restart_count, restart_count, exit_code,
                )
                crash_detected = True

            # Case 2: container transitioned from running → exited with non-zero exit code
            if (self._last_container_status == "running"
                    and status in ("exited", "dead")
                    and exit_code != 0):
                logger.warning(
                    "CRASH DETECTED on %s: status running→%s exit_code=%d",
                    self.service_name, status, exit_code,
                )
                crash_detected = True

            if crash_detected:
                self._restart_increased = True
                self._per_metric_drifts["restarts"] += 1
            else:
                self._restart_increased = False

            self._last_restart_count = restart_count
            self._last_exit_code = exit_code
            self._last_container_status = status
        except Exception:
            self._restart_increased = False

    async def _check_k8s_restarts(self) -> None:
        try:
            selector = self.label_selector or f"app={self.service_name}"
            proc = await asyncio.create_subprocess_exec(
                "kubectl", "get", "pods",
                "-n", config.k8s_namespace,
                "-l", selector,
                "-o", "jsonpath={range .items[*]}{range .status.containerStatuses[*]}"
                      "{.restartCount}{' '}{.lastState.terminated.exitCode}{'\\n'}{end}{end}",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=10)
            if proc.returncode != 0:
                self._restart_increased = False
                return
            total_restarts = 0
            last_exit = 0
            for line in stdout.decode().strip().splitlines():
                parts = line.strip().split()
                if parts:
                    try:
                        total_restarts += int(parts[0])
                        if len(parts) > 1 and parts[1].lstrip("-").isdigit():
                            last_exit = int(parts[1])
                    except ValueError:
                        pass
            if self._last_restart_count >= 0 and total_restarts > self._last_restart_count:
                logger.warning(
                    "CRASH DETECTED on %s: restarts %d→%d exit_code=%d",
                    self.service_name, self._last_restart_count, total_restarts, last_exit,
                )
                self._restart_increased = True
                self._per_metric_drifts["restarts"] += 1
                self._last_exit_code = last_exit
            else:
                self._restart_increased = False
            self._last_restart_count = total_restarts
        except Exception:
            self._restart_increased = False

    def has_crashed(self) -> bool:
        """True for one scrape cycle after restart count increases — triggers immediate rollback."""
        return self._restart_increased

    def _ewma_anomaly_check(self) -> None:
        """EWMA-based anomaly detection used during STL warmup period (< MIN_READINGS_FOR_STL).

        Stores synthetic residuals so _update_drift_state residual path can run unchanged.
        EWMA needs only 4 readings — no minimum season requirement.
        """
        alpha = float(os.getenv("BACKTRACK_EWMA_ALPHA", "0.3"))
        metrics = {
            "cpu":        list(self.cpu_history),
            "memory":     list(self.memory_history),
            "latency":    list(self.latency_history),
            "error_rate": list(self.error_rate_history),
        }
        for name, series in metrics.items():
            if len(series) < 4:
                continue
            ewma = series[0]
            ewma_residuals = []
            for v in series:
                ewma = alpha * v + (1 - alpha) * ewma
                ewma_residuals.append(v - ewma)
            self.residuals[name] = ewma_residuals
            # Trend: difference of last two EWMA values
            self.trend[name] = [0.0] * len(series)

    def _decompose(self) -> None:
        """Run STL decomposition on each metric series."""
        from statsmodels.tsa.seasonal import STL

        # Convert deques to numpy arrays once; reuse across all metrics
        arrays: dict[str, np.ndarray] = {
            "cpu":        np.array(self.cpu_history),
            "memory":     np.array(self.memory_history),
            "latency":    np.array(self.latency_history),
            "error_rate": np.array(self.error_rate_history),
        }

        for name, arr in arrays.items():
            if len(arr) < MIN_READINGS_FOR_STL:
                continue
            try:
                if arr.std() < 1e-6:
                    # Constant/zero series — STL would produce trivially zero residuals.
                    # Skip the expensive LOESS fit and write zeros directly.
                    zeros = [0.0] * len(arr)
                    self.residuals[name] = zeros
                    self.seasonal[name] = zeros
                    self.trend[name] = arr.tolist()
                    continue
                result = STL(arr, period=STL_PERIOD, robust=True).fit()
                self.residuals[name] = result.resid.tolist()
                self.seasonal[name] = result.seasonal.tolist()
                self.trend[name] = result.trend.tolist()
            except Exception:
                logger.warning("STL decomposition failed for %s", name)

        self._compute_z_scores()

    def _compute_z_scores(self) -> None:
        """Compute modified Z-scores, trend directions, and confidence per metric."""
        Z_THRESHOLD = 3.0
        self.tsd_confidence = round(min(1.0, len(self.cpu_history) / DEQUE_SIZE), 4)

        for name in ("cpu", "memory", "latency", "error_rate"):
            residuals = self.residuals.get(name, [])
            trend = self.trend.get(name, [])

            if len(residuals) < MIN_READINGS_FOR_STL:
                self.tsd_status[name] = "INSUFFICIENT_DATA"
                continue

            arr = np.array(residuals)
            median_val = float(np.median(arr))
            mad = float(np.median(np.abs(arr - median_val)))
            mod_z = 0.6745 * (arr[-1] - median_val) / (mad if mad > 1e-6 else 1e-6)
            self.z_scores[name] = round(float(mod_z), 4)

            if abs(mod_z) > Z_THRESHOLD:
                self.tsd_status[name] = "ANOMALY"
            elif abs(mod_z) > Z_THRESHOLD * 0.7:
                self.tsd_status[name] = "WARNING"
            else:
                self.tsd_status[name] = "STABLE"

            # Trend direction — use metric-specific threshold, not a dimensionless 0.1
            if len(trend) >= 6:
                threshold = TREND_THRESHOLDS.get(name, 0.1)
                slope = (trend[-1] - trend[-6]) / 6
                if slope > threshold:
                    self.trend_directions[name] = "INCREASING"
                elif slope < -threshold:
                    self.trend_directions[name] = "DECREASING"
                else:
                    self.trend_directions[name] = "STABLE"

    def is_drifting(self) -> bool:
        """Return drift status.

        Returns the cached result from the last collect cycle when available
        (prevents double-counting counters from HTTP handler calls).
        Falls back to a stateless computation when the collect loop has not yet
        run — this path is used by unit tests that set residuals directly.
        """
        if self._cached_drifting is not None:
            return self._cached_drifting
        # Stateless fallback: compute without touching counters (read-only check)
        return self._compute_drift_now(mutate_counters=False)

    def _update_drift_state(self) -> bool:
        """Compute and cache drift detection result. Called only from _collect_loop.

        Delegates to _compute_drift_now with counter mutation enabled.
        """
        return self._compute_drift_now(mutate_counters=True)

    def _compute_drift_now(self, mutate_counters: bool = True) -> bool:
        """Core drift detection logic.

        mutate_counters=True: updates _drift_events_total etc. (used by collect loop).
        mutate_counters=False: read-only check for HTTP handlers and fallback path.
        """
        drifting_now = False
        # Local counter accumulator — only applied to self if mutate_counters=True
        _metric_hits: dict[str, int] = {k: 0 for k in self._per_metric_drifts}

        # Convert deques once; reused for raw-history check AND memory-leak check below
        cpu_series = list(self.cpu_history)
        mem_series = list(self.memory_history)

        # Raw-history anomaly detection: catches step changes that STL absorbs into trend.
        # Uses first half of the deque as the stable baseline (oldest = pre-fault readings).
        raw_histories: dict[str, list[float]] = {
            "cpu": cpu_series,
            "memory": mem_series,
        }
        for name, series in raw_histories.items():
            if len(series) < MIN_READINGS_FOR_STL:
                continue

            n = len(series)
            baseline_window = max(6, n // 2)
            baseline_series = series[:baseline_window]  # oldest readings = pre-fault
            recent = series[-3:]

            hist_mean = float(np.mean(baseline_series))
            hist_q1, hist_q3 = float(np.percentile(baseline_series, 25)), float(np.percentile(baseline_series, 75))
            hist_iqr = hist_q3 - hist_q1
            hist_std = float(np.std(baseline_series))
            spread = max(hist_iqr, hist_std, 0.01)

            # Flat-zero crash: was active, now near-zero
            if hist_mean > 1.0 and all(v < 0.01 for v in recent):
                logger.warning(
                    "TSD FLAT-ZERO DRIFT on %s: baseline_mean=%.2f dropped to near-zero %s",
                    name, hist_mean, [round(v, 4) for v in recent],
                )
                _metric_hits[name] = _metric_hits.get(name, 0) + 1
                drifting_now = True

            # Spike detection: recent readings are far above baseline (sustained step-up)
            spike_threshold = hist_mean + 5.0 * spread
            if spike_threshold > 0 and all(v > spike_threshold for v in recent):
                logger.warning(
                    "TSD SPIKE DRIFT on %s: baseline_mean=%.2f recent=%s threshold=%.2f",
                    name, hist_mean, [round(v, 2) for v in recent], spike_threshold,
                )
                _metric_hits[name] = _metric_hits.get(name, 0) + 1
                drifting_now = True

        # Memory leak: monotonically increasing for 6+ consecutive readings AND >15% above baseline
        if len(mem_series) >= 8:
            recent_mem = mem_series[-6:]
            if all(recent_mem[i] < recent_mem[i + 1] for i in range(len(recent_mem) - 1)):
                baseline_mem = float(np.mean(mem_series[:len(mem_series) // 2]))
                mem_growth = recent_mem[-1] - recent_mem[0]
                if baseline_mem > 1.0 and mem_growth / baseline_mem > 0.15:
                    logger.warning(
                        "TSD MEMORY LEAK on %s: monotonic growth %.1f→%.1f MB (+%.1f%% over 6 readings)",
                        self.service_name, recent_mem[0], recent_mem[-1],
                        100 * mem_growth / baseline_mem,
                    )
                    _metric_hits["memory"] = _metric_hits.get("memory", 0) + 1
                    drifting_now = True

        for name, residuals in self.residuals.items():
            if len(residuals) < 6:
                continue
            baseline = residuals[:-3]
            if len(baseline) < 3:
                continue
            q1, q3 = np.percentile(baseline, [25, 75])
            iqr = q3 - q1
            if iqr < 1e-6:
                continue
            threshold = config.tsd_iqr_multiplier * iqr
            last_three = residuals[-3:]
            if all(abs(r) > threshold for r in last_three):
                logger.warning(
                    "TSD DRIFT on %s: last 3 residuals %s exceed threshold %.4f",
                    name, [round(r, 4) for r in last_three], threshold,
                )
                _metric_hits[name] = _metric_hits.get(name, 0) + 1
                drifting_now = True

        if mutate_counters:
            for k, v in _metric_hits.items():
                self._per_metric_drifts[k] = self._per_metric_drifts.get(k, 0) + v

        if mutate_counters:
            if drifting_now:
                self._drift_consecutive += 1
                if self._drift_consecutive == 1:
                    self._drift_events_total += 1
                if self._drift_consecutive >= 3:
                    self._drift_sustained += 1
            else:
                self._drift_consecutive = 0

        return drifting_now

    def get_evaluation(self) -> dict:
        """Drift detection quality estimates (no ground truth — uses heuristics)."""
        total = self._drift_events_total
        sustained = self._drift_sustained
        spikes = max(0, total - sustained)
        est_precision = sustained / total if total > 0 else 0.0

        # TN estimated as scrape cycles where no drift was detected at all
        tn = max(0, self._total_readings - total)

        return {
            "drift_events_total": total,
            "drift_sustained": sustained,
            "drift_spikes": spikes,
            "total_readings": self._total_readings,
            "estimated_precision": round(est_precision, 4),
            "per_metric_drifts": dict(self._per_metric_drifts),
            "confusion_matrix": {
                "TP_sustained": sustained,
                "FP_spikes": spikes,
                "TN_clean_cycles": tn,
                "note": "FN unknown without fault injection ground truth",
            },
        }

    def get_metrics(self) -> dict:
        """Return current readings, STL decomposition, drift status for /metrics endpoint."""
        def _r(vals: list[float], n: int = 4) -> list[float]:
            return [round(v, n) for v in vals]

        # Map internal short keys → frontend field names
        key_map = {
            "cpu": "cpu_percent",
            "memory": "memory_mb",
            "latency": "latency_ms",
            "error_rate": "error_rate_percent",
        }

        decomposition: dict = {}
        for short, full in key_map.items():
            if self.residuals.get(short):
                decomposition[full] = {
                    "seasonal": _r(self.seasonal.get(short, [])),
                    "trend":    _r(self.trend.get(short, [])),
                    "residual": _r(self.residuals.get(short, [])),
                }

        return {
            "current": {
                "cpu_percent":        round(self.current_cpu, 3),
                "memory_mb":          round(self.current_memory, 2),
                "latency_ms":         round(self.current_latency, 2),
                "error_rate_percent": round(self.current_error_rate, 3),
            },
            "history": {
                "cpu":        _r(list(self.cpu_history), 3),
                "memory":     _r(list(self.memory_history), 2),
                "latency":    _r(list(self.latency_history), 2),
                "error_rate": _r(list(self.error_rate_history), 3),
            },
            "decomposition": decomposition,
            "residuals": {k: _r(v) for k, v in self.residuals.items()},
            "readings_count": len(self.cpu_history),
            "is_drifting": self.is_drifting(),
            "has_crashed": self.has_crashed(),
            "restart_count": self._last_restart_count,
            "last_exit_code": self._last_exit_code,
            "container_status": self._last_container_status,
            "z_scores": dict(self.z_scores),
            "trend_directions": dict(self.trend_directions),
            "tsd_confidence": self.tsd_confidence,
            "tsd_status": dict(self.tsd_status),
            "evaluation": self.get_evaluation(),
        }
