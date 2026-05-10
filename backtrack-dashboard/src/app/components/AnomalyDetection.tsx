"use client";

import { useState } from "react";
import Link from "next/link";
import { AlertTriangle, Clock, RotateCcw, ShieldCheck, TriangleAlert, X, Zap } from "lucide-react";
import type { DashboardAnomaly } from "@/lib/monitoring-types";

const SEV = {
  critical: {
    bar:         "rgba(251,113,133,0.75)",
    border:      "rgba(251,113,133,0.18)",
    bg:          "rgba(251,113,133,0.05)",
    text:        "#fca5a5",
    chip:        "bt-chip bt-chip-critical",
    countBorder: "rgba(251,113,133,0.35)",
    countBg:     "rgba(251,113,133,0.10)",
    countText:   "#fca5a5",
    icon:        <TriangleAlert size={13} />,
  },
  high: {
    bar:         "rgba(251,191,36,0.75)",
    border:      "rgba(251,191,36,0.16)",
    bg:          "rgba(251,191,36,0.05)",
    text:        "#fcd34d",
    chip:        "bt-chip bt-chip-amber",
    countBorder: "rgba(251,191,36,0.35)",
    countBg:     "rgba(251,191,36,0.10)",
    countText:   "#fcd34d",
    icon:        <TriangleAlert size={13} />,
  },
  warning: {
    bar:         "rgba(253,224,71,0.6)",
    border:      "rgba(253,224,71,0.14)",
    bg:          "rgba(253,224,71,0.04)",
    text:        "#fde68a",
    chip:        "bt-chip bt-chip-warning",
    countBorder: "rgba(253,224,71,0.28)",
    countBg:     "rgba(253,224,71,0.08)",
    countText:   "#fde68a",
    icon:        <Clock size={13} />,
  },
} as const;

type Severity = keyof typeof SEV;

function relativeTime(iso?: string): string {
  if (!iso) return "";
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60)   return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  return `${Math.floor(diff / 3600)} hr ago`;
}

function SeverityCount({ label, count, sev }: { label: string; count: number; sev: Severity }) {
  const t = SEV[sev];
  return (
    <div
      className="flex flex-col items-center rounded-lg px-3 py-1.5 min-w-[44px]"
      style={{ border: `1px solid ${t.countBorder}`, background: t.countBg }}
    >
      <span className="bt-mono text-[15px] font-semibold leading-none" style={{ color: t.countText }}>
        {count}
      </span>
      <span className="text-[9px] uppercase tracking-[0.1em] mt-0.5" style={{ color: t.countText, opacity: 0.7 }}>
        {label}
      </span>
    </div>
  );
}

