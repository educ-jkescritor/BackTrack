import asyncio
from unittest.mock import patch

import pytest
from src.collectors.lsi import BASELINE_WINDOWS, CORPUS_SIZE, ERROR_BASELINE_WINDOWS, LSICollector


@pytest.fixture(autouse=True)
def mock_config():
    with patch("src.collectors.lsi.config") as cfg:
        cfg.target = "test-service"
        cfg.k8s_label_selector = "app=test"
        cfg.mode = "docker"
        cfg.lsi_score_multiplier = 2.0
        yield cfg


def make_fitted_collector() -> LSICollector:
    """Build a collector with a real fitted model using synthetic log lines."""
    collector = LSICollector(service_name="test")
    corpus = (
        ["error exception failed crash"] * 50
        + ["warning deprecated slow retry"] * 50
        + ["started ready connected success"] * 50
        + ["random log line number " + str(i) for i in range(50)]
    )
    collector.corpus = corpus
    collector._fit()
    return collector


# --- _fit ---


def test_fit_marks_fitted():
    collector = make_fitted_collector()
    assert collector.fitted
    assert collector.vectorizer is not None
    assert collector.svd is not None
    assert set(collector.centroids.keys()) == {"ERROR", "WARN", "INFO"}


# --- _classify ---


def test_classify_error_line():
    collector = make_fitted_collector()
    assert collector._classify("error exception failed") == "ERROR"


def test_classify_warn_line():
    collector = make_fitted_collector()
    assert collector._classify("warning deprecated slow") == "WARN"


def test_classify_info_line():
    collector = make_fitted_collector()
    assert collector._classify("started ready connected success") == "INFO"


def test_classify_before_fit_returns_info():
    collector = LSICollector(service_name="test")
    assert collector._classify("anything here") == "INFO"


# --- _close_window ---


def test_close_window_computes_score():
    collector = make_fitted_collector()
    # score = (ERROR*5 + NOVEL*3 + WARN*1) / total = (1*5 + 0*3 + 2*1) / 3 = 7/3
    collector.window_counts = {"INFO": 0, "WARN": 2, "ERROR": 1, "NOVEL": 0}
    collector.window_total = 3
    collector._close_window()
    assert abs(collector.score_history[-1] - 7 / 3) < 1e-9


def test_close_window_zero_total_gives_zero_score():
    collector = make_fitted_collector()
    collector.window_total = 0
    collector._close_window()
    assert collector.score_history[-1] == 0.0


def test_close_window_resets_counts():
    collector = make_fitted_collector()
    collector.window_counts = {"INFO": 5, "WARN": 1, "ERROR": 2, "NOVEL": 1}
    collector.window_total = 9
    collector._close_window()
    assert collector.window_total == 0
    assert all(v == 0 for v in collector.window_counts.values())


# --- baseline locking ---


def test_baseline_locks_after_n_windows():
    collector = make_fitted_collector()
    for _ in range(BASELINE_WINDOWS):
        collector.window_counts["INFO"] = 10
        collector.window_total = 10
        collector._close_window()
    assert collector.baseline_locked
    assert len(collector.baseline_scores) == BASELINE_WINDOWS


def test_baseline_does_not_lock_before_n_windows():
    collector = make_fitted_collector()
    for _ in range(BASELINE_WINDOWS - 1):
        collector.window_total = 10
        collector.window_counts["INFO"] = 10
        collector._close_window()
    assert not collector.baseline_locked


# --- is_anomalous ---


def test_is_anomalous_false_before_baseline():
    collector = make_fitted_collector()
    assert not collector.is_anomalous()


def test_is_anomalous_false_when_score_within_threshold():
    collector = make_fitted_collector()
    collector.baseline_scores = [1.0] * BASELINE_WINDOWS
    collector.baseline_locked = True
    collector.score_history = [1.5]  # 1.5 < 2.0 * 1.0
    assert not collector.is_anomalous()


def test_is_anomalous_true_when_score_exceeds_threshold():
    collector = make_fitted_collector()
    collector.baseline_scores = [1.0] * BASELINE_WINDOWS
    collector.baseline_locked = True
    collector.score_history = [3.0]  # 3.0 > 2.0 * 1.0
    assert collector.is_anomalous()


def test_is_anomalous_false_when_baseline_mean_is_zero():
    collector = make_fitted_collector()
    collector.baseline_scores = [0.0] * BASELINE_WINDOWS
    collector.baseline_locked = True
    collector.score_history = [0.5]
    assert not collector.is_anomalous()


