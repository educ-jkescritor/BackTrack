import { NextRequest, NextResponse } from "next/server";
import { addEvaluation, listEvaluations } from "@/lib/metrics-store";
import type { EvalScores } from "@/lib/metrics-store";

function avgScores(entries: ReturnType<typeof listEvaluations>): Partial<EvalScores> | null {
  if (!entries.length) return null;
  const chars = Object.keys(entries[0].scores) as (keyof EvalScores)[];
  const result: Record<string, Record<string, number>> = {};

  for (const char of chars) {
    const subs = Object.keys(entries[0].scores[char]) as string[];
    result[char] = {};
    for (const sub of subs) {
      const vals = entries.map(
        (e) => (e.scores[char] as Record<string, number>)[sub] ?? 0,
      );
      result[char][sub] = vals.reduce((a, b) => a + b, 0) / vals.length;
    }
  }

  return result as unknown as Partial<EvalScores>;
}

export async function GET() {
  const entries = listEvaluations();
  const averages = avgScores(entries);
  return NextResponse.json({ entries, averages, count: entries.length });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { respondent, role, scores, comments } = body;

  if (!respondent || !scores) {
    return NextResponse.json({ error: "respondent and scores are required." }, { status: 400 });
  }

  const entry = addEvaluation({ respondent, role: role ?? "", scores, comments: comments ?? "" });
  return NextResponse.json({ ok: true, entry });
}
