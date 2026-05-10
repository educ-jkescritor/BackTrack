"use client";

import { useCallback, useEffect, useState } from "react";
import { Activity, BarChart2, CheckCircle2, Clock, FlaskConical, Trash2, XCircle, Zap } from "lucide-react";
import Nav from "@/app/components/Nav";

type MttrEntry = {
  id: string;
  service: string;
  anomaly_type: string;
  anomaly_detected_at: string;
  rollback_triggered_at: string;
  rollback_completed_at: string;
  mttr_seconds: number;
  success: boolean;
  source?: "manual" | "agent";
};

type MttrStats = { count: number; avg: number | null; min: number | null; max: number | null };

type MatrixCell = { tp: number; fp: number; tn: number; fn: number; precision: number | null; recall: number | null; f1: number | null; accuracy: number | null };

type DetectionEntry = {
  id: string;
  test_label: string;
  fault_injected: boolean;
  fault_type: string;
  service?: string;
  tsd_detected: boolean;
  lsi_detected: boolean;
  detection_latency_seconds: number | null;
  notes: string;
  created_at: string;
};

type TestForm = {
  test_label: string;
  fault_injected: boolean;
  fault_type: "crash" | "latency" | "logs" | "none";
  service: string;
  injected_at: string;
  tsd_detected: boolean;
  lsi_detected: boolean;
  detected_at: string;
  notes: string;
};

const fmtSeconds = (s: number) =>
  s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;

const fmtPct = (v: number | null) =>
  v === null ? "—" : `${(v * 100).toFixed(1)}%`;

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

