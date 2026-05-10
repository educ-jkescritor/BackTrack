import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import AsyncClient, ASGITransport

import src.main as main_module
from src.app_registry import AppRegistry, ApplicationGroup, ServiceInfo, _parse_labels
from src.main import (
    STABLE_THRESHOLD_SECONDS,
    _discover_services,
    get_config,
    get_lsi,
    get_metrics,
    get_services,
    get_versions,
    health,
    on_deployment_event,
    polling_loop,
    rollback_history,
    rollback_trigger,
)
from src.deployment_watcher import DeploymentEvent


@pytest.fixture(autouse=True)
def reset_state():
    """Isolate module-level mutable state between tests."""
    main_module.service_monitors.clear()
    main_module.consecutive_anomaly_counts.clear()
    main_module.clean_seconds_map.clear()
    main_module.rollback_cooldown_until.clear()
    main_module.version_store = None
    main_module.rollback_executor = None
    yield
    main_module.service_monitors.clear()
    main_module.consecutive_anomaly_counts.clear()
    main_module.clean_seconds_map.clear()
    main_module.rollback_cooldown_until.clear()
    main_module.version_store = None
    main_module.rollback_executor = None


@pytest.fixture(autouse=True)
def mock_config():
    with patch("src.main.config") as cfg:
        cfg.mode = "docker"
        cfg.target = "my-app"
        cfg.scrape_interval = 10
        cfg.image_tag = "v1.0.0"
        cfg.k8s_namespace = "default"
        yield cfg


def make_tsd(drifting=False, readings=2, crashed=False):
    tsd = MagicMock()
    tsd.is_drifting.return_value = drifting
    tsd.has_crashed.return_value = crashed
    tsd._last_exit_code = 1
    tsd.cpu_history = [1.0] * readings
    tsd.get_metrics.return_value = {"current": {"cpu_percent": 5.0}}
    return tsd


def make_lsi(anomalous=False, fitted=True):
    lsi = MagicMock()
    lsi.is_anomalous.return_value = anomalous
    lsi.is_error_anomalous.return_value = anomalous  # rollback signal mirrors display signal in tests
    lsi.fitted = fitted
    lsi.get_lsi.return_value = {"fitted": fitted, "baseline_mean": 0.5}
    return lsi


# --- /health ---

async def test_health_returns_ok():
    result = await health()
    assert result["status"] == "ok"


async def test_health_includes_mode():
    result = await health()
    assert result["mode"] == "docker"


async def test_health_includes_monitored_services():
    main_module.service_monitors["svc-a"] = (make_tsd(), make_lsi())
    result = await health()
    assert "svc-a" in result["monitored_services"]


async def test_health_uptime_is_non_negative():
    result = await health()
    assert result["uptime_seconds"] >= 0


# --- /config ---

async def test_get_config_delegates_to_config(mock_config):
    mock_config.to_dict.return_value = {"mode": "docker", "target": "my-app"}
    result = await get_config()
    assert result == {"mode": "docker", "target": "my-app"}


# --- /services ---

async def test_get_services_empty_when_no_monitors():
    assert await get_services() == []


async def test_get_services_shape():
    main_module.service_monitors["svc"] = (make_tsd(), make_lsi())
    result = await get_services()
    assert len(result) == 1
    assert result[0]["name"] == "svc"
    assert result[0]["is_drifting"] is False
    assert result[0]["is_anomalous"] is False
    assert result[0]["is_error_anomalous"] is False
    assert result[0]["lsi_fitted"] is True
    assert result[0]["readings_count"] == 2


async def test_get_services_multiple():
    main_module.service_monitors["a"] = (make_tsd(), make_lsi())
    main_module.service_monitors["b"] = (make_tsd(drifting=True), make_lsi(anomalous=True))
    result = await get_services()
    names = {r["name"] for r in result}
    assert names == {"a", "b"}


# --- /metrics ---

async def test_get_metrics_empty_when_no_monitors(mock_config):
    mock_config.target = "nonexistent"
    assert await get_metrics(service="") == {}


async def test_get_metrics_by_name():
    tsd = make_tsd()
    main_module.service_monitors["svc"] = (tsd, make_lsi())
    assert await get_metrics(service="svc") == tsd.get_metrics()


