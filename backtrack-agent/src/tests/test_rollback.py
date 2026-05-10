import json
import subprocess
from unittest.mock import MagicMock, patch

import pytest
from src.rollback.executor import RollbackExecutor
from src.versions import Snapshot


def make_snapshot(image_tag: str, status: str = "STABLE", snap_id: str = "") -> Snapshot:
    return Snapshot(
        id=snap_id or f"id-{image_tag}",
        timestamp="2026-01-01T00:00:00+00:00",
        image_tag=image_tag,
        status=status,
    )


@pytest.fixture()
def mock_config():
    with patch("src.rollback.executor.config") as cfg:
        cfg.rollback_enabled = True
        cfg.mode = "docker"
        cfg.target = "my-app"
        cfg.k8s_namespace = "default"
        cfg.k8s_label_selector = "app=my-app"
        yield cfg


@pytest.fixture()
def mock_store():
    store = MagicMock()
    store.get_last_stable.return_value = make_snapshot("v1.0.0")
    store.get_current_pending.return_value = make_snapshot("v1.1.0", status="PENDING", snap_id="id-pending")
    return store


@pytest.fixture()
def executor(mock_store):
    return RollbackExecutor(version_store=mock_store)


# --- trigger: guards ---

def test_trigger_disabled(mock_config, executor):
    mock_config.rollback_enabled = False
    result = executor.trigger("test")
    assert result["success"] is False
    assert "disabled" in result["message"].lower()


def test_trigger_no_stable_version(mock_config, executor, mock_store):
    mock_store.get_last_stable.return_value = None
    result = executor.trigger("test")
    assert result["success"] is False
    assert "no stable version" in result["message"].lower()


# --- trigger: docker success ---

def test_trigger_docker_returns_correct_tags(mock_config, executor, tmp_path):
    with patch("src.rollback.executor.ROLLBACK_LOG_FILE", str(tmp_path / "log.json")):
        with patch.object(executor, "_rollback_docker"):
            result = executor.trigger("anomaly")

    assert result["success"] is True
    assert result["from_tag"] == "v1.1.0"
    assert result["to_tag"] == "v1.0.0"


def test_trigger_docker_marks_pending_rolled_back(mock_config, executor, mock_store, tmp_path):
    with patch("src.rollback.executor.ROLLBACK_LOG_FILE", str(tmp_path / "log.json")):
        with patch.object(executor, "_rollback_docker"):
            executor.trigger("anomaly")

    mock_store.mark_rolled_back.assert_called_once_with("id-pending")


def test_trigger_kubernetes_dispatches_correctly(mock_config, executor, mock_store, tmp_path):
    mock_config.mode = "kubernetes"
    with patch("src.rollback.executor.ROLLBACK_LOG_FILE", str(tmp_path / "log.json")):
        with patch.object(executor, "_rollback_kubernetes") as mock_rb:
            result = executor.trigger("drift")

    assert result["success"] is True
    mock_rb.assert_called_once()


# --- trigger: no pending snapshot ---

def test_trigger_no_pending_uses_unknown_from_tag(mock_config, executor, mock_store, tmp_path):
    mock_store.get_current_pending.return_value = None
    with patch("src.rollback.executor.ROLLBACK_LOG_FILE", str(tmp_path / "log.json")):
        with patch.object(executor, "_rollback_docker"):
            result = executor.trigger("test")

    assert result["success"] is True
    assert result["from_tag"] == "unknown"
    mock_store.mark_rolled_back.assert_not_called()


# --- trigger: exception during rollback ---

def test_trigger_exception_returns_failure(mock_config, executor, mock_store, tmp_path):
    with patch("src.rollback.executor.ROLLBACK_LOG_FILE", str(tmp_path / "log.json")):
        with patch.object(executor, "_rollback_docker", side_effect=RuntimeError("container gone")):
            result = executor.trigger("test")

    assert result["success"] is False
    assert "container gone" in result["message"]


