"use client";

import { ExternalLink, GitMerge, RotateCcw, Search, Terminal, Triangle } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import RollbackEventCard, { type RollbackEvent } from "./RollbackEventCard";

type AgentSnapshot = {
  id: string;
  timestamp: string;
  image_tag: string;
  status: "PENDING" | "STABLE" | "ROLLED_BACK";
  tsd_baseline: Record<string, number>;
  lsi_baseline: number;
};

type DeploymentVersion = {
  version: string;
  revision?: number;
  status: "Current" | "Available";
  source: "kubernetes" | "github";
  time: string;
  message: string;
  link?: string;
};

type DeploymentItem = {
  name: string;
  namespace: string;
  status: "Success" | "Unknown";
  deployment: string;
  currentVersion: string;
  deployedTime: string;
  source: string;
  versions: DeploymentVersion[];
  versionCount: number;
  commitCount: number;
};

type HistoryResponse = {
  connectionId?: string;
  githubRepo?: string | null;
  deployments?: DeploymentItem[];
};

function RecentDeployment({
  rollbackEvents = [],
  onDismissRollback,
  platform,
}: {
  rollbackEvents?: RollbackEvent[];
  onDismissRollback?: (id: string) => void;
  platform?: string;
}) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<"k8s" | "backtrack">("k8s");
  const [expandedIndex, setExpandedIndex] = useState<number | null>(0);
  const [deployments, setDeployments] = useState<DeploymentItem[]>([]);
  const [connectionId, setConnectionId] = useState<string>("");
  const [isLoading, setIsLoading] = useState(true);
  const [message, setMessage] = useState<string>("");
  const [rollingBackKey, setRollingBackKey] = useState<string>("");
  const hasLoadedRef = useRef(false);