async def test_get_metrics_falls_back_to_first(mock_config):
    mock_config.target = "nonexistent"
    tsd = make_tsd()
    main_module.service_monitors["only"] = (tsd, make_lsi())
    assert await get_metrics(service="") == tsd.get_metrics()


# --- /lsi ---

async def test_get_lsi_empty_when_no_monitors(mock_config):
    mock_config.target = "nonexistent"
    assert await get_lsi(service="") == {}


async def test_get_lsi_by_name():
    lsi = make_lsi()
    main_module.service_monitors["svc"] = (make_tsd(), lsi)
    assert await get_lsi(service="svc") == lsi.get_lsi()


async def test_get_lsi_falls_back_to_first(mock_config):
    mock_config.target = "nonexistent"
    lsi = make_lsi()
    main_module.service_monitors["only"] = (make_tsd(), lsi)
    assert await get_lsi(service="") == lsi.get_lsi()


# --- /versions ---

async def test_get_versions_empty_when_no_store():
    assert await get_versions() == []


async def test_get_versions_delegates_to_store():
    mock_store = MagicMock()
    mock_store.get_all.return_value = [{"id": "abc"}]
    main_module.version_store = mock_store
    assert await get_versions() == [{"id": "abc"}]


# --- /rollback/history ---

async def test_rollback_history_delegates():
    with patch("src.main.RollbackExecutor.get_history", return_value=[{"id": "x"}]):
        result = await rollback_history()
    assert result == [{"id": "x"}]


# --- /rollback/trigger ---

async def test_rollback_trigger_no_executor():
    result = await rollback_trigger()
    assert result["success"] is False
    assert "not initialised" in result["message"].lower()


async def test_rollback_trigger_delegates_to_executor():
    mock_exec = MagicMock()
    mock_exec.trigger.return_value = {"success": True, "message": "done"}
    main_module.rollback_executor = mock_exec
    result = await rollback_trigger(body={})
    assert result["success"] is True
    mock_exec.trigger.assert_called_once_with(reason="Manual trigger via dashboard", service_name="")


# --- _discover_services ---

async def test_discover_docker_returns_target(mock_config):
    mock_config.mode = "docker"
    mock_config.target = "my-container"
    assert await _discover_services() == [("my-container", "")]


async def test_discover_kubernetes_parses_deployments(mock_config):
    mock_config.mode = "kubernetes"
    mock_config.target = ""  # empty target → use kubectl for discovery
    mock_proc = MagicMock()
    mock_proc.communicate = AsyncMock(return_value=(b"api-service\nworker\n", b""))
    with patch("asyncio.create_subprocess_exec", return_value=mock_proc):
        result = await _discover_services()
    assert ("api-service", "app=api-service") in result
    assert ("worker", "app=worker") in result


async def test_discover_kubernetes_with_explicit_target(mock_config):
    """When a target is set for kubernetes mode, return it directly without calling kubectl."""
    mock_config.mode = "kubernetes"
    mock_config.target = "my-service"
    mock_config.k8s_label_selector = ""
    result = await _discover_services()
    assert result == [("my-service", "app=my-service")]


async def test_discover_kubernetes_returns_empty_on_no_deployments(mock_config):
    """No target + kubectl returns empty output → empty list (no fallback)."""
    mock_config.mode = "kubernetes"
    mock_config.target = ""
    mock_proc = MagicMock()
    mock_proc.communicate = AsyncMock(return_value=(b"", b""))
    with patch("asyncio.create_subprocess_exec", return_value=mock_proc):
        result = await _discover_services()
    assert result == []


async def test_discover_kubernetes_returns_empty_on_exception(mock_config):
    """No target + kubectl raises → empty list."""
    mock_config.mode = "kubernetes"
    mock_config.target = ""
    with patch("asyncio.create_subprocess_exec", side_effect=Exception("kubectl not found")):
        result = await _discover_services()
    assert result == []


# --- polling_loop ---

async def _run_n_cycles(n: int) -> None:
    """Run exactly n iterations of the polling loop then cancel it."""
    call_count = 0

    async def limited_sleep(_):
        nonlocal call_count
        call_count += 1
        if call_count > n:
            raise asyncio.CancelledError()

    with patch("asyncio.sleep", side_effect=limited_sleep):
        try:
            await polling_loop()
        except asyncio.CancelledError:
            pass