def test_trigger_exception_does_not_mark_rolled_back(mock_config, executor, mock_store, tmp_path):
    with patch("src.rollback.executor.ROLLBACK_LOG_FILE", str(tmp_path / "log.json")):
        with patch.object(executor, "_rollback_docker", side_effect=RuntimeError("boom")):
            executor.trigger("test")

    mock_store.mark_rolled_back.assert_not_called()


# --- trigger: _append_log always runs ---

def test_trigger_logs_success_event(mock_config, executor, tmp_path):
    log_path = tmp_path / "log.json"
    with patch("src.rollback.executor.ROLLBACK_LOG_FILE", str(log_path)):
        with patch.object(executor, "_rollback_docker"):
            executor.trigger("my reason")

    entries = json.loads(log_path.read_text())
    assert entries[0]["success"] is True
    assert entries[0]["reason"] == "my reason"


def test_trigger_logs_failure_event(mock_config, executor, tmp_path):
    log_path = tmp_path / "log.json"
    with patch("src.rollback.executor.ROLLBACK_LOG_FILE", str(log_path)):
        with patch.object(executor, "_rollback_docker", side_effect=RuntimeError("fail")):
            executor.trigger("my reason")

    entries = json.loads(log_path.read_text())
    assert entries[0]["success"] is False


# --- _rollback_docker ---

def test_rollback_docker_stop_remove_run(mock_config):
    executor = RollbackExecutor(version_store=MagicMock())
    stable = make_snapshot("v1.0.0")

    inspect_output = json.dumps([{
        "HostConfig": {"NetworkMode": "bridge", "PortBindings": {}, "Binds": []},
        "Config": {"Env": []},
    }])
    side_effects = [
        MagicMock(returncode=0, stdout="", stderr=""),  # docker pull
        MagicMock(returncode=0, stdout=inspect_output), # docker inspect
        MagicMock(returncode=0),                        # docker stop
        MagicMock(returncode=0),                        # docker rm
        MagicMock(returncode=0, stdout="abc123"),       # docker run
    ]

    with patch("subprocess.run", side_effect=side_effects) as mock_run:
        executor._rollback_docker(stable)

    called_commands = [c.args[0] for c in mock_run.call_args_list]
    assert any(cmd[0] == "docker" and "stop" in cmd for cmd in called_commands)
    assert any(cmd[0] == "docker" and "rm" in cmd for cmd in called_commands)
    assert any(cmd[0] == "docker" and "run" in cmd for cmd in called_commands)


def test_rollback_docker_propagates_exception(mock_config):
    executor = RollbackExecutor(version_store=MagicMock())
    with patch("subprocess.run", side_effect=RuntimeError("docker down")):
        with pytest.raises(RuntimeError, match="docker down"):
            executor._rollback_docker(make_snapshot("v1.0.0"))


# --- _rollback_kubernetes ---

def test_rollback_kubernetes_correct_command(mock_config):
    executor = RollbackExecutor(version_store=MagicMock())
    side_effects = [
        MagicMock(stdout="1"),           # get replicas
        MagicMock(stdout="rolled back"), # rollout undo
        MagicMock(stdout="successfully rolled out", returncode=0),  # rollout status
    ]

    with patch("subprocess.run", side_effect=side_effects) as mock_run:
        executor._rollback_kubernetes()

    called_commands = [c.args[0] for c in mock_run.call_args_list]
    assert ["kubectl", "rollout", "undo", "deployment/my-app", "-n", "default"] in called_commands


def test_rollback_kubernetes_falls_back_to_label_selector(mock_config):
    mock_config.target = ""
    executor = RollbackExecutor(version_store=MagicMock())
    mock_result = MagicMock(stdout="", returncode=0)

    with patch("subprocess.run", return_value=mock_result) as mock_run:
        executor._rollback_kubernetes()

    # Check at least one call included "deployment/my-app"
    called_commands = [c.args[0] for c in mock_run.call_args_list]
    assert any("deployment/my-app" in cmd for cmd in called_commands)


