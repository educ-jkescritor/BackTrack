from unittest.mock import AsyncMock, MagicMock, patch

import numpy as np
import pytest
from src.collectors.tsd import TSDCollector, MIN_READINGS_FOR_STL


@pytest.fixture(autouse=True)
def mock_config():
    with patch("src.collectors.tsd.config") as cfg:
        cfg.target = "test-service"
        cfg.k8s_label_selector = "app=test"
        cfg.k8s_namespace = "default"
        cfg.mode = "docker"
        cfg.scrape_interval = 10
        cfg.tsd_iqr_multiplier = 3.0
        yield cfg


def make_collector_with_history(n: int = 20) -> TSDCollector:
    """Return a TSDCollector pre-populated with n varied readings."""
    collector = TSDCollector(service_name="test")
    rng = np.random.default_rng(42)
    for _ in range(n):
        collector.cpu_history.append(float(rng.uniform(10, 30)))
        collector.memory_history.append(float(rng.uniform(100, 200)))
        collector.latency_history.append(float(rng.uniform(5, 20)))
        collector.error_rate_history.append(0.0)
    return collector


# --- _decompose ---

def test_decompose_fills_residuals():
    collector = make_collector_with_history(20)
    collector._decompose()
    assert len(collector.residuals["cpu"]) > 0
    assert len(collector.residuals["memory"]) > 0
    assert len(collector.residuals["latency"]) > 0


def test_decompose_skips_short_series():
    collector = TSDCollector(service_name="test")
    for _ in range(MIN_READINGS_FOR_STL - 1):
        collector.cpu_history.append(10.0)
    collector._decompose()
    assert collector.residuals["cpu"] == []


# --- is_drifting ---

def test_is_drifting_false_with_no_residuals():
    collector = TSDCollector(service_name="test")
    assert not collector.is_drifting()


def test_is_drifting_false_when_flat_series():
    collector = TSDCollector(service_name="test")
    # All-zero residuals → IQR < 1e-6, skipped
    collector.residuals["cpu"] = [0.0] * 12
    assert not collector.is_drifting()


def test_is_drifting_false_when_last_three_within_threshold():
    collector = TSDCollector(service_name="test")
    # IQR of [1..9] ≈ 4, threshold = 3 * 4 = 12 → last 3 = 3.0 < 12
    collector.residuals["cpu"] = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 3.0, 3.0, 3.0]
    assert not collector.is_drifting()


def test_is_drifting_true_when_last_three_spike():
    collector = TSDCollector(service_name="test")
    # Stable baseline [1.0]*9 → IQR=0, skip... need variance.
    # Use a range: baseline [1,2,3,4,5,6,7,8,9] → IQR=4, threshold=12
    # Last 3 = 1000 → all exceed 12 → drifting
    collector.residuals["cpu"] = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0,
                                  1000.0, 1000.0, 1000.0]
    assert collector.is_drifting()


def test_is_drifting_false_when_only_two_of_three_spike():
    collector = TSDCollector(service_name="test")
    collector.residuals["cpu"] = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0,
                                  1000.0, 1000.0, 3.0]  # last is within threshold
    assert not collector.is_drifting()


def test_is_drifting_checks_all_metrics():
    collector = TSDCollector(service_name="test")
    # cpu is fine, memory drifts
    collector.residuals["cpu"] = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0,
                                  3.0, 3.0, 3.0]
    collector.residuals["memory"] = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0,
                                     1000.0, 1000.0, 1000.0]
    assert collector.is_drifting()


# --- get_metrics ---

