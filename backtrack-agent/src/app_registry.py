"""
AppRegistry — service-scoped Docker discovery.
Groups containers into ApplicationGroup objects using a 4-priority ownership model.
"""
import asyncio
import json
import logging
import os
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

logger = logging.getLogger("backtrack.app_registry")

# Networks that are infra-level and must not be used for heuristic grouping
_INFRA_NETWORKS = {"bridge", "host", "none", "kind", "backtrack_default", "backtrack"}


def _parse_labels(labels_str: str) -> dict[str, str]:
    """Parse Docker's comma-separated label string. Values may contain '=' — split on first '=' only."""
    result: dict[str, str] = {}
    if not labels_str:
        return result
    for pair in labels_str.split(","):
        pair = pair.strip()
        if not pair:
            continue
        idx = pair.find("=")
        if idx == -1:
            result[pair] = ""
        else:
            result[pair[:idx]] = pair[idx + 1:]
    return result


@dataclass
class ServiceInfo:
    container_name: str   # actual Docker container name (used for docker logs/stats)
    service_name: str     # logical name (compose service label or container name)
    image: str = ""
    status: str = ""


@dataclass
class ApplicationGroup:
    id: str
    name: str             # app name
    strategy: str         # "label" | "compose" | "network" | "manual"
    services: list[ServiceInfo] = field(default_factory=list)
    compose_project: str = ""
    network: str = ""
    created_at: str = ""
    excluded_containers: list[str] = field(default_factory=list)

    def container_names(self) -> list[str]:
        return [s.container_name for s in self.services]

    def service_names(self) -> list[str]:
        return [s.service_name for s in self.services]


