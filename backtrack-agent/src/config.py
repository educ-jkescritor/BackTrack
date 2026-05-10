"""
Auto-configuration for Backtrack agent.
Detects Docker vs Kubernetes mode and reads all settings from environment variables.
"""
import json
import os
import logging

from dotenv import load_dotenv

load_dotenv()

logger = logging.getLogger("backtrack.config")

K8S_SERVICE_ACCOUNT_PATH = "/var/run/secrets/kubernetes.io/serviceaccount"


class BacktrackConfig:
    """Reads all configuration from environment variables. Zero hardcoded values."""

    def __init__(self) -> None:
        self.target: str = os.getenv("BACKTRACK_TARGET", "")
        self.k8s_namespace: str = os.getenv("BACKTRACK_K8S_NAMESPACE", "default")
        self.k8s_label_selector: str = os.getenv("BACKTRACK_K8S_LABEL_SELECTOR", "")
        self.tsd_iqr_multiplier: float = float(os.getenv("BACKTRACK_TSD_IQR_MULTIPLIER", "3.0"))
        self.lsi_score_multiplier: float = float(os.getenv("BACKTRACK_LSI_SCORE_MULTIPLIER", "2.0"))
        self.scrape_interval: int = int(os.getenv("BACKTRACK_SCRAPE_INTERVAL", "10"))
        self.rollback_enabled: bool = os.getenv("BACKTRACK_ROLLBACK_ENABLED", "true").lower() == "true"
        self.image_tag: str = os.getenv("BACKTRACK_IMAGE_TAG", "unknown")
        self.clusters: list[dict] = self._parse_clusters()
        self.app_label: str = os.getenv("BACKTRACK_APP_LABEL", "backtrack.app")
        self.exclude_label: str = os.getenv("BACKTRACK_EXCLUDE_LABEL", "backtrack.exclude")
        self.compose_projects: str = os.getenv("BACKTRACK_COMPOSE_PROJECTS", "")
        self.include_orphans: bool = os.getenv("BACKTRACK_INCLUDE_ORPHANS", "false").lower() == "true"
        # Set by /reconfigure — overrides env var without mutating os.environ (thread-safe)
        self._forced_mode: str = ""

    @property
    def mode(self) -> str:
        """Returns 'kubernetes' if forced via reconfigure or env var or inside a K8s pod, else 'docker'."""
        if self._forced_mode:
            return self._forced_mode
        forced = os.getenv("BACKTRACK_MODE", "").lower()
        if forced in ("kubernetes", "k8s"):
            return "kubernetes"
        if os.path.exists(K8S_SERVICE_ACCOUNT_PATH):
            return "kubernetes"
        return "docker"

    def _parse_clusters(self) -> list[dict]:
        raw = os.getenv("BACKTRACK_CLUSTERS", "")
        if raw:
            try:
                clusters = json.loads(raw)
                if isinstance(clusters, list):
                    return [
                        {
                            "name": str(c.get("name", "default")),
                            "kubeconfig": str(c.get("kubeconfig", "")),
                            "namespace": str(c.get("namespace", "default")),
                        }
                        for c in clusters
                        if isinstance(c, dict)
                    ]
            except json.JSONDecodeError:
                logger.warning("BACKTRACK_CLUSTERS is not valid JSON — falling back to single cluster")
        return [
            {
                "name": "default",
                "kubeconfig": os.getenv("KUBECONFIG", ""),
                "namespace": self.k8s_namespace,
            }
        ]

    def validate(self) -> None:
        """Raises ValueError if no target is configured."""
        if not self.target and not self.k8s_label_selector:
            raise ValueError(
                "No target configured. Set BACKTRACK_TARGET (Docker container name) "
                "or BACKTRACK_K8S_LABEL_SELECTOR (Kubernetes label selector). "
                "Example: BACKTRACK_TARGET=my-app or BACKTRACK_K8S_LABEL_SELECTOR=app=my-app"
            )

    def log_startup_summary(self) -> None:
        """Print a clear startup table to stdout."""
        border = "=" * 55
        logger.info(border)
        logger.info("  BACKTRACK AGENT — CONFIGURATION SUMMARY")
        logger.info(border)
        logger.info("  Mode:                %s", self.mode)
        logger.info("  Target:              %s", self.target or "(not set)")
        logger.info("  K8s Namespace:       %s", self.k8s_namespace)
        logger.info("  K8s Label Selector:  %s", self.k8s_label_selector or "(not set)")
        logger.info("  Scrape Interval:     %ds", self.scrape_interval)
        logger.info("  TSD IQR Multiplier:  %.1f", self.tsd_iqr_multiplier)
        logger.info("  LSI Score Multiplier:%.1f", self.lsi_score_multiplier)
        logger.info("  Rollback Enabled:    %s", self.rollback_enabled)
        logger.info("  Image Tag:           %s", self.image_tag)
        logger.info("  App Label:           %s", self.app_label)
        logger.info("  Exclude Label:       %s", self.exclude_label)
        logger.info("  Compose Projects:    %s", self.compose_projects or "(all)")
        logger.info("  Include Orphans:     %s", self.include_orphans)
        logger.info(border)

    def to_dict(self) -> dict:
        """Serialise config for the /config endpoint."""
        return {
            "mode": self.mode,
            "target": self.target,
            "k8s_namespace": self.k8s_namespace,
            "k8s_label_selector": self.k8s_label_selector,
            "scrape_interval": self.scrape_interval,
            "tsd_iqr_multiplier": self.tsd_iqr_multiplier,
            "lsi_score_multiplier": self.lsi_score_multiplier,
            "rollback_enabled": self.rollback_enabled,
            "image_tag": self.image_tag,
            "clusters": self.clusters,
            "app_label": self.app_label,
            "exclude_label": self.exclude_label,
            "compose_projects": self.compose_projects,
            "include_orphans": self.include_orphans,
        }


# Module-level singleton
config = BacktrackConfig()