def test_get_metrics_structure():
    collector = make_collector_with_history(15)
    collector._decompose()
    result = collector.get_metrics()
    assert set(result.keys()) == {
        "current", "history", "decomposition", "residuals",
        "readings_count", "is_drifting", "has_crashed",
        "restart_count", "last_exit_code", "container_status",
        "z_scores", "trend_directions", "tsd_confidence", "tsd_status",
        "evaluation",
    }
    assert set(result["current"].keys()) == {
        "cpu_percent", "memory_mb", "latency_ms", "error_rate_percent"
    }
    assert result["readings_count"] == 15
    assert set(result["z_scores"].keys()) == {"cpu", "memory", "latency", "error_rate"}
    assert set(result["trend_directions"].keys()) == {"cpu", "memory", "latency", "error_rate"}
    assert set(result["tsd_status"].keys()) == {"cpu", "memory", "latency", "error_rate"}
    assert isinstance(result["tsd_confidence"], float)


def test_get_metrics_readings_count():
    collector = make_collector_with_history(7)
    assert collector.get_metrics()["readings_count"] == 7


# --- _scrape_docker ---

async def test_scrape_docker_cpu_and_memory(mock_config):
    collector = TSDCollector(service_name="test")

    fake_cache = {"test": {"cpu": 40.0, "mem_mb": 150.0}}

    with patch("src.collectors.tsd._refresh_docker_stats", new_callable=AsyncMock):
        with patch("src.collectors.tsd._stats_cache", fake_cache):
            with patch("src.collectors.tsd.TSDCollector._probe_latency", new_callable=AsyncMock, return_value=10.0):
                await collector._scrape_docker()

    assert abs(collector.current_cpu - 40.0) < 1e-6
    assert abs(collector.current_memory - 150.0) < 1e-6
    assert collector.current_latency == 10.0
    assert len(collector.cpu_history) == 1


async def test_scrape_docker_failure_zeroes_metrics(mock_config):
    collector = TSDCollector(service_name="test")
    with patch("src.collectors.tsd._refresh_docker_stats", new_callable=AsyncMock):
        with patch("src.collectors.tsd._stats_cache", {}):
            with patch("src.collectors.tsd.TSDCollector._probe_latency", new_callable=AsyncMock, return_value=0.0):
                await collector._scrape_docker()
    assert collector.current_cpu == 0.0
    assert collector.current_memory == 0.0
    # readings still appended (even on failure)
    assert len(collector.cpu_history) == 1


# --- _scrape_kubernetes ---

async def test_scrape_kubernetes_parses_millicores():
    collector = TSDCollector(service_name="test")
    # Pod names must contain the service name ("test") — _scrape_kubernetes filters by needle.
    kubectl_output = b"test-pod-abc  25m  128Mi\ntest-pod-xyz  50m  64Mi\n"

    mock_proc = MagicMock()
    mock_proc.returncode = 0
    mock_proc.communicate = AsyncMock(return_value=(kubectl_output, b""))

    with patch("asyncio.create_subprocess_exec", return_value=mock_proc):
        with patch("src.collectors.tsd.TSDCollector._probe_latency", new_callable=AsyncMock, return_value=5.0):
            await collector._scrape_kubernetes()

    # (25 + 50) millicores = 0.075 cores → 0.075 * 100 = 7.5%
    assert abs(collector.current_cpu - 7.5) < 1e-6
    # 128 + 64 = 192 MiB
    assert abs(collector.current_memory - 192.0) < 1e-6


async def test_scrape_kubernetes_parses_gi_memory():
    collector = TSDCollector(service_name="test")
    kubectl_output = b"test-pod-abc  100m  1Gi\n"

    mock_proc = MagicMock()
    mock_proc.returncode = 0
    mock_proc.communicate = AsyncMock(return_value=(kubectl_output, b""))

    with patch("asyncio.create_subprocess_exec", return_value=mock_proc):
        with patch("src.collectors.tsd.TSDCollector._probe_latency", new_callable=AsyncMock, return_value=0.0):
            await collector._scrape_kubernetes()

    assert abs(collector.current_memory - 1024.0) < 1e-6