function RollbackConfirmModal({
  anomaly,
  onConfirm,
  onCancel,
}: {
  anomaly: DashboardAnomaly;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.65)", backdropFilter: "blur(4px)" }}
    >
      <div
        className="relative w-full max-w-[400px] rounded-[18px] border p-6 shadow-2xl"
        style={{
          background: "rgba(11,16,26,0.98)",
          borderColor: "rgba(251,113,133,0.28)",
          boxShadow: "0 20px 60px rgba(0,0,0,0.6), 0 0 0 1px rgba(251,113,133,0.08)",
        }}
      >
        {/* close */}
        <button
          type="button"
          onClick={onCancel}
          className="absolute top-4 right-4 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
        >
          <X size={15} />
        </button>

        {/* icon */}
        <div
          className="flex items-center justify-center w-11 h-11 rounded-full mb-4"
          style={{
            background: "rgba(251,113,133,0.10)",
            border: "1px solid rgba(251,113,133,0.28)",
          }}
        >
          <AlertTriangle size={20} style={{ color: "#fca5a5" }} />
        </div>

        {/* heading */}
        <h2 className="text-[15px] font-semibold text-[var(--text-primary)] mb-1">
          Confirm rollback
        </h2>
        <p className="text-[12px] text-[var(--text-secondary)] mb-4 leading-relaxed">
          Roll back{" "}
          <span className="bt-mono text-[var(--accent-rose)] font-medium">{anomaly.service}</span>{" "}
          to its last stable version? This will restart the service.
        </p>

        {/* detail row */}
        <div
          className="rounded-[10px] border px-3.5 py-2.5 mb-5 grid gap-y-1.5"
          style={{
            borderColor: "rgba(148,163,184,0.12)",
            background: "rgba(255,255,255,0.02)",
            gridTemplateColumns: "auto 1fr",
            columnGap: "0.75rem",
          }}
        >
          {[
            { label: "Service",  value: anomaly.service },
            { label: "Severity", value: anomaly.severity.toUpperCase() },
            { label: "Metric",   value: `${anomaly.metric}  →  ${anomaly.current} (was ${anomaly.baseline})` },
          ].map(({ label, value }) => (
            <>
              <span key={`l-${label}`} className="text-[10px] bt-mono uppercase tracking-[0.1em] text-[var(--text-muted)]">{label}</span>
              <span key={`v-${label}`} className="text-[10.5px] text-[var(--text-secondary)] truncate">{value}</span>
            </>
          ))}
        </div>

        {/* actions */}
        <div className="flex gap-2.5">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 rounded-[10px] border border-[var(--border-soft)] bg-transparent px-4 py-2 text-[12px] text-[var(--text-secondary)] hover:bg-white/[0.04] transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="flex-1 rounded-[10px] px-4 py-2 text-[12px] font-semibold transition-colors"
            style={{
              background: "rgba(251,113,133,0.15)",
              border: "1px solid rgba(251,113,133,0.40)",
              color: "#fca5a5",
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "rgba(251,113,133,0.25)"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "rgba(251,113,133,0.15)"; }}
          >
            <span className="flex items-center justify-center gap-1.5">
              <RotateCcw size={12} />
              Rollback now
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}