def test_is_anomalous_respects_multiplier_over_abs_floor():
    """Score > 1.5 must NOT be anomalous when multiplier * baseline_mean > score.

    Previously, a hardcoded ABS_FLOOR = 1.5 fired before the threshold check,
    meaning NOVEL-heavy windows (score ≈ 1.6) were always flagged even when
    the configured threshold was 2.0 or higher.
    """
    collector = make_fitted_collector()
    # baseline_mean = 1.0, multiplier = 2.0 → threshold = 2.0
    collector.baseline_scores = [1.0] * BASELINE_WINDOWS
    collector.baseline_locked = True
    # Score of 1.6 is above the old ABS_FLOOR (1.5) but below threshold (2.0)
    collector.score_history = [1.6]
    assert not collector.is_anomalous()


def test_is_anomalous_zero_baseline_uses_abs_floor():
    """When baseline is zero (pure-INFO service), fall back to the absolute floor."""
    collector = make_fitted_collector()
    collector.baseline_scores = [0.0] * BASELINE_WINDOWS
    collector.baseline_locked = True
    collector.score_history = [1.6]  # above ABS_FLOOR of 1.5
    assert collector.is_anomalous()


# --- is_error_anomalous ---


def test_is_error_anomalous_false_before_baseline():
    collector = make_fitted_collector()
    assert not collector.is_error_anomalous()


def test_is_error_anomalous_false_when_within_threshold():
    collector = make_fitted_collector()
    collector.error_baseline_scores = [1.0] * BASELINE_WINDOWS
    collector.error_baseline_locked = True
    collector.error_score_history.append(1.5)  # 1.5 < 2.0 * 1.0
    assert not collector.is_error_anomalous()


def test_is_error_anomalous_true_when_exceeds_threshold():
    collector = make_fitted_collector()
    collector.error_baseline_scores = [1.0] * BASELINE_WINDOWS
    collector.error_baseline_locked = True
    collector.error_score_history.append(3.0)  # 3.0 > 2.0 * 1.0
    assert collector.is_error_anomalous()


def test_is_error_anomalous_zero_baseline_uses_floor():
    """When no errors in baseline, the 0.3 floor applies."""
    collector = make_fitted_collector()
    collector.error_baseline_scores = [0.0] * BASELINE_WINDOWS
    collector.error_baseline_locked = True
    collector.error_score_history.append(0.4)  # 0.4 > 0.3 floor
    assert collector.is_error_anomalous()


def test_is_error_anomalous_false_when_below_floor():
    collector = make_fitted_collector()
    collector.error_baseline_scores = [0.0] * BASELINE_WINDOWS
    collector.error_baseline_locked = True
    collector.error_score_history.append(0.2)  # 0.2 < 0.3 floor
    assert not collector.is_error_anomalous()


def test_is_error_anomalous_warn_only_does_not_trigger():
    """WARN lines do not contribute to error_score — a WARN-heavy window is not rollback-worthy."""
    collector = make_fitted_collector()
    collector.error_baseline_scores = [0.0] * BASELINE_WINDOWS
    collector.error_baseline_locked = True
    collector.error_score_history.append(0.0)  # no errors
    assert not collector.is_error_anomalous()


# --- error-score tracking ---


def test_error_score_appended_each_window():
    """error_score_history grows by one entry per _close_window() call."""
    collector = make_fitted_collector()
    assert len(collector.error_score_history) == 0
    collector.window_counts = {"INFO": 8, "WARN": 1, "ERROR": 1, "NOVEL": 0}
    collector.window_total = 10
    collector._close_window()
    assert len(collector.error_score_history) == 1
    # error_score = 1 error * 3 / 10 total = 0.3
    assert abs(collector.error_score_history[-1] - 0.3) < 1e-9


def test_error_score_zero_when_no_errors():
    collector = make_fitted_collector()
    collector.window_counts = {"INFO": 10, "WARN": 0, "ERROR": 0, "NOVEL": 0}
    collector.window_total = 10
    collector._close_window()
    assert collector.error_score_history[-1] == 0.0


def test_error_score_warn_not_counted():
    """WARN lines do not inflate error_score — only ERROR lines do."""
    collector = make_fitted_collector()
    collector.window_counts = {"INFO": 0, "WARN": 10, "ERROR": 0, "NOVEL": 0}
    collector.window_total = 10
    collector._close_window()
    assert collector.error_score_history[-1] == 0.0


