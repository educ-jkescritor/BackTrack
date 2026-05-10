"""
DeploymentWatcher — CI/CD-agnostic deployment detection.

Three detection tiers (handled in priority order):

  Tier 1 — CI/CD push (fastest, richest metadata)
    POST /deployment/notify { service, image, git_sha }
    → Handled directly in main.py, calls on_deployment_event()

  Tier 2 — Infrastructure event streams (automatic, no CI/CD needed)
    Kubernetes: kubernetes Watch API on Deployment objects
                fires when deployment.kubernetes.io/revision changes
    Docker:     `docker events` streaming API
                fires on container start with a different image

  Tier 3 — Periodic reconciliation (fallback for missed events)
    Runs every 60s, compares current infra image/revision with last known.
    Catches deployments that happened while the agent was offline or
    while the watch stream was reconnecting.

DeploymentEvent is the common data structure emitted by all three tiers.
The handler (on_deployment_event in main.py) treats them identically.
"""
import asyncio
import dataclasses
import logging
from typing import Awaitable, Callable, Optional

logger = logging.getLogger("backtrack.deployment_watcher")


@dataclasses.dataclass
class DeploymentEvent:
    service:   str
    image:     str = ""
    git_sha:   str = ""
    revision:  int = 0
    # "ci-push" | "k8s-watch" | "docker-events" | "reconciliation"
    source:    str = "unknown"
    app_group: str = ""  # filled by on_deployment_event via app_registry.find_group_for_container()


Handler = Callable[[DeploymentEvent], Awaitable[None]]


