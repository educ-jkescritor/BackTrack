"""
LSI Collector — Latent Semantic Indexing using SVD on TF-IDF log vectors.

Tails container logs in real time using Docker SDK log stream.
Collects first 200 log lines as training corpus for SVD fit.
Builds TF-IDF term-document matrix, applies TruncatedSVD (K=50).
Classifies each log line as INFO / WARN / ERROR / NOVEL via cosine similarity.
Computes LSI anomaly score per 30-second window.
"""
import asyncio
import collections
import json
import logging
import os
import re
import time
from typing import Optional

import numpy as np
from sklearn.decomposition import TruncatedSVD
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity

from src.collectors.k8s_pod_cache import pod_cache
from src.config import config

logger = logging.getLogger("backtrack.lsi")

CORPUS_SIZE = int(os.getenv("BACKTRACK_CORPUS_SIZE", "200"))
WINDOW_SECONDS = int(os.getenv("BACKTRACK_WINDOW_SECONDS", "30"))
BASELINE_WINDOWS = int(os.getenv("BACKTRACK_BASELINE_WINDOWS", "10"))
# Error baseline locks faster than the full score baseline so faults are caught earlier.
# Default 3 windows = 90 s — enough to establish a pre-fault error-rate floor.
ERROR_BASELINE_WINDOWS = int(os.getenv("BACKTRACK_ERROR_BASELINE_WINDOWS", "3"))
SVD_SIMILARITY_THRESHOLD = float(os.getenv("BACKTRACK_SVD_SIMILARITY_THRESHOLD", "0.55"))

# Seed keywords for each log class
SEED_KEYWORDS = {
    "ERROR": ["error", "exception", "failed", "crash", "traceback", "fatal"],
    "WARN": ["warning", "deprecated", "slow", "retry", "timeout", "retrying"],
    "INFO": ["started", "ready", "connected", "success", "listening", "ok"],
}


