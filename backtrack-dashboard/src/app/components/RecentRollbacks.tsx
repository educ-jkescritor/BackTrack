"use client";

import { useEffect, useState } from "react";
import { CheckCircle, RotateCcw, XCircle } from "lucide-react";

type RollbackEntry = {
  id: string;
  timestamp: string;
  reason: string;
  from_tag: string;
  to_tag: string;
  service_name: string;
  mode: string;
  success: boolean;
  rollback_triggered_at: string;
  rollback_completed_at: string;
};

export default function RecentRollbacks() {
  const [entries, setEntries] = useState<RollbackEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch("/api/agent?path=rollback/history", { cache: "no-store" });
        if (res.ok) {
          const data = await res.json();
          setEntries(Array.isArray(data) ? data.slice(0, 15) : []);
        }
      } catch {
        // agent unreachable
      } finally {
        setLoading(false);
      }
    };
    load();
    const timer = setInterval(load, 15000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="h-full flex flex-col rounded-[16px] border border-[var(--border-soft)] bg-[var(--card-bg)] overflow-hidden">
      {/* header */}
      <div className="flex-shrink-0 flex items-center justify-between px-5 py-3.5 border-b border-[var(--border-soft)]">
        <div className="flex items-center gap-2">
          <RotateCcw size={14} className="text-[var(--accent-teal)]" />
          <span className="text-[12px] font-semibold tracking-[0.12em] uppercase text-[var(--text-secondary)]">
            Recent Rollbacks
          </span>
        </div>
        <span className="bt-mono text-[10px] text-[var(--text-muted)]">
          {entries.length} total
        </span>
      </div>

      {/* body */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center h-full text-[12px] text-[var(--text-muted)]">
            Loading…
          </div>
        ) : entries.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 py-8">
            <RotateCcw size={20} className="text-[var(--text-muted)] opacity-30" />
            <p className="text-[11.5px] text-[var(--text-muted)]">No rollbacks recorded yet</p>
          </div>
        ) : (
          <div className="divide-y divide-[var(--border-soft)]">
            {entries.map((entry) => (
              <div
                key={entry.id}
                className="px-5 py-3 hover:bg-white/[0.015] transition-colors"
              >
                <div className="flex items-start gap-2.5">
                  {/* status icon */}
                  <div className="shrink-0 mt-0.5">
                    {entry.success ? (
                      <CheckCircle size={13} style={{ color: "var(--accent-green)" }} />
                    ) : (
                      <XCircle size={13} style={{ color: "var(--accent-rose)" }} />
                    )}
                  </div>

                  {/* content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2 mb-0.5">
                      <span className="bt-mono text-[11px] font-medium text-[var(--text-primary)] truncate">
                        {entry.service_name || "—"}
                      </span>
                      <span className="shrink-0 bt-mono text-[10px] text-[var(--text-muted)]">
                        {new Date(
                          entry.rollback_triggered_at || entry.timestamp
                        ).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                    </div>

                    {/* version arrow */}
                    <div className="flex items-center gap-1 bt-mono text-[10px] mb-1">
                      <span
                        style={{ color: "#fca5a5" }}
                        className="truncate max-w-[110px]"
                        title={entry.from_tag}
                      >
                        {entry.from_tag || "?"}
                      </span>
                      <span className="text-[var(--text-muted)]">→</span>
                      <span
                        style={{ color: "#6ee7b7" }}
                        className="truncate max-w-[110px]"
                        title={entry.to_tag}
                      >
                        {entry.to_tag || "?"}
                      </span>
                    </div>

                    <p className="text-[10px] text-[var(--text-muted)] truncate">
                      {entry.reason}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