async def test_polling_loop_no_rollback_before_3_cycles(mock_config):
    main_module.service_monitors["svc"] = (make_tsd(drifting=True), make_lsi(anomalous=True))
    mock_exec = MagicMock()
    main_module.rollback_executor = mock_exec
    await _run_n_cycles(2)
    mock_exec.trigger.assert_not_called()


async def test_polling_loop_triggers_rollback_after_3_cycles(mock_config):
    main_module.service_monitors["svc"] = (make_tsd(drifting=True), make_lsi(anomalous=True))
    mock_exec = MagicMock()
    main_module.rollback_executor = mock_exec
    await _run_n_cycles(3)
    mock_exec.trigger.assert_called_once()


async def test_polling_loop_resets_count_after_clean_cycle(mock_config):
    main_module.service_monitors["svc"] = (make_tsd(drifting=True), make_lsi(anomalous=True))
    mock_exec = MagicMock()
    main_module.rollback_executor = mock_exec

    # 2 anomaly cycles, then 1 clean cycle, then 2 more — should NOT trigger rollback
    tsd = make_tsd(drifting=True)
    lsi = make_lsi(anomalous=True)
    main_module.service_monitors["svc"] = (tsd, lsi)

    call_count = 0

    async def toggling_sleep(_):
        nonlocal call_count
        call_count += 1
        # On the 3rd iteration, flip to clean
        if call_count == 3:
            tsd.is_drifting.return_value = False
            lsi.is_anomalous.return_value = False
            lsi.is_error_anomalous.return_value = False
        if call_count > 5:
            raise asyncio.CancelledError()

    with patch("asyncio.sleep", side_effect=toggling_sleep):
        try:
            await polling_loop()
        except asyncio.CancelledError:
            pass

    mock_exec.trigger.assert_not_called()


async def test_polling_loop_marks_stable_after_threshold(mock_config):
    mock_config.scrape_interval = 10
    tsd = make_tsd(drifting=False)
    lsi = make_lsi(anomalous=False)
    main_module.service_monitors["svc"] = (tsd, lsi)

    mock_store = MagicMock()
    pending = MagicMock()
    pending.id = "pending-id"
    pending.status = "PENDING"
    mock_store.get_current_pending.return_value = pending
    main_module.version_store = mock_store

    # Pre-seed clean time so one more cycle pushes it over the threshold
    main_module.clean_seconds_map["svc"] = STABLE_THRESHOLD_SECONDS - 10

    await _run_n_cycles(1)

    mock_store.mark_stable.assert_called_once_with(
        "pending-id",
        tsd_baseline=tsd.get_metrics().get("current", {}),
        lsi_baseline=lsi.get_lsi().get("baseline_mean", 0.0),
        k8s_revision=0,
    )


# --- _discover_services + app_registry ---

async def test_discover_docker_no_target_calls_app_registry(mock_config):
    """When config.target == '' and mode == 'docker', _discover_services calls app_registry.discover()."""
    mock_config.mode = "docker"
    mock_config.target = ""

    svc = ServiceInfo(container_name="my-container", service_name="my-container")
    grp = ApplicationGroup(id="myapp", name="myapp", strategy="compose", services=[svc])
    mock_discover = AsyncMock(return_value=[grp])

    with patch("src.main.app_registry") as mock_registry:
        mock_registry.discover = mock_discover
        result = await _discover_services()

    mock_discover.assert_called_once()
    assert result == [("my-container", "")]


# --- AppRegistry unit tests ---

def test_app_registry_parses_labels():
    """_parse_labels handles '=' characters in values correctly."""
    labels = "com.docker.compose.project=myapp,mykey=val=with=equals,empty="
    parsed = _parse_labels(labels)
    assert parsed["com.docker.compose.project"] == "myapp"
    assert parsed["mykey"] == "val=with=equals"
    assert parsed["empty"] == ""


async def test_app_registry_label_priority_over_compose():
    """backtrack.app label (Priority 1) beats compose project (Priority 2)."""
    containers = [
        {
            "Names": "my-container",
            "Image": "myimage:latest",
            "Status": "Up",
            "Labels": "backtrack.app=explicit-app,com.docker.compose.project=compose-project,com.docker.compose.service=web",
            "Networks": "",
        }
    ]
    registry = AppRegistry.__new__(AppRegistry)
    registry._cfg = MagicMock(
        app_label="backtrack.app",
        exclude_label="backtrack.exclude",
        compose_projects="",
        include_orphans=False,
    )
    registry._manual = {}
    registry._groups = {}

    with patch.object(registry, "_docker_ps", AsyncMock(return_value=containers)):
        groups = await registry.discover()

    names = {g.name for g in groups}
    assert "explicit-app" in names
    assert "compose-project" not in names