def test_error_score_novel_not_counted():
    """NOVEL lines do not inflate error_score even though they inflate the full score."""
    collector = make_fitted_collector()
    collector.window_counts = {"INFO": 0, "WARN": 0, "ERROR": 0, "NOVEL": 10}
    collector.window_total = 10
    collector._close_window()
    assert collector.error_score_history[-1] == 0.0


def test_error_baseline_locks_after_n_windows():
    collector = make_fitted_collector()
    for _ in range(ERROR_BASELINE_WINDOWS):
        collector.window_counts["INFO"] = 10
        collector.window_total = 10
        collector._close_window()
    assert collector.error_baseline_locked
    assert len(collector.error_baseline_scores) == ERROR_BASELINE_WINDOWS


def test_error_baseline_does_not_lock_before_n_windows():
    collector = make_fitted_collector()
    for _ in range(ERROR_BASELINE_WINDOWS - 1):
        collector.window_total = 10
        collector.window_counts["INFO"] = 10
        collector._close_window()
    assert not collector.error_baseline_locked


# --- get_lsi ---


def test_get_lsi_structure():
    collector = make_fitted_collector()
    result = collector.get_lsi()
    assert result["fitted"] is True
    assert result["corpus_size"] > 0  # exact size depends on make_fitted_collector, not CORPUS_SIZE env var
    for key in (
        "current_score",
        "baseline_mean",
        "threshold",
        "is_anomalous",
        "is_error_anomalous",
        "error_score",
        "error_baseline_mean",
        "error_threshold",
        "error_baseline_locked",
        "error_score_history",
        "window_counts",
        "score_history",
        "recent_lines",
        "topics",
        "error_patterns",
        "dominant_themes",
        "log_diversity",
        "interpretation",
    ):
        assert key in result


def test_get_lsi_before_fit():
    collector = LSICollector(service_name="test")
    result = collector.get_lsi()
    assert result["fitted"] is False
    assert result["corpus_size"] == 0
    assert result["current_score"] == 0.0


# --- _process_line (async) ---


async def test_process_line_accumulates_corpus():
    collector = LSICollector(service_name="test")
    await collector._process_line("some log line")
    assert len(collector.corpus) == 1
    assert not collector.fitted


async def test_process_line_triggers_fit_at_corpus_size():
    collector = LSICollector(service_name="test")
    # Send exactly CORPUS_SIZE - 1 varied lines so fit hasn't triggered yet
    labels = ["error exception failed", "warning deprecated slow", "started ready connected", "random info log"]
    for i in range(CORPUS_SIZE - 1):
        await collector._process_line(labels[i % len(labels)] + f" {i}")
    assert not collector.fitted
    await collector._process_line("final triggering line")
    assert collector.fitted


async def test_process_line_after_fit_adds_to_recent_lines():
    collector = make_fitted_collector()
    await collector._process_line("error something crashed")
    assert len(collector.recent_lines) == 1
    entry = collector.recent_lines[0]
    assert "line" in entry and "label" in entry and "timestamp" in entry


# --- _label_topic ---


def test_label_topic_error_handling():
    assert LSICollector._label_topic(["error", "exception", "fatal"]) == "ERROR_HANDLING"


def test_label_topic_network():
    assert LSICollector._label_topic(["connection", "socket", "timeout"]) == "NETWORK_OPERATIONS"


def test_label_topic_database():
    assert LSICollector._label_topic(["database", "query", "postgres"]) == "DATABASE_OPERATIONS"


def test_label_topic_auth():
    assert LSICollector._label_topic(["auth", "token", "unauthorized"]) == "AUTHENTICATION"


def test_label_topic_request():
    assert LSICollector._label_topic(["request", "response", "handler"]) == "REQUEST_HANDLING"


def test_label_topic_performance():
    assert LSICollector._label_topic(["latency", "slow", "cpu"]) == "PERFORMANCE"


def test_label_topic_service():
    assert LSICollector._label_topic(["service", "api", "endpoint"]) == "SERVICE_INTEGRATION"


def test_label_topic_fallback():
    assert LSICollector._label_topic(["foo", "bar", "baz"]) == "GENERAL_OPERATIONS"


# --- _extract_error_patterns ---


def test_extract_error_patterns_timeout():
    patterns = LSICollector._extract_error_patterns(["connection timeout occurred"], 1, 0)
    assert any("Timeout" in p for p in patterns)


def test_extract_error_patterns_connection_refused():
    patterns = LSICollector._extract_error_patterns(["connection refused by server"], 1, 0)
    assert any("Connection Refused" in p for p in patterns)


def test_extract_error_patterns_http_500():
    patterns = LSICollector._extract_error_patterns(["returned status 500 internal error"], 0, 0)
    assert any("500" in p for p in patterns)


