"use client";

import { useEffect } from "react";
import { CheckCircle, RotateCcw, X, XCircle } from "lucide-react";

export type RollbackToast = {
  id: string;
  service: string;
  fromVersion: string;
  toVersion: string;
  status: "success" | "failed";
};

type Props = {
  toasts: RollbackToast[];
  onDismiss: (id: string) => void;
};

function Toast({ toast, onDismiss }: { toast: RollbackToast; onDismiss: (id: string) => void }) {
  const ok = toast.status === "success";

  useEffect(() => {
    const t = setTimeout(() => onDismiss(toast.id), 6000);
    return () => clearTimeout(t);
  }, [toast.id, onDismiss]);

  return (
    <div
      className="bt-rollback-event flex items-start gap-3 rounded-[14px] border p-4 shadow-2xl w-[340px]"
      style={{
        borderColor:  ok ? "rgba(52,211,153,0.28)"   : "rgba(251,113,133,0.28)",
        background:   ok ? "rgba(11,20,16,0.97)"      : "rgba(20,11,16,0.97)",
        boxShadow:    ok ? "0 8px 40px rgba(52,211,153,0.12)" : "0 8px 40px rgba(251,113,133,0.12)",
      }}
    >
      {/* icon */}
      <div
        className="shrink-0 h-8 w-8 rounded-full flex items-center justify-center"
        style={{
          background: ok ? "rgba(52,211,153,0.12)" : "rgba(251,113,133,0.12)",
          border: `1px solid ${ok ? "rgba(52,211,153,0.30)" : "rgba(251,113,133,0.30)"}`,
        }}
      >
        {ok
          ? <CheckCircle size={15} style={{ color: "var(--accent-green)" }} />
          : <XCircle    size={15} style={{ color: "var(--accent-rose)"  }} />
        }
      </div>

      {/* body */}
      <div className="flex-1 min-w-0">
        <p className="text-[13px] font-semibold" style={{ color: ok ? "#6ee7b7" : "#fca5a5" }}>
          {ok ? "Rollback successful" : "Rollback failed"}
        </p>
        <p className="text-[11px] text-[var(--text-secondary)] mt-0.5 truncate">
          {toast.service}
        </p>

        {/* version path */}
        <div className="flex items-center gap-1.5 bt-mono text-[10px] mt-1.5">
          <RotateCcw size={9} className="text-[var(--text-muted)]" />
          <span style={{ color: "#fca5a5", textDecoration: "line-through" }}>{toast.fromVersion}</span>
          <span className="text-[var(--text-muted)]">→</span>
          <span style={{ color: "#6ee7b7" }}>{toast.toVersion}</span>
        </div>

        {!ok && (
          <p className="text-[10.5px] text-[var(--text-muted)] mt-1.5">
            Check agent logs — rollback could not be completed.
          </p>
        )}
      </div>

      {/* dismiss */}
      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        className="shrink-0 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors mt-0.5"
      >
        <X size={13} />
      </button>
    </div>
  );
}

export default function RollbackToastStack({ toasts, onDismiss }: Props) {
  if (toasts.length === 0) return null;

  return (
    <div
      className="fixed bottom-6 right-6 z-50 flex flex-col gap-2.5 pointer-events-none"
    >
      {toasts.map((t) => (
        <div key={t.id} className="pointer-events-auto">
          <Toast toast={t} onDismiss={onDismiss} />
        </div>
      ))}
    </div>
  );
}
