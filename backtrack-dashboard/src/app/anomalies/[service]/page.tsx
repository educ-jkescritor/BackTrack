  "use client";

import { useEffect, useRef, useState, Suspense } from "react";
import { useParams, useSearchParams } from "next/navigation";
import {
  Activity,
  ArrowLeft,
  CheckCircle2,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldAlert,
  History,
  CircleDot,
  BarChart2,
  HardDrive,
  Wifi,
  TrendingUp,
  TerminalSquare,
  ChevronDown,
  Maximize2,
} from "lucide-react";
import Link from "next/link";
import dynamic from "next/dynamic";
import AnomalyModal from "./AnomalyModal";
import { useLongPress } from "./useLongPress";

const AnomalyTerminal = dynamic(() => import("../KubernetesTerminal"), { ssr: false });

type ResidualMetric = "cpu" | "memory" | "latency" | "error_rate";
type HistoryMetric = "memory" | "latency";
type ActiveModal =
  | null
  | { kind: "tsd-live" }
  | { kind: "residual"; metric: ResidualMetric }
  | { kind: "tsd-history"; metric: HistoryMetric }
  | { kind: "lsi-scores" }
  | { kind: "lsi-history" }
  | { kind: "lsi-window" }
  | { kind: "root-cause" }
  | { kind: "diagnostic" }
  | { kind: "agent-status" }
  | { kind: "version-history" };

const RESIDUAL_META: Record<ResidualMetric, { label: string; color: string; unit: string }> = {
  cpu: { label: "CPU Residuals", color: "#6ee7b7", unit: "%" },
  memory: { label: "Memory Residuals", color: "#7dd3fc", unit: "MB" },
  latency: { label: "Latency Residuals", color: "#c4b5fd", unit: "ms" },
  error_rate: { label: "Error Rate Residuals", color: "#fca5a5", unit: "%" },
};

// --- Types ---

type TSDMetrics = {
  current: { cpu_percent: number; memory_mb: number; latency_ms: number; error_rate_percent: number };
  history: { cpu: number[]; memory: number[]; latency: number[]; error_rate: number[] };
  residuals: { cpu: number[]; memory: number[]; latency: number[]; error_rate: number[] };
  readings_count: number;
  is_drifting: boolean;
};

type LSIData = {
  fitted: boolean;
  corpus_size: number;
  current_score: number;
  baseline_mean: number;
  threshold: number;
  is_anomalous: boolean;
  is_error_anomalous: boolean;
  error_score: number;
  error_baseline_mean: number;
  error_threshold: number;
  error_baseline_locked: boolean;
  error_score_history: number[];
  window_counts: { INFO: number; WARN: number; ERROR: number; NOVEL: number };
  score_history: number[];
  recent_lines: Array<{ line: string; label: string; timestamp: number }>;
};

type VersionSnapshot = { id: string; image_tag: string; status: string; created_at: string };

// --- Helpers ---

function severityTone(severity: string) {
  const t = severity.toLowerCase();
  if (t === "critical") return { badge: "bg-red-500/15 text-red-300 border-red-500/30", accent: "text-red-400", dot: "bg-red-400" };
  if (t === "high") return { badge: "bg-orange-500/15 text-orange-300 border-orange-500/30", accent: "text-orange-400", dot: "bg-orange-400" };
  return { badge: "bg-yellow-500/15 text-yellow-300 border-yellow-500/30", accent: "text-yellow-400", dot: "bg-yellow-400" };
}

function decode(value: string | null) { return value ? decodeURIComponent(value) : "unknown"; }

function versionStatusMeta(status: string) {
  switch (status) {
    case "STABLE":
      return {
        label: "Stable",
        border: "border-emerald-500/25",
        bg: "bg-emerald-500/[0.05]",
        textColor: "text-emerald-300",
        iconColor: "text-emerald-400",
      };
    case "PENDING":
      return {
        label: "Pending",
        border: "border-cyan-500/25",
        bg: "bg-cyan-500/[0.05]",
        textColor: "text-cyan-300",
        iconColor: "text-cyan-400",
      };
    case "ROLLED_BACK":
      return {
        label: "Rolled back",
        border: "border-amber-500/30",
        bg: "bg-amber-500/[0.06]",
        textColor: "text-amber-300",
        iconColor: "text-amber-400",
      };
    default:
      return {
        label: status || "unknown",
        border: "border-white/10",
        bg: "bg-white/[0.03]",
        textColor: "text-white/60",
        iconColor: "text-white/40",
      };
  }
}

function formatRelTimestamp(value?: string) {
  if (!value) return "unknown";
  const t = new Date(value).getTime();
  if (Number.isNaN(t)) return "unknown";
  const delta = Math.floor((Date.now() - t) / 1000);
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return `${Math.floor(delta / 86400)}d ago`;
}

function estimateIQR(values: number[]): number {
  if (values.length < 4) return 1;
  const sorted = [...values].map(Math.abs).sort((a, b) => a - b);
  const q1 = sorted[Math.floor(sorted.length * 0.25)];
  const q3 = sorted[Math.floor(sorted.length * 0.75)];
  return Math.max(q3 - q1, 0.001);
}

const METRIC_DEFS = [
  { name: "CPU", key: "cpu" as const },
  { name: "Memory", key: "memory" as const },
  { name: "Latency", key: "latency" as const },
  { name: "Error Rate", key: "error_rate" as const },
];

type InsightDriver = "TSD_DRIFT" | "LSI_ANOMALOUS" | "BOTH" | "NONE";
type RootCauseInsight = {
  driver: InsightDriver;
  driftingMetrics: Array<{ name: string; lastResidual: number; iqrThreshold: number; ratio: number }>;
  novelRatio: number; errorRatio: number; scoreRatio: number;
  novelLines: Array<{ line: string; timestamp: number }>;
  headline: string; explanation: string;
};

function generateInsight(tsd: TSDMetrics | null, lsi: LSIData | null): RootCauseInsight {
  const empty: RootCauseInsight = {
    driver: "NONE", driftingMetrics: [], novelRatio: 0, errorRatio: 0, scoreRatio: 0, novelLines: [],
    headline: "No active anomaly signals.",
    explanation: "Both TSD residuals and LSI log scores are within normal bounds.",
  };
  if (!tsd && !lsi) return empty;

  const driftingMetrics: RootCauseInsight["driftingMetrics"] = [];
  if (tsd?.is_drifting) {
    for (const def of METRIC_DEFS) {
      const residuals = tsd.residuals?.[def.key] ?? [];
      const lastResidual = residuals.at(-1) ?? 0;
      const iqrThreshold = 3.0 * estimateIQR(residuals);
      const ratio = Math.abs(lastResidual) / iqrThreshold;
      if (ratio > 1.0) driftingMetrics.push({ name: def.name, lastResidual, iqrThreshold, ratio });
    }
    driftingMetrics.sort((a, b) => b.ratio - a.ratio);
  }

  const wc = lsi?.window_counts ?? { INFO: 0, WARN: 0, ERROR: 0, NOVEL: 0 };
  const total = Math.max(wc.INFO + wc.WARN + wc.ERROR + wc.NOVEL, 1);
  const novelRatio = wc.NOVEL / total;
  const errorRatio = wc.ERROR / total;
  const scoreRatio = (lsi?.current_score ?? 0) / Math.max(lsi?.threshold ?? 0.0001, 0.0001);
  const novelLines = (lsi?.recent_lines ?? []).filter((e) => e.label === "NOVEL").slice(0, 3).map((e) => ({ line: e.line, timestamp: e.timestamp }));

  const isDrifting = tsd?.is_drifting ?? false;
  const isAnomalous = lsi?.is_anomalous ?? false;

  let driver: InsightDriver = "NONE";
  if (isDrifting && isAnomalous) driver = "BOTH";
  else if (isDrifting) driver = "TSD_DRIFT";
  else if (isAnomalous) driver = "LSI_ANOMALOUS";

  const topMetric = driftingMetrics[0];
  let headline = "No active anomaly signals.";
  let explanation = "Both TSD residuals and LSI log scores are within normal bounds.";

  if (driver === "BOTH") {
    headline = "Correlated metric drift and anomalous log patterns detected.";
    explanation = topMetric
      ? `${topMetric.name} residuals are ~${topMetric.ratio.toFixed(1)}× above the 3×IQR drift threshold. Simultaneously, ${(novelRatio * 100).toFixed(0)}% of recent log lines are NOVEL patterns. LSI score is ${scoreRatio.toFixed(1)}× the anomaly threshold.`
      : `Both TSD drift and LSI anomaly signals are active. LSI score is ${scoreRatio.toFixed(1)}× the anomaly threshold with ${(novelRatio * 100).toFixed(0)}% NOVEL log lines.`;
  } else if (driver === "TSD_DRIFT") {
    headline = "Metric drift detected — log patterns nominal.";
    explanation = topMetric
      ? `${topMetric.name} residuals are ~${topMetric.ratio.toFixed(1)}× above the 3×IQR threshold after STL decomposition, suggesting a resource regression. Log semantics remain within the trained baseline.`
      : "TSD residuals outside normal bounds. Log semantics remain within trained baseline.";
  } else if (driver === "LSI_ANOMALOUS") {
    headline = "Anomalous log patterns without metric drift.";
    explanation = `LSI score is ${scoreRatio.toFixed(1)}× the anomaly threshold, driven by ${(novelRatio * 100).toFixed(0)}% NOVEL and ${(errorRatio * 100).toFixed(0)}% ERROR log lines. NOVEL lines have cosine similarity < 0.25 to all SVD baseline centroids. CPU, memory, and latency residuals are within normal bounds.`;
  }

  return { driver, driftingMetrics, novelRatio, errorRatio, scoreRatio, novelLines, headline, explanation };
}

// --- Smooth Line Sparkline (for history + LSI score) ---

