import { NextRequest, NextResponse } from "next/server";
import { addMttrEntry, clearMttrEntries, listMttrEntries, type MttrEntry } from "@/lib/metrics-store";

type AgentRollbackHistoryEntry = {
  id: string;
  timestamp: string;
  first_anomaly_at?: string;
  rollback_triggered_at?: string;
  rollback_completed_at?: string;
  reason: string;
  from_tag: string;
  to_tag: string;
  service_name?: string;
  mode: string;
  success: boolean;
};

const AGENT_URL = process.env.BACKTRACK_AGENT_URL || "http://127.0.0.1:8847";

function parseServiceName(entry: AgentRollbackHistoryEntry): string {
  if (entry.service_name && entry.service_name.trim()) return entry.service_name.trim();

  const reason = entry.reason || "";
  const patterns = [
    /anomaly on\s+(.+?)\s+for\s+\d+\s+cycles/i,
    /Dashboard rollback for\s+(.+?)(?:[,.]|$)/i,
    /for service\s+(.+?)(?:[,.]|$)/i,
  ];

  for (const pattern of patterns) {
    const match = reason.match(pattern);
    if (match?.[1]) return match[1].trim();
  }

  return entry.from_tag || "unknown";
}

function parseTime(entry: AgentRollbackHistoryEntry, key: "rollback_triggered_at" | "rollback_completed_at"): string {
  return entry[key] || entry.timestamp;
}

async function loadAgentRollbackEntries(): Promise<MttrEntry[]> {
  try {
    const response = await fetch(`${AGENT_URL}/rollback/history`, { cache: "no-store" });
    if (!response.ok) return [];

    const payload = (await response.json()) as AgentRollbackHistoryEntry[];
    if (!Array.isArray(payload)) return [];

    return payload
      .filter((entry) => entry.success)
      .map((entry) => {
        // MTTR = first anomaly detection → rollback completion (full detection-to-recovery time)
        const detectedAt = entry.first_anomaly_at || parseTime(entry, "rollback_triggered_at");
        const completedAt = parseTime(entry, "rollback_completed_at");
        return {
          id: `agent-${entry.id}`,
          service: parseServiceName(entry),
          anomaly_type: "AUTO",
          anomaly_detected_at: detectedAt,
          rollback_triggered_at: parseTime(entry, "rollback_triggered_at"),
          rollback_completed_at: completedAt,
          mttr_seconds: Math.max(
            0,
            Math.round((new Date(completedAt).getTime() - new Date(detectedAt).getTime()) / 1000),
          ),
          success: true,
          source: "agent",
        };
      });
  } catch {
    return [];
  }
}

function sortByCompletionTime(entries: MttrEntry[]): MttrEntry[] {
  return [...entries].sort(
    (left, right) => new Date(left.rollback_completed_at).getTime() - new Date(right.rollback_completed_at).getTime(),
  );
}

export async function GET() {
  const entries = sortByCompletionTime([
    ...listMttrEntries(),
    ...await loadAgentRollbackEntries(),
  ]);
  const count = entries.length;
  const successful = entries.filter((e) => e.success);
  const avg = successful.length
    ? successful.reduce((s, e) => s + e.mttr_seconds, 0) / successful.length
    : null;
  const min = successful.length ? Math.min(...successful.map((e) => e.mttr_seconds)) : null;
  const max = successful.length ? Math.max(...successful.map((e) => e.mttr_seconds)) : null;

  return NextResponse.json({ entries, stats: { count, avg, min, max } });
}

export async function POST(request: NextRequest) {
  const body = await request.json();

  if (body.action === "clear") {
    clearMttrEntries();
    return NextResponse.json({ ok: true });
  }

  const {
    service,
    connectionId,
    anomaly_type,
    anomaly_detected_at,
    rollback_triggered_at,
    rollback_completed_at,
    success,
  } = body;

  if (!service || !anomaly_detected_at || !rollback_triggered_at || !rollback_completed_at) {
    return NextResponse.json({ error: "Missing required fields." }, { status: 400 });
  }

  const mttr_seconds = Math.round(
    (new Date(rollback_completed_at).getTime() - new Date(anomaly_detected_at).getTime()) / 1000,
  );

  const entry = addMttrEntry({
    service,
    connectionId,
    anomaly_type: anomaly_type ?? "MANUAL",
    anomaly_detected_at,
    rollback_triggered_at,
    rollback_completed_at,
    mttr_seconds,
    success: success ?? true,
  });

  return NextResponse.json({ ok: true, entry });
}