function StatCard({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: string; sub?: string }) {
  return (
    <div className="bt-panel p-4 flex items-start gap-3">
      <div className="text-[var(--accent-teal)] mt-0.5">{icon}</div>
      <div>
        <p className="text-[11px] text-[var(--text-muted)] uppercase tracking-wide">{label}</p>
        <p className="text-[22px] font-semibold text-[var(--text-primary)] leading-tight">{value}</p>
        {sub && <p className="text-[11px] text-[var(--text-muted)] mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}

function MatrixBlock({ label, cell, color }: { label: string; cell: MatrixCell; color: string }) {
  // Detect "no anomaly events yet" — valid for healthy systems, not a bug
  const noEvents = cell.tp === 0 && cell.fp === 0 && cell.fn === 0 && cell.tn > 0;

  return (
    <div className="bt-panel p-4 flex flex-col gap-3">
      <p className="text-[12px] font-semibold text-[var(--text-primary)] flex items-center gap-2">
        <span className="w-2 h-2 rounded-full inline-block" style={{ background: color }} />
        {label}
      </p>
      <div className="grid grid-cols-2 gap-2">
        {[
          { k: "TP", v: cell.tp, c: "text-emerald-400" },
          { k: "FP", v: cell.fp, c: "text-rose-400" },
          { k: "FN", v: cell.fn, c: "text-amber-400" },
          { k: "TN", v: cell.tn, c: "text-sky-400" },
        ].map(({ k, v, c }) => (
          <div key={k} className="rounded-lg bg-white/[0.03] border border-[var(--border-soft)] p-2 text-center">
            <p className="text-[10px] text-[var(--text-muted)]">{k}</p>
            <p className={`text-[20px] font-bold ${c}`}>{v}</p>
          </div>
        ))}
      </div>
      {noEvents ? (
        <div className="rounded-lg bg-emerald-500/[0.07] border border-emerald-500/20 px-3 py-2 text-center">
          <p className="text-[11px] text-emerald-400 font-medium">No anomaly events — system operating nominally</p>
          <p className="text-[10px] text-white/30 mt-0.5">Precision / Recall / F1 require at least one anomaly event to compute. Accuracy: {fmtPct(cell.accuracy)}</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2 text-center">
          {[
            { k: "Precision", v: cell.precision },
            { k: "Recall", v: cell.recall },
            { k: "F1 Score", v: cell.f1 },
            { k: "Accuracy", v: cell.accuracy },
          ].map(({ k, v }) => (
            <div key={k} className="rounded-lg bg-white/[0.03] border border-[var(--border-soft)] p-2">
              <p className="text-[10px] text-[var(--text-muted)]">{k}</p>
              <p className="text-[14px] font-semibold text-[var(--text-primary)]">{fmtPct(v)}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function MetricsPage() {
  const [mttrEntries, setMttrEntries] = useState<MttrEntry[]>([]);
  const [mttrStats, setMttrStats] = useState<MttrStats>({ count: 0, avg: null, min: null, max: null });
  const [showMttrForm, setShowMttrForm] = useState(false);
  type MttrAnomalyType = "TSD" | "LSI" | "BOTH" | "MANUAL";
  const [mttrForm, setMttrForm] = useState<{ service: string; anomaly_type: MttrAnomalyType; anomaly_detected_at: string; rollback_triggered_at: string; rollback_completed_at: string; success: boolean }>({ service: "", anomaly_type: "MANUAL", anomaly_detected_at: "", rollback_triggered_at: "", rollback_completed_at: "", success: true });
  const [detectionEntries, setDetectionEntries] = useState<DetectionEntry[]>([]);
  const [matrix, setMatrix] = useState<{ tsd: MatrixCell; lsi: MatrixCell } | null>(null);
  const [matrixSource, setMatrixSource] = useState<"manual" | "agent" | "none">("none");
  const [showTestForm, setShowTestForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [testForm, setTestForm] = useState<TestForm>({
    test_label: "",
    fault_injected: true,
    fault_type: "latency",
    service: "",
    injected_at: new Date().toISOString().slice(0, 16),
    tsd_detected: false,
    lsi_detected: false,
    detected_at: new Date().toISOString().slice(0, 16),
    notes: "",
  });

  const loadMttr = useCallback(async () => {
    const res = await fetch("/api/metrics/mttr");
    if (!res.ok) return;
    const data = await res.json();
    setMttrEntries(data.entries ?? []);
    setMttrStats(data.stats ?? { count: 0, avg: null, min: null, max: null });
  }, []);

  const loadDetection = useCallback(async () => {
    const res = await fetch("/api/metrics/detection");
    if (!res.ok) return;
    const data = await res.json();
    setDetectionEntries(data.entries ?? []);
    setMatrix(data.matrix ?? null);
    setMatrixSource(data.source ?? "none");
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadMttr();
    loadDetection();
  }, [loadMttr, loadDetection]);

  const submitTestRun = async () => {
    setSubmitting(true);
    await fetch("/api/metrics/detection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...testForm,
        injected_at: testForm.fault_injected ? new Date(testForm.injected_at).toISOString() : null,
        detected_at: (testForm.tsd_detected || testForm.lsi_detected) ? new Date(testForm.detected_at).toISOString() : null,
      }),
    });
    await loadDetection();
    setSubmitting(false);
    setShowTestForm(false);
    setTestForm({
      test_label: "",
      fault_injected: true,
      fault_type: "latency",
      service: "",
      injected_at: new Date().toISOString().slice(0, 16),
      tsd_detected: false,
      lsi_detected: false,
      detected_at: new Date().toISOString().slice(0, 16),
      notes: "",
    });
  };

  const submitMttrManual = async () => {
    setSubmitting(true);
    await fetch("/api/metrics/mttr", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...mttrForm,
        anomaly_detected_at: new Date(mttrForm.anomaly_detected_at).toISOString(),
        rollback_triggered_at: new Date(mttrForm.rollback_triggered_at).toISOString(),
        rollback_completed_at: new Date(mttrForm.rollback_completed_at).toISOString(),
      }),
    });
    await loadMttr();
    setSubmitting(false);
    setShowMttrForm(false);
    setMttrForm({ service: "", anomaly_type: "MANUAL", anomaly_detected_at: "", rollback_triggered_at: "", rollback_completed_at: "", success: true });
  };

  const clearMttr = async () => {
    await fetch("/api/metrics/mttr", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "clear" }) });
    loadMttr();
  };

  const clearDetection = async () => {
    await fetch("/api/metrics/detection", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "clear" }) });
    loadDetection();
  };

  return (
    <div className="h-screen flex flex-col bg-[var(--bg-base)] text-[var(--text-primary)] overflow-hidden">
    <Nav />
    <main className="flex-1 min-h-0 overflow-hidden p-6">
      <div className="flex h-full min-h-0 flex-col gap-8">
      {/* Header */}
      <div className="flex items-center gap-3 shrink-0">
        <BarChart2 size={22} className="text-[var(--accent-teal)]" />
        <div>
          <h1 className="text-[18px] font-semibold">Evaluation Metrics</h1>
          <p className="text-[12px] text-[var(--text-muted)]">MTTR · Confusion Matrix · ISO 25010 via /evaluate</p>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-hide pr-1 space-y-8">
      {/* ── MTTR ── */}
      <section id="wt-mttr-section">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-[13px] font-semibold text-[var(--text-secondary)] uppercase tracking-widest flex items-center gap-2">
            <Clock size={14} /> Mean Time to Recovery
          </h2>
          <div className="flex gap-2">
            <button
              onClick={() => setShowMttrForm((v) => !v)}
              className="flex items-center gap-1.5 text-[11px] px-3 py-1.5 rounded-lg border border-[var(--border-soft)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-white/[0.04] transition"
            >
              + Manual Entry
            </button>
            {mttrEntries.length > 0 && (
              <button onClick={clearMttr} className="flex items-center gap-1.5 text-[11px] text-[var(--text-muted)] hover:text-rose-400 transition px-2 py-1 rounded-lg hover:bg-white/[0.04]">
                <Trash2 size={12} /> Clear
              </button>
            )}
          </div>
        </div>

        {showMttrForm && (
          <div className="bt-panel p-5 mb-4 space-y-4">
            <p className="text-[12px] font-semibold text-[var(--text-primary)]">Manual MTTR Entry</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="bt-label block mb-1">Service Name</label>
                <input className="w-full bg-white/[0.04] border border-[var(--border-soft)] rounded-lg px-3 py-2 text-[12px] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-teal)]" value={mttrForm.service} onChange={(e) => setMttrForm((p) => ({ ...p, service: e.target.value }))} placeholder="e.g. memstress" />
              </div>
              <div>
                <label className="bt-label block mb-1">Anomaly Type</label>
                <select className="w-full bg-[var(--bg-elevated)] border border-[var(--border-soft)] rounded-lg px-3 py-2 text-[12px] text-[var(--text-primary)]" value={mttrForm.anomaly_type} onChange={(e) => setMttrForm((p) => ({ ...p, anomaly_type: e.target.value as "TSD" | "LSI" | "BOTH" | "MANUAL" }))}>
                  {["TSD", "LSI", "BOTH", "MANUAL"].map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              {[
                { key: "anomaly_detected_at", label: "Anomaly Detected At" },
                { key: "rollback_triggered_at", label: "Rollback Triggered At" },
                { key: "rollback_completed_at", label: "Rollback Completed At" },
              ].map(({ key, label }) => (
                <div key={key}>
                  <label className="bt-label block mb-1">{label}</label>
                  <input type="datetime-local" className="w-full bg-white/[0.04] border border-[var(--border-soft)] rounded-lg px-3 py-2 text-[12px] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-teal)]" value={(mttrForm as unknown as Record<string, string>)[key]} onChange={(e) => setMttrForm((p) => ({ ...p, [key]: e.target.value }))} />
                </div>
              ))}
            </div>
            <div className="flex gap-2 items-center">
              <label className="text-[12px] text-[var(--text-secondary)] flex items-center gap-2">
                <input type="checkbox" className="accent-[var(--accent-teal)]" checked={mttrForm.success} onChange={(e) => setMttrForm((p) => ({ ...p, success: e.target.checked }))} />
                Rollback Succeeded
              </label>
              <div className="flex gap-2 ml-auto">
                <button onClick={() => setShowMttrForm(false)} className="px-4 py-2 text-[12px] rounded-lg border border-[var(--border-soft)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition">Cancel</button>
                <button onClick={submitMttrManual} disabled={submitting || !mttrForm.service || !mttrForm.anomaly_detected_at || !mttrForm.rollback_completed_at} className="px-4 py-2 text-[12px] rounded-lg bg-[var(--accent-teal)] text-[#0d1117] font-semibold hover:opacity-90 transition disabled:opacity-50">{submitting ? "Saving…" : "Save Entry"}</button>
              </div>
            </div>
          </div>
        )}

        <div className="grid grid-cols-4 gap-3 mb-4">
          <StatCard icon={<Activity size={16} />} label="Total Rollbacks" value={String(mttrStats.count)} />
          <StatCard icon={<Clock size={16} />} label="Avg MTTR" value={mttrStats.avg !== null ? fmtSeconds(Math.round(mttrStats.avg)) : "—"} sub="from detection to recovery" />
          <StatCard icon={<Zap size={16} />} label="Best MTTR" value={mttrStats.min !== null ? fmtSeconds(mttrStats.min) : "—"} />
          <StatCard icon={<Clock size={16} />} label="Worst MTTR" value={mttrStats.max !== null ? fmtSeconds(mttrStats.max) : "—"} />
        </div>

        {mttrEntries.length > 0 ? (
          <div className="bt-panel overflow-hidden">
            <div className="max-h-[42vh] overflow-y-auto scrollbar-hide">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b border-[var(--border-soft)]">
                  {["Service", "Type", "Detected At", "Completed At", "MTTR", "Status"].map((h) => (
                    <th key={h} className="text-left px-4 py-3 text-[11px] text-[var(--text-muted)] uppercase tracking-wide font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[...mttrEntries].reverse().map((e) => (
                  <tr key={e.id} className="border-b border-[var(--border-soft)] last:border-0 hover:bg-white/[0.02]">
                    <td className="px-4 py-3 font-mono text-[var(--accent-teal)]">{e.service}</td>
                    <td className="px-4 py-3">
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-white/[0.06] border border-[var(--border-soft)]">{e.anomaly_type}</span>
                    </td>
                    <td className="px-4 py-3 text-[var(--text-muted)]">{fmtDate(e.anomaly_detected_at)}</td>
                    <td className="px-4 py-3 text-[var(--text-muted)]">{fmtDate(e.rollback_completed_at)}</td>
                    <td className="px-4 py-3 font-semibold">{fmtSeconds(e.mttr_seconds)}</td>
                    <td className="px-4 py-3">
                      {e.success
                        ? <span className="flex items-center gap-1 text-emerald-400"><CheckCircle2 size={12} /> Success</span>
                        : <span className="flex items-center gap-1 text-rose-400"><XCircle size={12} /> Failed</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </div>
        ) : (
          <div className="bt-panel p-8 text-center text-[var(--text-muted)] text-[13px]">
            No rollbacks recorded yet. MTTR is logged automatically when rollback is triggered from the anomaly page.
          </div>
        )}
      </section>

      {/* ── Confusion Matrix ── */}
      <section id="wt-matrix-section">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-[13px] font-semibold text-[var(--text-secondary)] uppercase tracking-widest flex items-center gap-2">
            <FlaskConical size={14} /> Detection Accuracy — Confusion Matrix
          </h2>
          <div className="flex gap-2">
            <button
              onClick={() => setShowTestForm((v) => !v)}
              className="flex items-center gap-1.5 text-[11px] px-3 py-1.5 rounded-lg border border-[var(--border-soft)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-white/[0.04] transition"
            >
              + Add Test Run
            </button>
            {detectionEntries.length > 0 && (
              <button onClick={clearDetection} className="flex items-center gap-1.5 text-[11px] text-[var(--text-muted)] hover:text-rose-400 transition px-2 py-1 rounded-lg hover:bg-white/[0.04]">
                <Trash2 size={12} /> Clear
              </button>
            )}
          </div>
        </div>

        {showTestForm && (
          <div className="bt-panel p-5 mb-4 space-y-4">
            <p className="text-[12px] font-semibold text-[var(--text-primary)]">New Test Run</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="bt-label block mb-1">Test Label</label>
                <input
                  className="w-full bg-white/[0.04] border border-[var(--border-soft)] rounded-lg px-3 py-2 text-[12px] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-teal)]"
                  value={testForm.test_label}
                  onChange={(e) => setTestForm((p) => ({ ...p, test_label: e.target.value }))}
                  placeholder="e.g. Latency spike test 1"
                />
              </div>
              <div>
                <label className="bt-label block mb-1">Service (optional)</label>
                <input
                  className="w-full bg-white/[0.04] border border-[var(--border-soft)] rounded-lg px-3 py-2 text-[12px] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-teal)]"
                  value={testForm.service}
                  onChange={(e) => setTestForm((p) => ({ ...p, service: e.target.value }))}
                  placeholder="e.g. memstress"
                />
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="bt-label block mb-1">Fault Injected?</label>
                <div className="flex gap-3">
                  {[true, false].map((v) => (
                    <label key={String(v)} className="flex items-center gap-1.5 cursor-pointer text-[12px] text-[var(--text-secondary)]">
                      <input type="radio" className="accent-[var(--accent-teal)]" checked={testForm.fault_injected === v} onChange={() => setTestForm((p) => ({ ...p, fault_injected: v }))} />
                      {v ? "Yes" : "No"}
                    </label>
                  ))}
                </div>
              </div>
              <div>
                <label className="bt-label block mb-1">Fault Type</label>
                <select
                  className="w-full bg-[var(--bg-elevated)] border border-[var(--border-soft)] rounded-lg px-3 py-2 text-[12px] text-[var(--text-primary)] focus:outline-none"
                  value={testForm.fault_type}
                  onChange={(e) => setTestForm((p) => ({ ...p, fault_type: e.target.value as TestForm["fault_type"] }))}
                  disabled={!testForm.fault_injected}
                >
                  <option value="latency">Latency</option>
                  <option value="crash">Crash</option>
                  <option value="logs">Log Corruption</option>
                  <option value="none">None</option>
                </select>
              </div>
              <div>
                <label className="bt-label block mb-1">Injected At</label>
                <input
                  type="datetime-local"
                  className="w-full bg-white/[0.04] border border-[var(--border-soft)] rounded-lg px-3 py-2 text-[12px] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-teal)]"
                  value={testForm.injected_at}
                  onChange={(e) => setTestForm((p) => ({ ...p, injected_at: e.target.value }))}
                  disabled={!testForm.fault_injected}
                />
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="bt-label block mb-1">TSD Detected?</label>
                <div className="flex gap-3">
                  {[true, false].map((v) => (
                    <label key={String(v)} className="flex items-center gap-1.5 cursor-pointer text-[12px] text-[var(--text-secondary)]">
                      <input type="radio" className="accent-[var(--accent-teal)]" checked={testForm.tsd_detected === v} onChange={() => setTestForm((p) => ({ ...p, tsd_detected: v }))} />
                      {v ? "Yes" : "No"}
                    </label>
                  ))}
                </div>
              </div>
              <div>
                <label className="bt-label block mb-1">LSI Detected?</label>
                <div className="flex gap-3">
                  {[true, false].map((v) => (
                    <label key={String(v)} className="flex items-center gap-1.5 cursor-pointer text-[12px] text-[var(--text-secondary)]">
                      <input type="radio" className="accent-[var(--accent-teal)]" checked={testForm.lsi_detected === v} onChange={() => setTestForm((p) => ({ ...p, lsi_detected: v }))} />
                      {v ? "Yes" : "No"}
                    </label>
                  ))}
                </div>
              </div>
              <div>
                <label className="bt-label block mb-1">Detected At</label>
                <input
                  type="datetime-local"
                  className="w-full bg-white/[0.04] border border-[var(--border-soft)] rounded-lg px-3 py-2 text-[12px] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-teal)]"
                  value={testForm.detected_at}
                  onChange={(e) => setTestForm((p) => ({ ...p, detected_at: e.target.value }))}
                  disabled={!testForm.tsd_detected && !testForm.lsi_detected}
                />
              </div>
            </div>

            <div>
              <label className="bt-label block mb-1">Notes</label>
              <input
                className="w-full bg-white/[0.04] border border-[var(--border-soft)] rounded-lg px-3 py-2 text-[12px] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-teal)]"
                value={testForm.notes}
                onChange={(e) => setTestForm((p) => ({ ...p, notes: e.target.value }))}
                placeholder="Optional notes"
              />
            </div>

            <div className="flex gap-2 justify-end">
              <button onClick={() => setShowTestForm(false)} className="px-4 py-2 text-[12px] rounded-lg border border-[var(--border-soft)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition">
                Cancel
              </button>
              <button
                onClick={submitTestRun}
                disabled={submitting || !testForm.test_label}
                className="px-4 py-2 text-[12px] rounded-lg bg-[var(--accent-teal)] text-[#0d1117] font-semibold hover:opacity-90 transition disabled:opacity-50"
              >
                {submitting ? "Saving…" : "Save Test Run"}
              </button>
            </div>
          </div>
        )}

        {matrixSource !== "none" && (
          <div className="flex items-center gap-2 mb-2">
            <span className="text-[11px] text-[var(--text-muted)]">Data source:</span>
            {matrixSource === "agent" ? (
              <span className="bt-chip bt-chip-teal">Live agent evaluation</span>
            ) : (
              <span className="bt-chip bt-chip-violet">Manual test runs</span>
            )}
            {matrixSource === "agent" && (
              <span className="text-[11px] text-[var(--text-muted)]">— TSD uses sustained vs spike drift · LSI uses ERROR keyword-vs-SVD comparison</span>
            )}
          </div>
        )}

        {matrix ? (
          <div className="grid grid-cols-2 gap-4">
            <MatrixBlock label="TSD — Time Series Decomposition" cell={matrix.tsd} color="#5eead4" />
            <MatrixBlock label="LSI — Latent Semantic Indexing" cell={matrix.lsi} color="#818cf8" />
          </div>
        ) : (
          <div className="bt-panel p-8 text-center text-[var(--text-muted)] text-[13px]">
            {matrixSource === "none"
              ? "Agent not running or no data yet. Start monitoring to auto-populate, or add manual test runs above."
              : "No test runs recorded yet. Add test runs above to compute precision, recall, and F1."}
          </div>
        )}

        {detectionEntries.length > 0 && (
          <div className="bt-panel mt-4 overflow-hidden">
            <p className="text-[11px] text-[var(--text-muted)] px-4 pt-3 pb-2 uppercase tracking-wide font-medium">Test Run History</p>
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b border-[var(--border-soft)]">
                  {["Label", "Fault", "Type", "TSD", "LSI", "Latency", "Date"].map((h) => (
                    <th key={h} className="text-left px-4 py-2 text-[11px] text-[var(--text-muted)] uppercase tracking-wide font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[...detectionEntries].reverse().map((e) => (
                  <tr key={e.id} className="border-b border-[var(--border-soft)] last:border-0 hover:bg-white/[0.02]">
                    <td className="px-4 py-2 text-[var(--text-primary)]">{e.test_label}</td>
                    <td className="px-4 py-2">{e.fault_injected ? <span className="text-amber-400">Yes</span> : <span className="text-sky-400">No</span>}</td>
                    <td className="px-4 py-2 text-[var(--text-muted)]">{e.fault_type}</td>
                    <td className="px-4 py-2">{e.tsd_detected ? <CheckCircle2 size={13} className="text-emerald-400" /> : <XCircle size={13} className="text-[var(--text-muted)]" />}</td>
                    <td className="px-4 py-2">{e.lsi_detected ? <CheckCircle2 size={13} className="text-emerald-400" /> : <XCircle size={13} className="text-[var(--text-muted)]" />}</td>
                    <td className="px-4 py-2 text-[var(--text-muted)]">{e.detection_latency_seconds !== null ? fmtSeconds(e.detection_latency_seconds) : "—"}</td>
                    <td className="px-4 py-2 text-[var(--text-muted)]">{fmtDate(e.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      </div>
      </div>
    </main>
    </div>
  );
}