function SparkLine({
  values,
  threshold,
  baseline,
  lineColor,
  id,
  height = 88,
}: {
  values: number[];
  threshold?: number;
  baseline?: number;
  lineColor: string;
  id: string;
  height?: number;
  unit?: string;
}) {
  const W = 400; const H = height;
  const P = { t: 8, b: 8, l: 4, r: 4 };
  const iW = W - P.l - P.r; const iH = H - P.t - P.b;

  if (values.length < 1) {
    return (
      <div
        className="flex items-center justify-center rounded-xl border border-white/5 bg-[#0b101a] text-[10px] text-white/25"
        style={{ height }}
      >
        Waiting for data…
      </div>
    );
  }
  if (values.length === 1) values = [values[0], values[0]];

  const allRef = [threshold, baseline].filter((v): v is number => v !== undefined);
  const vMin = Math.min(...values, ...allRef);
  const vMax = Math.max(...values, ...allRef, vMin + 0.001);
  const range = vMax - vMin;

  const toX = (i: number) => P.l + (i / (values.length - 1)) * iW;
  const toY = (v: number) => P.t + (1 - (v - vMin) / range) * iH;

  const pts = values.map((v, i) => ({ x: toX(i), y: toY(v) }));

  let linePath = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) {
    const cp = ((pts[i - 1].x + pts[i].x) / 2).toFixed(1);
    linePath += ` C ${cp} ${pts[i - 1].y.toFixed(1)}, ${cp} ${pts[i].y.toFixed(1)}, ${pts[i].x.toFixed(1)} ${pts[i].y.toFixed(1)}`;
  }
  const areaPath = `${linePath} L ${pts.at(-1)!.x.toFixed(1)} ${(H - P.b).toFixed(1)} L ${P.l} ${(H - P.b).toFixed(1)} Z`;

  const thY = threshold !== undefined ? toY(threshold) : null;
  const blY = baseline !== undefined ? toY(baseline) : null;
  const lastPt = pts.at(-1)!;
  const gradId = `spk-${id}`;

  return (
    <div className="rounded-xl border border-white/5 bg-[#0b101a] overflow-hidden" style={{ height }}>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-full" preserveAspectRatio="none">
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={lineColor} stopOpacity="0.22" />
            <stop offset="100%" stopColor={lineColor} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {thY !== null && (
          <>
            <rect x={P.l} y={thY} width={iW} height={Math.max(0, H - P.b - thY)} fill="rgba(239,68,68,0.04)" />
            <line x1={P.l} y1={thY} x2={W - P.r} y2={thY} stroke="rgba(239,68,68,0.55)" strokeWidth="0.9" strokeDasharray="5,3" />
          </>
        )}
        {blY !== null && (
          <line x1={P.l} y1={blY} x2={W - P.r} y2={blY} stroke="rgba(255,255,255,0.2)" strokeWidth="0.7" strokeDasharray="3,4" />
        )}
        <path d={areaPath} fill={`url(#${gradId})`} />
        <path d={linePath} fill="none" stroke={lineColor} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx={lastPt.x} cy={lastPt.y} r="2.5" fill={lineColor} />
      </svg>
    </div>
  );
}

// --- Residual Sparkline (centered at 0, ±threshold bands) ---

function ResidualSparkline({
  values,
  threshold,
  lineColor,
  id,
  height = 88,
}: {
  values: number[];
  threshold: number;
  lineColor: string;
  id: string;
  height?: number;
}) {
  const W = 400; const H = height;
  const P = { t: 8, b: 8, l: 4, r: 4 };
  const iW = W - P.l - P.r; const iH = H - P.t - P.b;

  if (values.length < 1) {
    return (
      <div
        className="flex items-center justify-center rounded-xl border border-white/5 bg-[#0b101a] text-[10px] text-white/25"
        style={{ height }}
      >
        Waiting for data…
      </div>
    );
  }
  if (values.length === 1) values = [values[0], values[0]];

  const absMax = Math.max(...values.map(Math.abs), threshold, 0.001);
  const vMin = -absMax * 1.2; const vMax = absMax * 1.2;
  const range = vMax - vMin;

  const toX = (i: number) => P.l + (i / (values.length - 1)) * iW;
  const toY = (v: number) => P.t + (1 - (v - vMin) / range) * iH;

  const pts = values.map((v, i) => ({ x: toX(i), y: toY(v) }));
  const zeroY = toY(0);
  const thrTopY = toY(threshold);
  const thrBotY = toY(-threshold);

  let linePath = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) {
    const cp = ((pts[i - 1].x + pts[i].x) / 2).toFixed(1);
    linePath += ` C ${cp} ${pts[i - 1].y.toFixed(1)}, ${cp} ${pts[i].y.toFixed(1)}, ${pts[i].x.toFixed(1)} ${pts[i].y.toFixed(1)}`;
  }

  const lastVal = values.at(-1) ?? 0;
  const isHot = threshold > 0 && Math.abs(lastVal) > threshold;
  const stroke = isHot ? "#f87171" : lineColor;
  const gradId = `res-${id}`;

  return (
    <div className="rounded-xl border border-white/5 bg-[#0b101a] overflow-hidden" style={{ height }}>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-full" preserveAspectRatio="none">
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity="0.15" />
            <stop offset="100%" stopColor={stroke} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {/* Safe zone */}
        <rect x={P.l} y={thrTopY} width={iW} height={Math.max(0, thrBotY - thrTopY)} fill="rgba(52,211,153,0.04)" />
        {/* Threshold lines */}
        <line x1={P.l} y1={thrTopY} x2={W - P.r} y2={thrTopY} stroke="rgba(239,68,68,0.45)" strokeWidth="0.8" strokeDasharray="5,3" />
        <line x1={P.l} y1={thrBotY} x2={W - P.r} y2={thrBotY} stroke="rgba(239,68,68,0.45)" strokeWidth="0.8" strokeDasharray="5,3" />
        {/* Zero baseline */}
        <line x1={P.l} y1={zeroY} x2={W - P.r} y2={zeroY} stroke="rgba(255,255,255,0.14)" strokeWidth="0.6" />
        {/* Area fill */}
        <path d={`${linePath} L ${pts.at(-1)!.x.toFixed(1)} ${zeroY.toFixed(1)} L ${pts[0].x.toFixed(1)} ${zeroY.toFixed(1)} Z`} fill={`url(#${gradId})`} />
        {/* Line */}
        <path d={linePath} fill="none" stroke={stroke} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        {/* Last point dot */}
        <circle cx={pts.at(-1)!.x} cy={pts.at(-1)!.y} r="2.5" fill={stroke} />
      </svg>
    </div>
  );
}

function ResidualTile({
  metric,
  label,
  values,
  last,
  thr,
  lineColor,
  id,
  onExpand,
}: {
  metric: ResidualMetric;
  label: string;
  values: number[];
  last: number;
  thr: number;
  lineColor: string;
  id: string;
  onExpand: (metric: ResidualMetric) => void;
}) {
  const longPress = useLongPress(() => onExpand(metric));
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={(e) => {
        e.stopPropagation();
        onExpand(metric);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onExpand(metric);
        }
      }}
      {...longPress}
      className="cursor-pointer rounded-xl transition border border-transparent hover:border-[rgba(94,234,212,0.35)] active:border-[rgba(94,234,212,0.6)] p-0.5"
      title="Click or long-press to expand"
    >
      <div className="mb-1 flex items-center justify-between text-[9px]">
        <span className="text-white/35">{label}</span>
        <span className="font-mono text-white/35">{(last > 0 ? "+" : "") + last.toFixed(3)}</span>
      </div>
      <ResidualSparkline values={values} threshold={thr} lineColor={lineColor} id={id} height={80} />
    </div>
  );
}

// --- Main page ---