async def test_app_registry_compose_priority_over_network():
    """Compose project label (Priority 2) beats shared network (Priority 3)."""
    containers = [
        {
            "Names": "web",
            "Image": "web:latest",
            "Status": "Up",
            "Labels": "com.docker.compose.project=mystack,com.docker.compose.service=web",
            "Networks": "mystack_default",
        },
        {
            "Names": "db",
            "Image": "postgres:15",
            "Status": "Up",
            "Labels": "com.docker.compose.project=mystack,com.docker.compose.service=db",
            "Networks": "mystack_default",
        },
    ]
    registry = AppRegistry.__new__(AppRegistry)
    registry._cfg = MagicMock(
        app_label="backtrack.app",
        exclude_label="backtrack.exclude",
        compose_projects="",
        include_orphans=False,
    )
    registry._manual = {}
    registry._groups = {}

    with patch.object(registry, "_docker_ps", AsyncMock(return_value=containers)):
        groups = await registry.discover()

    assert len(groups) == 1
    assert groups[0].name == "mystack"
    assert groups[0].strategy == "compose"


async def test_app_registry_excludes_backtrack_project():
    """Containers with com.docker.compose.project=backtrack are excluded."""
    containers = [
        {
            "Names": "backtrack-agent",
            "Image": "backtrack:latest",
            "Status": "Up",
            "Labels": "com.docker.compose.project=backtrack,com.docker.compose.service=agent",
            "Networks": "",
        }
    ]
    registry = AppRegistry.__new__(AppRegistry)
    registry._cfg = MagicMock(
        app_label="backtrack.app",
        exclude_label="backtrack.exclude",
        compose_projects="",
        include_orphans=False,
    )
    registry._manual = {}
    registry._groups = {}

    with patch.object(registry, "_docker_ps", AsyncMock(return_value=containers)):
        groups = await registry.discover()

    assert groups == []


async def test_app_registry_exclude_label():
    """Containers with backtrack.exclude=true are skipped entirely."""
    containers = [
        {
            "Names": "excluded-container",
            "Image": "some:image",
            "Status": "Up",
            "Labels": "backtrack.exclude=true,com.docker.compose.project=myapp",
            "Networks": "",
        }
    ]
    registry = AppRegistry.__new__(AppRegistry)
    registry._cfg = MagicMock(
        app_label="backtrack.app",
        exclude_label="backtrack.exclude",
        compose_projects="",
        include_orphans=False,
    )
    registry._manual = {}
    registry._groups = {}

    with patch.object(registry, "_docker_ps", AsyncMock(return_value=containers)):
        groups = await registry.discover()

    assert groups == []


def _make_registry(app_label="backtrack.app", exclude_label="backtrack.exclude",
                   compose_projects="", include_orphans=False) -> AppRegistry:
    registry = AppRegistry.__new__(AppRegistry)
    registry._cfg = MagicMock(
        app_label=app_label,
        exclude_label=exclude_label,
        compose_projects=compose_projects,
        include_orphans=include_orphans,
    )
    registry._manual = {}
    registry._groups = {}
    return registry


# --- AppRegistry.discover — network grouping (Priority 3) ---

async def test_app_registry_network_grouping():
    containers = [
        {"Names": "api", "Image": "api:1", "Status": "Up", "Labels": "", "Networks": "myapp_net"},
        {"Names": "worker", "Image": "worker:1", "Status": "Up", "Labels": "", "Networks": "myapp_net"},
    ]
    registry = _make_registry()
    with patch.object(registry, "_docker_ps", AsyncMock(return_value=containers)):
        groups = await registry.discover()
    assert len(groups) == 1
    assert groups[0].strategy == "network"
    assert groups[0].name == "myapp_net"
    assert {s.container_name for s in groups[0].services} == {"api", "worker"}