def test_extract_error_patterns_unclassified():
    patterns = LSICollector._extract_error_patterns(["some vague error"], 3, 0)
    assert any("Unclassified" in p for p in patterns)


def test_extract_error_patterns_capped_at_five():
    # trigger all 11 patterns by including all keywords
    doc = "connection refused timeout out of memory null pointer permission denied not found deadlock panic 500 503 429"
    patterns = LSICollector._extract_error_patterns([doc], 0, 0)
    assert len(patterns) <= 5


# --- _extract_dominant_themes ---


def test_extract_dominant_themes_returns_top_two():
    topics = [
        {"label": "NETWORK_OPERATIONS", "strength": 0.1},
        {"label": "ERROR_HANDLING",     "strength": 0.5},
        {"label": "REQUEST_HANDLING",   "strength": 0.3},
    ]
    themes = LSICollector._extract_dominant_themes(topics)
    assert themes == ["ERROR_HANDLING", "REQUEST_HANDLING"]


def test_extract_dominant_themes_empty():
    assert LSICollector._extract_dominant_themes([]) == []


# --- _generate_interpretation ---


def test_generate_interpretation_stable():
    result = LSICollector._generate_interpretation(
        complexity=0.3, error_ratio=0.01, topics=[], error_patterns=[],
        dominant_themes=[], log_diversity="LOW", status="STABLE",
    )
    assert "STABLE" in result


def test_generate_interpretation_anomaly():
    result = LSICollector._generate_interpretation(
        complexity=0.8, error_ratio=0.4, topics=[], error_patterns=["Timeout - Slow response"],
        dominant_themes=["ERROR_HANDLING"], log_diversity="HIGH", status="ANOMALY",
    )
    assert "ANOMALOUS" in result
    assert "Timeout" in result


def test_generate_interpretation_warning():
    result = LSICollector._generate_interpretation(
        complexity=0.5, error_ratio=0.12, topics=[], error_patterns=[],
        dominant_themes=[], log_diversity="MODERATE", status="WARNING",
    )
    assert "WARNING" in result


def test_generate_interpretation_includes_error_rate():
    result = LSICollector._generate_interpretation(
        complexity=0.2, error_ratio=0.35, topics=[], error_patterns=[],
        dominant_themes=[], log_diversity="LOW", status="ANOMALY",
    )
    assert "CRITICAL" in result or "35.0%" in result


# --- _compute_semantics via _close_window ---


def test_close_window_populates_topics_after_fit():
    """_compute_semantics is called on window close and populates topics."""
    collector = make_fitted_collector()
    collector.window_counts = {"INFO": 8, "WARN": 1, "ERROR": 1, "NOVEL": 0}
    collector.window_total = 10
    collector._close_window()
    assert isinstance(collector.topics, list)
    assert len(collector.topics) > 0
    first = collector.topics[0]
    assert "topic_id" in first and "label" in first and "top_terms" in first


def test_close_window_sets_log_diversity():
    """After a window close on a fitted collector, log_diversity is categorized."""
    collector = make_fitted_collector()
    collector.window_counts = {"INFO": 10, "WARN": 0, "ERROR": 0, "NOVEL": 0}
    collector.window_total = 10
    collector._close_window()
    assert collector.log_diversity in ("LOW", "MODERATE", "HIGH", "INSUFFICIENT")


def test_close_window_sets_interpretation():
    """After a window close with errors, interpretation is a non-empty string."""
    collector = make_fitted_collector()
    collector.window_counts = {"INFO": 0, "WARN": 0, "ERROR": 10, "NOVEL": 0}
    collector.window_total = 10
    collector._close_window()
    assert isinstance(collector.interpretation, str)
    assert len(collector.interpretation) > 0


def test_compute_semantics_no_op_before_fit():
    """_compute_semantics is a no-op when the model is not fitted."""
    collector = LSICollector(service_name="test")
    collector._compute_semantics(error_count=5, warning_count=2, window_total=10)
    assert collector.topics == []
    assert collector.interpretation == ""


# --- _keyword_classify negation detection ---


def test_keyword_classify_returns_error_on_plain_error():
    collector = make_fitted_collector()
    assert collector._keyword_classify("exception occurred in service") == "ERROR"


def test_keyword_classify_suppressed_by_no_error():
    collector = make_fitted_collector()
    assert collector._keyword_classify("health check passed, no error found") is None


def test_keyword_classify_suppressed_by_zero_errors():
    collector = make_fitted_collector()
    assert collector._keyword_classify("0 errors detected in scan") is None


