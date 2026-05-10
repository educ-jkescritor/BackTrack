"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, ClipboardList, Users } from "lucide-react";
import Nav from "@/app/components/Nav";

type EvalScores = {
  functional_suitability: { completeness: number; correctness: number; appropriateness: number };
  performance_efficiency: { time_behavior: number; resource_utilization: number };
  compatibility: { coexistence: number; interoperability: number };
  usability: { recognisability: number; learnability: number; operability: number; user_error_protection: number; ui_aesthetics: number };
  reliability: { maturity: number; availability: number; fault_tolerance: number; recoverability: number };
  security: { confidentiality: number; integrity: number; authenticity: number };
  maintainability: { modularity: number; reusability: number; analysability: number; testability: number };
  portability: { adaptability: number; installability: number };
};

type EvalEntry = {
  id: string;
  respondent: string;
  role: string;
  submitted_at: string;
  scores: EvalScores;
  comments: string;
};

const CHARACTERISTICS: {
  key: keyof EvalScores;
  label: string;
  color: string;
  subs: { key: string; label: string; question: string }[];
}[] = [
  {
    key: "functional_suitability",
    label: "Functional Suitability",
    color: "#5eead4",
    subs: [
      { key: "completeness", label: "Completeness", question: "BackTrack covers all the monitoring and rollback functions I need." },
      { key: "correctness", label: "Correctness", question: "BackTrack produces accurate detection results and correct rollback outcomes." },
      { key: "appropriateness", label: "Appropriateness", question: "The features provided are appropriate for CI/CD anomaly monitoring." },
    ],
  },
  {
    key: "performance_efficiency",
    label: "Performance Efficiency",
    color: "#818cf8",
    subs: [
      { key: "time_behavior", label: "Time Behavior", question: "BackTrack detects anomalies and triggers rollbacks in a timely manner." },
      { key: "resource_utilization", label: "Resource Utilization", question: "BackTrack uses CPU and memory resources efficiently on my machine." },
    ],
  },
  {
    key: "compatibility",
    label: "Compatibility",
    color: "#f59e0b",
    subs: [
      { key: "coexistence", label: "Co-existence", question: "BackTrack works alongside my existing Kubernetes / Docker tools without conflicts." },
      { key: "interoperability", label: "Interoperability", question: "BackTrack integrates well with GitHub, Prometheus, and other external systems." },
    ],
  },
  {
    key: "usability",
    label: "Usability",
    color: "#34d399",
    subs: [
      { key: "recognisability", label: "Recognisability", question: "I can quickly understand the purpose and capabilities of each dashboard section." },
      { key: "learnability", label: "Learnability", question: "I was able to learn how to use BackTrack without extensive guidance." },
      { key: "operability", label: "Operability", question: "I can easily configure connections and navigate through the system." },
      { key: "user_error_protection", label: "User Error Protection", question: "The system prevents and warns me about potential errors." },
      { key: "ui_aesthetics", label: "UI Aesthetics", question: "The visual design is clean, readable, and professional." },
    ],
  },
  {
    key: "reliability",
    label: "Reliability",
    color: "#f87171",
    subs: [
      { key: "maturity", label: "Maturity", question: "BackTrack behaves consistently without unexpected failures." },
      { key: "availability", label: "Availability", question: "BackTrack remains accessible and responsive during normal use." },
      { key: "fault_tolerance", label: "Fault Tolerance", question: "BackTrack continues to function even when the agent or cluster is temporarily unavailable." },
      { key: "recoverability", label: "Recoverability", question: "After a rollback, BackTrack accurately reflects the restored system state." },
    ],
  },
  {
    key: "security",
    label: "Security",
    color: "#fb923c",
    subs: [
      { key: "confidentiality", label: "Confidentiality", question: "Sensitive data (tokens, credentials) are handled safely." },
      { key: "integrity", label: "Integrity", question: "BackTrack does not alter deployment state unintentionally." },
      { key: "authenticity", label: "Authenticity", question: "Actions performed are clearly attributed and traceable." },
    ],
  },
  {
    key: "maintainability",
    label: "Maintainability",
    color: "#a78bfa",
    subs: [
      { key: "modularity", label: "Modularity", question: "The system components (agent, dashboard, API) are clearly separated." },
      { key: "reusability", label: "Reusability", question: "The system components can be reused or extended for other projects." },
      { key: "analysability", label: "Analysability", question: "It is easy to diagnose issues within the system when something goes wrong." },
      { key: "testability", label: "Testability", question: "The system can be effectively tested through the evaluation metrics provided." },
    ],
  },
  {
    key: "portability",
    label: "Portability",
    color: "#22d3ee",
    subs: [
      { key: "adaptability", label: "Adaptability", question: "BackTrack can be adapted to different environments (Minikube, K3s, Kind)." },
      { key: "installability", label: "Installability", question: "Installing and setting up BackTrack is straightforward." },
    ],
  },
];

const SCALE_LABELS = ["Strongly Disagree", "Disagree", "Neutral", "Agree", "Strongly Agree"];