async def test_app_registry_infra_networks_ignored():
    containers = [
        {"Names": "api", "Image": "api:1", "Status": "Up", "Labels": "", "Networks": "bridge"},
        {"Names": "worker", "Image": "worker:1", "Status": "Up", "Labels": "", "Networks": "bridge"},
    ]
    registry = _make_registry()
    with patch.object(registry, "_docker_ps", AsyncMock(return_value=containers)):
        groups = await registry.discover()
    assert groups == []


# --- AppRegistry.discover — orphan (Priority 4) ---

async def test_app_registry_orphan_included_when_flag_set():
    containers = [
        {"Names": "orphan-svc", "Image": "img:1", "Status": "Up", "Labels": "", "Networks": ""},
    ]
    registry = _make_registry(include_orphans=True)
    with patch.object(registry, "_docker_ps", AsyncMock(return_value=containers)):
        groups = await registry.discover()
    assert len(groups) == 1
    assert groups[0].container_names() == ["orphan-svc"]


async def test_app_registry_orphan_excluded_by_default():
    containers = [
        {"Names": "orphan-svc", "Image": "img:1", "Status": "Up", "Labels": "", "Networks": ""},
    ]
    registry = _make_registry(include_orphans=False)
    with patch.object(registry, "_docker_ps", AsyncMock(return_value=containers)):
        groups = await registry.discover()
    assert groups == []


# --- AppRegistry.discover — compose allowlist ---

async def test_app_registry_compose_allowlist_filters():
    containers = [
        {
            "Names": "api", "Image": "api:1", "Status": "Up",
            "Labels": "com.docker.compose.project=allowed,com.docker.compose.service=api",
            "Networks": "",
        },
        {
            "Names": "other", "Image": "other:1", "Status": "Up",
            "Labels": "com.docker.compose.project=blocked,com.docker.compose.service=other",
            "Networks": "",
        },
    ]
    registry = _make_registry(compose_projects="allowed")
    with patch.object(registry, "_docker_ps", AsyncMock(return_value=containers)):
        groups = await registry.discover()
    names = {g.name for g in groups}
    assert "allowed" in names
    assert "blocked" not in names


async def test_app_registry_compose_allowlist_empty_means_all():
    containers = [
        {
            "Names": "a", "Image": "a:1", "Status": "Up",
            "Labels": "com.docker.compose.project=proj-a,com.docker.compose.service=a",
            "Networks": "",
        },
        {
            "Names": "b", "Image": "b:1", "Status": "Up",
            "Labels": "com.docker.compose.project=proj-b,com.docker.compose.service=b",
            "Networks": "",
        },
    ]
    registry = _make_registry(compose_projects="")
    with patch.object(registry, "_docker_ps", AsyncMock(return_value=containers)):
        groups = await registry.discover()
    names = {g.name for g in groups}
    assert "proj-a" in names
    assert "proj-b" in names


# --- AppRegistry.discover — multiple groups / isolation ---

async def test_app_registry_multiple_compose_projects():
    containers = [
        {
            "Names": "frontend-web", "Image": "web:1", "Status": "Up",
            "Labels": "com.docker.compose.project=frontend,com.docker.compose.service=web",
            "Networks": "",
        },
        {
            "Names": "backend-api", "Image": "api:1", "Status": "Up",
            "Labels": "com.docker.compose.project=backend,com.docker.compose.service=api",
            "Networks": "",
        },
    ]
    registry = _make_registry()
    with patch.object(registry, "_docker_ps", AsyncMock(return_value=containers)):
        groups = await registry.discover()
    names = {g.name for g in groups}
    assert "frontend" in names
    assert "backend" in names
    assert len(groups) == 2


async def test_app_registry_container_belongs_to_exactly_one_group():
    """A container with a backtrack.app label must not also appear in a compose group."""
    containers = [
        {
            "Names": "api", "Image": "api:1", "Status": "Up",
            "Labels": "backtrack.app=mystack,com.docker.compose.project=other-project",
            "Networks": "",
        },
    ]
    registry = _make_registry()
    with patch.object(registry, "_docker_ps", AsyncMock(return_value=containers)):
        groups = await registry.discover()
    total_entries = sum(len(g.services) for g in groups)
    assert total_entries == 1
    assert groups[0].name == "mystack"


# --- AppRegistry.discover — manual override ---