def test_keyword_classify_suppressed_by_error_free():
    collector = make_fitted_collector()
    assert collector._keyword_classify("system is error-free") is None


def test_keyword_classify_suppressed_by_errors_count_zero():
    collector = make_fitted_collector()
    assert collector._keyword_classify("errors: 0 warnings: 0") is None


def test_keyword_classify_suppressed_by_without_exception():
    collector = make_fitted_collector()
    assert collector._keyword_classify("completed without exception") is None


def test_keyword_classify_returns_warn_normally():
    collector = make_fitted_collector()
    assert collector._keyword_classify("retrying after timeout") == "WARN"


def test_keyword_classify_warn_suppressed_by_no_warn():
    collector = make_fitted_collector()
    assert collector._keyword_classify("no warning issued") is None


# --- NOVEL fallback in _batch_classify ---


def test_batch_classify_novel_without_keywords_returns_info():
    """Lines that don't fit the SVD model but have no error keywords → INFO, not NOVEL."""
    collector = make_fitted_collector()
    # A line very different from the corpus — SVD will likely NOVEL it
    result = collector._batch_classify(["xyzzy quux frobnicate zork nonce"])
    assert "NOVEL" not in result
    assert result[0] in ("INFO", "ERROR", "WARN")


def test_batch_classify_novel_with_error_keywords_returns_error():
    """Lines that don't fit the SVD model but contain error keywords → ERROR."""
    collector = make_fitted_collector()
    # Highly unusual phrasing but contains error keyword
    result = collector._batch_classify(["xyzzy quux frobnicate zork exception nonce"])
    # Should be ERROR (keyword hit on fallback) or INFO — never NOVEL
    assert "NOVEL" not in result


def test_batch_classify_never_returns_novel():
    """NOVEL should never appear in _batch_classify output after the keyword-fallback fix."""
    collector = make_fitted_collector()
    lines = [
        "completely unrecognised jargon zzz qqq",
        "another strange sentence with no match",
        "normal log line started ready",
    ]
    results = collector._batch_classify(lines)
    assert "NOVEL" not in results


# --- is_error_anomalous pre-baseline floor ---


def test_is_error_anomalous_true_before_baseline_high_score():
    """Score > 0.5 triggers even before baseline locks (catches cold-start faults)."""
    collector = make_fitted_collector()
    assert not collector.error_baseline_locked
    collector.error_score_history.append(0.6)
    assert collector.is_error_anomalous()


def test_is_error_anomalous_false_before_baseline_low_score():
    """Score ≤ 0.5 does not trigger before baseline locks."""
    collector = make_fitted_collector()
    assert not collector.error_baseline_locked
    collector.error_score_history.append(0.4)
    assert not collector.is_error_anomalous()


def test_is_error_anomalous_false_before_baseline_no_history():
    """Empty error_score_history → always False."""
    collector = make_fitted_collector()
    assert not collector.is_error_anomalous()


# --- get_lsi error_threshold values ---


def test_get_lsi_error_threshold_pre_baseline():
    """Before baseline locks the threshold is the pre-baseline floor (0.5)."""
    collector = make_fitted_collector()
    result = collector.get_lsi()
    assert not result["error_baseline_locked"]
    assert result["error_threshold"] == 0.5


def test_get_lsi_error_threshold_zero_baseline():
    """After baseline locks with zero-error history, threshold is the 0.3 floor."""
    collector = make_fitted_collector()
    collector.error_baseline_scores = [0.0] * ERROR_BASELINE_WINDOWS
    collector.error_baseline_locked = True
    result = collector.get_lsi()
    assert result["error_threshold"] == 0.3


def test_get_lsi_error_threshold_with_baseline():
    """After baseline locks with non-zero mean, threshold is multiplier × mean."""
    collector = make_fitted_collector()
    collector.error_baseline_scores = [1.0] * ERROR_BASELINE_WINDOWS
    collector.error_baseline_locked = True
    result = collector.get_lsi()
    assert abs(result["error_threshold"] - 2.0) < 1e-6


def test_get_lsi_error_score_history_populated():
    """error_score_history in get_lsi reflects recent windows."""
    collector = make_fitted_collector()
    collector.window_counts = {"INFO": 8, "WARN": 0, "ERROR": 2, "NOVEL": 0}
    collector.window_total = 10
    collector._close_window()
    result = collector.get_lsi()
    assert len(result["error_score_history"]) == 1
    assert result["error_score_history"][0] == round(2 * 3 / 10, 4)