async def test_scrape_kubernetes_parses_ki_memory():
    collector = TSDCollector(service_name="test")
    kubectl_output = b"test-pod-abc  10m  512Ki\n"

    mock_proc = MagicMock()
    mock_proc.returncode = 0
    mock_proc.communicate = AsyncMock(return_value=(kubectl_output, b""))

    with patch("asyncio.create_subprocess_exec", return_value=mock_proc):
        with patch("src.collectors.tsd.TSDCollector._probe_latency", new_callable=AsyncMock, return_value=0.0):
            await collector._scrape_kubernetes()

    assert abs(collector.current_memory - 0.5) < 1e-6  # 512Ki = 0.5 MiB


# --- _compute_z_scores ---

def test_compute_z_scores_populated_after_decompose():
    """After _decompose(), z_scores and tsd_status are set for each metric."""
    collector = make_collector_with_history(20)
    collector._decompose()
    for key in ("cpu", "memory", "latency", "error_rate"):
        assert key in collector.z_scores
        assert key in collector.tsd_status
        assert key in collector.trend_directions


def test_compute_z_scores_stable_when_normal():
    """Stable residuals should produce a STABLE status."""
    collector = TSDCollector(service_name="test")
    # Flat, low-variance residuals → last value close to median → small Z-score
    collector.residuals["cpu"] = [1.0, 1.1, 0.9, 1.0, 1.05, 0.95,
                                   1.0, 1.1, 0.9, 1.0, 1.05, 0.95]
    collector._compute_z_scores()
    assert collector.tsd_status["cpu"] == "STABLE"
    assert abs(collector.z_scores["cpu"]) < 3.0


def test_compute_z_scores_anomaly_on_spike():
    """A large residual spike should produce an ANOMALY status and large Z-score."""
    collector = TSDCollector(service_name="test")
    # Stable baseline, then huge spike as last value
    collector.residuals["cpu"] = [1.0] * 11 + [500.0]
    collector._compute_z_scores()
    assert collector.tsd_status["cpu"] == "ANOMALY"
    assert abs(collector.z_scores["cpu"]) > 3.0


def test_compute_z_scores_insufficient_data():
    """Short residuals list → status remains INSUFFICIENT_DATA."""
    collector = TSDCollector(service_name="test")
    collector.residuals["cpu"] = [1.0, 2.0]  # fewer than MIN_READINGS_FOR_STL
    collector._compute_z_scores()
    assert collector.tsd_status["cpu"] == "INSUFFICIENT_DATA"


def test_compute_z_scores_trend_increasing():
    """Trend series with positive slope → INCREASING direction."""
    collector = TSDCollector(service_name="test")
    collector.residuals["cpu"] = [1.0] * 12
    collector.trend["cpu"] = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0]
    collector._compute_z_scores()
    assert collector.trend_directions["cpu"] == "INCREASING"


def test_compute_z_scores_trend_decreasing():
    """Trend series with negative slope → DECREASING direction."""
    collector = TSDCollector(service_name="test")
    collector.residuals["cpu"] = [1.0] * 12
    collector.trend["cpu"] = [6.0, 5.0, 4.0, 3.0, 2.0, 1.0]
    collector._compute_z_scores()
    assert collector.trend_directions["cpu"] == "DECREASING"


def test_compute_z_scores_trend_stable():
    """Flat trend series → STABLE direction."""
    collector = TSDCollector(service_name="test")
    collector.residuals["cpu"] = [1.0] * 12
    collector.trend["cpu"] = [5.0, 5.0, 5.0, 5.0, 5.0, 5.0]
    collector._compute_z_scores()
    assert collector.trend_directions["cpu"] == "STABLE"


def test_compute_z_scores_confidence_proportional():
    """Confidence grows as the rolling deque fills up (capped at 1.0)."""
    from src.collectors.tsd import DEQUE_SIZE
    c_partial = make_collector_with_history(DEQUE_SIZE // 2)
    c_partial._compute_z_scores()
    c_full = make_collector_with_history(DEQUE_SIZE)
    c_full._compute_z_scores()
    assert c_partial.tsd_confidence < c_full.tsd_confidence
    assert c_full.tsd_confidence == 1.0