const [agentSnapshots, setAgentSnapshots] = useState<AgentSnapshot[]>([]);
  const [agentOnline, setAgentOnline] = useState(false);
  const [agentRollingBack, setAgentRollingBack] = useState(false);
  const [agentMessage, setAgentMessage] = useState<string>("");

  const loadHistory = async () => {
    if (!hasLoadedRef.current) setIsLoading(true);

    try {
      const historyRes = await fetch("/api/deployments/history", { cache: "no-store" });

      if (!historyRes.ok) throw new Error("Unable to fetch deployment history.");

      const payload = (await historyRes.json()) as HistoryResponse;
      setConnectionId(payload.connectionId || "");
      setDeployments(Array.isArray(payload.deployments) ? payload.deployments : []);
      setMessage("");
      hasLoadedRef.current = true;

    } catch (error: unknown) {
      setDeployments([]);
      setMessage(error instanceof Error ? error.message : "Failed to load deployment history.");
    } finally {
      setIsLoading(false);
    }
  };

  const loadAgentVersions = async () => {
    try {
      const res = await fetch("/api/agent?path=versions", { cache: "no-store" });
      if (!res.ok) { setAgentOnline(false); return; }
      const data = await res.json();
      if (!data.error && Array.isArray(data)) {
        setAgentSnapshots(data);
        setAgentOnline(true);
      } else {
        setAgentOnline(false);
      }
    } catch {
      setAgentOnline(false);
    }
  };

  const rollbackToSnapshot = async (snapshot: AgentSnapshot) => {
    const confirmed = window.confirm(`Rollback to ${snapshot.image_tag}?`);
    if (!confirmed) return;
    setAgentRollingBack(true);
    setAgentMessage("");
    try {
      const res = await fetch("/api/agent?path=rollback/trigger", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ snapshot_id: snapshot.id }),
      });
      const data = await res.json();
      setAgentMessage(data.message || (data.success ? "Rollback triggered." : "Rollback failed."));
      loadAgentVersions();
    } catch {
      setAgentMessage("Failed to reach agent.");
    } finally {
      setAgentRollingBack(false);
    }
  };

  useEffect(() => {
    loadHistory();
    loadAgentVersions();

    const refresh = () => {
      hasLoadedRef.current = false;  // force loading indicator on reconnect
      loadHistory();
      loadAgentVersions();
    };

    const timer = window.setInterval(() => { loadHistory(); loadAgentVersions(); }, 20000);
    window.addEventListener("backtrack:connection-updated", refresh);

    return () => {
      window.clearInterval(timer);
      window.removeEventListener("backtrack:connection-updated", refresh);
    };
  }, []);

  const toggleExpand = (index: number) => {
    setExpandedIndex(expandedIndex === index ? null : index);
  };

  const rollback = async (serviceName: string, version: DeploymentVersion) => {
    if (!connectionId) {
      setMessage("No active connection for rollback.");
      return;
    }

    const label = version.revision ? `revision ${version.revision}` : version.version;
    const confirmed = window.confirm(`Rollback ${serviceName} to ${label}?`);
    if (!confirmed) return;

    const key = `${serviceName}:${label}`;
    setRollingBackKey(key);

    try {
      const response = await fetch("/api/rollback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          connectionId,
          service: serviceName,
          revision: version.revision,
        }),
      });

      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || "Rollback failed.");
      }

      const accessNote = payload.accessUrl ? ` App accessible at ${payload.accessUrl}` : "";
      setMessage(`Rollback completed for ${serviceName}.${accessNote}`);
      loadHistory();
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : "Rollback failed.");
    } finally {
      setRollingBackKey("");
    }
  };

  const successRate = useMemo(() => {
    if (deployments.length === 0) return 0;
    const successful = deployments.filter((deployment) => deployment.status === "Success").length;
    return Math.round((successful / deployments.length) * 100);
  }, [deployments]);

  const snapStatusTokens: Record<string, { chip: string; label: string }> = {
    PENDING:     { chip: "bt-chip bt-chip-amber",   label: "PENDING" },
    STABLE:      { chip: "bt-chip bt-chip-green",   label: "STABLE" },
    ROLLED_BACK: { chip: "bt-chip",                 label: "ROLLED BACK" },
  };

  return (
    <div className="bt-panel h-full flex flex-col overflow-hidden p-5">

      {/* ── Header ── */}
      <div className="flex items-center justify-between gap-3 mb-3 flex-shrink-0">
        <div className="flex items-center gap-2">
          <GitMerge size={14} className="text-[var(--accent-violet)]" />
          <span className="bt-label">Recent Deployment</span>
        </div>
        {successRate > 0 && (
          <span className="bt-mono text-[10.5px] text-[var(--accent-green)]">
            {successRate}% success
          </span>
        )}
      </div>

      {/* ── Tabs ── */}
      <div className="flex gap-1.5 mb-3 flex-shrink-0">
        <button
          type="button"
          onClick={() => setActiveTab("k8s")}
          className={`flex-1 bt-tab text-center text-[11.5px] ${activeTab === "k8s" ? "bt-tab-active" : ""}`}
        >
          {platform === "docker" ? "Docker History" : "K8s History"}
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("backtrack")}
          className={`flex-1 bt-tab text-center text-[11.5px] flex items-center justify-center gap-1.5 ${activeTab === "backtrack" ? "bt-tab-active" : ""}`}
        >
          BackTrack Versions
          <span className={`h-1.5 w-1.5 rounded-full ${agentOnline ? "bg-[var(--accent-teal)]" : "bg-[var(--border-mid)]"}`} />
        </button>
      </div>

      {/* ── Rollback event cards ── */}
      {rollbackEvents.length > 0 && (
        <div className="space-y-2 mb-3 flex-shrink-0">
          {rollbackEvents.map((ev) => (
            <RollbackEventCard
              key={ev.id}
              event={ev}
              onDismiss={onDismissRollback ?? (() => {})}
            />
          ))}
        </div>
      )}

      {/* ── BackTrack Versions tab ── */}
      {activeTab === "backtrack" && (
        <div className="flex-1 min-h-0 overflow-y-auto scrollbar-hide space-y-2">
          {agentMessage && (
            <div className="rounded-xl border border-[var(--border-soft)] bg-white/[0.02] px-3 py-2 text-[12px] text-[var(--text-primary)]">
              {agentMessage}
            </div>
          )}
          {!agentOnline ? (
            <div className="rounded-xl border border-[var(--border-soft)] bg-white/[0.02] p-3 text-[12px] text-[var(--text-muted)]">
              Agent offline — start backtrack-agent on port 8847 to see version history.
            </div>
          ) : agentSnapshots.length === 0 ? (
            <div className="rounded-xl border border-[var(--border-soft)] bg-white/[0.02] p-3 text-[12px] text-[var(--text-muted)]">
              No version snapshots yet.
            </div>
          ) : agentSnapshots.map((snap) => {
            const token = snapStatusTokens[snap.status] ?? snapStatusTokens.PENDING;
            const canRollback = snap.status === "STABLE";
            const relTime = new Date(snap.timestamp).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
            const hasTsd = snap.tsd_baseline && Object.keys(snap.tsd_baseline).length > 0;
            return (
              <div
                key={snap.id}
                className="rounded-xl border border-[var(--border-mid)] bg-white/[0.02] p-3 hover:bg-white/[0.03] transition-colors"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex flex-col gap-1.5 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="bt-mono text-[12.5px] text-[var(--text-primary)] truncate">{snap.image_tag}</span>
                      <span className={token.chip}>{token.label}</span>
                    </div>
                    <span className="bt-mono text-[10.5px] text-[var(--text-muted)]">{relTime}</span>
                    {hasTsd && (
                      <div className="flex gap-3 bt-mono text-[10px] text-[var(--text-muted)]">
                        {snap.tsd_baseline.cpu_percent !== undefined && (
                          <span>CPU <span className="text-[var(--text-secondary)]">{snap.tsd_baseline.cpu_percent.toFixed(1)}%</span></span>
                        )}
                        {snap.tsd_baseline.memory_mb !== undefined && (
                          <span>Mem <span className="text-[var(--text-secondary)]">{snap.tsd_baseline.memory_mb.toFixed(0)} MB</span></span>
                        )}
                        {snap.lsi_baseline > 0 && (
                          <span>LSI <span className="text-[var(--text-secondary)]">{snap.lsi_baseline.toFixed(4)}</span></span>
                        )}
                      </div>
                    )}
                  </div>
                  {canRollback ? (
                    <button
                      type="button"
                      disabled={agentRollingBack}
                      onClick={() => rollbackToSnapshot(snap)}
                      className="flex items-center gap-1 px-2.5 py-1 rounded-lg border border-[rgba(251,191,36,0.35)] bg-[rgba(251,191,36,0.08)] text-[#fcd34d] text-xs transition hover:bg-[rgba(251,191,36,0.14)] disabled:opacity-40 shrink-0"
                    >
                      <RotateCcw size={11} />
                      {agentRollingBack ? "Rolling back…" : "Rollback"}
                    </button>
                  ) : snap.status === "PENDING" ? (
                    <span className="bt-mono text-[10.5px] text-[var(--accent-amber)] shrink-0">Current</span>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── K8s / Docker History tab ── */}
      {activeTab === "k8s" && (
        <>
          {message && (
            <div className="mb-3 shrink-0 rounded-xl border border-[var(--border-soft)] bg-white/[0.02] px-3 py-2 text-[12px] text-[var(--text-primary)]">
              {message}
            </div>
          )}

<div className="flex-1 min-h-0 overflow-y-auto scrollbar-hide">
            {isLoading && (
              <div className="text-[12px] text-[var(--text-muted)] px-1">Loading deployment history…</div>
            )}
            {!isLoading && deployments.length === 0 && (
              platform === "docker" ? (
                <div className="h-full w-full flex flex-col items-center justify-center gap-4 px-6 text-center">
                  <div className="h-16 w-16 rounded-2xl border border-[var(--border-soft)] bg-white/[0.03] flex items-center justify-center">
                    <Terminal size={26} className="text-[var(--accent-teal)] opacity-60" />
                  </div>
                  <div>
                    <p className="text-[15px] font-semibold text-[var(--text-primary)] mb-1.5">No container history yet</p>
                    <p className="text-[12.5px] text-[var(--text-muted)] leading-relaxed">
                      History populates automatically as BackTrack monitors your containers over time.
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5 text-[11px] text-[var(--text-muted)] bt-mono bg-white/[0.02] border border-[var(--border-soft)] rounded-lg px-3 py-1.5">
                    <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent-teal)] animate-pulse" />
                    Monitoring active
                  </div>
                </div>
              ) : (
                <div className="rounded-xl border border-[var(--border-soft)] bg-white/[0.02] p-3 text-[12px] text-[var(--text-muted)]">
                  No deployment history yet. Configure a Kubernetes connection and optional GitHub repo.
                </div>
              )
            )}

            {deployments.map((deployment, index) => (
              <div key={`${deployment.name}-${index}`}>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => toggleExpand(index)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      toggleExpand(index);
                    }
                  }}
                  className="w-full rounded-xl border border-[var(--border-mid)] bg-white/[0.02] hover:bg-white/[0.035] transition-colors p-3 text-left cursor-pointer"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex flex-col gap-1.5 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-[13px] font-medium text-[var(--text-primary)]">{deployment.name}</span>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            router.push(`/anomalies/${encodeURIComponent(deployment.name)}?namespace=${encodeURIComponent(deployment.namespace)}&severity=warning&metric=general&current=—&baseline=—&message=Inspecting+service`);
                          }}
                          className="flex items-center gap-1 px-2 py-0.5 rounded-md border border-[rgba(94,234,212,0.28)] bg-[rgba(94,234,212,0.08)] text-[10px] text-[var(--accent-teal)] hover:bg-[rgba(94,234,212,0.14)] transition"
                        >
                          <Search size={9} />
                          Inspect
                        </button>
                      </div>
                      <div className="flex items-center gap-2 bt-mono text-[10.5px] text-[var(--text-muted)]">
                        <span>{deployment.currentVersion}</span>
                        <span className="h-3 w-px bg-[var(--border-mid)]" />
                        <span>{deployment.deployedTime}</span>
                        <span className="h-3 w-px bg-[var(--border-mid)]" />
                        <span>{deployment.versionCount}v · {deployment.commitCount}c</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2.5 shrink-0">
                      <div className="text-right">
                        <p className="text-[11px] text-[var(--accent-green)] font-medium">{deployment.status}</p>
                        <p className="text-[10.5px] text-[var(--text-muted)] bt-mono">{deployment.source}</p>
                      </div>
                      <Triangle
                        size={12}
                        className={`text-[var(--text-muted)] transition-transform ${expandedIndex === index ? "rotate-0" : "rotate-180"}`}
                      />
                    </div>
                  </div>
                </div>

                {expandedIndex === index && (
                  <div className="mt-1 rounded-xl border border-[var(--border-soft)] bg-white/[0.01] p-3">
                    <div className="flex items-center justify-between mb-2.5">
                      <span className="bt-label text-[9.5px]">Version History</span>
                      <span className="bt-mono text-[10px] text-[var(--text-muted)]">
                        {deployment.versionCount}v · {deployment.commitCount} commits
                      </span>
                    </div>
                    {deployment.versions.length === 0 && (
                      <p className="text-[11px] text-[var(--text-muted)]">No versions available.</p>
                    )}
                    {deployment.versions.map((version, versionIndex) => {
                      const rollbackKey = `${deployment.name}:${version.revision ? `revision ${version.revision}` : version.version}`;
                      const canRollback = version.source === "kubernetes" && version.status !== "Current";
                      const isCurrent = version.status === "Current";

                      return (
                        <div
                          key={`${version.version}-${versionIndex}`}
                          className="flex items-center justify-between px-2 py-2 rounded-lg hover:bg-white/[0.03] transition-colors"
                        >
                          <div className="flex flex-col gap-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="bt-mono text-[12px] text-[var(--text-primary)]">{version.version}</span>
                              <span className={`bt-chip ${version.source === "kubernetes" ? "bt-chip-teal" : "bt-chip-violet"}`}>
                                {version.source}
                              </span>
                              {version.link && (
                                <button
                                  type="button"
                                  onClick={() => window.open(version.link, "_blank", "noopener,noreferrer")}
                                  className="text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
                                >
                                  <ExternalLink size={12} />
                                </button>
                              )}
                            </div>
                            <p className="text-[11px] text-[var(--text-secondary)] truncate">{version.message}</p>
                            <p className="bt-mono text-[10px] text-[var(--text-muted)]">{version.time}</p>
                          </div>

                          <div className="flex items-center gap-1.5 shrink-0 ml-2">
                            {isCurrent && version.source === "kubernetes" && (
                              <button
                                type="button"
                                onClick={() => router.push(`/anomalies/${encodeURIComponent(deployment.name)}?namespace=${encodeURIComponent(deployment.namespace)}&severity=warning&metric=general&current=—&baseline=—&message=Live+view`)}
                                className="flex items-center gap-1 px-2 py-1 rounded-md border border-[rgba(94,234,212,0.28)] bg-[rgba(94,234,212,0.08)] text-[var(--accent-teal)] text-[11px] hover:bg-[rgba(94,234,212,0.14)] transition"
                              >
                                <Terminal size={10} />
                                Live
                              </button>
                            )}
                            {canRollback && (
                              <button
                                type="button"
                                disabled={rollingBackKey === rollbackKey}
                                onClick={() => rollback(deployment.name, version)}
                                className="flex items-center gap-1 px-2.5 py-1 rounded-md border border-[rgba(251,191,36,0.35)] bg-[rgba(251,191,36,0.08)] text-[#fcd34d] text-[11px] hover:bg-[rgba(251,191,36,0.14)] transition disabled:opacity-40"
                              >
                                <RotateCcw size={11} />
                                {rollingBackKey === rollbackKey ? "Rolling…" : "Rollback"}
                              </button>
                            )}
                            {!canRollback && isCurrent && (
                              <span className="bt-mono text-[10.5px] text-[var(--accent-green)]">Current</span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export default RecentDeployment;
