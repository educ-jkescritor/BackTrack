import { NextRequest, NextResponse } from "next/server";

const AGENT_URL = process.env.BACKTRACK_AGENT_URL || "http://127.0.0.1:8847";

/**
 * Proxy requests to the backtrack-agent sidecar.
 * Usage: GET /api/agent?path=metrics  -> agent /metrics
 *        GET /api/agent?path=lsi      -> agent /lsi
 *        GET /api/agent?path=versions -> agent /versions
 *        GET /api/agent?path=health   -> agent /health
 *        GET /api/agent?path=rollback/history -> agent /rollback/history
 */
export async function GET(request: NextRequest) {
  const agentPath = request.nextUrl.searchParams.get("path");

  if (!agentPath) {
    return NextResponse.json(
      { error: "path parameter is required (e.g. ?path=metrics)" },
      { status: 400 },
    );
  }

  const allowed = ["health", "config", "metrics", "lsi", "versions", "services", "rollback/history", "fault/status"];
  if (!allowed.includes(agentPath)) {
    return NextResponse.json(
      { error: `Invalid path. Allowed: ${allowed.join(", ")}` },
      { status: 400 },
    );
  }

  try {
    const agentUrl = new URL(`${AGENT_URL}/${agentPath}`);
    // Forward service query param if present
    const serviceParam = request.nextUrl.searchParams.get("service");
    if (serviceParam) agentUrl.searchParams.set("service", serviceParam);
    const url = agentUrl.toString();
    const response = await fetch(url, { cache: "no-store" });

    if (!response.ok) {
      return NextResponse.json(
        { error: `Agent returned ${response.status}` },
        { status: response.status },
      );
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch {
    return NextResponse.json(
      { error: "Agent unreachable. Is backtrack-agent running on " + AGENT_URL + "?" },
      { status: 502 },
    );
  }
}

/**
 * Forward POST to agent (e.g. manual rollback trigger).
 * Usage: POST /api/agent?path=rollback/trigger
 */
export async function POST(request: NextRequest) {
  const agentPath = request.nextUrl.searchParams.get("path");

  if (!agentPath) {
    return NextResponse.json(
      { error: "path parameter is required" },
      { status: 400 },
    );
  }

  const allowed = ["rollback/trigger", "reconfigure", "fault/inject/crash", "fault/inject/latency", "fault/inject/logs", "fault/reset"];
  if (!allowed.includes(agentPath)) {
    return NextResponse.json(
      { error: `Invalid POST path. Allowed: ${allowed.join(", ")}` },
      { status: 400 },
    );
  }

  try {
    const body = await request.text();
    const url = `${AGENT_URL}/${agentPath}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body || "{}",
    });

    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch {
    return NextResponse.json(
      { error: "Agent unreachable." },
      { status: 502 },
    );
  }
}
