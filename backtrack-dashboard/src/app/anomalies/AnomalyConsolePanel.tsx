"use client";

import { ChevronRight } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

type ConsoleTab = "pipeline" | "shell" | "sources";

type AnomalyConsolePanelProps = {
  serviceName: string;
  namespace: string;
  terminalLines: string[];
  diffLines: Array<{ sign: string; text: string }>;
  clusterName?: string;
};

type LiveLogResponse = {
  service: string;
  namespace: string;
  podNamespace?: string;
  podName: string | null;
  podStatus?: string;
  podReady?: string;
  restartCount?: number;
  podReason?: string;
  podMessage?: string;
  logs: string[];
  metrics: {
    cpuCores: number;
    memoryMiB: number;
    status: string;
  } | null;
};

export default function AnomalyConsolePanel({
  serviceName,
  namespace,
  terminalLines,
  diffLines,
  clusterName = "local",
}: AnomalyConsolePanelProps) {
  const [activeTab, setActiveTab] = useState<ConsoleTab>("pipeline");
  const [liveLogs, setLiveLogs] = useState<string[]>(terminalLines);
  const [liveMetrics, setLiveMetrics] = useState<LiveLogResponse["metrics"]>(null);
  const [livePod, setLivePod] = useState<string | null>(null);
  const [podStatus, setPodStatus] = useState<string>("unknown");
  const [podReady, setPodReady] = useState<string>("0/0");
  const [restartCount, setRestartCount] = useState<number>(0);
  const [podReason, setPodReason] = useState<string>("");
  const [isLoadingLogs, setIsLoadingLogs] = useState(false);
  const [logError, setLogError] = useState<string | null>(null);

  useEffect(() => {
    if (activeTab !== "shell") {
      return;
    }

    let active = true;

    const loadLogs = async () => {
      try {
        setIsLoadingLogs(true);
        const response = await fetch(
          `/api/anomalies/logs?service=${encodeURIComponent(serviceName)}&namespace=${encodeURIComponent(namespace || "default")}`,
          { cache: "no-store" },
        );
        const payload = (await response.json()) as LiveLogResponse & { error?: string };

        if (!active) return;

        if (!response.ok) {
          throw new Error(payload.error || "Unable to load service logs.");
        }

        setLiveLogs(payload.logs && payload.logs.length > 0 ? payload.logs : [`[WARN] No live logs available for ${serviceName}`]);
        setLiveMetrics(payload.metrics);
        setLivePod(payload.podName);
        setPodStatus(payload.podStatus || payload.metrics?.status || "unknown");
        setPodReady(payload.podReady || "0/0");
        setRestartCount(payload.restartCount || 0);
        setPodReason(payload.podReason || "");
        setLogError(null);
      } catch (error: unknown) {
        if (!active) return;
        setLogError(error instanceof Error ? error.message : "Unable to load service logs.");
      } finally {
        if (active) {
          setIsLoadingLogs(false);
        }
      }
    };

    loadLogs();
    const timer = window.setInterval(loadLogs, 3000);

    return () => {
      active = false;
      if (timer) {
        window.clearInterval(timer);
      }
    };
  }, [activeTab, namespace, serviceName]);

  const tabContent = useMemo(() => {
    const statusTone =
      podStatus === "running"
        ? "text-green-400"
        : podStatus === "restarting"
          ? "text-orange-400"
          : podStatus === "pending"
            ? "text-yellow-400"
            : "text-red-400";

    if (activeTab === "shell") {
      return (
        <div className="flex-1 overflow-hidden p-4">
          <div className="flex h-full flex-col overflow-hidden rounded-[24px] border border-[#12202a] bg-[#020b11] p-4 font-mono text-sm leading-6">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-white/40">
              <span>01 | kubectl logs {livePod || `deployment/${serviceName}`} -n {namespace || "default"} --tail=120</span>
              <span className={`text-[11px] ${statusTone}`}>
                {isLoadingLogs ? "Refreshing..." : liveMetrics ? `cpu ${liveMetrics.cpuCores.toFixed(3)} | mem ${liveMetrics.memoryMiB.toFixed(1)} MiB` : "live tail"}
              </span>
            </div>

            <div className="mb-3 grid gap-2 text-[11px] text-white/60 sm:grid-cols-2">
              <div className="rounded-xl border border-white/5 bg-white/[0.02] px-3 py-2">
                <div className="text-white/35 uppercase tracking-wide">Pod state</div>
                <div className={`mt-1 font-semibold ${statusTone}`}>
                  {podStatus.toUpperCase()} {podReason ? `• ${podReason}` : ""}
                </div>
              </div>
              <div className="rounded-xl border border-white/5 bg-white/[0.02] px-3 py-2">
                <div className="text-white/35 uppercase tracking-wide">Readiness</div>
                <div className="mt-1 font-semibold text-white/80">
                  {podReady} • {restartCount} restarts
                </div>
              </div>
            </div>

            {logError ? (
              <div className="mb-3 rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-300">
                {logError}
              </div>
            ) : null}

            <div className="flex-1 space-y-0.5 overflow-auto pr-2">
              {liveLogs.map((line, index) => {
                const color =
                  line.includes("ERROR") || line.includes("fatal") || line.includes("OOM")
                    ? "text-red-400"
                    : line.includes("WARN")
                      ? "text-yellow-400"
                      : line.includes("INFO")
                        ? "text-green-400"
                        : "text-cyan-300";

                return (
                  <div key={`${line}-${index}`} className={color}>
                    {String(index + 2).padStart(2, "0")} | {line}
                  </div>
                );
              })}
            </div>

            <div className="mt-4 flex items-center justify-between text-green-400">
              <span>admin@{clusterName}:~$</span>
              {liveMetrics ? (
                <span className="text-[11px] text-white/55">
                  pod {livePod || "unknown"} • {podStatus} • cpu {liveMetrics.cpuCores.toFixed(3)} • mem {liveMetrics.memoryMiB.toFixed(1)} MiB
                </span>
              ) : null}
            </div>
          </div>
        </div>
      );
    }

    if (activeTab === "sources") {
      return (
        <div className="flex-1 overflow-hidden p-4">
          <div className="h-full rounded-[24px] border border-[#12202a] bg-[#020b11] p-4 font-mono text-sm leading-6 overflow-hidden">
            <div className="mb-3 text-white/40">source-diff / release comparison</div>
            <div className="space-y-1 text-[12px] leading-5">
              {diffLines.map((line) => (
                <div key={line.text} className={line.sign === "+" ? "text-green-400" : "text-red-400"}>
                  {line.sign} {line.text}
                </div>
              ))}
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="flex-1 overflow-hidden p-4">
        <div className="h-full rounded-[24px] border border-[#12202a] bg-[#020b11] p-4 font-mono text-sm leading-6 overflow-hidden">
          <div className="mb-3 text-white/40">01 | kubectl logs deployment/{serviceName} --tail=50</div>
          <div className="grid gap-2">
            <div className="rounded-xl border border-white/5 bg-white/[0.02] p-3 text-white/75">
              <div className="text-[11px] uppercase tracking-wide text-white/35">Pipeline Stage</div>
              <div className="mt-2 text-sm text-white/85">Fetching runtime logs and release metadata</div>
            </div>
            <div className="rounded-xl border border-white/5 bg-white/[0.02] p-3 text-white/75">
              <div className="text-[11px] uppercase tracking-wide text-white/35">Pipeline Stage</div>
              <div className="mt-2 text-sm text-white/85">Comparing anomaly release against stable version</div>
            </div>
            <div className="rounded-xl border border-white/5 bg-white/[0.02] p-3 text-white/75">
              <div className="text-[11px] uppercase tracking-wide text-white/35">Pipeline Stage</div>
              <div className="mt-2 text-sm text-white/85">Awaiting TSD and LSI algorithm outputs</div>
            </div>
          </div>
        </div>
      </div>
    );
  }, [activeTab, clusterName, diffLines, isLoadingLogs, liveMetrics, livePod, liveLogs, logError, namespace, podReason, podReady, podStatus, restartCount, serviceName]);

  return (
    <section className="flex min-h-0 flex-col overflow-hidden rounded-[28px] border border-white/5 bg-[#171e29] p-5 shadow-[0_20px_60px_rgba(0,0,0,0.28)]">
      <div className="mb-4 flex items-center justify-between gap-4 rounded-2xl border border-white/5 bg-[#0f1420] px-4 py-3">
        <div className="flex items-center gap-2 text-xs font-semibold text-white/80">
          <ChevronRight size={13} className="text-white/45" />
          <span>bitbros-thesis / checkout-services - tty1</span>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-white/50">
          <span className="rounded-md border border-white/10 bg-white/[0.03] px-2 py-1">Source Diff v2.4 and v2.3</span>
          <span className="rounded-md border border-white/10 bg-white/[0.03] px-2 py-1">
            {podStatus.toUpperCase()} · {podReady} · {restartCount} restarts
          </span>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[28px] border border-white/5 bg-[#071319]">
        <div className="border-b border-white/5 px-4 py-3">
          <div className="flex items-center gap-4 text-[11px] text-white/55">
            <button
              type="button"
              onClick={() => setActiveTab("pipeline")}
              className={`rounded-full border-b-2 pb-2 transition ${activeTab === "pipeline" ? "border-green-400 text-white/85" : "border-transparent hover:text-white/80"}`}
            >
              Deployment Pipeline
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("shell")}
              className={`rounded-full border-b-2 pb-2 transition ${activeTab === "shell" ? "border-green-400 text-white/85" : "border-transparent hover:text-white/80"}`}
            >
              Interactive Shell
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("sources")}
              className={`rounded-full border-b-2 pb-2 transition ${activeTab === "sources" ? "border-green-400 text-white/85" : "border-transparent hover:text-white/80"}`}
            >
              Sources
            </button>
          </div>
        </div>

        {tabContent}
      </div>
    </section>
  );
}
