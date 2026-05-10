"use client";

import { ExternalLink, GitBranch, GitCommit, ImageIcon, Package, RefreshCw, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import type { CICDData, CICDImageTag, CICDWorkflowRun } from "@/lib/monitoring-types";

function formatRelTime(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function WorkflowBadge({ run }: { run: CICDWorkflowRun }) {
  if (run.status === "in_progress" || run.status === "queued" || run.status === "waiting") {
    const label = run.status === "in_progress" ? "running" : run.status;
    return (
      <span className="inline-flex items-center gap-1 bt-chip bt-chip-amber">
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent-amber)] animate-pulse" />
        {label}
      </span>
    );
  }
  if (run.conclusion === "success") return <span className="bt-chip bt-chip-green">passed</span>;
  if (run.conclusion === "failure" || run.conclusion === "timed_out") {
    return <span className="bt-chip" style={{ color: "#f87171", borderColor: "rgba(248,113,113,0.3)", background: "rgba(248,113,113,0.08)" }}>failed</span>;
  }
  if (run.conclusion === "cancelled") return <span className="bt-chip">cancelled</span>;
  if (run.conclusion === "action_required") return <span className="bt-chip bt-chip-amber">action needed</span>;
  return <span className="bt-chip">{run.conclusion ?? run.status}</span>;
}

type RollbackState = { tag: string; status: "rolling" | "ok" | "error"; message: string };

