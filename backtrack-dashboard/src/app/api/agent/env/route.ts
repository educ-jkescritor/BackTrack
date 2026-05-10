import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const AGENT_ENV_PATH = path.resolve(process.cwd(), "..", "backtrack-agent", ".env");

function parseEnv(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    result[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return result;
}

function serializeEnv(env: Record<string, string>): string {
  return Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
}

const DEFAULTS: Record<string, string> = {
  BACKTRACK_MODE: "kubernetes",
  BACKTRACK_TARGET: "",
  BACKTRACK_IMAGE_TAG: "",
  BACKTRACK_K8S_NAMESPACE: "default",
  BACKTRACK_SCRAPE_INTERVAL: "10",
  BACKTRACK_STABLE_SECONDS: "60",
  BACKTRACK_ROLLBACK_ENABLED: "true",
  BACKTRACK_ROLLBACK_COOLDOWN: "120",
  BACKTRACK_CORPUS_SIZE: "30",
  BACKTRACK_BASELINE_WINDOWS: "3",
  BACKTRACK_WINDOW_SECONDS: "10",
  BACKTRACK_TSD_IQR_MULTIPLIER: "3.0",
  BACKTRACK_LSI_SCORE_MULTIPLIER: "2.0",
  BACKTRACK_DATA_DIR: "/tmp/backtrack-data",
};

export async function POST(request: NextRequest) {
  let body: { platform?: string; appName?: string; namespace?: string } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Read existing .env if present, else start from defaults
  let existing: Record<string, string> = { ...DEFAULTS };
  try {
    const raw = fs.readFileSync(AGENT_ENV_PATH, "utf8");
    existing = { ...DEFAULTS, ...parseEnv(raw) };
  } catch {
    // file doesn't exist yet — use defaults
  }

  // Apply connection form values
  if (body.platform) existing["BACKTRACK_MODE"] = body.platform;
  if (body.appName) existing["BACKTRACK_TARGET"] = body.appName;
  if (body.namespace) existing["BACKTRACK_K8S_NAMESPACE"] = body.namespace;

  try {
    const dir = path.dirname(AGENT_ENV_PATH);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(AGENT_ENV_PATH, serializeEnv(existing), "utf8");
  } catch (err: unknown) {
    return NextResponse.json(
      { error: `Failed to write agent .env: ${err instanceof Error ? err.message : String(err)}`, path: AGENT_ENV_PATH },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, path: AGENT_ENV_PATH, written: existing });
}

export async function GET() {
  try {
    const raw = fs.readFileSync(AGENT_ENV_PATH, "utf8");
    return NextResponse.json({ ok: true, env: parseEnv(raw) });
  } catch {
    return NextResponse.json({ ok: false, env: DEFAULTS });
  }
}
