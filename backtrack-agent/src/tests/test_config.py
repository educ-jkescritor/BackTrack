from unittest.mock import patch

import pytest
from src.config import BacktrackConfig


ENV_VARS = (
    "BACKTRACK_TARGET",
    "BACKTRACK_K8S_NAMESPACE",
    "BACKTRACK_K8S_LABEL_SELECTOR",
    "BACKTRACK_TSD_IQR_MULTIPLIER",
    "BACKTRACK_LSI_SCORE_MULTIPLIER",
    "BACKTRACK_SCRAPE_INTERVAL",
    "BACKTRACK_ROLLBACK_ENABLED",
    "BACKTRACK_IMAGE_TAG",
    "BACKTRACK_MODE",
)


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    for var in ENV_VARS:
        monkeypatch.delenv(var, raising=False)


# --- defaults ---

def test_default_target(monkeypatch):
    assert BacktrackConfig().target == ""


def test_default_k8s_namespace(monkeypatch):
    assert BacktrackConfig().k8s_namespace == "default"


def test_default_k8s_label_selector(monkeypatch):
    assert BacktrackConfig().k8s_label_selector == ""


def test_default_tsd_iqr_multiplier(monkeypatch):
    assert BacktrackConfig().tsd_iqr_multiplier == 3.0


def test_default_lsi_score_multiplier(monkeypatch):
    assert BacktrackConfig().lsi_score_multiplier == 2.0


def test_default_scrape_interval(monkeypatch):
    assert BacktrackConfig().scrape_interval == 10


def test_default_rollback_enabled(monkeypatch):
    assert BacktrackConfig().rollback_enabled is True


def test_default_image_tag(monkeypatch):
    assert BacktrackConfig().image_tag == "unknown"


# --- env var overrides ---

def test_reads_target(monkeypatch):
    monkeypatch.setenv("BACKTRACK_TARGET", "my-app")
    assert BacktrackConfig().target == "my-app"


def test_reads_k8s_namespace(monkeypatch):
    monkeypatch.setenv("BACKTRACK_K8S_NAMESPACE", "prod")
    assert BacktrackConfig().k8s_namespace == "prod"


def test_reads_k8s_label_selector(monkeypatch):
    monkeypatch.setenv("BACKTRACK_K8S_LABEL_SELECTOR", "app=my-app")
    assert BacktrackConfig().k8s_label_selector == "app=my-app"


def test_reads_tsd_iqr_multiplier(monkeypatch):
    monkeypatch.setenv("BACKTRACK_TSD_IQR_MULTIPLIER", "5.0")
    assert BacktrackConfig().tsd_iqr_multiplier == 5.0


def test_reads_lsi_score_multiplier(monkeypatch):
    monkeypatch.setenv("BACKTRACK_LSI_SCORE_MULTIPLIER", "3.5")
    assert BacktrackConfig().lsi_score_multiplier == 3.5


def test_reads_scrape_interval(monkeypatch):
    monkeypatch.setenv("BACKTRACK_SCRAPE_INTERVAL", "30")
    assert BacktrackConfig().scrape_interval == 30


def test_reads_rollback_enabled_false(monkeypatch):
    monkeypatch.setenv("BACKTRACK_ROLLBACK_ENABLED", "false")
    assert BacktrackConfig().rollback_enabled is False


def test_reads_rollback_enabled_case_insensitive(monkeypatch):
    monkeypatch.setenv("BACKTRACK_ROLLBACK_ENABLED", "FALSE")
    assert BacktrackConfig().rollback_enabled is False


def test_reads_image_tag(monkeypatch):
    monkeypatch.setenv("BACKTRACK_IMAGE_TAG", "v2.0.0")
    assert BacktrackConfig().image_tag == "v2.0.0"


# --- mode property ---

def test_mode_defaults_to_docker():
    cfg = BacktrackConfig()
    with patch("os.path.exists", return_value=False):
        assert cfg.mode == "docker"


def test_mode_kubernetes_from_env_keyword(monkeypatch):
    monkeypatch.setenv("BACKTRACK_MODE", "kubernetes")
    assert BacktrackConfig().mode == "kubernetes"


def test_mode_k8s_alias(monkeypatch):
    monkeypatch.setenv("BACKTRACK_MODE", "k8s")
    assert BacktrackConfig().mode == "kubernetes"


def test_mode_env_var_is_case_insensitive(monkeypatch):
    monkeypatch.setenv("BACKTRACK_MODE", "KUBERNETES")
    assert BacktrackConfig().mode == "kubernetes"


def test_mode_kubernetes_from_service_account_path():
    cfg = BacktrackConfig()
    with patch("os.path.exists", return_value=True):
        assert cfg.mode == "kubernetes"


def test_mode_env_var_takes_priority_over_service_account(monkeypatch):
    monkeypatch.setenv("BACKTRACK_MODE", "kubernetes")
    cfg = BacktrackConfig()
    # Even if path doesn't exist, env var wins
    with patch("os.path.exists", return_value=False):
        assert cfg.mode == "kubernetes"


# --- validate ---

def test_validate_raises_when_no_target_no_selector():
    cfg = BacktrackConfig()
    cfg.target = ""
    cfg.k8s_label_selector = ""
    with pytest.raises(ValueError, match="No target configured"):
        cfg.validate()


def test_validate_passes_with_target():
    cfg = BacktrackConfig()
    cfg.target = "my-app"
    cfg.k8s_label_selector = ""
    cfg.validate()  # must not raise


def test_validate_passes_with_label_selector():
    cfg = BacktrackConfig()
    cfg.target = ""
    cfg.k8s_label_selector = "app=my-app"
    cfg.validate()  # must not raise


def test_validate_passes_with_both_set():
    cfg = BacktrackConfig()
    cfg.target = "my-app"
    cfg.k8s_label_selector = "app=my-app"
    cfg.validate()  # must not raise


# --- to_dict ---

def test_to_dict_has_all_keys():
    result = BacktrackConfig().to_dict()
    expected = {
        "mode", "target", "k8s_namespace", "k8s_label_selector",
        "scrape_interval", "tsd_iqr_multiplier", "lsi_score_multiplier",
        "rollback_enabled", "image_tag", "clusters",
        "app_label", "exclude_label", "compose_projects", "include_orphans",
    }
    assert set(result.keys()) == expected


def test_to_dict_values_match_attributes(monkeypatch):
    monkeypatch.setenv("BACKTRACK_TARGET", "my-app")
    monkeypatch.setenv("BACKTRACK_IMAGE_TAG", "v1.2.3")
    monkeypatch.setenv("BACKTRACK_SCRAPE_INTERVAL", "15")
    cfg = BacktrackConfig()
    d = cfg.to_dict()
    assert d["target"] == "my-app"
    assert d["image_tag"] == "v1.2.3"
    assert d["scrape_interval"] == 15
    assert d["rollback_enabled"] == cfg.rollback_enabled
