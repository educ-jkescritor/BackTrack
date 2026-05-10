"""
Shared in-process pod state cache backed by the kubernetes Python SDK watch stream.
Replaces per-service kubectl subprocess calls for pod existence checks.
"""
import asyncio
import logging
from typing import Optional

logger = logging.getLogger("backtrack.k8s_pod_cache")


class PodCache:
    def __init__(self) -> None:
        self._pods: dict[str, dict] = {}
        self.available: bool = False
        self._watch_task: Optional[asyncio.Task] = None
        self._stop_event: asyncio.Event = asyncio.Event()

    def get_running_pod(self, service_name: str, namespace: str) -> Optional[str]:
        needle = service_name.lower().replace(".", "-")
        candidates: list[str] = []
        for key, pod in self._pods.items():
            if pod["namespace"] != namespace:
                continue
            if pod["status"] != "Running":
                continue
            pod_name = pod["name"].lower()
            if pod_name == needle or pod_name.startswith(needle + "-"):
                candidates.insert(0, pod["name"])
            elif needle in pod_name:
                candidates.append(pod["name"])
        return candidates[0] if candidates else None

    def get_pods_for_service(self, service_name: str, namespace: str) -> list[str]:
        """Return all running pod names matching service_name in namespace."""
        needle = service_name.lower().replace(".", "-")
        result = []
        for pod in self._pods.values():
            if pod["namespace"] != namespace:
                continue
            if pod["status"] != "Running":
                continue
            pod_name = pod["name"].lower()
            if pod_name == needle or pod_name.startswith(needle + "-") or needle in pod_name:
                result.append(pod["name"])
        return result

    async def start(self, namespace: str) -> None:
        self._stop_event.clear()
        try:
            from kubernetes import client, config as k8s_config, watch  # type: ignore
            try:
                k8s_config.incluster_config()
            except Exception:
                k8s_config.load_kube_config()
            self.available = True
            self._watch_task = asyncio.create_task(
                self._watch_pods(namespace, client, watch)
            )
            logger.info("PodCache started for namespace=%s", namespace)
        except Exception as exc:
            logger.warning("PodCache unavailable (no kubeconfig or SDK): %s", exc)
            self.available = False

    async def stop(self) -> None:
        self._stop_event.set()
        if self._watch_task and not self._watch_task.done():
            self._watch_task.cancel()
            try:
                await self._watch_task
            except asyncio.CancelledError:
                pass
        self._pods.clear()
        logger.info("PodCache stopped")

    async def _watch_pods(self, namespace: str, client_mod, watch_mod) -> None:
        v1 = client_mod.CoreV1Api()
        w = watch_mod.Watch()
        loop = asyncio.get_event_loop()
        try:
            while not self._stop_event.is_set():
                try:
                    # Run the blocking watch in a thread executor
                    await loop.run_in_executor(
                        None, self._sync_watch, v1, w, namespace
                    )
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    logger.warning("Pod watch stream error, restarting in 5s: %s", exc)
                    await asyncio.sleep(5)
        finally:
            try:
                w.stop()
            except Exception:
                pass

    def _sync_watch(self, v1, w, namespace: str) -> None:
        for event in w.stream(
            v1.list_namespaced_pod,
            namespace=namespace,
            timeout_seconds=60,
        ):
            obj = event["object"]
            event_type = event["type"]
            name = obj.metadata.name
            ns = obj.metadata.namespace
            key = f"{ns}/{name}"

            if event_type == "DELETED":
                self._pods.pop(key, None)
            else:
                phase = obj.status.phase or "Unknown"
                node = obj.spec.node_name or ""
                self._pods[key] = {
                    "name": name,
                    "namespace": ns,
                    "status": phase,
                    "node": node,
                }


pod_cache = PodCache()