async def test_app_registry_manual_overrides_auto_discovered():
    containers = [
        {
            "Names": "api", "Image": "api:1", "Status": "Up",
            "Labels": "com.docker.compose.project=myapp,com.docker.compose.service=api",
            "Networks": "",
        },
    ]
    registry = _make_registry()
    manual = ApplicationGroup(
        id="myapp", name="myapp", strategy="manual",
        services=[ServiceInfo(container_name="api", service_name="api-override")],
    )
    registry._manual = {"myapp": manual}
    with patch.object(registry, "_docker_ps", AsyncMock(return_value=containers)):
        groups = await registry.discover()
    assert len(groups) == 1
    assert groups[0].strategy == "manual"
    assert groups[0].services[0].service_name == "api-override"


async def test_app_registry_docker_ps_failure_returns_manual_groups():
    registry = _make_registry()
    manual = ApplicationGroup(
        id="myapp", name="myapp", strategy="manual",
        services=[ServiceInfo(container_name="api", service_name="api")],
    )
    registry._manual = {"myapp": manual}
    with patch.object(registry, "_docker_ps", AsyncMock(return_value=[])):
        groups = await registry.discover()
    assert len(groups) == 1
    assert groups[0].name == "myapp"


# --- AppRegistry.register / deregister ---

def test_app_registry_register_adds_group(tmp_path):
    registry = _make_registry()
    registry._data_dir = str(tmp_path)
    registry._registry_file = str(tmp_path / "app_registry.json")
    grp = registry.register("myapp", ["api", "worker"], ["api-svc", "worker-svc"])
    assert grp.name == "myapp"
    assert grp.strategy == "manual"
    assert len(grp.services) == 2
    assert grp.services[0].container_name == "api"
    assert grp.services[0].service_name == "api-svc"
    assert "myapp" in registry._groups
    assert "myapp" in registry._manual


def test_app_registry_register_persists(tmp_path):
    registry = _make_registry()
    registry._data_dir = str(tmp_path)
    registry._registry_file = str(tmp_path / "app_registry.json")
    registry.register("myapp", ["api"])
    assert (tmp_path / "app_registry.json").exists()


def test_app_registry_register_defaults_service_names(tmp_path):
    registry = _make_registry()
    registry._data_dir = str(tmp_path)
    registry._registry_file = str(tmp_path / "app_registry.json")
    grp = registry.register("myapp", ["api", "worker"])
    assert grp.services[0].service_name == "api"
    assert grp.services[1].service_name == "worker"


def test_app_registry_deregister_removes_group(tmp_path):
    registry = _make_registry()
    registry._data_dir = str(tmp_path)
    registry._registry_file = str(tmp_path / "app_registry.json")
    registry.register("myapp", ["api"])
    assert registry.deregister("myapp") is True
    assert "myapp" not in registry._groups
    assert "myapp" not in registry._manual


def test_app_registry_deregister_unknown_returns_false():
    registry = _make_registry()
    assert registry.deregister("nonexistent") is False


# --- AppRegistry.exclude_container ---

def test_app_registry_exclude_container_removes_service():
    registry = _make_registry()
    grp = ApplicationGroup(
        id="myapp", name="myapp", strategy="compose",
        services=[
            ServiceInfo(container_name="api", service_name="api"),
            ServiceInfo(container_name="db", service_name="db"),
        ],
    )
    registry._groups = {"myapp": grp}
    assert registry.exclude_container("myapp", "db") is True
    assert "db" not in grp.container_names()
    assert "db" in grp.excluded_containers


def test_app_registry_exclude_container_unknown_group_returns_false():
    registry = _make_registry()
    assert registry.exclude_container("nonexistent", "api") is False


# --- AppRegistry.find_group_for_container ---

def test_app_registry_find_group_for_container():
    registry = _make_registry()
    grp = ApplicationGroup(
        id="myapp", name="myapp", strategy="compose",
        services=[ServiceInfo(container_name="api", service_name="api")],
    )
    registry._groups = {"myapp": grp}
    found = registry.find_group_for_container("api")
    assert found is not None
    assert found.name == "myapp"


def test_app_registry_find_group_for_container_unknown_returns_none():
    registry = _make_registry()
    registry._groups = {}
    assert registry.find_group_for_container("api") is None


# --- AppRegistry.to_api_response ---