export default function CICDPanel() {
  const [data, setData] = useState<CICDData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"commits" | "workflows" | "images">("commits");
  const [rollback, setRollback] = useState<RollbackState | null>(null);

  const load = async () => {
    try {
      const res = await fetch("/api/cicd/github", { cache: "no-store" });
      if (res.status === 404) { setData(null); setError(null); setLoading(false); return; }
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed to load CI/CD data.");
      setData(await res.json());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const timer = window.setInterval(load, 30_000);
    const refresh = () => load();
    window.addEventListener("backtrack:connection-updated", refresh);
    return () => { window.clearInterval(timer); window.removeEventListener("backtrack:connection-updated", refresh); };
  }, []);

  const triggerRollback = async (img: CICDImageTag) => {
    if (!window.confirm(`Roll back all services to ${img.tag}?\n\n${img.pullUrl}`)) return;
    setRollback({ tag: img.tag, status: "rolling", message: `Rolling back to ${img.tag}…` });
    try {
      const res = await fetch("/api/cicd/rollback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pullUrl: img.pullUrl, tag: img.tag }),
      });
      const d = await res.json();
      setRollback({
        tag: img.tag,
        status: d.ok ? "ok" : "error",
        message: d.message || (d.ok ? "Rollback complete." : "Rollback failed."),
      });
      if (d.ok) window.dispatchEvent(new Event("backtrack:connection-updated"));
    } catch {
      setRollback({ tag: img.tag, status: "error", message: "Request failed — is the dashboard server running?" });
    }
  };

  // Don't render if no GitHub repo is configured
  if (!loading && !data && !error) return null;

  return (
    <div className="bt-panel h-full flex flex-col overflow-hidden p-5">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 mb-3 flex-shrink-0">
        <div className="flex items-center gap-2">
          <GitBranch size={14} className="text-[var(--accent-violet)]" />
          <span className="bt-label">CI / CD</span>
          {data && (
            <span className="bt-mono text-[10px] text-[var(--text-muted)]">{data.repo}</span>
          )}
        </div>
        {loading && <RefreshCw size={11} className="text-[var(--accent-teal)] animate-spin" />}
      </div>

      {/* Error state */}
      {error && (
        <div className="rounded-xl border border-red-500/20 bg-red-950/10 px-3 py-2 text-[11.5px] text-red-400">
          {error}
        </div>
      )}

      {/* Loading skeleton */}
      {loading && !data && (
        <div className="flex-1 flex items-center justify-center text-[12px] text-[var(--text-muted)]">
          Loading CI/CD data…
        </div>
      )}

      {data && (
        <>
          {/* Tabs */}
          <div className="flex gap-1.5 mb-3 flex-shrink-0">
            {(["commits", "workflows", "images"] as const).map((t) => {
              const counts = { commits: data.commits.length, workflows: data.workflowRuns.length, images: data.imageTags.length };
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTab(t)}
                  className={`flex-1 bt-tab text-center text-[11.5px] capitalize flex items-center justify-center gap-1.5 ${tab === t ? "bt-tab-active" : ""}`}
                >
                  {t === "commits" && <GitCommit size={10} />}
                  {t === "workflows" && <RefreshCw size={10} />}
                  {t === "images" && <Package size={10} />}
                  {t}
                  {counts[t] > 0 && (
                    <span className="bt-mono text-[9px] text-[var(--text-muted)]">{counts[t]}</span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Content */}
          <div className="flex-1 min-h-0 overflow-y-auto scrollbar-hide space-y-1.5">

            {/* Commits */}
            {tab === "commits" && (
              data.commits.length === 0 ? (
                <EmptyState icon={<GitCommit size={20} />} text="No commits found on this branch." />
              ) : data.commits.map((c) => (
                <div key={c.sha} className="flex items-start gap-3 rounded-xl border border-[var(--border-mid)] bg-white/[0.02] px-3 py-2.5 hover:bg-white/[0.035] transition-colors">
                  <span className="bt-mono text-[10.5px] text-[var(--accent-teal)] shrink-0 pt-0.5">{c.shortSha}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-[12px] text-[var(--text-primary)] truncate">{c.message}</p>
                    <p className="bt-mono text-[10px] text-[var(--text-muted)] mt-0.5">{c.author} · {formatRelTime(c.timestamp)}</p>
                  </div>
                  <a href={c.url} target="_blank" rel="noopener noreferrer" className="shrink-0 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors mt-0.5">
                    <ExternalLink size={11} />
                  </a>
                </div>
              ))
            )}

            {/* Workflow runs */}
            {tab === "workflows" && (
              data.workflowRuns.length === 0 ? (
                <EmptyState icon={<RefreshCw size={20} />} text="No workflow runs found. Make sure your token has actions:read scope." />
              ) : data.workflowRuns.map((r) => (
                <div key={r.id} className="flex items-start gap-3 rounded-xl border border-[var(--border-mid)] bg-white/[0.02] px-3 py-2.5 hover:bg-white/[0.035] transition-colors">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-[12px] text-[var(--text-primary)] truncate">{r.name}</span>
                      <WorkflowBadge run={r} />
                    </div>
                    <p className="bt-mono text-[10px] text-[var(--text-muted)]">
                      {r.headSha} · {r.branch} · triggered by {r.triggeredBy} · {formatRelTime(r.startedAt)}
                    </p>
                  </div>
                  <a href={r.url} target="_blank" rel="noopener noreferrer" className="shrink-0 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors mt-0.5">
                    <ExternalLink size={11} />
                  </a>
                </div>
              ))
            )}

            {/* Images */}
            {tab === "images" && (
              <>
                {/* Rollback result banner */}
                {rollback && (
                  <div className={`flex items-center justify-between gap-2 rounded-xl border px-3 py-2 text-[11.5px] mb-1 ${
                    rollback.status === "rolling" ? "border-[var(--border-mid)] text-[var(--text-muted)]" :
                    rollback.status === "ok"      ? "border-emerald-500/25 bg-emerald-950/15 text-emerald-400" :
                                                    "border-red-500/25 bg-red-950/15 text-red-400"
                  }`}>
                    <span className="flex items-center gap-2">
                      {rollback.status === "rolling" && <RefreshCw size={11} className="animate-spin" />}
                      {rollback.message}
                    </span>
                    {rollback.status !== "rolling" && (
                      <button type="button" onClick={() => setRollback(null)} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]">✕</button>
                    )}
                  </div>
                )}

                {data.imageTags.length === 0 ? (
                  <EmptyState
                    icon={<ImageIcon size={20} />}
                    text="No container images found in GHCR. Push images to ghcr.io to track them here."
                    sub={`docker push ghcr.io/${data.repo}:<tag>`}
                  />
                ) : data.imageTags.map((img) => {
                  const isRollingThis = rollback?.status === "rolling" && rollback.tag === img.tag;
                  return (
                    <div key={img.tag + img.pushedAt} className="flex items-center gap-3 rounded-xl border border-[var(--border-mid)] bg-white/[0.02] px-3 py-2.5 hover:bg-white/[0.035] transition-colors">
                      <Package size={11} className="text-[var(--accent-violet)] shrink-0" />
                      <div className="flex-1 min-w-0">
                        <span className="bt-mono text-[12px] text-[var(--text-primary)] truncate block">{img.tag}</span>
                        <p className="bt-mono text-[10px] text-[var(--text-muted)] mt-0.5">
                          {img.pullUrl} · {formatRelTime(img.pushedAt)}
                        </p>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <button
                          type="button"
                          onClick={() => navigator.clipboard.writeText(img.pullUrl).catch(() => {})}
                          className="text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors bt-mono text-[10px] border border-[var(--border-soft)] rounded-md px-2 py-0.5"
                        >
                          copy
                        </button>
                        <button
                          type="button"
                          disabled={rollback?.status === "rolling"}
                          onClick={() => triggerRollback(img)}
                          className="flex items-center gap-1 px-2 py-0.5 rounded-md border border-[rgba(251,191,36,0.35)] bg-[rgba(251,191,36,0.08)] text-[#fcd34d] bt-mono text-[10px] hover:bg-[rgba(251,191,36,0.14)] transition disabled:opacity-40"
                        >
                          <RotateCcw size={9} />
                          {isRollingThis ? "rolling…" : "rollback"}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function EmptyState({ icon, text, sub }: { icon: React.ReactNode; text: string; sub?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
      <span className="text-[var(--text-muted)] opacity-40">{icon}</span>
      <p className="text-[12px] text-[var(--text-muted)]">{text}</p>
      {sub && (
        <code className="bt-mono text-[10.5px] text-[var(--accent-teal)] bg-black/40 border border-[var(--border-soft)] rounded-md px-3 py-1.5">{sub}</code>
      )}
    </div>
  );
}