class DeploymentWatcher:
    """
    Detects deployments from infrastructure events without requiring CI/CD.
    Instantiated once in main.py startup; stopped on shutdown.
    """

    def __init__(self, handler: Handler) -> None:
        self._handler   = handler
        self._tasks:    list[asyncio.Task] = []
        self._running   = False
        self._services: list[str] = []
        # Tracks last-seen image per service (Docker)
        self._last_images:    dict[str, str] = {}
        # Tracks last-seen revision per deployment (Kubernetes)
        self._last_revisions: dict[str, str] = {}

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    async def start(self, mode: str, namespace: str, services: list[str]) -> None:
        self._running  = True
        self._services = list(services)

        if mode == "kubernetes":
            self._tasks.append(asyncio.create_task(
                self._watch_k8s(namespace), name="k8s-deploy-watch"
            ))
        else:
            self._tasks.append(asyncio.create_task(
                self._watch_docker(services), name="docker-deploy-watch"
            ))

        self._tasks.append(asyncio.create_task(
            self._reconcile(mode, namespace, services), name="deploy-reconcile"
        ))
        logger.info(
            "DeploymentWatcher started (mode=%s services=%s)", mode, services
        )

    async def stop(self) -> None:
        self._running = False
        for t in self._tasks:
            t.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks.clear()
        logger.info("DeploymentWatcher stopped")

    # ── Kubernetes Watch (Tier 2) ─────────────────────────────────────────────

    async def _watch_k8s(self, namespace: str) -> None:
        """Watch Deployment resources for revision annotation increments."""
        loop = asyncio.get_event_loop()
        while self._running:
            try:
                from kubernetes import (  # type: ignore
                    client as k8s_client,
                    config as k8s_config,
                    watch as k8s_watch,
                )
                try:
                    k8s_config.incluster_config()
                except Exception:
                    k8s_config.load_kube_config()

                apps_v1 = k8s_client.AppsV1Api()

                # Seed current revisions so the first ADDED pass doesn't fire events
                await loop.run_in_executor(
                    None, self._seed_k8s_revisions, apps_v1, namespace
                )

                w = k8s_watch.Watch()
                logger.info("K8s deployment watch started (namespace=%s)", namespace)

                await loop.run_in_executor(
                    None, self._sync_watch_k8s, apps_v1, w, namespace, loop
                )

            except asyncio.CancelledError:
                return
            except Exception as exc:
                logger.warning(
                    "K8s deployment watch error, retrying in 15s: %s", exc
                )
                await asyncio.sleep(15)

    def _seed_k8s_revisions(self, apps_v1, namespace: str) -> None:
        """One-shot list to record current revisions before the watch stream connects."""
        try:
            deployments = apps_v1.list_namespaced_deployment(namespace=namespace)
            for dep in deployments.items:
                name = dep.metadata.name
                rev  = (dep.metadata.annotations or {}).get(
                    "deployment.kubernetes.io/revision", "0"
                )
                # Only seed if not already known — don't overwrite state from a reconnect
                if name not in self._last_revisions:
                    self._last_revisions[name] = rev
            logger.debug(
                "Seeded K8s revisions: %d deployments in %s",
                len(deployments.items), namespace,
            )
        except Exception as exc:
            logger.warning("K8s revision seed failed: %s", exc)

    def _sync_watch_k8s(self, apps_v1, w, namespace: str, loop) -> None:
        """Blocking watch loop — runs in a thread executor."""
        for event in w.stream(
            apps_v1.list_namespaced_deployment,
            namespace=namespace,
            timeout_seconds=120,
        ):
            if not self._running:
                w.stop()
                return

            obj        = event["object"]
            event_type = event["type"]
            if event_type not in ("ADDED", "MODIFIED"):
                continue

            name  = obj.metadata.name
            annos = obj.metadata.annotations or {}
            rev   = annos.get("deployment.kubernetes.io/revision", "0")

            prev_rev = self._last_revisions.get(name)
            if prev_rev == rev:
                continue  # no change

            self._last_revisions[name] = rev

            # Skip the initial ADDED pass (seed already handled above)
            if prev_rev is None:
                continue

            containers = (obj.spec.template.spec.containers or [])
            image = containers[0].image if containers else ""

            # Try OCI standard label from pod template annotations
            pod_annos = {}
            if obj.spec.template.metadata:
                pod_annos = obj.spec.template.metadata.annotations or {}
            sha = (
                pod_annos.get("org.opencontainers.image.revision", "")
                or pod_annos.get("git-sha", "")
                or pod_annos.get("app.kubernetes.io/version", "")
            )
            # Fallback: image digest is a stable unique identifier
            if not sha and image and "@sha256:" in image:
                sha = "sha256:" + image.split("@sha256:")[-1][:12]

            logger.info(
                "K8s deployment change: %s  revision %s→%s  image=%s",
                name, prev_rev, rev, image,
            )
            asyncio.run_coroutine_threadsafe(
                self._handler(DeploymentEvent(
                    service=name, image=image, git_sha=sha,
                    revision=int(rev or 0), source="k8s-watch",
                )),
                loop,
            )

    # ── Docker Events (Tier 2) ────────────────────────────────────────────────

    async def _watch_docker(self, services: list[str]) -> None:
        """Stream Docker start events; emit DeploymentEvent on image change."""
        # Seed current images before watching so we can diff
        for svc in services:
            img = await self._docker_current_image(svc)
            if img:
                self._last_images[svc] = img

        proc: Optional[asyncio.subprocess.Process] = None
        while self._running:
            try:
                proc = await asyncio.create_subprocess_exec(
                    "docker", "events",
                    "--filter", "event=start",
                    "--format", "{{.Actor.Attributes.name}}\t{{.Actor.Attributes.image}}",
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                logger.info("Docker events watch started")

                while self._running and proc.stdout:
                    try:
                        raw = await asyncio.wait_for(proc.stdout.readline(), timeout=60)
                    except asyncio.TimeoutError:
                        continue
                    if not raw:
                        break

                    line  = raw.decode().strip()
                    parts = line.split("\t")
                    if len(parts) < 2:
                        continue

                    name, image = parts[0], parts[1]
                    if services and name not in services:
                        continue

                    last = self._last_images.get(name)
                    if last == image:
                        continue  # same image restarted — not a new deployment

                    self._last_images[name] = image
                    sha = await self._docker_label(name, "org.opencontainers.image.revision")
                    if not sha:
                        sha = await self._docker_image_digest(name)

                    logger.info(
                        "Docker deployment detected: %s  %s → %s",
                        name, last or "(first)", image,
                    )
                    await self._handler(DeploymentEvent(
                        service=name, image=image, git_sha=sha,
                        source="docker-events",
                    ))

            except asyncio.CancelledError:
                return
            except Exception as exc:
                logger.warning(
                    "Docker events watch error, retrying in 10s: %s", exc
                )
            finally:
                if proc and proc.returncode is None:
                    try:
                        proc.kill()
                        await proc.wait()
                    except Exception:
                        pass

            if self._running:
                await asyncio.sleep(10)

    async def _docker_label(self, container: str, label: str) -> str:
        try:
            proc = await asyncio.create_subprocess_exec(
                "docker", "inspect", container,
                "--format", f'{{{{index .Config.Labels "{label}"}}}}',
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=5)
            return stdout.decode().strip()
        except Exception:
            return ""

    async def _docker_image_digest(self, container: str) -> str:
        """Return first 19 chars of image digest as a fallback version identifier."""
        try:
            proc = await asyncio.create_subprocess_exec(
                "docker", "inspect", container,
                "--format", "{{.Image}}",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=5)
            d = stdout.decode().strip()
            return d[:19] if d else ""  # "sha256:abc123456789"
        except Exception:
            return ""

    async def _docker_current_image(self, container: str) -> str:
        try:
            proc = await asyncio.create_subprocess_exec(
                "docker", "inspect", container,
                "--format", "{{.Config.Image}}",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=5)
            return stdout.decode().strip() if proc.returncode == 0 else ""
        except Exception:
            return ""

    # ── Reconciliation (Tier 3) ───────────────────────────────────────────────

    async def _reconcile(self, mode: str, namespace: str, services: list[str]) -> None:
        """
        Every 60s compare current infra state against last known.
        Catches deployments that happened while the agent was offline or
        while the event watch stream was reconnecting.
        """
        # Wait for watchers to seed their state before first reconcile
        await asyncio.sleep(90)

        while self._running:
            await asyncio.sleep(60)
            try:
                for svc in list(services):
                    if mode == "kubernetes":
                        await self._reconcile_k8s(svc, namespace)
                    else:
                        await self._reconcile_docker(svc)
            except asyncio.CancelledError:
                return
            except Exception:
                logger.exception("Reconciliation loop error")

    async def _reconcile_k8s(self, service: str, namespace: str) -> None:
        try:
            proc = await asyncio.create_subprocess_exec(
                "kubectl", "get", "deployment", service, "-n", namespace,
                "-o", (
                    "jsonpath={.metadata.annotations.deployment\\.kubernetes\\.io/revision}"
                    "\\t{.spec.template.spec.containers[0].image}"
                ),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=10)
            if proc.returncode != 0:
                return

            parts = stdout.decode().strip().split("\t")
            if len(parts) < 2:
                return

            rev, image = parts[0].strip(), parts[1].strip()
            prev = self._last_revisions.get(service)

            if prev is None:
                self._last_revisions[service] = rev
                return

            if prev != rev:
                sha = ""
                if "@sha256:" in image:
                    sha = "sha256:" + image.split("@sha256:")[-1][:12]
                logger.info(
                    "Reconciliation: %s revision %s → %s", service, prev, rev
                )
                self._last_revisions[service] = rev
                await self._handler(DeploymentEvent(
                    service=service, image=image, git_sha=sha,
                    revision=int(rev or 0), source="reconciliation",
                ))
        except Exception as exc:
            logger.debug("Reconcile K8s check failed for %s: %s", service, exc)

    async def _reconcile_docker(self, service: str) -> None:
        try:
            image = await self._docker_current_image(service)
            if not image:
                return

            prev = self._last_images.get(service)
            if prev is None:
                self._last_images[service] = image
                return

            if prev != image:
                sha = await self._docker_label(service, "org.opencontainers.image.revision")
                logger.info(
                    "Reconciliation: %s image %s → %s", service, prev, image
                )
                self._last_images[service] = image
                await self._handler(DeploymentEvent(
                    service=service, image=image, git_sha=sha,
                    source="reconciliation",
                ))
        except Exception as exc:
            logger.debug("Reconcile Docker check failed for %s: %s", service, exc)