class AppRegistry:
    def __init__(self) -> None:
        from src.config import config as _cfg
        self._cfg = _cfg
        self._data_dir: str = os.getenv("BACKTRACK_DATA_DIR", "/data")
        self._registry_file: str = os.path.join(self._data_dir, "app_registry.json")
        # Manually registered groups — keyed by name
        self._manual: dict[str, ApplicationGroup] = {}
        # Last discovered groups (auto + manual merged)
        self._groups: dict[str, ApplicationGroup] = {}
        self._load_manual()

    # ── Persistence ────────────────────────────────────────────────────────────

    def _load_manual(self) -> None:
        """Load manual registrations from disk on startup."""
        if not os.path.exists(self._registry_file):
            return
        try:
            with open(self._registry_file) as f:
                data = json.load(f)
            for entry in data:
                name = entry.get("name", "")
                if not name:
                    continue
                services = [
                    ServiceInfo(
                        container_name=s["container_name"],
                        service_name=s.get("service_name", s["container_name"]),
                        image=s.get("image", ""),
                        status=s.get("status", ""),
                    )
                    for s in entry.get("services", [])
                ]
                grp = ApplicationGroup(
                    id=entry.get("id", name),
                    name=name,
                    strategy="manual",
                    services=services,
                    compose_project=entry.get("compose_project", ""),
                    network=entry.get("network", ""),
                    created_at=entry.get("created_at", ""),
                    excluded_containers=entry.get("excluded_containers", []),
                )
                self._manual[name] = grp
        except Exception:
            logger.warning("Failed to load app_registry.json")

    def _save_manual(self) -> None:
        """Atomically persist manual registrations."""
        try:
            os.makedirs(self._data_dir, exist_ok=True)
            data = []
            for grp in self._manual.values():
                data.append({
                    "id": grp.id,
                    "name": grp.name,
                    "strategy": grp.strategy,
                    "compose_project": grp.compose_project,
                    "network": grp.network,
                    "created_at": grp.created_at,
                    "excluded_containers": grp.excluded_containers,
                    "services": [
                        {
                            "container_name": s.container_name,
                            "service_name": s.service_name,
                            "image": s.image,
                            "status": s.status,
                        }
                        for s in grp.services
                    ],
                })
            tmp = self._registry_file + ".tmp"
            with open(tmp, "w") as f:
                json.dump(data, f, indent=2)
            os.replace(tmp, self._registry_file)
        except Exception:
            logger.warning("Failed to persist app_registry.json")

    # ── Discovery ──────────────────────────────────────────────────────────────

    async def discover(self) -> list[ApplicationGroup]:
        """
        Run full pipeline: docker ps → parse labels/networks → build groups.
        Manual registrations override auto-discovered groups with same name.
        """
        raw_containers = await self._docker_ps()
        if not raw_containers:
            logger.warning("AppRegistry: docker ps returned no containers")
            self._groups = dict(self._manual)
            return list(self._groups.values())

        # Collect allow-listed compose projects (empty = all)
        allowed_projects: set[str] = set()
        raw_cp = getattr(self._cfg, "compose_projects", os.getenv("BACKTRACK_COMPOSE_PROJECTS", ""))
        if raw_cp:
            allowed_projects = {p.strip().lower() for p in raw_cp.split(",") if p.strip()}

        app_label_key = getattr(self._cfg, "app_label", os.getenv("BACKTRACK_APP_LABEL", "backtrack.app"))
        exclude_label_key = getattr(self._cfg, "exclude_label", os.getenv("BACKTRACK_EXCLUDE_LABEL", "backtrack.exclude"))
        include_orphans = getattr(self._cfg, "include_orphans", os.getenv("BACKTRACK_INCLUDE_ORPHANS", "false").lower() == "true")

        # Groups keyed by name
        groups: dict[str, ApplicationGroup] = {}

        # network → list[container] for heuristic grouping (Priority 3)
        network_map: dict[str, list[dict]] = {}

        for c in raw_containers:
            labels = _parse_labels(c.get("Labels", ""))

            # Excluded containers are never monitored
            if labels.get(exclude_label_key, "").lower() == "true":
                continue

            container_name = (c.get("Names") or "").strip()
            if not container_name:
                continue

            image = (c.get("Image") or "").strip()
            status = (c.get("Status") or "").strip()

            compose_project = labels.get("com.docker.compose.project", "").strip().lower()
            compose_service = labels.get("com.docker.compose.service", "").strip()

            # Skip the backtrack project itself
            if compose_project == "backtrack":
                continue

            # Priority 1 — explicit backtrack.app label
            explicit_app = labels.get(app_label_key, "").strip()
            if explicit_app:
                grp = groups.setdefault(explicit_app, ApplicationGroup(
                    id=explicit_app,
                    name=explicit_app,
                    strategy="label",
                    created_at=datetime.now(timezone.utc).isoformat(),
                ))
                # upgrade strategy if this group was created with lower priority
                grp.strategy = "label"
                svc_name = compose_service or container_name
                svc = ServiceInfo(container_name=container_name, service_name=svc_name, image=image, status=status)
                if container_name not in grp.container_names():
                    grp.services.append(svc)
                continue

            # Priority 2 — compose project label
            if compose_project:
                if allowed_projects and compose_project not in allowed_projects:
                    continue  # not in allowlist
                grp = groups.setdefault(compose_project, ApplicationGroup(
                    id=compose_project,
                    name=compose_project,
                    strategy="compose",
                    compose_project=compose_project,
                    created_at=datetime.now(timezone.utc).isoformat(),
                ))
                svc_name = compose_service or container_name
                svc = ServiceInfo(container_name=container_name, service_name=svc_name, image=image, status=status)
                if container_name not in grp.container_names():
                    grp.services.append(svc)
                continue

            # Priority 3 — shared network (heuristic); collect now, group after loop
            nets = [
                n.strip() for n in (c.get("Networks") or "").split(",")
                if n.strip() and n.strip().lower() not in _INFRA_NETWORKS
            ]
            if nets:
                for net in nets:
                    network_map.setdefault(net, []).append(c)
                continue

            # Priority 4 — orphan
            if include_orphans:
                grp = groups.setdefault(container_name, ApplicationGroup(
                    id=container_name,
                    name=container_name,
                    strategy="network",  # lowest auto priority label
                    created_at=datetime.now(timezone.utc).isoformat(),
                ))
                svc = ServiceInfo(container_name=container_name, service_name=container_name, image=image, status=status)
                if container_name not in grp.container_names():
                    grp.services.append(svc)

        # Process network-heuristic containers (Priority 3)
        for net, containers in network_map.items():
            if len(containers) < 1:
                continue
            # Group name = network name
            grp = groups.setdefault(net, ApplicationGroup(
                id=net,
                name=net,
                strategy="network",
                network=net,
                created_at=datetime.now(timezone.utc).isoformat(),
            ))
            for c in containers:
                cname = (c.get("Names") or "").strip()
                if not cname or cname in grp.container_names():
                    continue
                labels = _parse_labels(c.get("Labels", ""))
                svc_name = labels.get("com.docker.compose.service", "").strip() or cname
                image = (c.get("Image") or "").strip()
                status = (c.get("Status") or "").strip()
                grp.services.append(ServiceInfo(
                    container_name=cname,
                    service_name=svc_name,
                    image=image,
                    status=status,
                ))

        # Remove groups with no services (shouldn't happen but guard)
        groups = {k: v for k, v in groups.items() if v.services}

        # Manual registrations override auto-discovered groups with same name
        for name, manual_grp in self._manual.items():
            groups[name] = manual_grp

        self._groups = groups
        logger.info(
            "AppRegistry discovered %d group(s): %s",
            len(groups), list(groups.keys()),
        )
        return list(groups.values())

    async def _docker_ps(self) -> list[dict]:
        """Run docker ps --format '{{json .}}' and return parsed list."""
        try:
            proc = await asyncio.create_subprocess_exec(
                "docker", "ps", "--format", "{{json .}}",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=15)
            if proc.returncode != 0:
                return []
            containers = []
            for line in stdout.decode().strip().splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    containers.append(json.loads(line))
                except Exception:
                    pass
            return containers
        except Exception as exc:
            logger.warning("docker ps failed: %s", exc)
            return []

    # ── Manual Registration ─────────────────────────────────────────────────────

    def register(self, name: str, container_names: list[str], service_names: list[str] | None = None) -> ApplicationGroup:
        """Manually register an application group and persist it."""
        svc_names = service_names or container_names
        if len(svc_names) < len(container_names):
            svc_names = svc_names + container_names[len(svc_names):]
        services = [
            ServiceInfo(container_name=c, service_name=s)
            for c, s in zip(container_names, svc_names)
        ]
        grp = ApplicationGroup(
            id=name,
            name=name,
            strategy="manual",
            services=services,
            created_at=datetime.now(timezone.utc).isoformat(),
        )
        self._manual[name] = grp
        self._groups[name] = grp
        self._save_manual()
        logger.info("Registered app group '%s' with containers: %s", name, container_names)
        return grp

    def deregister(self, name: str) -> bool:
        removed = self._manual.pop(name, None) is not None
        self._groups.pop(name, None)
        if removed:
            self._save_manual()
            logger.info("Deregistered app group '%s'", name)
        return removed

    def exclude_container(self, group_name: str, container_name: str) -> bool:
        grp = self._groups.get(group_name)
        if grp is None:
            return False
        if container_name not in grp.excluded_containers:
            grp.excluded_containers.append(container_name)
        # Remove from service list if present
        grp.services = [s for s in grp.services if s.container_name != container_name]
        # Persist if manual
        if group_name in self._manual:
            self._save_manual()
        return True

    def find_group_for_container(self, container_name: str) -> Optional[ApplicationGroup]:
        for grp in self._groups.values():
            if container_name in grp.container_names():
                return grp
        return None

    def get_all(self) -> list[ApplicationGroup]:
        return list(self._groups.values())

    def to_api_response(self) -> list[dict]:
        result = []
        for grp in self._groups.values():
            result.append({
                "id": grp.id,
                "name": grp.name,
                "strategy": grp.strategy,
                "compose_project": grp.compose_project,
                "network": grp.network,
                "created_at": grp.created_at,
                "excluded_containers": grp.excluded_containers,
                "services": [
                    {
                        "container_name": s.container_name,
                        "service_name": s.service_name,
                        "image": s.image,
                        "status": s.status,
                    }
                    for s in grp.services
                ],
            })
        return result


# Module-level singleton
app_registry = AppRegistry()