function buildDefaultScores(): EvalScores {
  const result: Record<string, Record<string, number>> = {};
  for (const c of CHARACTERISTICS) {
    result[c.key] = {};
    for (const s of c.subs) result[c.key][s.key] = 3;
  }
  return result as unknown as EvalScores;
}

function charAvg(scores: EvalScores, key: keyof EvalScores): number {
  const vals = Object.values(scores[key] as Record<string, number>);
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function overallAvg(scores: EvalScores): number {
  const avgs = CHARACTERISTICS.map((c) => charAvg(scores, c.key));
  return avgs.reduce((a, b) => a + b, 0) / avgs.length;
}

function ScoreBar({ value, color }: { value: number; color: string }) {
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 rounded-full bg-white/[0.06]">
        <div className="h-full rounded-full transition-all duration-500" style={{ width: `${(value / 5) * 100}%`, background: color }} />
      </div>
      <span className="text-[11px] font-semibold text-[var(--text-primary)] w-6 text-right">{value.toFixed(1)}</span>
    </div>
  );
}

export default function EvaluatePage() {
  const [respondent, setRespondent] = useState("");
  const [role, setRole] = useState("");
  const [comments, setComments] = useState("");
  const [scores, setScores] = useState<EvalScores>(buildDefaultScores);
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [results, setResults] = useState<{ entries: EvalEntry[]; averages: EvalScores | null; count: number } | null>(null);
  const [view, setView] = useState<"form" | "results">("form");

  const loadResults = useCallback(async () => {
    const res = await fetch("/api/evaluate");
    if (!res.ok) return;
    const data = await res.json();
    setResults(data);
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { loadResults(); }, [loadResults]);

  const setScore = (char: keyof EvalScores, sub: string, val: number) => {
    setScores((prev) => ({
      ...prev,
      [char]: { ...(prev[char] as Record<string, number>), [sub]: val },
    }));
  };

  const submit = async () => {
    if (!respondent.trim()) return;
    setSubmitting(true);
    await fetch("/api/evaluate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ respondent, role, scores, comments }),
    });
    await loadResults();
    setSubmitting(false);
    setSubmitted(true);
    setView("results");
  };

  return (
    <div className="h-screen flex flex-col bg-[var(--bg-base)] text-[var(--text-primary)] overflow-hidden">
    <Nav />
    <main className="flex-1 min-h-0 overflow-y-auto p-6 max-w-4xl mx-auto w-full space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <ClipboardList size={22} className="text-[var(--accent-teal)]" />
          <div>
            <h1 className="text-[18px] font-semibold">ISO 25010 Evaluation</h1>
            <p className="text-[12px] text-[var(--text-muted)]">Product Quality Model — Software Quality Assessment</p>
          </div>
        </div>
        <div className="flex gap-2">
          {["form", "results"].map((v) => (
            <button
              key={v}
              onClick={() => setView(v as "form" | "results")}
              className="px-3 py-1.5 text-[12px] rounded-lg border transition"
              style={{
                borderColor: view === v ? "rgba(94,234,212,0.35)" : "var(--border-soft)",
                background: view === v ? "rgba(94,234,212,0.07)" : "transparent",
                color: view === v ? "#d7f7ee" : "var(--text-secondary)",
              }}
            >
              {v === "form" ? "Survey Form" : `Results (${results?.count ?? 0})`}
            </button>
          ))}
        </div>
      </div>

      {view === "form" && (
        <>
          {submitted && (
            <div className="flex items-center gap-2 px-4 py-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-[13px]">
              <CheckCircle2 size={15} /> Response submitted. You can view aggregate results in the Results tab.
            </div>
          )}

          <div className="bt-panel p-5 space-y-4">
            <p className="text-[12px] font-semibold text-[var(--text-primary)]">Respondent Info</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="bt-label block mb-1">Full Name *</label>
                <input
                  className="w-full bg-white/[0.04] border border-[var(--border-soft)] rounded-lg px-3 py-2 text-[12px] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-teal)]"
                  value={respondent}
                  onChange={(e) => setRespondent(e.target.value)}
                  placeholder="e.g. Juan dela Cruz"
                />
              </div>
              <div>
                <label className="bt-label block mb-1">Role / Position</label>
                <input
                  className="w-full bg-white/[0.04] border border-[var(--border-soft)] rounded-lg px-3 py-2 text-[12px] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-teal)]"
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                  placeholder="e.g. DevOps Engineer"
                />
              </div>
            </div>
          </div>

          <p className="text-[12px] text-[var(--text-muted)]">
            Rate each statement from <strong className="text-[var(--text-secondary)]">1 (Strongly Disagree)</strong> to <strong className="text-[var(--text-secondary)]">5 (Strongly Agree)</strong>.
          </p>

          {CHARACTERISTICS.map((char) => (
            <div key={char.key} className="bt-panel p-5 space-y-4">
              <p className="text-[13px] font-semibold flex items-center gap-2">
                <span className="w-2 h-2 rounded-full inline-block" style={{ background: char.color }} />
                {char.label}
              </p>
              <div className="space-y-4">
                {char.subs.map((sub) => {
                  const val = (scores[char.key] as Record<string, number>)[sub.key];
                  return (
                    <div key={sub.key}>
                      <p className="text-[12px] text-[var(--text-secondary)] mb-2">{sub.question}</p>
                      <div className="flex gap-2 items-center">
                        {[1, 2, 3, 4, 5].map((n) => (
                          <button
                            key={n}
                            onClick={() => setScore(char.key, sub.key, n)}
                            title={SCALE_LABELS[n - 1]}
                            className="w-9 h-9 rounded-lg border text-[12px] font-semibold transition-all"
                            style={{
                              borderColor: val === n ? char.color : "var(--border-soft)",
                              background: val === n ? `${char.color}20` : "transparent",
                              color: val === n ? char.color : "var(--text-muted)",
                            }}
                          >
                            {n}
                          </button>
                        ))}
                        <span className="text-[11px] text-[var(--text-muted)] ml-2">{SCALE_LABELS[val - 1]}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}

          <div className="bt-panel p-5">
            <label className="bt-label block mb-2">Additional Comments</label>
            <textarea
              rows={3}
              className="w-full bg-white/[0.04] border border-[var(--border-soft)] rounded-lg px-3 py-2 text-[12px] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-teal)] resize-none"
              value={comments}
              onChange={(e) => setComments(e.target.value)}
              placeholder="Any additional feedback about the system…"
            />
          </div>

          <button
            onClick={submit}
            disabled={submitting || !respondent.trim()}
            className="w-full py-3 rounded-xl bg-[var(--accent-teal)] text-[#0d1117] font-semibold text-[13px] hover:opacity-90 transition disabled:opacity-50"
          >
            {submitting ? "Submitting…" : "Submit Evaluation"}
          </button>
        </>
      )}

      {view === "results" && (
        <>
          {!results || results.count === 0 ? (
            <div className="bt-panel p-10 text-center text-[var(--text-muted)] text-[13px]">
              No evaluations submitted yet. Be the first to complete the survey form.
            </div>
          ) : (
            <>
              <div className="flex items-center gap-3 bt-panel p-4">
                <Users size={18} className="text-[var(--accent-teal)]" />
                <div>
                  <p className="text-[13px] font-semibold">{results.count} Respondent{results.count !== 1 ? "s" : ""}</p>
                  {results.averages && (
                    <p className="text-[12px] text-[var(--text-muted)]">
                      Overall Average: <strong className="text-[var(--accent-teal)]">{overallAvg(results.averages).toFixed(2)} / 5.00</strong>
                    </p>
                  )}
                </div>
              </div>

              {results.averages && (
                <div className="bt-panel p-5 space-y-4">
                  <p className="text-[12px] font-semibold text-[var(--text-primary)] uppercase tracking-wide">Aggregate Scores by Characteristic</p>
                  <div className="space-y-3">
                    {CHARACTERISTICS.map((char) => {
                      const avg = charAvg(results.averages!, char.key);
                      return (
                        <div key={char.key}>
                          <div className="flex justify-between mb-1">
                            <span className="text-[12px] text-[var(--text-secondary)]">{char.label}</span>
                          </div>
                          <ScoreBar value={avg} color={char.color} />
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {results.averages && (
                <div className="grid grid-cols-2 gap-4">
                  {CHARACTERISTICS.map((char) => (
                    <div key={char.key} className="bt-panel p-4 space-y-3">
                      <p className="text-[12px] font-semibold flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full inline-block" style={{ background: char.color }} />
                        {char.label}
                        <span className="ml-auto text-[11px] font-normal text-[var(--text-muted)]">{charAvg(results.averages!, char.key).toFixed(2)}</span>
                      </p>
                      {char.subs.map((sub) => {
                        const val = (results.averages![char.key] as Record<string, number>)[sub.key];
                        return (
                          <div key={sub.key}>
                            <p className="text-[11px] text-[var(--text-muted)] mb-1">{sub.label}</p>
                            <ScoreBar value={val} color={char.color} />
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>
              )}

              <div className="bt-panel overflow-hidden">
                <p className="text-[11px] text-[var(--text-muted)] px-4 pt-3 pb-2 uppercase tracking-wide font-medium">Individual Responses</p>
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="border-b border-[var(--border-soft)]">
                      {["Respondent", "Role", "Overall Avg", "Comments", "Date"].map((h) => (
                        <th key={h} className="text-left px-4 py-2 text-[11px] text-[var(--text-muted)] uppercase tracking-wide font-medium">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {[...results.entries].reverse().map((e) => (
                      <tr key={e.id} className="border-b border-[var(--border-soft)] last:border-0 hover:bg-white/[0.02]">
                        <td className="px-4 py-3 font-semibold">{e.respondent}</td>
                        <td className="px-4 py-3 text-[var(--text-muted)]">{e.role || "—"}</td>
                        <td className="px-4 py-3 text-[var(--accent-teal)] font-semibold">{overallAvg(e.scores).toFixed(2)}</td>
                        <td className="px-4 py-3 text-[var(--text-muted)] max-w-[200px] truncate">{e.comments || "—"}</td>
                        <td className="px-4 py-3 text-[var(--text-muted)]">{new Date(e.submitted_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </main>
    </div>
  );
}