def test_app_registry_to_api_response_structure():
    registry = _make_registry()
    grp = ApplicationGroup(
        id="myapp", name="myapp", strategy="compose", compose_project="myapp",
        services=[ServiceInfo(container_name="api", service_name="api", image="api:1", status="Up")],
    )
    registry._groups = {"myapp": grp}
    result = registry.to_api_response()
    assert len(result) == 1
    row = result[0]
    assert row["name"] == "myapp"
    assert row["strategy"] == "compose"
    assert row["compose_project"] == "myapp"
    assert row["services"][0]["container_name"] == "api"
    assert row["services"][0]["image"] == "api:1"


# --- /apps endpoints ---

async def test_list_apps_endpoint_empty():
    with patch("src.main.app_registry") as mock_reg:
        mock_reg.to_api_response.return_value = []
        async with AsyncClient(transport=ASGITransport(app=main_module.app), base_url="http://test") as client:
            resp = await client.get("/apps")
    assert resp.status_code == 200
    assert resp.json() == []


async def test_list_apps_endpoint_returns_groups():
    with patch("src.main.app_registry") as mock_reg:
        mock_reg.to_api_response.return_value = [{"name": "myapp", "strategy": "compose"}]
        async with AsyncClient(transport=ASGITransport(app=main_module.app), base_url="http://test") as client:
            resp = await client.get("/apps")
    assert resp.status_code == 200
    assert resp.json()[0]["name"] == "myapp"


async def test_register_app_endpoint():
    grp = ApplicationGroup(id="myapp", name="myapp", strategy="manual",
                           services=[ServiceInfo(container_name="api", service_name="api")])
    mock_proc = MagicMock()
    mock_proc.communicate = AsyncMock(return_value=(b"api\n", b""))
    mock_proc.returncode = 0
    with patch("src.main.app_registry") as mock_reg, \
         patch("asyncio.create_subprocess_exec", return_value=mock_proc):
        mock_reg.register.return_value = grp
        mock_reg.to_api_response.return_value = [{"name": "myapp"}]
        async with AsyncClient(transport=ASGITransport(app=main_module.app), base_url="http://test") as client:
            resp = await client.post("/apps/register", json={"name": "myapp", "containers": ["api"]})
    assert resp.status_code == 200
    data = resp.json()
    assert data["ok"] is True
    mock_reg.register.assert_called_once_with("myapp", ["api"], None)


async def test_register_app_endpoint_missing_name():
    async with AsyncClient(transport=ASGITransport(app=main_module.app), base_url="http://test") as client:
        resp = await client.post("/apps/register", json={"containers": ["api"]})
    assert resp.status_code == 200
    assert resp.json()["ok"] is False


async def test_register_app_endpoint_missing_containers():
    async with AsyncClient(transport=ASGITransport(app=main_module.app), base_url="http://test") as client:
        resp = await client.post("/apps/register", json={"name": "myapp"})
    assert resp.status_code == 200
    assert resp.json()["ok"] is False


async def test_deregister_app_endpoint():
    with patch("src.main.app_registry") as mock_reg:
        mock_reg.deregister.return_value = True
        async with AsyncClient(transport=ASGITransport(app=main_module.app), base_url="http://test") as client:
            resp = await client.delete("/apps/myapp")
    assert resp.status_code == 200
    assert resp.json()["ok"] is True


async def test_deregister_app_endpoint_not_found():
    with patch("src.main.app_registry") as mock_reg:
        mock_reg.deregister.return_value = False
        async with AsyncClient(transport=ASGITransport(app=main_module.app), base_url="http://test") as client:
            resp = await client.delete("/apps/nonexistent")
    assert resp.status_code == 200
    assert resp.json()["ok"] is False


async def test_exclude_from_app_endpoint():
    with patch("src.main.app_registry") as mock_reg:
        mock_reg.exclude_container.return_value = True
        async with AsyncClient(transport=ASGITransport(app=main_module.app), base_url="http://test") as client:
            resp = await client.post("/apps/myapp/exclude", json={"container": "db"})
    assert resp.status_code == 200
    assert resp.json()["ok"] is True
    mock_reg.exclude_container.assert_called_once_with("myapp", "db")


