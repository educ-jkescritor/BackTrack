"""
Rollback Executor.

Docker mode: Docker SDK — pull previous image tag, stop current container, run previous.
K8s mode: subprocess call to kubectl rollout undo deployment/<name> -n <namespace>.
Appends rollback events to /data/rollback_log.json.
"""
import json
import logging
import os
import subprocess
import uuid
from datetime import datetime, timezone
from typing import Optional

from src.config import config
from src.versions import Snapshot, VersionStore

logger = logging.getLogger("backtrack.rollback")

_DATA_DIR = os.getenv("BACKTRACK_DATA_DIR", "/data")
ROLLBACK_LOG_FILE = os.path.join(_DATA_DIR, "rollback_log.json")


class RollbackExecutor:
    """Executes rollback to the last known stable version."""

    def __init__(self, version_store: VersionStore) -> None:
        self.version_store = version_store

    def trigger(self, reason: str, service_name: str = "", first_anomaly_at: str = "") -> dict:
        """
        Main entry point — rolls back to last stable version.
        service_name: the specific deployment/container to roll back (overrides config.target).
        Returns a result dict with success status and details.
        """
        if not config.rollback_enabled:
            msg = "Rollback disabled by BACKTRACK_ROLLBACK_ENABLED=false"
            logger.info(msg)
            return {"success": False, "message": msg}

        last_stable = self.version_store.get_last_stable()
        if last_stable is None:
            msg = "No stable version found — cannot rollback."
            logger.error(msg)
            return {"success": False, "message": msg}

        current_pending = self.version_store.get_current_pending()
        from_tag = current_pending.image_tag if current_pending else "unknown"
        to_tag = last_stable.image_tag

        # Use the specific service name if provided, otherwise fall back to config.target
        target = service_name or config.target

        logger.warning(
            "EXECUTING ROLLBACK: %s → %s (service: %s, reason: %s)",
            from_tag, to_tag, target, reason,
        )

        rollback_triggered_at = datetime.now(timezone.utc).isoformat()
        rollback_completed_at = rollback_triggered_at

        try:
            if config.mode == "docker":
                self._rollback_docker(last_stable, target)
            else:
                self._rollback_kubernetes(target, stable_revision=last_stable.k8s_revision)

            rollback_completed_at = datetime.now(timezone.utc).isoformat()

            # Mark current pending as rolled back
            if current_pending:
                self.version_store.mark_rolled_back(current_pending.id)

            result = {
                "success": True,
                "message": f"Rolled back from {from_tag} to {to_tag}",
                "from_tag": from_tag,
                "to_tag": to_tag,
            }

        except Exception as exc:
            rollback_completed_at = datetime.now(timezone.utc).isoformat()
            result = {
                "success": False,
                "message": f"Rollback failed: {exc}",
                "from_tag": from_tag,
                "to_tag": to_tag,
            }
            logger.exception("Rollback execution failed")

        # Log the rollback event
        self._append_log(
            reason,
            from_tag,
            to_tag,
            result["success"],
            service_name=target,
            rollback_triggered_at=rollback_triggered_at,
            rollback_completed_at=rollback_completed_at,
            first_anomaly_at=first_anomaly_at or rollback_triggered_at,
        )

        return result

    def _rollback_docker(self, stable: Snapshot, target: str = "") -> None:
        """Docker mode: pre-pull image, then recreate container.

        Pre-pulling before stopping eliminates the downtime window that existed
        when the container was removed before the new image was available.
        """
        container_name = target or config.target
        image = stable.image_tag

        # Step 1: pre-pull target image BEFORE touching the running container.
        # Failure here aborts rollback with no impact on the running service.
        logger.info("Pre-pulling rollback image %s ...", image)
        pull_result = subprocess.run(
            ["docker", "pull", image],
            capture_output=True, text=True, timeout=120,
        )
        if pull_result.returncode != 0:
            raise RuntimeError(f"docker pull failed for {image}: {pull_result.stderr.strip()}")

        # Step 2: inspect running container config
        inspect = subprocess.run(
            ["docker", "inspect", container_name],
            capture_output=True, text=True,
        )
        if inspect.returncode != 0:
            raise RuntimeError(f"docker inspect failed: {inspect.stderr.strip()}")

        import json as _json
        attrs = _json.loads(inspect.stdout)[0]
        host_config = attrs.get("HostConfig", {})
        container_config = attrs.get("Config", {})

        network_mode = host_config.get("NetworkMode", "bridge")
        env_list: list[str] = container_config.get("Env") or []
        binds: list[str] = host_config.get("Binds") or []
        port_bindings: dict = host_config.get("PortBindings") or {}

        # Step 3: stop and remove — image is already local, minimising downtime window
        logger.info("Stopping container %s ...", container_name)
        subprocess.run(["docker", "stop", container_name], check=True)
        subprocess.run(["docker", "rm", container_name], check=True)

        # Step 4: start container with rollback image
        cmd = ["docker", "run", "-d", "--name", container_name, "--network", network_mode]
        for e in env_list:
            cmd += ["-e", e]
        for b in binds:
            cmd += ["-v", b]
        for container_port, host_ports in port_bindings.items():
            if host_ports:
                for hp in host_ports:
                    host = hp.get("HostPort", "")
                    if host:
                        cmd += ["-p", f"{host}:{container_port}"]
        cmd.append(image)

        logger.info("Starting container %s with image %s ...", container_name, image)
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            raise RuntimeError(f"docker run failed: {result.stderr.strip()}")
        logger.info("Docker rollback complete.")

    def _rollback_kubernetes(self, target: str = "", stable_revision: int = 0) -> None:
        """K8s mode: kubectl rollout undo to a known-good revision.

        Uses --to-revision=N when a stable revision number is recorded, preventing
        oscillation between two bad revisions (rollout undo without --to-revision
        always goes to the immediately previous revision, which may also be bad).
        """
        name = target or config.target
        if not name and config.k8s_label_selector:
            first_pair = config.k8s_label_selector.split(",")[0]
            name = first_pair.split("=")[-1] if "=" in first_pair else first_pair
        if not name:
            raise ValueError(
                "Cannot determine deployment name for rollback — service_name must be passed."
            )

        # Check current replica count — scale-to-0 defeats rollout undo
        rep_result = subprocess.run(
            ["kubectl", "get", "deployment", name, "-n", config.k8s_namespace,
             "-o", "jsonpath={.spec.replicas}"],
            capture_output=True, text=True,
        )
        current_replicas = int(rep_result.stdout.strip() or "1")

        cmd = [
            "kubectl", "rollout", "undo",
            f"deployment/{name}",
            "-n", config.k8s_namespace,
        ]
        if stable_revision > 0:
            cmd += [f"--to-revision={stable_revision}"]
            logger.info("Rolling back to revision %d", stable_revision)

        logger.info("Running: %s", " ".join(cmd))
        result = subprocess.run(cmd, check=True, capture_output=True, text=True)
        logger.info("kubectl rollout undo output: %s", result.stdout.strip())

        # Wait for rollout to complete (up to 120s) so we know it actually succeeded
        status_cmd = [
            "kubectl", "rollout", "status", f"deployment/{name}",
            "-n", config.k8s_namespace, "--timeout=120s",
        ]
        logger.info("Waiting for rollout status...")
        status_result = subprocess.run(status_cmd, capture_output=True, text=True)
        if status_result.returncode != 0:
            raise RuntimeError(
                f"Rollout did not complete within 120s: {status_result.stderr.strip()}"
            )
        logger.info("Rollout complete: %s", status_result.stdout.strip())

        if current_replicas == 0:
            logger.warning("Deployment was scaled to 0 — restoring to 1 replica.")
            subprocess.run(
                ["kubectl", "scale", "deployment", name,
                 "--replicas=1", "-n", config.k8s_namespace],
                check=True, capture_output=True, text=True,
            )

    def _append_log(
        self,
        reason: str,
        from_tag: str,
        to_tag: str,
        success: bool,
        service_name: str = "",
        rollback_triggered_at: str = "",
        rollback_completed_at: str = "",
        first_anomaly_at: str = "",
    ) -> None:
        """Append a rollback event to the log file."""
        log_dir = os.path.dirname(ROLLBACK_LOG_FILE)
        if log_dir:
            os.makedirs(log_dir, exist_ok=True)
        now = datetime.now(timezone.utc).isoformat()
        log_entry = {
            "id": str(uuid.uuid4()),
            "timestamp": now,
            "first_anomaly_at": first_anomaly_at or rollback_triggered_at or now,
            "rollback_triggered_at": rollback_triggered_at or now,
            "rollback_completed_at": rollback_completed_at or now,
            "reason": reason,
            "from_tag": from_tag,
            "to_tag": to_tag,
            "service_name": service_name,
            "mode": config.mode,
            "success": success,
        }

        entries: list[dict] = []
        if os.path.exists(ROLLBACK_LOG_FILE):
            try:
                with open(ROLLBACK_LOG_FILE, "r") as f:
                    entries = json.load(f)
            except Exception:
                entries = []

        entries.insert(0, log_entry)

        # Atomic write: write to tmp then rename — prevents JSON corruption if process
        # crashes mid-write or two rollbacks trigger simultaneously.
        tmp_file = ROLLBACK_LOG_FILE + ".tmp"
        with open(tmp_file, "w") as f:
            json.dump(entries, f, indent=2)
        os.replace(tmp_file, ROLLBACK_LOG_FILE)

    @staticmethod
    def get_history() -> list[dict]:
        """Read rollback log file."""
        if not os.path.exists(ROLLBACK_LOG_FILE):
            return []
        try:
            with open(ROLLBACK_LOG_FILE, "r") as f:
                return json.load(f)
        except Exception:
            return []
