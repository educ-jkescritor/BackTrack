"use client";

import { Check, X } from "lucide-react";

export type RollbackEvent = {
  id: string;
  service: string;
  fromVersion: string;
  toVersion: string;
  reason: string;
  metric: string;
  value: string;
  baseline: string;
  phase: "rolling" | "complete";
};

type Props = {
  event: RollbackEvent;
  onDismiss: (id: string) => void;
};

const ROW: Array<{ label: string; value: (e: RollbackEvent) => string }> = [
  { label: "trigger",  value: (e) => e.reason },
  { label: "metric",   value: (e) => `${e.metric}  ${e.value}  (baseline ${e.baseline})` },
];

export default function RollbackEventCard({ event, onDismiss }: Props) {
  const rolling = event.phase === "rolling";

  const barColor     = rolling ? "rgba(251,191,36,0.75)"  : "rgba(52,211,153,0.75)";
  const borderColor  = rolling ? "rgba(251,191,36,0.22)"  : "rgba(52,211,153,0.22)";
  const bgColor      = rolling ? "rgba(251,191,36,0.04)"  : "rgba(52,211,153,0.04)";
  const textColor    = rolling ? "#fcd34d"                 : "#6ee7b7";

  return (
    <div
      className="bt-rollback-event relative rounded-[14px] border overflow-hidden"
      style={{ borderColor, background: bgColor }}
    >
      {/* left bar */}
      <div className="absolute left-0 top-0 bottom-0 w-[2px]" style={{ background: barColor }} />

      <div className="px-4 py-3 pl-5">
        {/* header */}
        <div className="flex items-center gap-2 mb-2">
          {rolling ? (
            <div className="bt-pulse-dot bt-amber shrink-0" />
          ) : (
            <div
              className="h-2 w-2 rounded-full flex items-center justify-center shrink-0"
              style={{ background: "var(--accent-green)" }}
            >
              <Check size={6} strokeWidth={3} className="text-black" />
            </div>
          )}
          <span className="text-[11.5px] font-medium" style={{ color: textColor }}>
            {rolling ? "Rolling back…" : "Rollback complete"}
          </span>
          <span
            className="bt-mono text-[10px] text-[var(--text-muted)] truncate flex-1"
            style={{ marginLeft: 4 }}
          >
            {event.service}
          </span>
          {!rolling && (
            <button
              type="button"
              onClick={() => onDismiss(event.id)}
              className="shrink-0 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
            >
              <X size={13} />
            </button>
          )}
        </div>

        {/* version path */}
        <div className="flex items-center gap-1.5 bt-mono text-[10.5px] mb-2">
          <span style={{ color: "#fca5a5", textDecoration: "line-through" }}>{event.fromVersion}</span>
          <span className="text-[var(--text-muted)]">→</span>
          <span style={{ color: "#6ee7b7" }}>{event.toVersion}</span>
        </div>

        {/* data rows */}
        <div
          className="grid text-[10px] gap-x-2.5 gap-y-0.5"
          style={{ gridTemplateColumns: "auto 1fr" }}
        >
          {ROW.map(({ label, value }) => (
            <>
              <span key={`l-${label}`} className="text-[var(--text-muted)] bt-mono uppercase tracking-[0.1em]">{label}</span>
              <span key={`v-${label}`} className="text-[var(--text-secondary)] truncate">{value(event)}</span>
            </>
          ))}
          {!rolling && (
            <>
              <span key="l-restored" className="text-[var(--text-muted)] bt-mono uppercase tracking-[0.1em]">restored</span>
              <span key="v-restored" style={{ color: "#6ee7b7", fontSize: 10 }}>Service healthy — error rate returned to baseline</span>
            </>
          )}
        </div>
      </div>

      {/* progress bar */}
      {rolling && (
        <div className="h-[2px] w-full" style={{ background: "rgba(251,191,36,0.12)" }}>
          <div
            className="bt-rollback-progress h-full"
            style={{ background: "rgba(251,191,36,0.65)" }}
          />
        </div>
      )}
    </div>
  );
}