async def test_exclude_from_app_endpoint_group_not_found():
    with patch("src.main.app_registry") as mock_reg:
        mock_reg.exclude_container.return_value = False
        async with AsyncClient(transport=ASGITransport(app=main_module.app), base_url="http://test") as client:
            resp = await client.post("/apps/myapp/exclude", json={"container": "db"})
    assert resp.status_code == 200
    assert resp.json()["ok"] is False


async def test_app_services_endpoint():
    grp = ApplicationGroup(
        id="myapp", name="myapp", strategy="compose",
        services=[ServiceInfo(container_name="api", service_name="api")],
    )
    with patch("src.main.app_registry") as mock_reg:
        mock_reg.get.return_value = grp
        async with AsyncClient(transport=ASGITransport(app=main_module.app), base_url="http://test") as client:
            resp = await client.get("/apps/myapp/services")
    assert resp.status_code == 200
    data = resp.json()
    assert data["name"] == "myapp"
    assert len(data["services"]) == 1


async def test_app_services_endpoint_not_found():
    with patch("src.main.app_registry") as mock_reg:
        mock_reg.get.return_value = None
        async with AsyncClient(transport=ASGITransport(app=main_module.app), base_url="http://test") as client:
            resp = await client.get("/apps/nonexistent/services")
    assert resp.status_code == 404


# --- /deployment/notify endpoint ---

async def test_deployment_notify_calls_on_deployment_event():
    with patch("src.main.on_deployment_event", new_callable=AsyncMock) as mock_handler:
        async with AsyncClient(transport=ASGITransport(app=main_module.app), base_url="http://test") as client:
            resp = await client.post("/deployment/notify", json={
                "service": "api", "image": "api:v2", "git_sha": "abc123",
            })
    assert resp.status_code == 200
    assert resp.json()["ok"] is True
    mock_handler.assert_called_once()
    event = mock_handler.call_args[0][0]
    assert event.service == "api"
    assert event.image == "api:v2"
    assert event.git_sha == "abc123"
    assert event.source == "ci-push"


async def test_deployment_notify_missing_service_uses_config_target(mock_config):
    mock_config.target = "default-svc"
    with patch("src.main.on_deployment_event", new_callable=AsyncMock):
        async with AsyncClient(transport=ASGITransport(app=main_module.app), base_url="http://test") as client:
            resp = await client.post("/deployment/notify", json={"image": "img:v2"})
    assert resp.status_code == 200
    assert resp.json()["ok"] is True


async def test_deployment_notify_no_service_no_target_returns_error(mock_config):
    mock_config.target = ""
    async with AsyncClient(transport=ASGITransport(app=main_module.app), base_url="http://test") as client:
        resp = await client.post("/deployment/notify", json={})
    assert resp.status_code == 200
    assert resp.json()["ok"] is False


# --- on_deployment_event ---

async def test_on_deployment_event_resets_collector_state():
    tsd = make_tsd()
    lsi = make_lsi()
    main_module.service_monitors["api"] = (tsd, lsi)
    main_module.consecutive_anomaly_counts["api"] = 3
    main_module.clean_seconds_map["api"] = 100
    event = DeploymentEvent(service="api", image="api:v2", git_sha="abc", source="ci-push")
    with patch("src.main.app_registry"):
        await on_deployment_event(event)
    tsd.reset.assert_called_once()
    lsi.reset.assert_called_once()
    assert main_module.consecutive_anomaly_counts.get("api", 0) == 0
    assert main_module.clean_seconds_map.get("api", 0) == 0


async def test_on_deployment_event_adds_pending_version():
    mock_store = MagicMock()
    main_module.version_store = mock_store
    event = DeploymentEvent(service="api", image="api:v3", git_sha="def456", source="ci-push")
    with patch("src.main.app_registry"):
        await on_deployment_event(event)
    mock_store.add_pending.assert_called_once_with(image_tag="api:v3", git_sha="def456")


async def test_on_deployment_event_no_version_store_is_safe():
    main_module.version_store = None
    event = DeploymentEvent(service="api", image="api:v3", source="ci-push")
    with patch("src.main.app_registry"):
        await on_deployment_event(event)  # must not raise


# --- DeploymentEvent.app_group field ---

def test_deployment_event_has_app_group_field():
    event = DeploymentEvent(service="api", image="api:v1", app_group="myapp")
    assert event.app_group == "myapp"


def test_deployment_event_app_group_defaults_to_empty():
    event = DeploymentEvent(service="api")
    assert event.app_group == ""