def test_rollback_kubernetes_raises_on_kubectl_failure(mock_config):
    executor = RollbackExecutor(version_store=MagicMock())
    side_effects = [
        MagicMock(stdout="1"),                           # get replicas succeeds
        subprocess.CalledProcessError(1, "kubectl"),     # rollout undo fails
    ]
    with patch("subprocess.run", side_effect=side_effects):
        with pytest.raises(subprocess.CalledProcessError):
            executor._rollback_kubernetes()


def test_rollback_kubernetes_restores_replicas_when_scaled_to_zero(mock_config):
    """If deployment is at 0 replicas, a scale command is issued after rollout undo."""
    executor = RollbackExecutor(version_store=MagicMock())
    side_effects = [
        MagicMock(stdout="0"),                                              # get replicas → 0
        MagicMock(stdout="rolled back"),                                    # rollout undo
        MagicMock(stdout="successfully rolled out", returncode=0),          # rollout status
        MagicMock(stdout=""),                                               # scale to 1
    ]
    with patch("subprocess.run", side_effect=side_effects) as mock_run:
        executor._rollback_kubernetes()

    assert mock_run.call_count == 4
    scale_cmd = mock_run.call_args_list[3].args[0]
    assert "--replicas=1" in scale_cmd


# --- _append_log ---

def test_append_log_creates_file(mock_config, executor, tmp_path):
    log_path = tmp_path / "log.json"
    with patch("src.rollback.executor.ROLLBACK_LOG_FILE", str(log_path)):
        executor._append_log("test", "v1.1.0", "v1.0.0", True)

    entries = json.loads(log_path.read_text())
    assert len(entries) == 1
    assert entries[0]["from_tag"] == "v1.1.0"
    assert entries[0]["to_tag"] == "v1.0.0"
    assert entries[0]["success"] is True
    assert entries[0]["reason"] == "test"
    assert "id" in entries[0]
    assert "timestamp" in entries[0]


def test_append_log_prepends_newest_first(mock_config, executor, tmp_path):
    log_path = tmp_path / "log.json"
    with patch("src.rollback.executor.ROLLBACK_LOG_FILE", str(log_path)):
        executor._append_log("first", "v1.0", "v0.9", True)
        executor._append_log("second", "v1.1", "v1.0", False)

    entries = json.loads(log_path.read_text())
    assert entries[0]["reason"] == "second"
    assert entries[1]["reason"] == "first"


def test_append_log_survives_corrupt_file(mock_config, executor, tmp_path):
    log_path = tmp_path / "log.json"
    log_path.write_text("not valid json")
    with patch("src.rollback.executor.ROLLBACK_LOG_FILE", str(log_path)):
        executor._append_log("test", "v1.1", "v1.0", True)

    entries = json.loads(log_path.read_text())
    assert len(entries) == 1


# --- get_history ---

def test_get_history_no_file(tmp_path):
    with patch("src.rollback.executor.ROLLBACK_LOG_FILE", str(tmp_path / "missing.json")):
        assert RollbackExecutor.get_history() == []


def test_get_history_returns_entries(tmp_path):
    log_path = tmp_path / "log.json"
    log_path.write_text(json.dumps([{"id": "abc", "success": True}]))
    with patch("src.rollback.executor.ROLLBACK_LOG_FILE", str(log_path)):
        result = RollbackExecutor.get_history()
    assert result == [{"id": "abc", "success": True}]


def test_get_history_returns_empty_on_corrupt_file(tmp_path):
    log_path = tmp_path / "log.json"
    log_path.write_text("not json")
    with patch("src.rollback.executor.ROLLBACK_LOG_FILE", str(log_path)):
        assert RollbackExecutor.get_history() == []