function AnomalyDetection({ anomalies, onAnomalyRollback }: { anomalies: DashboardAnomaly[]; onAnomalyRollback?: (anomaly: DashboardAnomaly) => void }) {
  const [pendingRollback, setPendingRollback] = useState<DashboardAnomaly | null>(null);

  const critical = anomalies.filter((a) => a.severity === "critical").length;
  const high     = anomalies.filter((a) => a.severity === "high").length;
  const warning  = anomalies.filter((a) => a.severity === "warning").length;

  return (
    <>
    {pendingRollback && (
      <RollbackConfirmModal
        anomaly={pendingRollback}
        onConfirm={() => {
          if (onAnomalyRollback) onAnomalyRollback(pendingRollback);
          setPendingRollback(null);
        }}
        onCancel={() => setPendingRollback(null)}
      />
    )}
    <div className="bt-panel h-full flex flex-col overflow-hidden p-5">

      {/* ── Header ── */}
      <div className="flex items-start justify-between gap-3 mb-4 flex-shrink-0">
        <div>
          <div className="flex items-center gap-2">
            <TriangleAlert size={15} className="text-[var(--accent-rose)]" />
            <span className="text-[15px] font-semibold text-[var(--text-primary)] leading-none">
              Anomaly Detection
            </span>
          </div>
          <p className="text-[11px] text-[var(--text-muted)] mt-1 ml-[23px]">BackTrack Analysis</p>
        </div>
        <div className="flex items-center gap-2">
          <SeverityCount label="Critical" count={critical} sev="critical" />
          <SeverityCount label="High"     count={high}     sev="high" />
          <SeverityCount label="Medium"   count={warning}  sev="warning" />
        </div>
      </div>

      {/* ── Divider ── */}
      <div className="bt-card-divider flex-shrink-0" />

      {/* ── List ── */}
      <div className="space-y-2.5 overflow-y-auto flex-1 min-h-0 scrollbar-hide mt-3">
        {anomalies.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center gap-3 rounded-xl border border-[rgba(52,211,153,0.2)] bg-[rgba(52,211,153,0.05)] px-4 py-3.5">
            <ShieldCheck size={22} className="text-[var(--accent-green)]" />
            <div className="text-center">
              <p className="text-[13px] text-[var(--accent-green)] font-medium">All systems nominal</p>
              <p className="text-[11px] text-[var(--text-muted)] mt-0.5">No active anomalies detected</p>
            </div>
          </div>
        ) : (
          anomalies.map((anomaly) => {
            const sev = (anomaly.severity as Severity) in SEV ? (anomaly.severity as Severity) : "warning";
            const t = SEV[sev];

            const href = `/anomalies/${encodeURIComponent(anomaly.service)}?namespace=${encodeURIComponent(anomaly.namespace)}&severity=${encodeURIComponent(anomaly.severity)}&metric=${encodeURIComponent(anomaly.metric)}&current=${encodeURIComponent(anomaly.current)}&baseline=${encodeURIComponent(anomaly.baseline)}&message=${encodeURIComponent(anomaly.message)}&platform=${encodeURIComponent(anomaly.platform ?? "kubernetes")}`;

            return (
              <Link
                key={anomaly.id}
                href={href}
                className="bt-anomaly-row block"
                style={{ border: `1px solid ${t.border}`, background: t.bg }}
              >
                {/* Left severity bar */}
                <div
                  className="absolute left-0 top-3 bottom-3 w-[2px] rounded-r-full"
                  style={{ background: t.bar }}
                />

                {/* Service + chip + timestamp */}
                <div className="flex items-center justify-between gap-2 mb-1.5">
                  <div className="flex items-center gap-2 min-w-0">
                    <span style={{ color: t.text }}>{t.icon}</span>
                    <span
                      className="text-[13px] font-medium leading-none truncate"
                      style={{ color: t.text }}
                    >
                      {anomaly.service}
                    </span>
                    <span className={t.chip}>{anomaly.severity}</span>
                    {anomaly.autoRollback && (
                      <span
                        className="bt-mono inline-flex items-center gap-1 shrink-0"
                        style={{
                          fontSize: 9.5,
                          textTransform: "uppercase",
                          letterSpacing: "0.08em",
                          color: "#fcd34d",
                          padding: "2px 7px",
                          borderRadius: 5,
                          border: "1px solid rgba(251,191,36,0.30)",
                          background: "rgba(251,191,36,0.06)",
                        }}
                      >
                        <Zap size={10} />auto-rollback
                      </span>
                    )}
                  </div>
                  {anomaly.detectedAt && (
                    <span className="text-[10px] text-[var(--text-muted)] bt-mono shrink-0">
                      {relativeTime(anomaly.detectedAt)}
                    </span>
                  )}
                </div>

                {/* Message */}
                <p className="text-[11.5px] text-[var(--text-secondary)] leading-[1.55] mb-3">
                  {anomaly.message}
                </p>

                {/* Horizontal rule */}
                <div className="h-px mb-2.5" style={{ background: t.border }} />

                {/* Metric / Baseline / Current columns */}
                <div className="flex items-end gap-2">
                  <div className="grid grid-cols-3 gap-2 flex-1">
                    {[
                      { label: "Metric",   value: anomaly.metric },
                      { label: "Baseline", value: anomaly.baseline },
                      { label: "Current",  value: anomaly.current },
                    ].map(({ label, value }) => (
                      <div key={label}>
                        <p className="text-[10px] text-[var(--text-muted)] mb-0.5">{label}</p>
                        <p
                          className="text-[11.5px] font-medium bt-mono"
                          style={{ color: t.text }}
                        >
                          {value}
                        </p>
                      </div>
                    ))}
                  </div>
                  {onAnomalyRollback && (
                    <button
                      type="button"
                      onClick={(e) => { e.preventDefault(); setPendingRollback(anomaly); }}
                      className="shrink-0 flex items-center gap-1.5"
                      style={{
                        padding: "3px 10px",
                        borderRadius: 6,
                        border: "1px solid rgba(251,191,36,0.35)",
                        background: "rgba(251,191,36,0.07)",
                        color: "#fcd34d",
                        fontSize: 11,
                        cursor: "pointer",
                      }}
                    >
                      <RotateCcw size={10} />Rollback now
                    </button>
                  )}
                </div>
              </Link>
            );
          })
        )}
      </div>
    </div>
    </>
  );
}

export default AnomalyDetection;