class LSICollector:
    """Collects container logs, classifies them with SVD, and scores anomaly windows."""

    def __init__(self, service_name: str = "", label_selector: str = "") -> None:
        self.service_name = service_name or config.target
        self.label_selector = label_selector or config.k8s_label_selector
        self.vectorizer: Optional[TfidfVectorizer] = None
        self.svd: Optional[TruncatedSVD] = None
        self.centroids: dict[str, np.ndarray] = {}

        self.corpus: list[str] = []
        self.fitted = False

        # Current window tracking
        self.window_start: float = time.time()
        self.window_counts: dict[str, int] = {"INFO": 0, "WARN": 0, "ERROR": 0, "NOVEL": 0}
        self.window_total: int = 0

        # Bounded score history — prevents unbounded memory growth
        self.score_history: collections.deque[float] = collections.deque(maxlen=500)
        self.baseline_scores: list[float] = []
        self.baseline_locked = False

        # Error-only score history — used for rollback decisions (WARN/NOVEL are informational only)
        self.error_score_history: collections.deque[float] = collections.deque(maxlen=500)
        self.error_baseline_scores: list[float] = []
        self.error_baseline_locked = False

        # Re-fit counter — triggers vocabulary refresh every N windows
        self._windows_since_fit: int = 0

        # Recent classified lines for the /lsi endpoint
        self.recent_lines: collections.deque[dict] = collections.deque(maxlen=50)

        # Confusion matrix: keyword label (reference) vs SVD label (predicted)
        _classes = ["INFO", "WARN", "ERROR", "NOVEL"]
        self._confusion: dict[str, dict[str, int]] = {
            ref: {pred: 0 for pred in _classes} for ref in _classes
        }
        self._svd_classified_count: int = 0

        # Pre-normalised centroids — computed at fit time, used for fast dot-product cosine sim
        self._centroids_norm: dict[str, np.ndarray] = {}
        # Lines that need SVD classification, buffered per window for batch processing
        self._window_buffer: list[str] = []

        # Semantic analysis state (refreshed each window close)
        self.topics: list[dict] = []
        self.error_patterns: list[str] = []
        self.dominant_themes: list[str] = []
        self.log_diversity: str = "INSUFFICIENT"
        self.interpretation: str = ""

        self._running = False
        self._task: Optional[asyncio.Task] = None
        # Backpressure queue — tail tasks are producers, consumer is a separate task.
        # maxsize=1000: explicit drop policy under load rather than blocking the event loop.
        self._log_queue: asyncio.Queue[str] = asyncio.Queue(maxsize=1000)

    async def start(self) -> None:
        """Start the background log tailing loop."""
        self._running = True
        self._task = asyncio.create_task(self._tail_loop())
        asyncio.create_task(self._consume_log_queue())
        asyncio.create_task(self._partial_fit_watchdog())
        asyncio.create_task(self._window_timer())
        logger.info("LSI collector started for %s (mode=%s)", self.service_name, config.mode)

    async def _window_timer(self) -> None:
        """Close stale windows when no log lines arrive to trigger _close_window."""
        while self._running:
            await asyncio.sleep(WINDOW_SECONDS)
            if not self._running or not self.fitted:
                continue
            now = time.time()
            if now - self.window_start >= WINDOW_SECONDS:
                self._close_window()

    async def _partial_fit_watchdog(self) -> None:
        """Fit with whatever corpus we have after 120s if still not fitted.
        Handles sparse loggers (Prometheus, Grafana) that never reach CORPUS_SIZE."""
        await asyncio.sleep(120)
        if not self._running or self.fitted:
            return
        if len(self.corpus) >= 10:
            logger.info(
                "LSI partial fit for %s: corpus=%d lines (below target %d, fitting anyway)",
                self.service_name, len(self.corpus), CORPUS_SIZE,
            )
            self._fit()
        else:
            logger.warning(
                "LSI corpus too sparse for %s after 120s (%d lines) — skipping fit",
                self.service_name, len(self.corpus),
            )

    def reset(self) -> None:
        """Clear accumulated log state after a rollback so the model re-fits on fresh pod logs."""
        self.corpus = []
        self.fitted = False
        self.vectorizer = None
        self.svd = None
        self.centroids = {}
        self._centroids_norm = {}
        self.score_history.clear()
        self.baseline_scores = []
        self.baseline_locked = False
        self.error_score_history.clear()
        self.error_baseline_scores = []
        self.error_baseline_locked = False
        self.window_counts = {"INFO": 0, "WARN": 0, "ERROR": 0, "NOVEL": 0}
        self.window_total = 0
        self.window_start = time.time()
        self._window_buffer = []
        self.recent_lines.clear()
        self._windows_since_fit = 0
        logger.info("LSI collector reset for %s after rollback", self.service_name)

    async def stop(self) -> None:
        """Stop the background log tailing loop."""
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        logger.info("LSI collector stopped.")

    # ── Log normalization ────────────────────────────────────────────────────

    _UUID_RE = re.compile(
        r'\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b', re.I
    )
    _IP_RE   = re.compile(r'\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b')
    _TS_RE   = re.compile(r'\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?\b')
    _HEX_RE  = re.compile(r'\b0x[0-9a-fA-F]{4,}\b')
    _NUM_RE  = re.compile(r'\b\d{5,}\b')  # long numeric tokens (request IDs, port numbers)

    @classmethod
    def _normalize_line(cls, line: str) -> str:
        """Strip high-cardinality tokens before TF-IDF to reduce vocabulary noise."""
        line = cls._TS_RE.sub('TIMESTAMP', line)
        line = cls._UUID_RE.sub('UUID', line)
        line = cls._IP_RE.sub('IP', line)
        line = cls._HEX_RE.sub('HEX', line)
        line = cls._NUM_RE.sub('NUM', line)
        return line

    # ── Queue consumer ───────────────────────────────────────────────────────

    async def _consume_log_queue(self) -> None:
        """Drain the log queue and process each line. Separate from tail tasks."""
        while self._running:
            try:
                line = await asyncio.wait_for(self._log_queue.get(), timeout=5.0)
                await self._process_line(line)
                self._log_queue.task_done()
            except asyncio.TimeoutError:
                continue
            except Exception:
                logger.exception("Log queue consumer error for %s", self.service_name)

    async def _enqueue(self, line: str) -> None:
        """Put a line onto the queue; drop silently if full (backpressure)."""
        try:
            self._log_queue.put_nowait(line)
        except asyncio.QueueFull:
            pass  # explicit drop — better than blocking the tail coroutine

    async def _tail_loop(self) -> None:
        """Tail container logs and classify each line."""
        if config.mode == "docker":
            await self._tail_docker()
        else:
            await self._tail_kubernetes()

    async def _tail_docker(self) -> None:
        """Tail logs from Docker container using docker logs CLI (works with any socket location)."""
        # Step 1: snapshot existing log history to fill corpus fast
        try:
            snap = await asyncio.create_subprocess_exec(
                "docker", "logs", "--tail", "500",
                self.service_name,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )
            stdout, _ = await asyncio.wait_for(snap.communicate(), timeout=15)
            BATCH = 50
            lines_raw = stdout.splitlines()
            for i in range(0, len(lines_raw), BATCH):
                if not self._running:
                    return
                for raw_line in lines_raw[i:i + BATCH]:
                    line = raw_line.decode("utf-8", errors="replace").strip()
                    if line:
                        await self._enqueue(line)
                await asyncio.sleep(0)  # yield once per batch, not per line
        except Exception:
            logger.warning("Docker log snapshot failed for %s", self.service_name)

        # Step 2: follow live log stream for ongoing anomaly detection
        proc = None
        try:
            proc = await asyncio.create_subprocess_exec(
                "docker", "logs", "--follow", "--tail", "0",
                self.service_name,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )
            assert proc.stdout is not None
            while self._running:
                try:
                    raw_line = await asyncio.wait_for(proc.stdout.readline(), timeout=30)
                    if not raw_line:
                        break
                    line = raw_line.decode("utf-8", errors="replace").strip()
                    if line:
                        await self._enqueue(line)
                except asyncio.TimeoutError:
                    continue  # quiet service — keep waiting
        except Exception:
            logger.exception("Docker log tailing failed for %s", self.service_name)
        finally:
            if proc and proc.returncode is None:
                try:
                    proc.kill()
                except Exception:
                    pass

    async def _resolve_pod_name(self) -> Optional[str]:
        """Find a pod whose name contains the service name. More robust than label selectors."""
        if pod_cache.available:
            return pod_cache.get_running_pod(self.service_name, config.k8s_namespace)
        try:
            proc = await asyncio.create_subprocess_exec(
                "kubectl", "get", "pods",
                "-n", config.k8s_namespace,
                "--no-headers",
                "-o", "custom-columns=NAME:.metadata.name,STATUS:.status.phase",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=10)
            if proc.returncode != 0:
                err = stderr.decode("utf-8", errors="replace").strip() if stderr else "no output"
                logger.warning("kubectl get pods failed for %s (rc=%d): %s",
                               self.service_name, proc.returncode, err[:300])
                return None
            needle = self.service_name.lower().replace(".", "-")
            candidates = []
            for line in stdout.decode("utf-8", errors="replace").splitlines():
                parts = line.split()
                if len(parts) < 1:
                    continue
                pod_name = parts[0].lower()
                status = parts[1].lower() if len(parts) >= 2 else "running"
                if status != "running":
                    continue
                # Prefer exact prefix match (frontend-7bc9d) over substring (internal-frontend-7bc9d)
                if pod_name == needle or pod_name.startswith(needle + "-"):
                    candidates.insert(0, parts[0])  # exact prefix first
                elif needle in pod_name:
                    candidates.append(parts[0])
            return candidates[0] if candidates else None
        except Exception as exc:
            logger.warning("Pod resolution failed for %s: %s", self.service_name, exc)
            return None

    async def _tail_kubernetes(self) -> None:
        """Tail logs from Kubernetes pods. Resolves pod name first then tails by name."""
        # Initial snapshot: populate corpus quickly with last 200 lines
        await self._fetch_kubernetes_snapshot(tail=200)

        while self._running:
            pod_name = await self._resolve_pod_name()
            if not pod_name:
                logger.warning("No running pod found for %s — retrying in 5s", self.service_name)
                await asyncio.sleep(5)
                continue

            try:
                proc = await asyncio.create_subprocess_exec(
                    "kubectl", "logs",
                    pod_name,
                    "-n", config.k8s_namespace,
                    "--follow", "--tail=0",
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                got_any_line = False
                while self._running and proc.stdout:
                    try:
                        raw_line = await asyncio.wait_for(proc.stdout.readline(), timeout=30)
                    except asyncio.TimeoutError:
                        break
                    if not raw_line:
                        break
                    line = raw_line.decode("utf-8", errors="replace").strip()
                    if line:
                        got_any_line = True
                        await self._enqueue(line)

                if proc.returncode is None:
                    proc.kill()
                    await proc.wait()

                if proc.returncode is not None and proc.returncode != 0:
                    stderr_bytes = b""
                    try:
                        if proc.stderr:
                            stderr_bytes = await asyncio.wait_for(proc.stderr.read(), timeout=2)
                    except Exception:
                        pass
                    err = stderr_bytes.decode("utf-8", errors="replace").strip() if stderr_bytes else ""
                    logger.warning(
                        "kubectl logs exited (rc=%d) for %s/%s%s",
                        proc.returncode, self.service_name, pod_name,
                        f": {err[:300]}" if err else "",
                    )

                if not got_any_line and self._running:
                    # Pod might have restarted — refetch snapshot
                    await self._fetch_kubernetes_snapshot(tail=50)

            except Exception as exc:
                logger.warning("K8s log tail broke for %s: %s — retrying in 3s", self.service_name, exc)

            if self._running:
                await asyncio.sleep(3)

    async def _fetch_kubernetes_snapshot(self, tail: int = 100) -> None:
        """Fetch the last N log lines from any pod matching the service name."""
        try:
            pod_name = await self._resolve_pod_name()
            if not pod_name:
                return
            proc = await asyncio.create_subprocess_exec(
                "kubectl", "logs",
                pod_name,
                "-n", config.k8s_namespace,
                f"--tail={tail}",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=20)
            if stdout:
                raw_lines = stdout.decode("utf-8", errors="replace").splitlines()
                count = 0
                BATCH = 50
                for i in range(0, len(raw_lines), BATCH):
                    for raw in raw_lines[i:i + BATCH]:
                        line = raw.strip()
                        if line:
                            await self._enqueue(line)
                            count += 1
                    await asyncio.sleep(0)
                logger.info("kubectl logs snapshot: %d lines from %s/%s",
                            count, self.service_name, pod_name)
            elif proc.returncode != 0:
                err = stderr.decode("utf-8", errors="replace").strip() if stderr else "no output"
                logger.warning("kubectl logs snapshot failed for %s/%s (rc=%d): %s",
                               self.service_name, pod_name, proc.returncode, err[:300])
        except Exception as exc:
            logger.warning("kubectl logs snapshot error for %s: %s", self.service_name, exc)

    async def _poll_logs_fallback(self) -> None:
        """Fallback: periodically fetch the last N log lines."""
        while self._running:
            try:
                if config.mode == "docker":
                    proc = await asyncio.create_subprocess_exec(
                        "docker", "logs", "--tail", "20",
                        self.service_name,
                        stdout=asyncio.subprocess.PIPE,
                        stderr=asyncio.subprocess.STDOUT,
                    )
                    stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=10)
                    logs = stdout.decode("utf-8", errors="replace")
                else:
                    proc = await asyncio.create_subprocess_exec(
                        "kubectl", "logs",
                        "-n", config.k8s_namespace,
                        "-l", self.label_selector,
                        "--tail=20",
                        stdout=asyncio.subprocess.PIPE,
                        stderr=asyncio.subprocess.PIPE,
                    )
                    stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=10)
                    logs = stdout.decode("utf-8", errors="replace")

                for line in logs.strip().splitlines():
                    line = line.strip()
                    if line:
                        await self._process_line(line)

            except Exception:
                logger.warning("Log poll fallback failed")

            await asyncio.sleep(max(5, WINDOW_SECONDS // 3))

    async def _process_line(self, line: str) -> None:
        """Process a single log line: collect for corpus, classify, score."""
        normalized = self._normalize_line(line)

        # Phase 1: collect corpus
        if not self.fitted:
            self.corpus.append(normalized)
            if len(self.corpus) >= max(CORPUS_SIZE, 2):
                self._fit()
            return

        # Phase 2: fast-path classify or buffer for batch SVD
        # Fast path 1: level embedded in the log line (Spring Boot, Python, etc.)
        label: Optional[str] = self._extract_structured_level(line)
        if label is None:
            # Fast path 2: seed keyword match
            label = self._keyword_classify(line)

        if label is not None:
            # Immediate — no sklearn overhead
            self.window_counts[label] += 1
            self.window_total += 1
            self.recent_lines.append({"line": line[:500], "label": label, "timestamp": time.time()})
        else:
            # No fast-path hit: defer to batch SVD at window close
            self._window_buffer.append(normalized)
            # Add to recent_lines with a default; label stays INFO for display purposes
            self.recent_lines.append({"line": line[:500], "label": "INFO", "timestamp": time.time()})

        if time.time() - self.window_start >= WINDOW_SECONDS:
            self._close_window()

    def _fit(self) -> None:
        """Fit TF-IDF + SVD on the collected corpus and compute seed centroids."""
        if len(self.corpus) < 2:
            logger.warning(
                "LSI corpus too small to fit (%d lines) — waiting for more logs",
                len(self.corpus),
            )
            return
        logger.info("Fitting LSI model on %d log lines...", len(self.corpus))
        try:
            self.vectorizer = TfidfVectorizer(max_features=5000)
            tfidf_matrix = self.vectorizer.fit_transform(self.corpus)

            n_components = min(50, tfidf_matrix.shape[1] - 1, tfidf_matrix.shape[0] - 1)
            if n_components < 1:
                logger.warning("Not enough features for SVD, using fallback")
                n_components = 1

            self.svd = TruncatedSVD(n_components=n_components, random_state=42)
            latent_matrix = self.svd.fit_transform(tfidf_matrix)

            # Compute centroids by matching seed keywords in corpus lines
            for label, keywords in SEED_KEYWORDS.items():
                matching_indices = []
                for i, line in enumerate(self.corpus):
                    lower = line.lower()
                    if any(kw in lower for kw in keywords):
                        matching_indices.append(i)

                if matching_indices:
                    self.centroids[label] = latent_matrix[matching_indices].mean(axis=0)
                else:
                    # Fallback: vectorize the keywords themselves
                    seed_vec = self.vectorizer.transform(keywords)
                    seed_latent = self.svd.transform(seed_vec)
                    self.centroids[label] = seed_latent.mean(axis=0)

            # Pre-normalise centroids once — avoids per-call reshape + sklearn dispatcher overhead
            self._centroids_norm = {
                label: centroid / (np.linalg.norm(centroid) + 1e-9)
                for label, centroid in self.centroids.items()
            }
            self.fitted = True
            logger.info("LSI model fitted. Centroids: %s", list(self.centroids.keys()))

        except Exception:
            logger.exception("LSI fit failed")

    def _maybe_refit(self) -> None:
        """Re-fit using recent_lines as the new corpus to handle vocabulary drift.

        Only fires every BACKTRACK_REFIT_WINDOWS windows (default: 20 = ~10 minutes).
        Requires at least 50 recent lines to avoid degrading the model.
        Does not reset the baseline — drift in log vocabulary should not reset anomaly history.
        """
        if len(self.recent_lines) < 50:
            return
        new_corpus = [self._normalize_line(e["line"]) for e in self.recent_lines]
        old_fitted = self.fitted
        self.fitted = False  # temporarily mark unfitted to allow _fit to run
        self.corpus = new_corpus
        self._fit()
        if not self.fitted:
            # Re-fit failed — restore previous state
            self.fitted = old_fitted
            logger.warning("LSI re-fit failed for %s — keeping previous model", self.service_name)
        else:
            logger.info("LSI model re-fitted for %s on %d recent lines", self.service_name, len(new_corpus))

    def _novelty_score(self, vec) -> float:
        """SVD reconstruction error — high value means the line is genuinely novel.

        Computed without densifying the sparse input vector:
          ||sparse - recon||² = ||sparse||² + ||recon||² - 2·(sparse · recon)
        The first term visits only non-zero elements (O(nnz)), avoiding the full
        n_features dense materialisation that vec.toarray() would require.
        """
        if self.svd is None:
            return 0.0
        try:
            latent = self.svd.transform(vec)              # (1, k)
            recon  = self.svd.inverse_transform(latent)   # (1, n_features) dense
            sparse_sq = float(vec.multiply(vec).sum())
            recon_sq  = float(np.dot(recon[0], recon[0]))
            cross     = float(vec.dot(recon.T)[0, 0])
            return float(np.sqrt(max(0.0, sparse_sq + recon_sq - 2.0 * cross)))
        except Exception:
            return 0.0

    _STRUCTURED_LEVELS = {
        "ERROR": "ERROR", "FATAL": "ERROR", "CRITICAL": "ERROR",
        "WARN": "WARN", "WARNING": "WARN",
        "INFO": "INFO", "DEBUG": "INFO", "TRACE": "INFO",
    }

    def _extract_structured_level(self, line: str) -> Optional[str]:
        """Parse log level from structured log formats (Spring Boot, logback, Python, etc).

        Checks the first 5 whitespace tokens — covers:
          Spring Boot:  2026-05-03T13:31:35Z INFO 1 --- ...
          Logback:      13:31:35.668 [thread] INFO  c.example ...
          Python:       2026-05-03 13:31:35 INFO backtrack: ...
        """
        parts = line.split(None, 5)
        for token in parts[:5]:
            upper = token.upper().rstrip(":[]")
            mapped = self._STRUCTURED_LEVELS.get(upper)
            if mapped:
                return mapped
        return None

    # Negation patterns: "no error", "0 errors", "error-free", "errors: 0", etc.
    _NEGATION_RE = re.compile(
        r'\b(?:no|zero|without|0)\s+(?:error|exception|fail|warn|crash)'
        r'|(?:error|exception|fail|warn|crash)s?\s*(?:count|rate)?\s*[=:]\s*0\b'
        r'|(?:error|warn)[- ]free\b',
        re.I,
    )

    def _keyword_classify(self, line: str) -> Optional[str]:
        """Fast-path: return ERROR/WARN if seed keywords hit, else None for SVD path.

        Negation patterns ("no error", "0 errors", "error-free") suppress the match
        so lines like health-check responses are not mis-labelled as ERROR.
        """
        if self._NEGATION_RE.search(line):
            return None
        lower = line.lower()
        for label in ("ERROR", "WARN"):
            if any(kw in lower for kw in SEED_KEYWORDS[label]):
                return label
        return None

    def _classify(self, line: str) -> str:
        """Classify a single log line (used as fallback / compatibility path).

        Priority order:
          1. Structured level embedded in the log line — most accurate, zero sklearn cost
          2. Seed keyword match — fast path for unstructured logs
          3. SVD cosine similarity — semantic fallback (uses pre-normalised centroids)

        Hot path: _process_line routes structured and keyword lines directly without
        calling this method.  SVD lines are batch-classified by _batch_classify instead.
        """
        structured = self._extract_structured_level(line)
        if structured:
            return structured  # trust the logger — no sklearn overhead

        kw = self._keyword_classify(line)
        if not self.vectorizer or not self.svd or not self._centroids_norm:
            return kw or "INFO"

        try:
            vec = self.vectorizer.transform([line])
            novel_threshold = float(os.getenv("BACKTRACK_NOVEL_RECON_THRESHOLD", "0.8"))
            if self._novelty_score(vec) > novel_threshold:
                return kw or "INFO"
            latent_flat = self.svd.transform(vec)[0]
            latent_norm = latent_flat / (np.linalg.norm(latent_flat) + 1e-9)
            scores = {lbl: float(np.dot(latent_norm, cn)) for lbl, cn in self._centroids_norm.items()}
            best_label = max(scores, key=scores.get)  # type: ignore[arg-type]
            return best_label if scores[best_label] > SVD_SIMILARITY_THRESHOLD else (kw or "INFO")
        except Exception:
            return kw or "INFO"

    def _batch_classify(self, lines: list[str]) -> list[str]:
        """Classify a batch of pre-normalised lines in a single vectorizer+SVD call.

        One vectorizer.transform + one svd.transform replaces N individual calls.
        Reconstruction error and cosine similarity are computed with numpy matrix ops.
        """
        if not lines or not self.vectorizer or not self.svd or not self._centroids_norm:
            return ["INFO"] * len(lines)
        try:
            novel_threshold = float(os.getenv("BACKTRACK_NOVEL_RECON_THRESHOLD", "0.8"))
            vecs   = self.vectorizer.transform(lines)           # (n, n_features) sparse
            latents = self.svd.transform(vecs)                  # (n, k) dense
            recon   = self.svd.inverse_transform(latents)       # (n, n_features) dense

            # Vectorised reconstruction error — sparse-aware, avoids full densification
            sparse_sq = np.asarray(vecs.multiply(vecs).sum(axis=1)).ravel()
            recon_sq  = np.sum(recon ** 2, axis=1)
            cross     = np.asarray(vecs.multiply(recon).sum(axis=1)).ravel()
            recon_errors = np.sqrt(np.maximum(0.0, sparse_sq + recon_sq - 2.0 * cross))

            # Vectorised cosine similarity via pre-normalised centroid matrix
            norms = np.linalg.norm(latents, axis=1, keepdims=True) + 1e-9
            latents_norm = latents / norms                       # (n, k)
            label_order  = sorted(self._centroids_norm.keys())
            centroid_mat = np.stack([self._centroids_norm[l] for l in label_order])  # (C, k)
            sims      = latents_norm @ centroid_mat.T            # (n, C)
            best_idx  = np.argmax(sims, axis=1)
            best_sims = sims[np.arange(len(lines)), best_idx]

            self._svd_classified_count += len(lines)
            labels: list[str] = []
            for i, (err, bi, bs) in enumerate(zip(recon_errors, best_idx, best_sims)):
                if err > novel_threshold or bs <= SVD_SIMILARITY_THRESHOLD:
                    # Line doesn't fit the model — use keyword fallback so genuinely
                    # novel-but-harmless lines don't inflate the score as NOVEL.
                    kw = self._keyword_classify(lines[i])
                    labels.append(kw if kw else "INFO")
                else:
                    labels.append(label_order[int(bi)])
            return labels
        except Exception:
            logger.warning("Batch classify failed for %s", self.service_name)
            return ["INFO"] * len(lines)

    def _close_window(self) -> None:
        """Close the current 30-second scoring window."""
        # Drain SVD buffer in one batch before computing the score
        if self._window_buffer:
            for lbl in self._batch_classify(self._window_buffer):
                self.window_counts[lbl] += 1
            self.window_total += len(self._window_buffer)
            self._window_buffer = []

        error_count = self.window_counts.get("ERROR", 0)
        warning_count = self.window_counts.get("WARN", 0)

        if self.window_total == 0:
            score = 0.0
        else:
            n = self.window_counts.get("NOVEL", 0)
            score = (error_count * 5 + n * 3 + warning_count * 1) / self.window_total

        self.score_history.append(score)

        # Error-only score: only ERROR lines count — WARN and NOVEL are informational
        error_score = (error_count * 3 / self.window_total) if self.window_total > 0 else 0.0
        self.error_score_history.append(error_score)

        # Lock baseline after first BASELINE_WINDOWS windows
        if not self.baseline_locked and len(self.score_history) >= BASELINE_WINDOWS:
            # score_history is a deque — convert to list before slicing
            self.baseline_scores = list(self.score_history)[:BASELINE_WINDOWS]
            self.baseline_locked = True
            logger.info("LSI baseline locked: mean=%.4f", np.mean(self.baseline_scores))
        elif self.baseline_locked and self.baseline_scores:
            # Gradually update baseline using only non-anomalous windows so it adapts
            # to normal log evolution without being corrupted by actual anomaly spikes.
            # Use same threshold logic as is_anomalous() for consistency.
            bm = float(np.mean(self.baseline_scores))
            current_threshold = 1.5 if bm <= 0 else config.lsi_score_multiplier * bm
            if score <= current_threshold:
                self.baseline_scores.append(score)
                self.baseline_scores = self.baseline_scores[-BASELINE_WINDOWS:]

        # Lock error baseline independently — uses ERROR_BASELINE_WINDOWS (default 3)
        # so detection can start after just 90 s rather than waiting 5 min.
        if not self.error_baseline_locked and len(self.error_score_history) >= ERROR_BASELINE_WINDOWS:
            self.error_baseline_scores = list(self.error_score_history)[:ERROR_BASELINE_WINDOWS]
            self.error_baseline_locked = True
            logger.info("LSI error baseline locked: mean=%.4f", np.mean(self.error_baseline_scores))
        elif self.error_baseline_locked and self.error_baseline_scores:
            ebm = float(np.mean(self.error_baseline_scores))
            error_threshold = 0.3 if ebm <= 0 else config.lsi_score_multiplier * ebm
            if error_score <= error_threshold:
                self.error_baseline_scores.append(error_score)
                self.error_baseline_scores = self.error_baseline_scores[-ERROR_BASELINE_WINDOWS:]

        self._compute_semantics(error_count, warning_count, self.window_total)

        # Periodic re-fit to handle vocabulary drift
        self._windows_since_fit += 1
        if self._windows_since_fit >= int(os.getenv("BACKTRACK_REFIT_WINDOWS", "20")):
            self._maybe_refit()
            self._windows_since_fit = 0

        # Reset window
        self.window_start = time.time()
        self.window_counts = {"INFO": 0, "WARN": 0, "ERROR": 0, "NOVEL": 0}
        self.window_total = 0

    def _compute_semantics(self, error_count: int, warning_count: int, window_total: int) -> None:
        """Extract topics, error patterns, and human-readable interpretation after each window."""
        if not self.fitted or self.svd is None or self.vectorizer is None:
            return
        try:
            feature_names = self.vectorizer.get_feature_names_out()
            variance_ratios = self.svd.explained_variance_ratio_

            # Extract up to 5 topics from SVD components
            self.topics = []
            n_topics = min(5, len(self.svd.components_))
            for idx in range(n_topics):
                component = self.svd.components_[idx]
                top_idxs = component.argsort()[-5:][::-1]
                top_terms = [feature_names[i] for i in top_idxs]
                top_weights = [round(float(component[i]), 4) for i in top_idxs]
                strength = round(float(variance_ratios[idx]) if idx < len(variance_ratios) else 0.0, 4)
                self.topics.append({
                    "topic_id": idx,
                    "strength": strength,
                    "top_terms": top_terms,
                    "weights": top_weights,
                    "label": self._label_topic(top_terms),
                })

            # Complexity from top 2 components (mirrors TestBt.py n_topics=2 approach)
            complexity = float(np.sum(variance_ratios[:2])) if len(variance_ratios) >= 2 else float(np.sum(variance_ratios))

            if complexity > 0.7:
                self.log_diversity = "HIGH"
            elif complexity > 0.4:
                self.log_diversity = "MODERATE"
            elif window_total > 0:
                self.log_diversity = "LOW"
            else:
                self.log_diversity = "INSUFFICIENT"

            recent_texts = [entry["line"] for entry in self.recent_lines]
            self.error_patterns = self._extract_error_patterns(recent_texts, error_count, warning_count)
            self.dominant_themes = self._extract_dominant_themes(self.topics)

            if self.is_anomalous():
                status = "ANOMALY"
            elif (self.score_history and self.baseline_scores and
                    self.score_history[-1] > max(1.0, float(np.mean(self.baseline_scores)))):
                status = "WARNING"
            else:
                status = "STABLE"

            error_ratio = (error_count + warning_count * 0.5) / max(window_total, 1)
            self.interpretation = self._generate_interpretation(
                complexity, error_ratio, self.topics, self.error_patterns,
                self.dominant_themes, self.log_diversity, status,
            )

        except Exception:
            logger.warning("Semantic analysis failed for %s", self.service_name)

    @staticmethod
    def _label_topic(terms: list[str]) -> str:
        """Assign a semantic label to a topic based on its top terms."""
        lower = [t.lower() for t in terms]
        if any(t in lower for t in ["error", "exception", "failed", "failure", "panic"]):
            return "ERROR_HANDLING"
        if any(t in lower for t in ["connection", "timeout", "network", "socket", "http"]):
            return "NETWORK_OPERATIONS"
        if any(t in lower for t in ["database", "query", "sql", "postgres", "mysql", "redis"]):
            return "DATABASE_OPERATIONS"
        if any(t in lower for t in ["auth", "authentication", "token", "permission", "unauthorized"]):
            return "AUTHENTICATION"
        if any(t in lower for t in ["request", "response", "status", "code", "handler"]):
            return "REQUEST_HANDLING"
        if any(t in lower for t in ["latency", "slow", "performance", "memory", "cpu"]):
            return "PERFORMANCE"
        if any(t in lower for t in ["service", "client", "api", "endpoint", "call"]):
            return "SERVICE_INTEGRATION"
        return "GENERAL_OPERATIONS"

    @staticmethod
    def _extract_error_patterns(docs: list[str], error_count: int, warning_count: int) -> list[str]:
        """Detect known error patterns from a list of log lines."""
        known = {
            "connection refused": "Connection Refused - Dependency unavailable",
            "timeout":            "Timeout - Slow response or network issue",
            "out of memory":      "Out of Memory - Resource exhaustion",
            "null pointer":       "Null Pointer - Code defect",
            "permission denied":  "Permission Denied - Authorization issue",
            "not found":          "Not Found - Missing resource",
            "deadlock":           "Deadlock - Concurrency issue",
            "panic":              "Panic - Critical application crash",
            "500":                "HTTP 500 - Internal server error",
            "503":                "HTTP 503 - Service unavailable",
            "429":                "HTTP 429 - Rate limit exceeded",
        }
        combined = " ".join(docs).lower()
        found = [desc for pattern, desc in known.items() if pattern in combined]
        if error_count > 0 and not found:
            found.append(f"Unclassified Errors - {error_count} error entries found")
        return found[:5]

    @staticmethod
    def _extract_dominant_themes(topics: list[dict]) -> list[str]:
        """Return labels of the two strongest topics."""
        if not topics:
            return []
        return [t["label"] for t in sorted(topics, key=lambda t: t["strength"], reverse=True)[:2]]

    @staticmethod
    def _generate_interpretation(
        complexity: float, error_ratio: float,
        topics: list[dict], error_patterns: list[str],
        dominant_themes: list[str], log_diversity: str, status: str,
    ) -> str:
        """Generate a human-readable interpretation of the LSI semantic analysis."""
        parts: list[str] = []

        if log_diversity == "HIGH":
            parts.append(
                f"📊 Log Diversity: HIGH ({complexity:.2f}) - Logs show diverse patterns, "
                "indicating varied system behaviors or multiple concurrent issues."
            )
        elif log_diversity == "MODERATE":
            parts.append(
                f"📊 Log Diversity: MODERATE ({complexity:.2f}) - Logs show some variation, "
                "typical of normal operations with occasional events."
            )
        else:
            parts.append(
                f"📊 Log Diversity: LOW ({complexity:.2f}) - Logs are very uniform, "
                "indicating stable, repetitive operations or limited logging."
            )

        if error_ratio > 0.3:
            parts.append(
                f"🔴 Error Rate: CRITICAL ({error_ratio:.1%}) - Very high proportion of error messages. "
                "This strongly suggests active failures."
            )
        elif error_ratio > 0.1:
            parts.append(
                f"🟠 Error Rate: ELEVATED ({error_ratio:.1%}) - Notable number of errors detected. "
                "System is experiencing some failures."
            )
        elif error_ratio > 0.05:
            parts.append(
                f"🟡 Error Rate: MODERATE ({error_ratio:.1%}) - Some errors present but within "
                "potentially acceptable range for normal operations."
            )
        else:
            parts.append(f"🟢 Error Rate: LOW ({error_ratio:.1%}) - Minimal errors detected.")

        if dominant_themes:
            parts.append(
                f"🎯 Dominant Themes: {', '.join(dominant_themes)} - "
                "These operational areas are most prominent in recent logs."
            )

        if error_patterns:
            parts.append(
                "⚠️  Detected Issues:\n   " + "\n   ".join(f"• {p}" for p in error_patterns)
            )

        if topics:
            topic_lines = [
                f"   Topic {t['topic_id']} ({t['label']}, {t['strength']:.1%} variance): "
                + ", ".join(t["top_terms"][:3])
                for t in topics
            ]
            parts.append("📝 Topic Breakdown:\n" + "\n".join(topic_lines))

        if status == "ANOMALY":
            parts.append(
                "🚨 OVERALL: Log patterns are ANOMALOUS. Either high error rate, unusual diversity, "
                "or both indicate potential system issues requiring investigation."
            )
        elif status == "WARNING":
            parts.append(
                "⚠️  OVERALL: Log patterns show WARNING signals. Some deviation from normal "
                "but not yet critical. Continue monitoring."
            )
        else:
            parts.append("✅ OVERALL: Log patterns appear STABLE and within normal parameters.")

        return "\n\n".join(parts)

    def is_anomalous(self) -> bool:
        """Returns True if LSI score exceeds the configured threshold.

        When a baseline is established (baseline_mean > 0), the configured
        lsi_score_multiplier always governs — no hard floor bypass.  The ABS_FLOOR
        only applies when the baseline is zero (pure-INFO service with no history),
        so the multiplier threshold is never silently overridden by novel-log inflation.
        """
        if not self.baseline_locked or not self.score_history:
            return False
        baseline_mean = float(np.mean(self.baseline_scores))
        current_score = self.score_history[-1]
        if baseline_mean <= 0:
            # Safety net only: no meaningful baseline yet, use absolute floor
            return current_score > 1.5
        return current_score > config.lsi_score_multiplier * baseline_mean

    def is_error_anomalous(self) -> bool:
        """True only when the ERROR-only window score exceeds baseline.

        WARN and NOVEL lines are informational — they do not trigger rollback.

        Detection layers (in order):
          1. Pre-baseline absolute floor: if current error_score > 0.5 (>16 % of
             lines classified ERROR) trigger immediately — catches cold-start faults
             and severe failures before the 90-s baseline window has closed.
          2. Post-baseline relative threshold: current > lsi_score_multiplier × mean.
          3. Clean-baseline floor: when baseline mean is 0 (pure-INFO service),
             a floor of 0.3 is used so ~10 ERROR lines per 100 avoid false negatives.
        """
        if not self.error_score_history:
            return False
        current = self.error_score_history[-1]

        if not self.error_baseline_locked:
            # Pre-baseline: absolute floor for severe faults only.
            # Catches cold-start faults and failures before 90-s warmup completes.
            return current > 0.5

        # Post-baseline: relative check with floor for zero-error baselines
        baseline_mean = float(np.mean(self.error_baseline_scores))
        if baseline_mean <= 0:
            return current > 0.3
        return current > config.lsi_score_multiplier * baseline_mean

    def get_evaluation(self) -> dict:
        """Compute confusion matrix + precision/recall/F1 per class (keyword vs SVD)."""
        classes = ["INFO", "WARN", "ERROR", "NOVEL"]
        matrix = self._confusion
        metrics: dict[str, dict] = {}

        for cls in classes:
            tp = matrix[cls][cls]
            fp = sum(matrix[ref][cls] for ref in classes if ref != cls)
            fn = sum(matrix[cls][pred] for pred in classes if pred != cls)
            tn = sum(
                matrix[ref][pred]
                for ref in classes for pred in classes
                if ref != cls and pred != cls
            )
            precision = tp / (tp + fp) if (tp + fp) > 0 else 0.0
            recall = tp / (tp + fn) if (tp + fn) > 0 else 0.0
            f1 = (2 * precision * recall / (precision + recall)
                  if (precision + recall) > 0 else 0.0)
            metrics[cls] = {
                "precision": round(precision, 4),
                "recall": round(recall, 4),
                "f1": round(f1, 4),
                "tp": tp, "fp": fp, "fn": fn, "tn": tn,
            }

        return {
            "confusion_matrix": {
                ref: dict(row) for ref, row in matrix.items()
            },
            "per_class": metrics,
            "svd_classified_total": self._svd_classified_count,
            "classes": classes,
        }

    def get_lsi(self) -> dict:
        """Return LSI status for the /lsi endpoint."""
        current_score = self.score_history[-1] if self.score_history else 0.0
        baseline_mean = float(np.mean(self.baseline_scores)) if self.baseline_scores else 0.0

        error_score = self.error_score_history[-1] if self.error_score_history else 0.0
        error_baseline_mean = float(np.mean(self.error_baseline_scores)) if self.error_baseline_scores else 0.0

        if not self.error_baseline_locked:
            computed_error_threshold = 0.5
        elif error_baseline_mean <= 0:
            computed_error_threshold = 0.3
        else:
            computed_error_threshold = config.lsi_score_multiplier * error_baseline_mean

        return {
            "fitted": self.fitted,
            "corpus_size": len(self.corpus),
            "current_score": round(current_score, 4),
            "baseline_mean": round(baseline_mean, 4),
            "threshold": round(1.5 if baseline_mean <= 0 else config.lsi_score_multiplier * baseline_mean, 4),
            "is_anomalous": self.is_anomalous(),
            "is_error_anomalous": self.is_error_anomalous(),
            "error_score": round(error_score, 4),
            "error_baseline_mean": round(error_baseline_mean, 4),
            "error_threshold": round(computed_error_threshold, 4),
            "error_baseline_locked": self.error_baseline_locked,
            "error_score_history": [round(s, 4) for s in list(self.error_score_history)[-20:]],
            "window_counts": dict(self.window_counts),
            "score_history": [round(s, 4) for s in list(self.score_history)[-20:]],
            "recent_lines": list(self.recent_lines),
            "topics": self.topics,
            "error_patterns": self.error_patterns,
            "dominant_themes": self.dominant_themes,
            "log_diversity": self.log_diversity,
            "interpretation": self.interpretation,
            "evaluation": self.get_evaluation(),
        }