function ServiceDiagnosticsPage() {
  const params = useParams();
  const searchParams = useSearchParams();

  const serviceName = decodeURIComponent(params.service as string);
  const namespace = decode(searchParams.get("namespace"));
  const severity = decode(searchParams.get("severity"));
  const metric = decode(searchParams.get("metric"));
  const current = decode(searchParams.get("current"));
  const baseline = decode(searchParams.get("baseline"));
  const message = decode(searchParams.get("message"));
  const platform = (searchParams.get("platform") ?? "kubernetes") as "kubernetes" | "docker";
  const tones = severityTone(severity);

  const [tsd, setTsd] = useState<TSDMetrics | null>(null);
  const [lsi, setLsi] = useState<LSIData | null>(null);
  const [versions, setVersions] = useState<VersionSnapshot[]>([]);
  const [agentOnline, setAgentOnline] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<string>("");
  const [leftTab, setLeftTab] = useState<"tsd" | "lsi">("tsd");
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [activeModal, setActiveModal] = useState<ActiveModal>(null);
  const [rollingBack, setRollingBack] = useState(false);
  const [rollbackMessage, setRollbackMessage] = useState<{ kind: "info" | "error"; text: string } | null>(null);
  const prevVersionsRef = useRef<VersionSnapshot[]>([]);
  const anomalyDetectedAtRef = useRef<string | null>(null);
  const anomalyTypeRef = useRef<"TSD" | "LSI" | "BOTH" | "MANUAL">("MANUAL");

  // Auto-detect agent-driven rollback: a new ROLLED_BACK entry appearing.
  useEffect(() => {
    const prev = prevVersionsRef.current;
    if (prev.length > 0 && versions.length > prev.length) {
      const fresh = versions.find(
        (v) => v.status === "ROLLED_BACK" && !prev.some((p) => p.id === v.id),
      );
      if (fresh) {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setRollingBack(false);
        setRollbackMessage({ kind: "info", text: `Auto-rollback complete · reverted to ${fresh.image_tag}` });
        setTimeout(() => setRollbackMessage(null), 6000);
      }
    }
    prevVersionsRef.current = versions;
  }, [versions]);

  const triggerRollback = async () => {
    if (rollingBack) return;
    setRollbackMessage(null);
    setRollingBack(true);
    try {
      const res = await fetch("/api/rollback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          service: serviceName,
          namespace,
          anomaly_detected_at: anomalyDetectedAtRef.current ?? new Date().toISOString(),
          anomaly_type: anomalyTypeRef.current,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setRollingBack(false);
        setRollbackMessage({ kind: "error", text: data?.error || "Rollback request failed." });
        setTimeout(() => setRollbackMessage(null), 6000);
        return;
      }
      setRollbackMessage({ kind: "info", text: data?.message || "Rollback initiated." });
      // Stop spinner once next poll lands a new version, OR after a 30s safety timeout.
      setTimeout(() => setRollingBack(false), 30000);
    } catch (err: unknown) {
      setRollingBack(false);
      setRollbackMessage({ kind: "error", text: err instanceof Error ? err.message : "Rollback request failed." });
      setTimeout(() => setRollbackMessage(null), 6000);
    }
  };

  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const svcParam = `&service=${encodeURIComponent(serviceName)}`;
        const [metricsRes, lsiRes, versionsRes] = await Promise.all([
          fetch(`/api/agent?path=metrics${svcParam}`, { cache: "no-store" }),
          fetch(`/api/agent?path=lsi${svcParam}`, { cache: "no-store" }),
          fetch("/api/agent?path=versions", { cache: "no-store" }),
        ]);
        if (!active) return;
        if (metricsRes.ok) {
          const d = await metricsRes.json();
          if (!d.error && typeof d.readings_count === "number") {
            setTsd(d);
            const tsdDrift = d.is_drifting === true || (d.drifting_metrics && d.drifting_metrics.length > 0);
            if (tsdDrift && !anomalyDetectedAtRef.current) {
              anomalyDetectedAtRef.current = new Date().toISOString();
              anomalyTypeRef.current = "TSD";
            }
          }
        }
        if (lsiRes.ok) {
          const d = await lsiRes.json();
          if (!d.error && typeof d.current_score === "number") {
            setLsi(d);
            const lsiAnomaly = d.is_anomalous === true;
            if (lsiAnomaly && !anomalyDetectedAtRef.current) {
              anomalyDetectedAtRef.current = new Date().toISOString();
              anomalyTypeRef.current = "LSI";
            } else if (lsiAnomaly && anomalyTypeRef.current === "TSD") {
              anomalyTypeRef.current = "BOTH";
            }
          }
        }
        if (versionsRes.ok) { const d = await versionsRes.json(); if (!d.error) setVersions(Array.isArray(d) ? d : []); }
        setAgentOnline(metricsRes.ok || lsiRes.ok);
        setLastUpdate(new Date().toLocaleTimeString());
      } catch { if (active) setAgentOnline(false); }
    };
    poll();
    const timer = window.setInterval(poll, 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, [serviceName]);

  const stableVersion = versions.find((v) => v.status === "STABLE");
  const pendingVersion = versions.find((v) => v.status === "PENDING");
  const currentVersion = pendingVersion || versions[0];

  const cpuResiduals = tsd?.residuals?.cpu ?? [];
  const memResiduals = tsd?.residuals?.memory ?? [];
  const latResiduals = tsd?.residuals?.latency ?? [];
  const errResiduals = tsd?.residuals?.error_rate ?? [];
  const lastCpuResidual = cpuResiduals.at(-1) ?? 0;
  const lastMemResidual = memResiduals.at(-1) ?? 0;
  const lastLatResidual = latResiduals.at(-1) ?? 0;
  const lastErrResidual = errResiduals.at(-1) ?? 0;

  const scoreHistory = lsi?.score_history ?? [];
  const recentLines = lsi?.recent_lines ?? [];
  const novelLogLines = recentLines.filter((e) => e.label === "NOVEL");
  const otherLogLines = recentLines.filter((e) => e.label !== "NOVEL");

  const insight = generateInsight(tsd, lsi);

  return (
    <div className="h-screen w-full overflow-hidden bg-[#0d1117] text-white flex flex-col">
      {/* Header */}
      <header className="flex h-13 shrink-0 items-center justify-between border-b border-white/[0.06] bg-[#161b22] px-5 gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <Link href="/anomalies" className="flex items-center gap-1.5 text-xs text-white/50 hover:text-white transition shrink-0">
            <ArrowLeft size={13} />
            Back
          </Link>
          <div className="h-3.5 w-px bg-white/10 shrink-0" />
          <span className="text-sm font-semibold text-white/90 truncate">{serviceName}</span>
          <span className={`rounded-full border px-2 py-0.5 text-[10px] shrink-0 ${tones.badge}`}>{severity.toUpperCase()}</span>
          {(tsd?.is_drifting || lsi?.is_anomalous) && (
            <span className="rounded-full bg-red-500/10 border border-red-500/25 px-2 py-0.5 text-[10px] text-red-300 shrink-0 animate-pulse">
              ● ANOMALY
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 text-[11px] shrink-0">
          <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 ${agentOnline ? "bg-green-500/10 text-green-300" : "bg-red-500/10 text-red-300"}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${agentOnline ? "bg-green-400" : "bg-red-400"}`} />
            Agent {agentOnline ? "Online" : "Offline"}
          </span>
          {lastUpdate && <span className="text-white/35">Updated {lastUpdate}</span>}
        </div>
      </header>

      {/* Offline banner */}
      {!agentOnline && !tsd && !lsi && (
        <div className="flex shrink-0 items-center gap-3 border-b border-red-500/20 bg-red-500/[0.05] px-5 py-2">
          <span className="h-1.5 w-1.5 rounded-full bg-red-400 shrink-0" />
          <p className="text-[11px] text-red-300">
            <span className="font-medium">Agent offline</span>{" — "}TSD · LSI · auto-rollback unavailable. Run{" "}
            <code className="font-mono text-[10px] text-red-200">
              BACKTRACK_TARGET=&lt;app&gt; python3 -m uvicorn src.main:app --port 8847
            </code>
          </p>
        </div>
      )}

      {/* Reverting banner */}
      {rollingBack && (
        <div className="flex shrink-0 items-center gap-3 border-b border-amber-500/30 bg-amber-500/[0.06] px-5 py-2">
          <RefreshCw size={13} className="text-amber-300 animate-spin shrink-0" />
          <p className="text-[11px] text-amber-200">
            <span className="font-semibold">Self-rollback in progress</span>{" — "}reverting{" "}
            <span className="font-mono">{currentVersion?.image_tag ?? serviceName}</span>
            {stableVersion && <> to <span className="font-mono">{stableVersion.image_tag}</span></>}
            . Awaiting agent confirmation…
          </p>
        </div>
      )}

      {/* Body — 3 columns */}
      <div className="flex flex-1 min-h-0 overflow-hidden gap-3 p-3">

        {/* ── LEFT PANEL: tabbed TSD / LSI ── */}
        <div className="w-[800px] shrink-0 flex flex-col gap-2 min-h-0">

          {/* Status + version row */}
          <div className="grid grid-cols-2 gap-2 shrink-0">
            <div className={`rounded-xl border border-white/[0.06] bg-[#161b22] px-3 py-2.5 flex items-center gap-2`}>
              <span className={`text-[11px] font-bold tracking-wide ${tsd?.is_drifting || lsi?.is_anomalous ? tones.accent : "text-emerald-400"}`}>
                {tsd?.is_drifting || lsi?.is_anomalous ? "ANOMALY DETECTED" : "SYSTEM NOMINAL"}
              </span>
              {tsd?.is_drifting && <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-red-500/15 border border-red-500/30 text-red-300">TSD</span>}
              {lsi?.is_error_anomalous && <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-red-500/15 border border-red-500/30 text-red-300">LSI ERR</span>}
              {lsi?.is_anomalous && !lsi?.is_error_anomalous && <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-300">LSI WARN</span>}
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <div className="rounded-xl border border-white/[0.06] bg-[#161b22] px-2 py-2">
                <div className="text-[9px] uppercase tracking-wide text-white/35">Current</div>
                <div className={`mt-0.5 text-xs font-bold truncate ${tones.accent}`}>{currentVersion?.image_tag || "N/A"}</div>
              </div>
              <div className="rounded-xl border border-emerald-500/20 bg-[#161b22] px-2 py-2">
                <div className="text-[9px] uppercase tracking-wide text-white/35">Stable</div>
                <div className="mt-0.5 text-xs font-bold text-emerald-400 truncate">{stableVersion?.image_tag || "N/A"}</div>
              </div>
            </div>
          </div>

          {/* Tabs */}
          <div className="flex gap-1.5 shrink-0">
            {([
              { id: "tsd" as const, label: "Time Series Decomposition", icon: <BarChart2 size={12} /> },
              { id: "lsi" as const, label: "Latent Semantic Indexing", icon: <Activity size={12} /> },
            ]).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setLeftTab(tab.id)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] transition border flex-1 justify-center ${
                  leftTab === tab.id
                    ? "bg-[rgba(94,234,212,0.08)] border-[rgba(94,234,212,0.3)] text-[#5eead4]"
                    : "bg-[#161b22] border-white/[0.06] text-white/40 hover:text-white/60 hover:border-white/15"
                }`}
              >
                {tab.icon}
                {tab.id === "tsd" ? "TSD" : "LSI"}
                {tab.id === "tsd" && tsd?.is_drifting && <span className="w-1.5 h-1.5 rounded-full bg-red-400 ml-0.5" />}
                {tab.id === "lsi" && lsi?.is_error_anomalous && <span className="w-1.5 h-1.5 rounded-full bg-red-400 ml-0.5" />}
                {tab.id === "lsi" && lsi?.is_anomalous && !lsi?.is_error_anomalous && <span className="w-1.5 h-1.5 rounded-full bg-amber-400 ml-0.5" />}
              </button>
            ))}
          </div>

          {/* Tab content — scrollable */}
          <div className="flex-1 min-h-0 overflow-y-auto pr-0.5 space-y-3 scrollbar-hide">

            {/* ─── TSD TAB ─── */}
            {leftTab === "tsd" && (
              <>
                {/* Current metrics */}
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => setActiveModal({ kind: "tsd-live" })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setActiveModal({ kind: "tsd-live" });
                    }
                  }}
                  className="rounded-2xl border border-white/[0.06] bg-[#161b22] p-3 cursor-pointer hover:border-white/15 transition"
                >
                  <div className="flex items-center justify-between mb-2.5">
                    <span className="text-[10px] font-semibold uppercase tracking-widest text-white/40">Live Metrics</span>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-white/25">{tsd?.readings_count ?? 0} readings</span>
                      <Maximize2 size={11} className="text-white/30" />
                    </div>
                  </div>
                  <div className="grid grid-cols-4 gap-1.5">
                    {[
                      { label: "CPU", value: `${tsd?.current?.cpu_percent?.toFixed(1) ?? "—"}%`, color: "text-emerald-400" },
                      { label: "Memory", value: `${tsd?.current?.memory_mb?.toFixed(1) ?? "—"} MB`, color: "text-sky-400" },
                      { label: "Latency", value: `${tsd?.current?.latency_ms?.toFixed(0) ?? "—"} ms`, color: "text-violet-400" },
                      { label: "Err Rate", value: `${tsd?.current?.error_rate_percent?.toFixed(2) ?? "—"}%`, color: "text-rose-400" },
                    ].map((s) => (
                      <div key={s.label} className="rounded-lg border border-white/[0.05] bg-[#0d1117] p-2 text-center">
                        <div className="text-[9px] uppercase tracking-wide text-white/30">{s.label}</div>
                        <div className={`mt-0.5 text-xs font-bold ${s.color}`}>{s.value}</div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Residual values */}
                <div className="rounded-2xl border border-white/[0.06] bg-[#161b22] p-3">
                  <div className="mb-2.5 text-[10px] font-semibold uppercase tracking-widest text-white/40">Residuals</div>
                  <div className="grid grid-cols-4 gap-1.5 mb-3">
                    {[
                      { label: "CPU", residuals: cpuResiduals },
                      { label: "Mem", residuals: memResiduals },
                      { label: "Lat", residuals: latResiduals },
                      { label: "Err", residuals: errResiduals },
                    ].map((r) => {
                      const iqr = estimateIQR(r.residuals);
                      const thr = 3 * iqr;
                      const lastAbs = Math.abs(r.residuals.at(-1) ?? 0);
                      const hot = thr > 0 && lastAbs > thr;
                      // Show IQR spread — more informative than last value which STL anchors to ~0
                      const display = iqr > 0 ? `±${iqr.toFixed(3)}` : "—";
                      return (
                        <div key={r.label} className="rounded-lg border border-white/[0.05] bg-[#0d1117] p-2 text-center">
                          <div className="text-[9px] uppercase tracking-wide text-white/30">{r.label}</div>
                          <div className={`mt-0.5 text-xs font-bold ${hot ? "text-red-400" : "text-emerald-400"}`}>
                            {display}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* 4 residual sparklines — click or long-press to expand */}
                  <div className="grid grid-cols-2 gap-2">
                    {([
                      { metric: "cpu" as const, label: "CPU Residuals", values: cpuResiduals, last: lastCpuResidual, thr: 3 * estimateIQR(cpuResiduals), lineColor: "#6ee7b7", id: "cpu-res" },
                      { metric: "memory" as const, label: "Memory Residuals", values: memResiduals, last: lastMemResidual, thr: 3 * estimateIQR(memResiduals), lineColor: "#7dd3fc", id: "mem-res" },
                      { metric: "latency" as const, label: "Latency Residuals", values: latResiduals, last: lastLatResidual, thr: 3 * estimateIQR(latResiduals), lineColor: "#c4b5fd", id: "lat-res" },
                      { metric: "error_rate" as const, label: "Error Rate Residuals", values: errResiduals, last: lastErrResidual, thr: 3 * estimateIQR(errResiduals), lineColor: "#fca5a5", id: "err-res" },
                    ]).map((c) => (
                      <ResidualTile
                        key={c.label}
                        metric={c.metric}
                        label={c.label}
                        values={c.values}
                        last={c.last}
                        thr={c.thr}
                        lineColor={c.lineColor}
                        id={c.id}
                        onExpand={(metric) => setActiveModal({ kind: "residual", metric })}
                      />
                    ))}
                  </div>
                </div>

                {/* Memory History */}
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => setActiveModal({ kind: "tsd-history", metric: "memory" })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setActiveModal({ kind: "tsd-history", metric: "memory" });
                    }
                  }}
                  className="rounded-2xl border border-white/[0.06] bg-[#161b22] p-3 cursor-pointer hover:border-white/15 transition"
                >
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest text-white/40">
                      <HardDrive size={11} className="text-sky-400" />
                      Memory History
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-mono text-sky-400">{tsd?.history?.memory?.at(-1)?.toFixed(1) ?? "—"} MB</span>
                      <Maximize2 size={11} className="text-white/30" />
                    </div>
                  </div>
                  <SparkLine
                    values={tsd?.history?.memory ?? []}
                    lineColor="#7dd3fc"
                    id="mem-hist"
                    height={80}
                    unit="MB"
                  />
                </div>

                {/* Latency History */}
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => setActiveModal({ kind: "tsd-history", metric: "latency" })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setActiveModal({ kind: "tsd-history", metric: "latency" });
                    }
                  }}
                  className="rounded-2xl border border-white/[0.06] bg-[#161b22] p-3 cursor-pointer hover:border-white/15 transition"
                >
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest text-white/40">
                      <Wifi size={11} className="text-violet-400" />
                      Latency History
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-mono text-violet-400">{tsd?.history?.latency?.at(-1)?.toFixed(0) ?? "—"} ms</span>
                      <Maximize2 size={11} className="text-white/30" />
                    </div>
                  </div>
                  <SparkLine
                    values={tsd?.history?.latency ?? []}
                    lineColor="#c4b5fd"
                    id="lat-hist"
                    height={80}
                    unit="ms"
                  />
                </div>

                {/* TSD warmup progress */}
                {tsd && tsd.readings_count < 12 && (
                  <div className="rounded-xl border border-cyan-500/25 bg-cyan-500/[0.05] px-3 py-2.5">
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-[11px] font-semibold text-cyan-300">Building TSD baseline…</span>
                      <span className="text-[10px] font-mono text-white/40">{tsd.readings_count} / 12 readings</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
                      <div className="h-full rounded-full bg-cyan-400 transition-all duration-700" style={{ width: `${(tsd.readings_count / 12) * 100}%` }} />
                    </div>
                    <p className="mt-1.5 text-[10px] text-white/35">STL decomposition activates after 12 readings (~2 min). Anomaly detection starts automatically.</p>
                  </div>
                )}

                {/* TSD Status */}
                <div className="rounded-xl border border-white/[0.05] bg-[#0d1117] px-3 py-2.5 text-[11px] leading-5 text-white/60">
                  <span className="font-semibold text-white/80">TSD Status: </span>
                  {tsd?.is_drifting ? (
                    <span className="text-red-400">Residual drift detected — anomalous readings exceed 3×IQR on {tsd.readings_count} readings.</span>
                  ) : tsd ? (
                    (() => {
                      const allZero = tsd.readings_count >= 12 &&
                        tsd?.current?.cpu_percent === 0 && tsd?.current?.memory_mb === 0 && tsd?.current?.latency_ms === 0;
                      return allZero
                        ? <span className="text-amber-400">{platform === "docker"
                            ? "All metrics are zero — agent may still be warming up for this container, or Docker stats are unavailable."
                            : "All metrics are zero — kubectl top may not be returning data. Check that metrics-server is installed and pods have "}{platform !== "docker" && <code>app={"<service>"}</code>}{platform !== "docker" && " labels."}</span>
                        : <span className="text-emerald-400">All residuals within normal bounds.</span>;
                    })()
                  ) : (
                    <span className="text-white/30">Waiting for agent connection...</span>
                  )}
                </div>
              </>
            )}

            {/* ─── LSI TAB ─── */}
            {leftTab === "lsi" && (
              <>
                {/* Score + Baseline */}
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => setActiveModal({ kind: "lsi-scores" })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setActiveModal({ kind: "lsi-scores" });
                    }
                  }}
                  className="rounded-2xl border border-white/[0.06] bg-[#161b22] p-3 cursor-pointer hover:border-white/15 transition"
                >
                  <div className="flex items-center justify-between mb-2.5">
                    <span className="text-[10px] font-semibold uppercase tracking-widest text-white/40">LSI Scores</span>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-white/25">{lsi?.fitted ? "Model Active" : `Corpus ${lsi?.corpus_size ?? 0} lines`}</span>
                      <Maximize2 size={11} className="text-white/30" />
                    </div>
                  </div>
                  {/* Rollback signal row */}
                  <div className="mb-1.5">
                    <div className="text-[8px] uppercase tracking-widest text-white/25 mb-1">Rollback Signal (Error Only)</div>
                    <div className="grid grid-cols-3 gap-1.5">
                      <div className="rounded-lg border border-white/[0.05] bg-[#0d1117] p-2.5">
                        <div className="text-[9px] uppercase tracking-wide text-white/30">Error Score</div>
                        <div className={`mt-0.5 text-base font-bold ${lsi?.is_error_anomalous ? "text-red-400" : "text-cyan-300"}`}>
                          {lsi?.error_score?.toFixed(4) ?? "—"}
                        </div>
                      </div>
                      <div className="rounded-lg border border-white/[0.05] bg-[#0d1117] p-2.5">
                        <div className="text-[9px] uppercase tracking-wide text-white/30">Error Baseline</div>
                        <div className="mt-0.5 text-base font-bold text-white/75">
                          {lsi?.error_baseline_locked ? lsi.error_baseline_mean.toFixed(4) : <span className="text-[11px] text-white/30">warming up…</span>}
                        </div>
                      </div>
                      <div className="rounded-lg border border-white/[0.05] bg-[#0d1117] p-2.5">
                        <div className="text-[9px] uppercase tracking-wide text-white/30">Error Threshold</div>
                        <div className="mt-0.5 text-base font-bold text-red-300/80">{lsi?.error_threshold?.toFixed(4) ?? "—"}</div>
                      </div>
                    </div>
                  </div>
                  {/* Display score row */}
                  <div className="mb-3">
                    <div className="text-[8px] uppercase tracking-widest text-white/25 mb-1">Full Score (Display)</div>
                    <div className="grid grid-cols-3 gap-1.5">
                      <div className="rounded-lg border border-white/[0.05] bg-[#0d1117] p-2.5">
                        <div className="text-[9px] uppercase tracking-wide text-white/30">Current Score</div>
                        <div className={`mt-0.5 text-base font-bold ${lsi?.is_anomalous ? "text-amber-400" : "text-white/50"}`}>
                          {lsi?.current_score?.toFixed(4) ?? "—"}
                        </div>
                      </div>
                      <div className="rounded-lg border border-white/[0.05] bg-[#0d1117] p-2.5">
                        <div className="text-[9px] uppercase tracking-wide text-white/30">Baseline Mean</div>
                        <div className="mt-0.5 text-base font-bold text-white/40">
                          {(lsi && lsi.baseline_mean > 0) ? lsi.baseline_mean.toFixed(4) : <span className="text-[11px] text-white/30">warming up…</span>}
                        </div>
                      </div>
                      <div className="rounded-lg border border-white/[0.05] bg-[#0d1117] p-2.5">
                        <div className="text-[9px] uppercase tracking-wide text-white/30">Threshold</div>
                        <div className="mt-0.5 text-base font-bold text-white/40">{lsi?.threshold?.toFixed(4) ?? "—"}</div>
                      </div>
                    </div>
                  </div>

                  {lsi?.fitted && (
                    <div className="grid grid-cols-4 gap-1.5">
                      {(["INFO", "WARN", "ERROR", "NOVEL"] as const).map((label) => {
                        const colors: Record<string, string> = { INFO: "text-emerald-400", WARN: "text-yellow-400", ERROR: "text-red-400", NOVEL: "text-purple-400" };
                        return (
                          <div key={label} className="rounded-lg border border-white/[0.05] bg-[#0d1117] p-2 text-center">
                            <div className="text-[9px] uppercase tracking-wide text-white/30">{label}</div>
                            <div className={`mt-0.5 text-sm font-bold ${colors[label]}`}>{lsi.window_counts?.[label] ?? 0}</div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Score History */}
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => setActiveModal({ kind: "lsi-history" })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setActiveModal({ kind: "lsi-history" });
                    }
                  }}
                  className="rounded-2xl border border-white/[0.06] bg-[#161b22] p-3 cursor-pointer hover:border-white/15 transition"
                >
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest text-white/40">
                      <TrendingUp size={11} className="text-cyan-400" />
                      Error Score History
                    </div>
                    <div className="flex items-center gap-2 text-[9px]">
                      <span className="text-white/30">Baseline</span>
                      <span className="font-mono text-white/50">{lsi?.error_baseline_mean?.toFixed(3) ?? "—"}</span>
                      <span className="text-red-400/60">Threshold {lsi?.error_threshold?.toFixed(3) ?? "—"}</span>
                      <Maximize2 size={11} className="text-white/30" />
                    </div>
                  </div>
                  <SparkLine
                    values={lsi?.error_score_history ?? []}
                    threshold={lsi?.error_threshold}
                    baseline={lsi?.error_baseline_mean}
                    lineColor={lsi?.is_error_anomalous ? "#fb7185" : "#67e8f9"}
                    id="lsi-error-score"
                    height={90}
                  />
                  <div className="mt-2 flex items-center gap-4 text-[9px] text-white/30">
                    <span className="flex items-center gap-1"><span className="inline-block w-4 border-t border-dashed border-red-400/60" /> Threshold</span>
                    <span className="flex items-center gap-1"><span className="inline-block w-4 border-t border-dashed border-white/25" /> Error baseline</span>
                    <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-full bg-cyan-400" /> Error score</span>
                  </div>
                </div>

                {/* Recent lines */}
                {lsi && (lsi.recent_lines?.length ?? 0) > 0 && (
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => setActiveModal({ kind: "lsi-window" })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setActiveModal({ kind: "lsi-window" });
                      }
                    }}
                    className="rounded-2xl border border-white/[0.06] bg-[#161b22] p-3 cursor-pointer hover:border-white/15 transition"
                  >
                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-[10px] font-semibold uppercase tracking-widest text-white/40">Recent Window Lines</span>
                      <Maximize2 size={11} className="text-white/30" />
                    </div>
                    <div className="space-y-0.5 font-mono text-[10px] max-h-[160px] overflow-y-auto scrollbar-hide">
                      {lsi.recent_lines.slice(-30).map((entry, i) => {
                        const colors: Record<string, string> = { INFO: "text-emerald-400", WARN: "text-yellow-400", ERROR: "text-red-400", NOVEL: "text-purple-400" };
                        return (
                          <div key={i} className="flex gap-2">
                            <span className={`shrink-0 w-10 text-right font-bold ${colors[entry.label] ?? "text-white/40"}`}>{entry.label}</span>
                            <span className="text-white/50 truncate">{entry.line}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* LSI warmup progress */}
                {lsi && !lsi.fitted && (
                  <div className="rounded-xl border border-violet-500/25 bg-violet-500/[0.05] px-3 py-2.5">
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-[11px] font-semibold text-violet-300">Building log corpus…</span>
                      <span className="text-[10px] font-mono text-white/40">{lsi.corpus_size} / 200 lines</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
                      <div className="h-full rounded-full bg-violet-400 transition-all duration-700" style={{ width: `${Math.min((lsi.corpus_size / 200) * 100, 100)}%` }} />
                    </div>
                    <p className="mt-1.5 text-[10px] text-white/35">TF-IDF + SVD model trains after 200 log lines. Log anomaly scoring activates automatically.</p>
                  </div>
                )}

                {/* LSI status */}
                <div className="rounded-xl border border-white/[0.05] bg-[#0d1117] px-3 py-2.5 text-[11px] leading-5 text-white/60">
                  <span className="font-semibold text-white/80">LSI Status: </span>
                  {lsi?.is_error_anomalous ? (
                    <span className="text-red-400">ERROR anomaly — score {lsi.current_score?.toFixed(4) ?? "—"} exceeds threshold. <span className="font-semibold">Rollback will trigger.</span></span>
                  ) : lsi?.is_anomalous ? (
                    <span className="text-amber-400">WARN/NOVEL anomaly — score {lsi.current_score?.toFixed(4) ?? "—"} exceeds threshold. Informational only — <span className="font-semibold">no rollback.</span></span>
                  ) : lsi?.fitted ? (
                    <span className="text-emerald-400">Log patterns within normal baseline.</span>
                  ) : (
                    <span className="text-white/30">{lsi ? "Waiting for corpus to reach 200 lines…" : "Waiting for agent connection..."}</span>
                  )}
                </div>
              </>
            )}
          </div>
        </div>

        {/* ── CENTER: Insights + Log Stream ── */}
        <div className="flex-1 min-w-0 flex flex-col min-h-0 gap-3">

          {/* ── Log Stream ── */}
          <div className={`${terminalOpen ? "h-1/2" : "flex-1"} min-h-0 rounded-2xl border border-white/[0.06] bg-[#161b22] overflow-hidden flex flex-col`}>
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/[0.06] shrink-0">
              <span className="text-[9px] font-semibold uppercase tracking-widest text-white/40">Classified Log Stream</span>
              <div className="flex items-center gap-3 text-[9px] text-white/25">
                {lsi && (
                  <span className="flex items-center gap-1.5">
                    <span className="text-purple-400">{lsi.window_counts?.NOVEL ?? 0} novel</span>
                    <span className="text-red-400">{lsi.window_counts?.ERROR ?? 0} error</span>
                    <span className="text-yellow-400">{lsi.window_counts?.WARN ?? 0} warn</span>
                    <span className="text-emerald-400">{lsi.window_counts?.INFO ?? 0} info</span>
                  </span>
                )}
                <span>{recentLines.length} lines (live)</span>
              </div>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto p-3 font-mono text-xs leading-5 bg-[#0d1117] scrollbar-hide">
              {recentLines.length === 0 ? (
                <div className="flex items-center justify-center h-full text-white/25 text-[11px]">
                  {!agentOnline
                    ? "Connect backtrack-agent to see classified logs."
                    : lsi && !lsi.fitted
                      ? `Building log corpus — ${lsi.corpus_size} / 200 lines collected. Classification starts after corpus is full.`
                      : "Waiting for classified log lines..."
                  }
                </div>
              ) : (
                <>
                  {novelLogLines.length > 0 && (
                    <>
                      <div className="mb-1.5 flex items-center gap-1.5 text-[9px] uppercase tracking-wide text-purple-400/60">
                        <span className="h-px flex-1 bg-purple-500/15" />Unknown Patterns ({novelLogLines.length})
                        <span className="h-px flex-1 bg-purple-500/15" />
                      </div>
                      {novelLogLines.map((entry, i) => (
                        <div key={`novel-${i}`} className="flex gap-2 py-0.5 rounded bg-purple-500/[0.04]">
                          <span className="shrink-0 w-12 text-right font-bold text-purple-400">NOVEL</span>
                          <span className="text-purple-200/65 truncate">{entry.line}</span>
                        </div>
                      ))}
                      {otherLogLines.length > 0 && (
                        <div className="my-2 flex items-center gap-1.5 text-[9px] uppercase tracking-wide text-white/20">
                          <span className="h-px flex-1 bg-white/[0.05]" />Classified Lines ({otherLogLines.length})
                          <span className="h-px flex-1 bg-white/[0.05]" />
                        </div>
                      )}
                    </>
                  )}
                  {otherLogLines.map((entry, i) => {
                    const labelColors: Record<string, string> = { ERROR: "text-red-400", WARN: "text-yellow-400", INFO: "text-emerald-400" };
                    return (
                      <div key={`line-${i}`} className="flex gap-2 py-0.5">
                        <span className={`shrink-0 w-12 text-right font-bold ${labelColors[entry.label] ?? "text-white/40"}`}>{entry.label}</span>
                        <span className="text-white/55 truncate">{entry.line}</span>
                      </div>
                    );
                  })}
                </>
              )}
            </div>
          </div>

          {/* ── Terminal pane ── */}
          {terminalOpen && (
            <div className="h-1/2 min-h-0 rounded-2xl border border-white/[0.06] bg-[#0d1117] overflow-hidden flex flex-col">
              <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/[0.06] shrink-0">
                <div className="flex items-center gap-2 text-[9px] font-semibold uppercase tracking-widest text-white/40">
                  <TerminalSquare size={12} className="text-[var(--accent-teal)]" />
                  Terminal
                </div>
                <button
                  type="button"
                  onClick={() => setTerminalOpen(false)}
                  className="flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] text-white/40 hover:bg-white/[0.05] hover:text-white/70 transition"
                  aria-label="Close terminal"
                >
                  <ChevronDown size={12} />
                  Close
                </button>
              </div>
              <div className="flex-1 min-h-0">
                <AnomalyTerminal />
              </div>
            </div>
          )}

          {/* ── Toggle button ── */}
          {!terminalOpen && (
            <button
              type="button"
              onClick={() => setTerminalOpen(true)}
              className="shrink-0 flex items-center justify-center gap-2 rounded-xl border border-white/[0.06] bg-[#161b22] px-3 py-2 text-[11px] text-white/55 hover:border-[rgba(94,234,212,0.35)] hover:bg-[rgba(94,234,212,0.06)] hover:text-[var(--accent-teal)] transition"
            >
              <TerminalSquare size={13} />
              Open Terminal
            </button>
          )}
        </div>

        {/* ── RIGHT SIDEBAR ── */}
        <aside className="w-[440px] shrink-0 flex flex-col gap-3 overflow-y-auto scrollbar-hide">

          {/* Root Cause Analysis */}
          <div
            role="button"
            tabIndex={0}
            onClick={() => setActiveModal({ kind: "root-cause" })}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setActiveModal({ kind: "root-cause" });
              }
            }}
            className="rounded-2xl border border-white/[0.06] bg-[#161b22] p-4 cursor-pointer hover:border-white/15 transition"
          >
            <div className="flex items-center gap-2 mb-3">
              <Search size={14} className="text-white/50" />
              <span className="font-semibold text-sm text-white">Root Cause</span>
              {insight.driver !== "NONE" && (
                <span className="ml-auto rounded-full border border-orange-500/30 bg-orange-500/10 px-1.5 py-0.5 text-[9px] text-orange-300">ACTIVE</span>
              )}
              <Maximize2 size={12} className={`text-white/30 ${insight.driver !== "NONE" ? "" : "ml-auto"}`} />
            </div>
            <div className="rounded-xl border border-white/[0.05] bg-[#0d1117] p-2.5 mb-2.5">
              <div className="text-[9px] uppercase tracking-wide text-white/30 mb-1">Analysis</div>
              <div className="text-[11px] leading-5 text-white/75">{insight.headline}</div>
            </div>
            <p className="text-[10px] leading-[1.65] text-white/45 mb-2.5">{insight.explanation}</p>
            {insight.driftingMetrics.length > 0 && (
              <div className="space-y-1 mb-2.5">
                <div className="text-[9px] uppercase tracking-wide text-white/30 mb-1">Metric Drift</div>
                {insight.driftingMetrics.map((m) => (
                  <div key={m.name} className="flex items-center justify-between rounded-lg border border-red-500/15 bg-red-500/[0.04] px-2.5 py-1.5">
                    <span className="text-[10px] text-white/55">{m.name} residual</span>
                    <span className="text-[10px] font-bold text-red-400">~{m.ratio.toFixed(1)}×</span>
                  </div>
                ))}
              </div>
            )}
            {lsi?.is_anomalous && (
              <div className="flex items-center justify-between rounded-lg border border-purple-500/15 bg-purple-500/[0.04] px-2.5 py-1.5 mb-2.5">
                <span className="text-[10px] text-white/55">NOVEL log ratio</span>
                <span className="text-[10px] font-bold text-purple-400">{(insight.novelRatio * 100).toFixed(0)}% of window</span>
              </div>
            )}
            {insight.novelLines.length > 0 && (
              <div>
                <div className="text-[9px] uppercase tracking-wide text-white/30 mb-1.5">Unknown Patterns</div>
                <div className="space-y-1 rounded-xl border border-white/[0.05] bg-[#0d1117] p-2 font-mono text-[9px]">
                  {insight.novelLines.map((e, i) => (
                    <div key={i} className="flex gap-1.5 text-purple-300/70 leading-4">
                      <span className="shrink-0 text-purple-500/50">▸</span>
                      <span className="truncate">{e.line}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {insight.driver === "NONE" && (
              <div className="text-center text-[10px] text-white/25 py-2">{tsd && lsi ? "No anomaly signals detected." : "Waiting for agent data..."}</div>
            )}
          </div>

          {/* Diagnostic Summary */}
          <div
            role="button"
            tabIndex={0}
            onClick={() => setActiveModal({ kind: "diagnostic" })}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setActiveModal({ kind: "diagnostic" });
              }
            }}
            className="rounded-2xl border border-white/[0.06] bg-[#161b22] p-4 cursor-pointer hover:border-white/15 transition"
          >
            <div className="flex items-center gap-2 mb-3">
              <Activity size={14} className="text-white/50" />
              <span className="font-semibold text-sm text-white">Diagnostic Summary</span>
              <Maximize2 size={12} className="text-white/30 ml-auto" />
            </div>
            <div className="space-y-2 text-[11px]">
              {[
                { label: "Detected Issue", value: message, color: tones.accent },
                { label: "Current vs Baseline", value: `${current} vs ${baseline}`, color: "text-white/70" },
                { label: "Metric", value: metric, color: "text-white/70" },
                { label: "Namespace", value: namespace, color: "text-white/70" },
              ].map((row) => (
                <div key={row.label} className="rounded-lg border border-white/[0.05] bg-[#0d1117] px-2.5 py-2">
                  <div className="text-[9px] uppercase tracking-wide text-white/30">{row.label}</div>
                  <div className={`mt-0.5 text-[11px] font-semibold ${row.color}`}>{row.value}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Agent Status */}
          <div
            role="button"
            tabIndex={0}
            onClick={() => setActiveModal({ kind: "agent-status" })}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setActiveModal({ kind: "agent-status" });
              }
            }}
            className="rounded-2xl border border-white/[0.06] bg-[#161b22] p-4 cursor-pointer hover:border-white/15 transition"
          >
            <div className="flex items-center gap-2 mb-3">
              <ShieldAlert size={14} className="text-white/50" />
              <span className="font-semibold text-sm text-white">Agent Status</span>
              <Maximize2 size={12} className="text-white/30 ml-auto" />
            </div>
            <div className="space-y-1.5 text-[11px]">
              {[
                { label: "TSD Drift", value: tsd?.is_drifting ? "DRIFTING" : "Normal", color: tsd?.is_drifting ? "text-red-400" : "text-emerald-400" },
                { label: "LSI (rollback)", value: lsi?.is_error_anomalous ? "ERROR" : "Normal", color: lsi?.is_error_anomalous ? "text-red-400" : "text-emerald-400" },
                { label: "LSI (display)", value: lsi?.is_anomalous ? (lsi?.is_error_anomalous ? "ERROR" : "WARN") : "Normal", color: lsi?.is_error_anomalous ? "text-red-400" : lsi?.is_anomalous ? "text-amber-400" : "text-emerald-400" },
                { label: "LSI Model", value: lsi?.fitted ? "Fitted" : "Training", color: lsi?.fitted ? "text-emerald-400" : "text-red-400" },
                { label: "Readings", value: String(tsd?.readings_count ?? 0), color: "text-emerald-400" },
                { label: "Versions", value: String(versions.length), color: "text-emerald-400" },
              ].map((row) => (
                <div key={row.label} className="flex justify-between text-white/50">
                  <span>{row.label}</span>
                  <span className={row.color}>{row.value}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Actions */}
          {/* Version History */}
          <div
            role="button"
            tabIndex={0}
            onClick={() => setActiveModal({ kind: "version-history" })}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setActiveModal({ kind: "version-history" });
              }
            }}
            className="rounded-2xl border border-white/[0.06] bg-[#161b22] p-4 cursor-pointer hover:border-white/15 transition"
          >
            <div className="flex items-center gap-2 mb-3">
              <History size={14} className="text-white/50" />
              <span className="font-semibold text-sm text-white">Version History</span>
              <span className="ml-auto text-[10px] text-white/35">{versions.length} total</span>
              <Maximize2 size={12} className="text-white/30" />
            </div>
            <div className="space-y-1.5">
              {rollingBack && (
                <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.07] px-2.5 py-1.5">
                  <RefreshCw size={11} className="text-amber-300 animate-spin" />
                  <div className="flex-1 min-w-0">
                    <div className="text-[11px] font-semibold text-amber-200">Reverting…</div>
                    <div className="text-[9px] text-white/40 truncate">Awaiting agent confirmation</div>
                  </div>
                </div>
              )}
              {versions.length === 0 && !rollingBack && (
                <div className="text-[10px] text-white/30 px-1">No version snapshots yet.</div>
              )}
              {versions.slice(0, 4).map((v) => {
                const meta = versionStatusMeta(v.status);
                return (
                  <div key={v.id} className={`flex items-center gap-2 rounded-lg border ${meta.border} ${meta.bg} px-2.5 py-1.5`}>
                    <CircleDot size={9} className={meta.iconColor} />
                    <div className="flex-1 min-w-0">
                      <div className="text-[11px] font-mono text-white/80 truncate">{v.image_tag}</div>
                      <div className="text-[9px] text-white/35">{formatRelTimestamp(v.created_at)}</div>
                    </div>
                    <span className={`text-[9px] font-semibold uppercase tracking-wide ${meta.textColor}`}>{meta.label}</span>
                  </div>
                );
              })}
              {versions.length > 4 && (
                <div className="text-[9.5px] text-white/35 px-1">+{versions.length - 4} more · click to expand</div>
              )}
            </div>
          </div>

          {/* Actions */}
          <div className="rounded-2xl border border-white/[0.06] bg-[#161b22] p-4">
            <h3 className="text-sm font-semibold text-white mb-3">Actions</h3>
            <div className="space-y-2">
              <button
                type="button"
                disabled={rollingBack || !stableVersion}
                onClick={triggerRollback}
                className="flex w-full items-center justify-center gap-2 rounded-xl border border-amber-500/35 bg-amber-500/[0.08] px-3 py-2 text-xs font-semibold text-amber-200 hover:bg-amber-500/[0.14] transition disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {rollingBack ? (
                  <>
                    <RefreshCw size={12} className="animate-spin" />
                    Reverting…
                  </>
                ) : (
                  <>
                    <RotateCcw size={12} />
                    Rollback to Stable
                  </>
                )}
              </button>
              {rollbackMessage && (
                <div className={`rounded-lg border px-2.5 py-1.5 text-[10.5px] ${
                  rollbackMessage.kind === "error"
                    ? "border-red-500/30 bg-red-500/[0.07] text-red-300"
                    : "border-emerald-500/25 bg-emerald-500/[0.06] text-emerald-300"
                }`}>
                  {rollbackMessage.text}
                </div>
              )}
              <Link
                href="/anomalies"
                className="flex w-full items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-xs text-white/70 hover:bg-white/[0.08] transition"
              >
                <ArrowLeft size={12} />
                Back to Terminal
              </Link>
              {stableVersion && !rollingBack && (
                <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.05] p-3">
                  <div className="flex items-center gap-1.5 text-[11px] text-emerald-400">
                    <CheckCircle2 size={12} />
                    Rollback Available
                  </div>
                  <div className="mt-1 text-[10px] text-white/40">Stable version {stableVersion.image_tag} ready.</div>
                </div>
              )}
            </div>
          </div>

        </aside>
      </div>

      {/* ── Detail Modals ── */}
      <AnomalyModal
        open={activeModal?.kind === "tsd-live"}
        onClose={() => setActiveModal(null)}
        title="Live Metrics"
        subtitle={`${tsd?.readings_count ?? 0} readings · STL decomposition residuals`}
        size="lg"
      >
        <div className="grid grid-cols-2 gap-3 mb-4">
          {[
            { label: "CPU", value: `${tsd?.current?.cpu_percent?.toFixed(1) ?? "—"}%`, color: "text-emerald-400" },
            { label: "Memory", value: `${tsd?.current?.memory_mb?.toFixed(1) ?? "—"} MB`, color: "text-sky-400" },
            { label: "Latency", value: `${tsd?.current?.latency_ms?.toFixed(0) ?? "—"} ms`, color: "text-violet-400" },
            { label: "Error Rate", value: `${tsd?.current?.error_rate_percent?.toFixed(2) ?? "—"}%`, color: "text-rose-400" },
          ].map((s) => (
            <div key={s.label} className="rounded-xl border border-white/[0.06] bg-[#0d1117] p-4">
              <div className="text-[11px] uppercase tracking-wide text-white/40">{s.label}</div>
              <div className={`mt-1 text-2xl font-bold ${s.color}`}>{s.value}</div>
            </div>
          ))}
        </div>
        <div className="space-y-3">
          {[
            { label: "CPU history", values: tsd?.history?.cpu ?? [], color: "#6ee7b7", id: "m-cpu" },
            { label: "Memory history", values: tsd?.history?.memory ?? [], color: "#7dd3fc", id: "m-mem" },
            { label: "Latency history", values: tsd?.history?.latency ?? [], color: "#c4b5fd", id: "m-lat" },
            { label: "Error rate history", values: tsd?.history?.error_rate ?? [], color: "#fca5a5", id: "m-err" },
          ].map((h) => (
            <div key={h.id} className="rounded-xl border border-white/[0.06] bg-[#0d1117] p-3">
              <div className="mb-2 flex items-center justify-between text-[11px]">
                <span className="text-white/55">{h.label}</span>
                <span className="font-mono text-white/40">{h.values.at(-1)?.toFixed(2) ?? "—"}</span>
              </div>
              <SparkLine values={h.values} lineColor={h.color} id={h.id} height={140} />
            </div>
          ))}
        </div>
      </AnomalyModal>

      <AnomalyModal
        open={activeModal?.kind === "residual"}
        onClose={() => setActiveModal(null)}
        title={activeModal?.kind === "residual" ? RESIDUAL_META[activeModal.metric].label : ""}
        subtitle="STL residuals · 3×IQR drift threshold"
        size="lg"
      >
        {activeModal?.kind === "residual" && (() => {
          const m = activeModal.metric;
          const values = tsd?.residuals?.[m] ?? [];
          const meta = RESIDUAL_META[m];
          const last = values.at(-1) ?? 0;
          const thr = 3 * estimateIQR(values);
          const ratio = thr > 0 ? Math.abs(last) / thr : 0;
          const hot = ratio > 1.0;
          const stats = values.length
            ? {
                min: Math.min(...values),
                max: Math.max(...values),
                avg: values.reduce((a, b) => a + b, 0) / values.length,
              }
            : { min: 0, max: 0, avg: 0 };
          return (
            <>
              <div className="grid grid-cols-4 gap-2 mb-4">
                <div className="rounded-xl border border-white/[0.06] bg-[#0d1117] p-3">
                  <div className="text-[10px] uppercase tracking-wide text-white/40">Last</div>
                  <div className={`mt-1 text-lg font-bold ${hot ? "text-red-400" : "text-emerald-400"}`}>
                    {(last > 0 ? "+" : "") + last.toFixed(3)}
                  </div>
                </div>
                <div className="rounded-xl border border-white/[0.06] bg-[#0d1117] p-3">
                  <div className="text-[10px] uppercase tracking-wide text-white/40">3×IQR threshold</div>
                  <div className="mt-1 text-lg font-bold text-white/75">±{thr.toFixed(3)}</div>
                </div>
                <div className="rounded-xl border border-white/[0.06] bg-[#0d1117] p-3">
                  <div className="text-[10px] uppercase tracking-wide text-white/40">Drift ratio</div>
                  <div className={`mt-1 text-lg font-bold ${hot ? "text-red-400" : "text-emerald-400"}`}>
                    {ratio.toFixed(2)}×
                  </div>
                </div>
                <div className="rounded-xl border border-white/[0.06] bg-[#0d1117] p-3">
                  <div className="text-[10px] uppercase tracking-wide text-white/40">Verdict</div>
                  <div className={`mt-1 text-sm font-bold ${hot ? "text-red-400" : "text-emerald-400"}`}>
                    {hot ? "DRIFTING" : "NORMAL"}
                  </div>
                </div>
              </div>
              <div className="rounded-xl border border-white/[0.06] bg-[#0d1117] p-3 mb-4">
                <ResidualSparkline values={values} threshold={thr} lineColor={meta.color} id={`big-${m}`} height={320} />
              </div>
              <div className="grid grid-cols-3 gap-2 text-[11px]">
                <div className="rounded-lg border border-white/[0.05] bg-[#0d1117] px-3 py-2">
                  <span className="text-white/40">Min</span>{" "}
                  <span className="font-mono text-white/80">{stats.min.toFixed(3)}</span>
                </div>
                <div className="rounded-lg border border-white/[0.05] bg-[#0d1117] px-3 py-2">
                  <span className="text-white/40">Avg</span>{" "}
                  <span className="font-mono text-white/80">{stats.avg.toFixed(3)}</span>
                </div>
                <div className="rounded-lg border border-white/[0.05] bg-[#0d1117] px-3 py-2">
                  <span className="text-white/40">Max</span>{" "}
                  <span className="font-mono text-white/80">{stats.max.toFixed(3)}</span>
                </div>
              </div>
            </>
          );
        })()}
      </AnomalyModal>

      <AnomalyModal
        open={activeModal?.kind === "tsd-history"}
        onClose={() => setActiveModal(null)}
        title={activeModal?.kind === "tsd-history" ? `${activeModal.metric === "memory" ? "Memory" : "Latency"} History` : ""}
        size="lg"
      >
        {activeModal?.kind === "tsd-history" && (() => {
          const m = activeModal.metric;
          const values = tsd?.history?.[m] ?? [];
          const color = m === "memory" ? "#7dd3fc" : "#c4b5fd";
          const unit = m === "memory" ? "MB" : "ms";
          const stats = values.length
            ? {
                min: Math.min(...values),
                max: Math.max(...values),
                avg: values.reduce((a, b) => a + b, 0) / values.length,
                cur: values.at(-1) ?? 0,
              }
            : { min: 0, max: 0, avg: 0, cur: 0 };
          return (
            <>
              <div className="grid grid-cols-4 gap-2 mb-4">
                {[
                  { l: "Current", v: stats.cur },
                  { l: "Min", v: stats.min },
                  { l: "Avg", v: stats.avg },
                  { l: "Max", v: stats.max },
                ].map((s) => (
                  <div key={s.l} className="rounded-xl border border-white/[0.06] bg-[#0d1117] p-3">
                    <div className="text-[10px] uppercase tracking-wide text-white/40">{s.l}</div>
                    <div className="mt-1 text-lg font-bold" style={{ color }}>
                      {s.v.toFixed(m === "memory" ? 1 : 0)} {unit}
                    </div>
                  </div>
                ))}
              </div>
              <div className="rounded-xl border border-white/[0.06] bg-[#0d1117] p-3">
                <SparkLine values={values} lineColor={color} id={`big-${m}-hist`} height={300} unit={unit} />
              </div>
            </>
          );
        })()}
      </AnomalyModal>

      <AnomalyModal
        open={activeModal?.kind === "lsi-scores"}
        onClose={() => setActiveModal(null)}
        title="LSI Scores"
        subtitle={lsi?.fitted ? "Model fitted · cosine similarity to baseline centroids" : `Corpus warming up: ${lsi?.corpus_size ?? 0} lines`}
        size="lg"
      >
        <div className="grid grid-cols-3 gap-3 mb-4">
          <div className="rounded-xl border border-white/[0.06] bg-[#0d1117] p-4">
            <div className="text-[11px] uppercase tracking-wide text-white/40">Current Score</div>
            <div className={`mt-1 text-2xl font-bold ${lsi?.is_error_anomalous ? "text-red-400" : lsi?.is_anomalous ? "text-amber-400" : "text-cyan-300"}`}>
              {lsi?.current_score?.toFixed(4) ?? "—"}
            </div>
          </div>
          <div className="rounded-xl border border-white/[0.06] bg-[#0d1117] p-4">
            <div className="text-[11px] uppercase tracking-wide text-white/40">Baseline Mean</div>
            <div className="mt-1 text-2xl font-bold text-white/80">
              {(lsi && lsi.baseline_mean > 0) ? lsi.baseline_mean.toFixed(4) : <span className="text-sm text-white/30">warming up…</span>}
            </div>
          </div>
          <div className="rounded-xl border border-white/[0.06] bg-[#0d1117] p-4">
            <div className="text-[11px] uppercase tracking-wide text-white/40">Threshold</div>
            <div className="mt-1 text-2xl font-bold text-red-300/80">{lsi?.threshold?.toFixed(4) ?? "—"}</div>
          </div>
        </div>
        <div className="grid grid-cols-4 gap-2">
          {(["INFO", "WARN", "ERROR", "NOVEL"] as const).map((label) => {
            const colors: Record<string, string> = { INFO: "text-emerald-400", WARN: "text-yellow-400", ERROR: "text-red-400", NOVEL: "text-purple-400" };
            return (
              <div key={label} className="rounded-xl border border-white/[0.06] bg-[#0d1117] p-3 text-center">
                <div className="text-[10px] uppercase tracking-wide text-white/40">{label}</div>
                <div className={`mt-1 text-2xl font-bold ${colors[label]}`}>{lsi?.window_counts?.[label] ?? 0}</div>
              </div>
            );
          })}
        </div>
      </AnomalyModal>

      <AnomalyModal
        open={activeModal?.kind === "lsi-history"}
        onClose={() => setActiveModal(null)}
        title="LSI Score History"
        subtitle="Cosine-similarity score per window · baseline + threshold overlaid"
        size="lg"
      >
        <div className="rounded-xl border border-white/[0.06] bg-[#0d1117] p-3">
          <SparkLine values={scoreHistory} threshold={lsi?.threshold} baseline={lsi?.baseline_mean} lineColor="#67e8f9" id="big-lsi-score" height={300} />
        </div>
        <div className="mt-3 flex items-center gap-4 text-[11px] text-white/40">
          <span className="flex items-center gap-1.5"><span className="inline-block w-4 border-t border-dashed border-red-400/60" /> Threshold {lsi?.threshold?.toFixed(4) ?? "—"}</span>
          <span className="flex items-center gap-1.5"><span className="inline-block w-4 border-t border-dashed border-white/25" /> Baseline mean {lsi?.baseline_mean?.toFixed(4) ?? "—"}</span>
          <span className="flex items-center gap-1.5"><span className="inline-block w-2 h-2 rounded-full bg-cyan-400" /> Current {lsi?.current_score?.toFixed(4) ?? "—"}</span>
        </div>
      </AnomalyModal>

      <AnomalyModal
        open={activeModal?.kind === "lsi-window"}
        onClose={() => setActiveModal(null)}
        title="Recent Window Lines"
        subtitle={`${lsi?.recent_lines?.length ?? 0} lines · classified by trained SVD model`}
        size="xl"
      >
        <div className="space-y-0.5 font-mono text-[12px] leading-6">
          {(lsi?.recent_lines ?? []).map((entry, i) => {
            const colors: Record<string, string> = { INFO: "text-emerald-400", WARN: "text-yellow-400", ERROR: "text-red-400", NOVEL: "text-purple-400" };
            return (
              <div key={i} className="flex gap-3 px-2 py-1 rounded hover:bg-white/[0.03]">
                <span className={`shrink-0 w-14 text-right font-bold ${colors[entry.label] ?? "text-white/40"}`}>{entry.label}</span>
                <span className="text-white/70 break-all">{entry.line}</span>
              </div>
            );
          })}
        </div>
      </AnomalyModal>

      <AnomalyModal
        open={activeModal?.kind === "root-cause"}
        onClose={() => setActiveModal(null)}
        title="Root Cause Analysis"
        subtitle={insight.headline}
        size="lg"
      >
        <p className="text-[13px] leading-7 text-white/70 mb-4">{insight.explanation}</p>
        {insight.driftingMetrics.length > 0 && (
          <div className="mb-4">
            <div className="text-[11px] uppercase tracking-wide text-white/40 mb-2">Drifting Metrics</div>
            <div className="space-y-1.5">
              {insight.driftingMetrics.map((m) => (
                <div key={m.name} className="flex items-center justify-between rounded-xl border border-red-500/20 bg-red-500/[0.05] px-3 py-2.5">
                  <div>
                    <div className="text-[12px] text-white/80">{m.name}</div>
                    <div className="text-[10px] text-white/40 font-mono">last residual {(m.lastResidual > 0 ? "+" : "") + m.lastResidual.toFixed(3)} · 3×IQR ±{m.iqrThreshold.toFixed(3)}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-[16px] font-bold text-red-400">{m.ratio.toFixed(1)}×</div>
                    <div className="text-[10px] text-white/35">over threshold</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        {lsi?.is_error_anomalous && (
          <div className="mb-4 rounded-xl border border-red-500/20 bg-red-500/[0.05] px-3 py-2.5">
            <div className="text-[11px] uppercase tracking-wide text-white/40 mb-1">LSI Error Anomaly — Rollback will trigger</div>
            <div className="text-[12px] text-white/80">
              LSI score {lsi.current_score?.toFixed(4) ?? "—"} is {(insight.scoreRatio).toFixed(2)}× the threshold ({lsi.threshold?.toFixed(4) ?? "—"}).
              ERROR ratio {(insight.errorRatio * 100).toFixed(0)}% of window.
            </div>
          </div>
        )}
        {lsi?.is_anomalous && !lsi?.is_error_anomalous && (
          <div className="mb-4 rounded-xl border border-amber-500/20 bg-amber-500/[0.05] px-3 py-2.5">
            <div className="text-[11px] uppercase tracking-wide text-white/40 mb-1">LSI Warn/Novel Anomaly — Informational only</div>
            <div className="text-[12px] text-white/80">
              LSI score {lsi.current_score?.toFixed(4) ?? "—"} is {(insight.scoreRatio).toFixed(2)}× the threshold ({lsi.threshold?.toFixed(4) ?? "—"}).
              NOVEL ratio {(insight.novelRatio * 100).toFixed(0)}% · No rollback will fire.
            </div>
          </div>
        )}
        {insight.novelLines.length > 0 && (
          <div>
            <div className="text-[11px] uppercase tracking-wide text-white/40 mb-2">Unknown Patterns</div>
            <div className="space-y-1 rounded-xl border border-white/[0.05] bg-[#0d1117] p-3 font-mono text-[12px]">
              {insight.novelLines.map((e, i) => (
                <div key={i} className="flex gap-2 text-purple-300/80 leading-6">
                  <span className="shrink-0 text-purple-500/60">▸</span>
                  <span className="break-all">{e.line}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </AnomalyModal>

      <AnomalyModal
        open={activeModal?.kind === "diagnostic"}
        onClose={() => setActiveModal(null)}
        title="Diagnostic Summary"
        size="md"
      >
        <div className="space-y-2">
          {[
            { label: "Detected Issue", value: message, color: tones.accent },
            { label: "Current vs Baseline", value: `${current} vs ${baseline}`, color: "text-white/80" },
            { label: "Metric", value: metric, color: "text-white/80" },
            { label: "Namespace", value: namespace, color: "text-white/80" },
            { label: "Service", value: serviceName, color: "text-white/80" },
            { label: "Severity", value: severity, color: tones.accent },
          ].map((row) => (
            <div key={row.label} className="rounded-xl border border-white/[0.06] bg-[#0d1117] px-4 py-3">
              <div className="text-[11px] uppercase tracking-wide text-white/40">{row.label}</div>
              <div className={`mt-1 text-[14px] font-semibold ${row.color}`}>{row.value}</div>
            </div>
          ))}
        </div>
      </AnomalyModal>

      <AnomalyModal
        open={activeModal?.kind === "agent-status"}
        onClose={() => setActiveModal(null)}
        title="Agent Status"
        subtitle={agentOnline ? "backtrack-agent online · port 8847" : "backtrack-agent offline"}
        size="md"
      >
        <div className="space-y-2">
          {[
            { label: "TSD Drift", value: tsd?.is_drifting ? "DRIFTING" : "Normal", color: tsd?.is_drifting ? "text-red-400" : "text-emerald-400" },
            { label: "LSI Error (rollback)", value: lsi?.is_error_anomalous ? "ANOMALOUS" : "Normal", color: lsi?.is_error_anomalous ? "text-red-400" : "text-emerald-400" },
            { label: "LSI Warn/Novel (display)", value: lsi?.is_anomalous && !lsi?.is_error_anomalous ? "ANOMALOUS" : "Normal", color: lsi?.is_anomalous && !lsi?.is_error_anomalous ? "text-amber-400" : "text-emerald-400" },
            { label: "LSI Model", value: lsi?.fitted ? "Fitted" : "Training", color: lsi?.fitted ? "text-emerald-400" : "text-red-400" },
            { label: "TSD Readings", value: String(tsd?.readings_count ?? 0), color: "text-emerald-400" },
            { label: "LSI Corpus", value: String(lsi?.corpus_size ?? 0), color: "text-emerald-400" },
            { label: "Versions", value: String(versions.length), color: "text-emerald-400" },
            { label: "Last Update", value: lastUpdate || "—", color: "text-emerald-400" },
          ].map((row) => (
            <div key={row.label} className="flex items-center justify-between rounded-xl border border-white/[0.06] bg-[#0d1117] px-4 py-3">
              <span className="text-[12px] text-white/55">{row.label}</span>
              <span className={`text-[13px] font-semibold ${row.color}`}>{row.value}</span>
            </div>
          ))}
        </div>
      </AnomalyModal>

      <AnomalyModal
        open={activeModal?.kind === "version-history"}
        onClose={() => setActiveModal(null)}
        title="Version History"
        subtitle={`${versions.length} snapshots tracked by backtrack-agent`}
        size="lg"
      >
        {rollingBack && (
          <div className="mb-4 flex items-center gap-3 rounded-xl border border-amber-500/30 bg-amber-500/[0.07] px-4 py-3">
            <RefreshCw size={16} className="text-amber-300 animate-spin shrink-0" />
            <div>
              <div className="text-[13px] font-semibold text-amber-200">Reverting…</div>
              <div className="text-[11px] text-white/50">
                Rolling back{" "}
                <span className="font-mono">{currentVersion?.image_tag ?? serviceName}</span>
                {stableVersion && <> to <span className="font-mono">{stableVersion.image_tag}</span></>}
                . Awaiting agent confirmation.
              </div>
            </div>
          </div>
        )}
        {versions.length === 0 && !rollingBack && (
          <div className="text-center text-[12px] text-white/40 py-6">No version snapshots yet.</div>
        )}
        <div className="space-y-2">
          {versions.map((v, idx) => {
            const meta = versionStatusMeta(v.status);
            const isLatest = idx === 0;
            return (
              <div key={v.id} className={`flex items-center gap-3 rounded-xl border ${meta.border} ${meta.bg} px-4 py-3`}>
                <CircleDot size={12} className={meta.iconColor} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-mono text-white/90 truncate">{v.image_tag}</span>
                    {isLatest && (
                      <span className="rounded-full border border-cyan-500/30 bg-cyan-500/[0.08] px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-cyan-300">Latest</span>
                    )}
                  </div>
                  <div className="text-[10px] text-white/40 font-mono mt-0.5">
                    {formatRelTimestamp(v.created_at)} · {v.id.slice(0, 8)}
                  </div>
                </div>
                <span className={`text-[11px] font-semibold uppercase tracking-wide ${meta.textColor}`}>{meta.label}</span>
              </div>
            );
          })}
        </div>
      </AnomalyModal>
    </div>
  );
}

export default function ServiceDiagnosticsPageWrapper() {
  return (
    <Suspense>
      <ServiceDiagnosticsPage />
    </Suspense>
  );
}
