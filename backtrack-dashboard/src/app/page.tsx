"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Nav from "./components/Nav";
import ContainerHealth from "./components/ContainerHealth";
import RecentDeployment from "@/app/components/RecentDeployment";
import ActiveContainers from "./components/ActiveContainers";
import AnomalyDetection from "./components/AnomalyDetection";
import { Activity, Plug, RefreshCw, Server } from "lucide-react";
import Link from "next/link";
import type { DashboardService, DashboardAnomaly } from "@/lib/monitoring-types";
import type { RollbackEvent } from "@/app/components/RollbackEventCard";
import RollbackToastStack, { type RollbackToast } from "@/app/components/RollbackToast";
import CICDPanel from "@/app/components/CICDPanel";
import RecentRollbacks from "@/app/components/RecentRollbacks";

// Module-level cache — survives page navigation, cleared on full reload
let _overviewCache: { services: DashboardService[]; anomalies: DashboardAnomaly[]; at: Date } | null = null;

export default function Home() {
  const [services, setServices] = useState<DashboardService[]>(_overviewCache?.services ?? []);
  const [anomalies, setAnomalies] = useState<DashboardAnomaly[]>(_overviewCache?.anomalies ?? []);
  const [lastSync, setLastSync] = useState<Date | null>(_overviewCache?.at ?? null);
  const [syncState, setSyncState] = useState<"idle" | "syncing" | "error">("idle");
  const [rollbackEvents, setRollbackEvents] = useState<RollbackEvent[]>([]);
  const [rollbackToasts, setRollbackToasts] = useState<RollbackToast[]>([]);
  const [hasCICD, setHasCICD] = useState(false);

  // Track agent rollback IDs already toasted so we don't double-notify
  const seenRollbackIds = useRef<Set<string>>(new Set());
  const seenRollbackInitialized = useRef(false);

  useEffect(() => {
    const poll = async () => {
      try {
        const res = await fetch("/api/agent?path=rollback/history", { cache: "no-store" });
        if (!res.ok) return;
        const data: Array<{
          id: string;
          service_name: string;
          from_tag: string;
          to_tag: string;
          success: boolean;
          reason: string;
        }> = await res.json();
        if (!Array.isArray(data)) return;

        if (!seenRollbackInitialized.current) {
          // On first load, mark all existing entries as seen — only new ones get toasted
          data.forEach((e) => seenRollbackIds.current.add(e.id));
          seenRollbackInitialized.current = true;
          return;
        }

        const newEntries = data.filter((e) => !seenRollbackIds.current.has(e.id));
        for (const entry of newEntries) {
          seenRollbackIds.current.add(entry.id);
          // Skip manual dashboard rollbacks — they already show a toast via handleAnomalyRollback
          if (entry.reason === "Manual trigger via dashboard") continue;
          setRollbackToasts((prev) => [
            {
              id: crypto.randomUUID(),
              service: entry.service_name || "unknown",
              fromVersion: entry.from_tag || "unknown",
              toVersion: entry.to_tag || "stable",
              status: entry.success ? "success" : "failed",
            },
            ...prev,
          ]);
        }
      } catch {
        // agent unreachable — silent
      }
    };

    poll();
    const timer = setInterval(poll, 10000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const checkCICD = () => {
      fetch("/api/connections", { cache: "no-store" })
        .then((r) => r.json())
        .then((d) => {
          const conns: Array<{ githubRepo?: string }> = Array.isArray(d.connections) ? d.connections : [];
          setHasCICD(conns.some((c) => c.githubRepo));
        })
        .catch(() => {});
    };
    checkCICD();
    window.addEventListener("backtrack:connection-updated", checkCICD);
    return () => window.removeEventListener("backtrack:connection-updated", checkCICD);
  }, []);

  useEffect(() => {
    let active = true;
    let errorCount = 0;
    let timer: number | null = null;

    const load = async () => {
      // Only show full spinner on first load — cached data stays visible during refresh
      if (!_overviewCache) setSyncState("syncing");
      try {
        const response = await fetch("/api/dashboard/overview", { cache: "no-store" });
        const data = await response.json();
        if (!active) return;
        const now = new Date();
        _overviewCache = { services: data.services ?? [], anomalies: data.anomalies ?? [], at: now };
        setServices(data.services ?? []);
        setAnomalies(data.anomalies ?? []);
        setLastSync(now);
        setSyncState("idle");
        errorCount = 0;
      } catch {
        if (!active) return;
        if (!_overviewCache) setServices([]);
        if (!_overviewCache) setAnomalies([]);
        setSyncState("error");
        errorCount++;
      }
      if (active) {
        // Exponential backoff on errors: 10s → 20s → 40s → 60s max
        const delay = errorCount > 0
          ? Math.min(10000 * Math.pow(2, errorCount - 1), 60000)
          : 10000;
        timer = window.setTimeout(load, delay);
      }
    };

    load();

    const refresh = () => { load(); };
    window.addEventListener("backtrack:connection-updated", refresh);

    return () => {
      active = false;
      if (timer !== null) window.clearTimeout(timer);
      window.removeEventListener("backtrack:connection-updated", refresh);
    };
  }, []);

  const lastSyncLabel = useMemo(() => {
    if (!lastSync) return "—";
    return lastSync.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }, [lastSync]);

  const handleAnomalyRollback = (anomaly: DashboardAnomaly) => {
    const evId = crypto.randomUUID();
    const fromVersion = anomaly.current;
    const toVersion = "previous stable";

    const ev: RollbackEvent = {
      id: evId,
      service: anomaly.service,
      fromVersion,
      toVersion,
      reason: `Anomaly threshold breached — ${anomaly.severity.toUpperCase()} severity triggered auto-rollback`,
      metric: anomaly.metric,
      value: anomaly.current,
      baseline: anomaly.baseline,
      phase: "rolling",
    };
    setRollbackEvents((prev) => [ev, ...prev]);

    fetch("/api/rollback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ service: anomaly.service, namespace: anomaly.namespace }),
    })
      .then((res) => res.json())
      .catch(() => ({ success: false }))
      .then((data) => {
        const succeeded = data?.success !== false && !data?.error;
        setTimeout(() => {
          setRollbackEvents((prev) =>
            prev.map((e) => (e.id === evId ? { ...e, phase: "complete" } : e))
          );
          if (succeeded) setAnomalies((prev) => prev.filter((a) => a.id !== anomaly.id));
          setRollbackToasts((prev) => [
            {
              id: crypto.randomUUID(),
              service: anomaly.service,
              fromVersion,
              toVersion,
              status: succeeded ? "success" : "failed",
            },
            ...prev,
          ]);
        }, 3200);
      });
  };

  const handleDismissRollback = (id: string) => {
    setRollbackEvents((prev) => prev.filter((e) => e.id !== id));
  };

  const handleDismissToast = (id: string) => {
    setRollbackToasts((prev) => prev.filter((t) => t.id !== id));
  };

  const healthSummary = useMemo(() => {
    const total = services.length;
    const up = services.filter((s) => s.status === "running").length;
    const down = services.filter((s) => s.status === "down").length;
    return { total, up, down };
  }, [services]);

  return (
    <div className="h-screen w-full flex flex-col bg-transparent overflow-hidden">
      <RollbackToastStack toasts={rollbackToasts} onDismiss={handleDismissToast} />
      <Nav healthSummary={healthSummary} />

      <main className="flex-1 min-h-0 w-full flex flex-col overflow-y-auto">

        {/* ── Full-screen empty state ── */}
        {services.length === 0 && syncState !== "syncing" && lastSync !== null ? (
          <div className="flex-1 flex flex-col items-center justify-center px-6 py-12 bt-rise">
            {/* Glow blob */}
            <div className="absolute inset-0 pointer-events-none overflow-hidden">
              <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[700px] h-[400px] rounded-full bg-[rgba(94,234,212,0.05)] blur-3xl" />
            </div>

            {/* Disconnected socket illustration */}
            <div className="relative mb-8 flex items-center justify-center">
              <svg width="220" height="110" viewBox="0 0 220 110" fill="none" xmlns="http://www.w3.org/2000/svg">
                {/* Left plug body */}
                <rect x="8" y="35" width="52" height="40" rx="8" fill="rgba(94,234,212,0.08)" stroke="rgba(94,234,212,0.35)" strokeWidth="1.5"/>
                {/* Left plug pins */}
                <rect x="56" y="46" width="18" height="6" rx="3" fill="rgba(94,234,212,0.5)"/>
                <rect x="56" y="58" width="18" height="6" rx="3" fill="rgba(94,234,212,0.5)"/>
                {/* Left cable */}
                <path d="M8 55 Q-10 55 -10 55" stroke="rgba(94,234,212,0.2)" strokeWidth="3" strokeLinecap="round"/>
                {/* Left plug prong detail */}
                <rect x="18" y="44" width="8" height="4" rx="2" fill="rgba(94,234,212,0.2)"/>
                <rect x="18" y="52" width="8" height="4" rx="2" fill="rgba(94,234,212,0.2)"/>
                <rect x="18" y="60" width="8" height="4" rx="2" fill="rgba(94,234,212,0.2)"/>

                {/* Right socket body */}
                <rect x="160" y="35" width="52" height="40" rx="8" fill="rgba(167,139,250,0.08)" stroke="rgba(167,139,250,0.35)" strokeWidth="1.5"/>
                {/* Right socket holes */}
                <rect x="146" y="46" width="18" height="6" rx="3" fill="rgba(11,16,26,0.9)" stroke="rgba(167,139,250,0.3)" strokeWidth="1"/>
                <rect x="146" y="58" width="18" height="6" rx="3" fill="rgba(11,16,26,0.9)" stroke="rgba(167,139,250,0.3)" strokeWidth="1"/>
                {/* Right cable */}
                <path d="M212 55 Q230 55 230 55" stroke="rgba(167,139,250,0.2)" strokeWidth="3" strokeLinecap="round"/>
                {/* Right socket detail */}
                <rect x="174" y="44" width="8" height="4" rx="2" fill="rgba(167,139,250,0.2)"/>
                <rect x="174" y="52" width="8" height="4" rx="2" fill="rgba(167,139,250,0.2)"/>
                <rect x="174" y="60" width="8" height="4" rx="2" fill="rgba(167,139,250,0.2)"/>

                {/* Gap / disconnected sparks */}
                <line x1="96" y1="48" x2="124" y2="48" stroke="rgba(100,116,139,0.15)" strokeWidth="1" strokeDasharray="3 3"/>
                <line x1="96" y1="62" x2="124" y2="62" stroke="rgba(100,116,139,0.15)" strokeWidth="1" strokeDasharray="3 3"/>

                {/* Disconnection indicator — X in the gap */}
                <circle cx="110" cy="55" r="14" fill="rgba(239,68,68,0.08)" stroke="rgba(239,68,68,0.25)" strokeWidth="1.2"/>
                <line x1="104" y1="49" x2="116" y2="61" stroke="rgba(239,68,68,0.6)" strokeWidth="1.8" strokeLinecap="round"/>
                <line x1="116" y1="49" x2="104" y2="61" stroke="rgba(239,68,68,0.6)" strokeWidth="1.8" strokeLinecap="round"/>
              </svg>

              {/* Animated pulse ring on the gap */}
              <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 h-8 w-8 rounded-full border border-red-500/20 animate-ping" style={{ animationDuration: "2s" }} />
            </div>

            {/* Heading */}
            <h2 className="bt-display text-[28px] sm:text-[34px] text-white text-center leading-tight mb-2">
              No cluster connected
            </h2>
            <p className="text-[14px] text-[var(--text-secondary)] text-center max-w-md mb-8">
              Connect a <span className="text-[var(--accent-teal)]">Kubernetes cluster</span> or <span className="text-[var(--accent-teal)]">Docker daemon</span> to start monitoring services, detecting anomalies, and triggering auto-rollbacks.
            </p>

            {/* CTA */}
            <button
              type="button"
              onClick={() => window.dispatchEvent(new Event("backtrack:open-configure"))}
              className="inline-flex items-center gap-2.5 rounded-xl border border-[rgba(94,234,212,0.5)] bg-[rgba(94,234,212,0.12)] px-6 py-3 text-[14px] font-semibold text-[#c6f5e8] hover:bg-[rgba(94,234,212,0.22)] hover:shadow-[0_0_30px_rgba(94,234,212,0.18)] transition-all duration-200 mb-10"
            >
              <Plug size={16} className="text-[var(--accent-teal)]" />
              Configure Cluster
            </button>

            {/* Option cards */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 w-full max-w-xl">
              {[
                {
                  icon: <Server size={18} className="text-[var(--accent-teal)]" />,
                  title: "Docker",
                  desc: "Monitor any running container. BackTrack reads CPU, memory, and logs via the Docker socket.",
                  step: "docker ps --format \"{{.Names}}\"",
                },
                {
                  icon: <Activity size={18} className="text-[var(--accent-violet)]" />,
                  title: "Kubernetes",
                  desc: "Discover all deployments in a namespace. TSD and LSI run per-service with auto-rollback via kubectl.",
                  step: "kubectl get deployments -n default",
                },
              ].map((card) => (
                <button
                  key={card.title}
                  type="button"
                  onClick={() => window.dispatchEvent(new Event("backtrack:open-configure"))}
                  className="text-left rounded-xl border border-[var(--border-soft)] bg-white/[0.02] p-4 hover:border-[rgba(94,234,212,0.25)] hover:bg-white/[0.04] transition-all duration-150 group"
                >
                  <div className="flex items-center gap-2 mb-2">
                    {card.icon}
                    <span className="text-[13px] font-semibold text-[var(--text-primary)]">{card.title}</span>
                  </div>
                  <p className="text-[11.5px] text-[var(--text-muted)] mb-3 leading-relaxed">{card.desc}</p>
                  <code className="block bt-mono text-[10.5px] text-[var(--accent-teal)] bg-black/40 border border-[var(--border-soft)] rounded-md px-2.5 py-1.5 truncate">
                    {card.step}
                  </code>
                </button>
              ))}
            </div>

            <p className="mt-8 text-[11px] text-[var(--text-muted)] text-center">
              BackTrack builds a 2-minute baseline after connecting, then anomaly detection and auto-rollback activate automatically.
            </p>
          </div>

        ) : syncState === "syncing" && lastSync === null ? (
          /* ── First-load spinner ── */
          <div className="flex-1 flex items-center justify-center">
            <div className="flex items-center gap-3 text-[13px] text-[var(--text-muted)]">
              <RefreshCw size={14} className="text-[var(--accent-teal)] animate-spin" />
              Connecting to cluster…
            </div>
          </div>

        ) : (
          /* ── Normal dashboard ── */
          <div className="flex-1 min-h-0 flex flex-col gap-3 lg:gap-4 px-4 sm:px-6 lg:px-8 xl:px-10 py-4 lg:py-5">
            {/* Status strip */}
            <section className="bt-rise flex flex-col sm:flex-row sm:items-center justify-between gap-3 flex-shrink-0" style={{ animationDelay: "0ms" }}>
              <div className="flex items-center gap-3">
                <Link href="/anomalies" className="inline-flex items-center gap-2 rounded-full border border-[rgba(148,163,184,0.15)] bg-white/[0.02] px-3 py-1.5 hover:border-[rgba(94,234,212,0.35)] hover:bg-[rgba(94,234,212,0.06)] transition group">
                  <Activity size={14} className="text-[var(--accent-teal)]" />
                  <span className="text-[11px] tracking-[0.18em] uppercase text-[var(--text-secondary)] group-hover:text-[var(--accent-teal)] transition">
                    Live Telemetry
                  </span>
                </Link>
                <div className="hidden md:flex items-center gap-2 text-xs text-[var(--text-muted)]">
                  <span>Self-healing observability across containerized workloads.</span>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <div className="bt-shimmer flex items-center gap-2 rounded-full border border-[rgba(148,163,184,0.15)] bg-white/[0.02] px-3 py-1.5 text-xs text-[var(--text-secondary)]">
                  <RefreshCw size={13} className={`text-[var(--accent-teal)] ${syncState === "syncing" ? "animate-spin" : ""}`} />
                  <span className="bt-mono text-[11px]">{syncState === "error" ? "sync failed" : `synced ${lastSyncLabel}`}</span>
                  <span className="h-3 w-px bg-[var(--border-mid)]" />
                  <span className="bt-mono text-[11px] text-[var(--text-muted)]">10s</span>
                </div>
              </div>
            </section>

            {/* Primary grid: health + deployments */}
            <section className="bt-rise relative z-10 flex-1 min-h-[280px] grid grid-cols-1 xl:grid-cols-3 gap-3 lg:gap-4" style={{ animationDelay: "80ms" }}>
              <div id="wt-health-dashboard" className="xl:col-span-2 min-h-0 h-full">
                <ContainerHealth services={services} />
              </div>
              <div id="wt-recent-deployment" className="xl:col-span-1 min-h-0 h-full">
                <RecentDeployment rollbackEvents={rollbackEvents} onDismissRollback={handleDismissRollback} platform={services[0]?.platform} />
              </div>
            </section>

            {/* Secondary grid: anomalies + containers */}
            <section className="bt-rise relative z-0 flex-shrink-0 h-[300px] md:h-[340px] xl:h-[360px] grid grid-cols-1 lg:grid-cols-2 gap-3 lg:gap-4" style={{ animationDelay: "160ms" }}>
              <div id="wt-anomaly-detection" className="min-h-0 h-full">
                <AnomalyDetection anomalies={anomalies} onAnomalyRollback={handleAnomalyRollback} />
              </div>
              <div id="wt-active-containers" className="min-h-0 h-full">
                <ActiveContainers services={services} />
              </div>
            </section>

            {/* CI/CD row: only when a connection has a GitHub repo */}
            {hasCICD && (
              <section className="bt-rise flex-shrink-0 h-[320px]" style={{ animationDelay: "240ms" }}>
                <CICDPanel />
              </section>
            )}

            {/* Recent rollbacks */}
            <section id="wt-recent-rollbacks" className="bt-rise flex-shrink-0 h-[280px]" style={{ animationDelay: "300ms" }}>
              <RecentRollbacks />
            </section>

            <footer className="flex-shrink-0 pt-2 pb-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 text-[11px] text-[var(--text-muted)]">
              <div className="flex items-center gap-2">
                <span className="bt-mono uppercase tracking-[0.2em]">backtrack</span>
                <span>/</span>
                <span>local-first observability</span>
              </div>
              <div className="flex items-center gap-3 bt-mono">
                <span>services {healthSummary.up}/{healthSummary.total}</span>
                <span className="h-3 w-px bg-[var(--border-mid)]" />
                <span>anomalies {anomalies.length}</span>
              </div>
            </footer>
          </div>
        )}
      </main>
    </div>
  );
}
