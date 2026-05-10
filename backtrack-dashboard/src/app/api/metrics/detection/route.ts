import { NextRequest, NextResponse } from "next/server";
import { addDetectionEntry, clearDetectionEntries, listDetectionEntries } from "@/lib/metrics-store";

const AGENT_URL = process.env.BACKTRACK_AGENT_URL || "http://127.0.0.1:8847";

type AgentTSDEval = {
  drift_events_total: number;
  drift_sustained: number;
  drift_spikes: number;
  total_readings: number;
  estimated_precision: number;
  confusion_matrix?: { TN_clean_cycles?: number };
};

type AgentLSIPerClass = {
  precision: number; recall: number; f1: number;
  tp: number; fp: number; fn: number; tn: number;
};

type AgentLSIEval = {
  per_class: Record<string, AgentLSIPerClass>;
  svd_classified_total: number;
};

function calcStats(m: { tp: number; fp: number; tn: number; fn: number }) {
  const precision = m.tp + m.fp > 0 ? m.tp / (m.tp + m.fp) : null;
  const recall    = m.tp + m.fn > 0 ? m.tp / (m.tp + m.fn) : null;
  const f1 = precision !== null && recall !== null && precision + recall > 0
    ? (2 * precision * recall) / (precision + recall) : null;
  const accuracy = m.tp + m.fp + m.tn + m.fn > 0
    ? (m.tp + m.tn) / (m.tp + m.fp + m.tn + m.fn) : null;
  return { ...m, precision, recall, f1, accuracy };
}

function computeMatrix(entries: ReturnType<typeof listDetectionEntries>) {
  const tsd = { tp: 0, fp: 0, tn: 0, fn: 0 };
  const lsi = { tp: 0, fp: 0, tn: 0, fn: 0 };
  for (const e of entries) {
    if (e.fault_injected) {
      if (e.tsd_detected) { tsd.tp++; } else { tsd.fn++; }
      if (e.lsi_detected) { lsi.tp++; } else { lsi.fn++; }
    } else {
      if (e.tsd_detected) { tsd.fp++; } else { tsd.tn++; }
      if (e.lsi_detected) { lsi.fp++; } else { lsi.tn++; }
    }
  }
  return { tsd: calcStats(tsd), lsi: calcStats(lsi) };
}

async function fetchAgentMatrix() {
  try {
    // Fetch all monitored services
    const svcRes = await fetch(`${AGENT_URL}/services`, { cache: "no-store", signal: AbortSignal.timeout(3000) });
    if (!svcRes.ok) return null;
    const services = (await svcRes.json()) as Array<{ name: string }>;
    if (!services.length) return null;

    // Aggregate TSD + LSI evaluation across all services
    const tsdAgg = { tp: 0, fp: 0, tn: 0, fn: 0 };
    const lsiAgg = { tp: 0, fp: 0, tn: 0, fn: 0 };

    await Promise.all(services.map(async (svc) => {
      try {
        const [mRes, lRes] = await Promise.all([
          fetch(`${AGENT_URL}/metrics?service=${encodeURIComponent(svc.name)}`, { cache: "no-store", signal: AbortSignal.timeout(2000) }),
          fetch(`${AGENT_URL}/lsi?service=${encodeURIComponent(svc.name)}`, { cache: "no-store", signal: AbortSignal.timeout(2000) }),
        ]);

        if (mRes.ok) {
          const m = await mRes.json() as { evaluation?: AgentTSDEval };
          const ev = m.evaluation;
          if (ev) {
            tsdAgg.tp += ev.drift_sustained ?? 0;
            tsdAgg.fp += ev.drift_spikes ?? 0;
            tsdAgg.tn += ev.confusion_matrix?.TN_clean_cycles ?? Math.max(0, (ev.total_readings ?? 0) - (ev.drift_events_total ?? 0));
            // FN unknown without fault injection ground truth — left as 0
          }
        }

        if (lRes.ok) {
          const l = await lRes.json() as { evaluation?: AgentLSIEval };
          const ev = l.evaluation;
          if (ev?.per_class) {
            // Only ERROR class = true anomaly detection signal.
            // NOVEL = "SVD didn't recognise pattern" which fires on any unseen log line
            // during normal operation — inflates FP massively on healthy systems.
            const c = ev.per_class["ERROR"];
            if (c) {
              lsiAgg.tp += c.tp;
              lsiAgg.fp += c.fp;
              lsiAgg.fn += c.fn;
              lsiAgg.tn += c.tn;
            }
          }
        }
      } catch { /* skip service */ }
    }));

    const hasData = tsdAgg.tp + tsdAgg.fp + lsiAgg.tp + lsiAgg.fp + lsiAgg.fn + lsiAgg.tn > 0;
    if (!hasData) return null;

    return { tsd: calcStats(tsdAgg), lsi: calcStats(lsiAgg), source: "agent" as const };
  } catch {
    return null;
  }
}

export async function GET() {
  const entries = listDetectionEntries();
  const manualMatrix = computeMatrix(entries);

  // If manual test runs exist, use them (ground truth is authoritative)
  // Otherwise fall back to agent's live evaluation data
  const hasManualData = entries.length > 0;
  let matrix = manualMatrix;
  let source: "manual" | "agent" | "none" = hasManualData ? "manual" : "none";

  if (!hasManualData) {
    const agentMatrix = await fetchAgentMatrix();
    if (agentMatrix) {
      matrix = agentMatrix;
      source = "agent";
    }
  }

  return NextResponse.json({ entries, matrix, source });
}

export async function POST(request: NextRequest) {
  const body = await request.json();

  if (body.action === "clear") {
    clearDetectionEntries();
    return NextResponse.json({ ok: true });
  }

  const {
    test_label,
    fault_injected,
    fault_type,
    service,
    injected_at,
    tsd_detected,
    lsi_detected,
    detected_at,
    notes,
  } = body;

  if (test_label === undefined || fault_injected === undefined) {
    return NextResponse.json({ error: "test_label and fault_injected are required." }, { status: 400 });
  }

  const detection_latency_seconds =
    detected_at && injected_at
      ? Math.round(
          (new Date(detected_at).getTime() - new Date(injected_at).getTime()) / 1000,
        )
      : null;

  const entry = addDetectionEntry({
    test_label,
    fault_injected: Boolean(fault_injected),
    fault_type: fault_type ?? "none",
    service,
    injected_at: injected_at ?? null,
    tsd_detected: Boolean(tsd_detected),
    lsi_detected: Boolean(lsi_detected),
    detected_at: detected_at ?? null,
    detection_latency_seconds,
    notes: notes ?? "",
  });

  return NextResponse.json({ ok: true, entry });
}
