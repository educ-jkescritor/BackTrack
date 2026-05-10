import { NextRequest, NextResponse } from "next/server";
import { listConnections } from "@/lib/monitoring-store";
import type { CICDData } from "@/lib/monitoring-types";

type GitHubCommitAPI = {
  sha: string;
  html_url: string;
  commit?: { message?: string; author?: { name?: string; date?: string } };
  author?: { login?: string };
};

type GitHubWorkflowRunAPI = {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  head_sha: string;
  head_branch: string;
  actor?: { login?: string };
  run_started_at: string;
  html_url: string;
};

type GitHubPackageVersionAPI = {
  id: number;
  created_at: string;
  updated_at: string;
  metadata?: { container?: { tags?: string[] } };
};

function ghHeaders(token: string | undefined): HeadersInit {
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function safeJson<T>(res: Response): Promise<T | null> {
  if (!res.ok) return null;
  try { return (await res.json()) as T; } catch { return null; }
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);

  // Prefer explicit query params, fall back to any stored connection that has a repo
  let repo = (searchParams.get("repo") || "").trim();
  let branch = (searchParams.get("branch") || "").trim();
  let token = (searchParams.get("token") || process.env.GITHUB_TOKEN || "").trim();

  if (!repo) {
    const connections = listConnections();
    const conn = connections.find((c) => c.githubRepo);
    if (conn) {
      repo = conn.githubRepo || "";
      branch = conn.githubBranch || "main";
      token = conn.githubToken || process.env.GITHUB_TOKEN || "";
    }
  }

  if (!repo) {
    return NextResponse.json(
      { error: "No GitHub repository configured. Add a GitHub repo to a connection first." },
      { status: 404 },
    );
  }

  branch = branch || "main";
  const headers = ghHeaders(token || undefined);
  const [owner, repoName] = repo.split("/");

  const [commitsRes, runsRes, orgPkgRes, userPkgRes] = await Promise.all([
    fetch(`https://api.github.com/repos/${repo}/commits?sha=${branch}&per_page=20`, {
      headers,
      cache: "no-store",
    }),
    fetch(`https://api.github.com/repos/${repo}/actions/runs?branch=${branch}&per_page=10`, {
      headers,
      cache: "no-store",
    }),
    fetch(
      `https://api.github.com/orgs/${owner}/packages/container/${encodeURIComponent(repoName)}/versions?per_page=15`,
      { headers, cache: "no-store" },
    ),
    fetch(
      `https://api.github.com/users/${owner}/packages/container/${encodeURIComponent(repoName)}/versions?per_page=15`,
      { headers, cache: "no-store" },
    ),
  ]);

  const commitsRaw = await safeJson<GitHubCommitAPI[]>(commitsRes);
  const runsRaw = await safeJson<{ workflow_runs: GitHubWorkflowRunAPI[] }>(runsRes);
  const pkgRaw =
    (await safeJson<GitHubPackageVersionAPI[]>(orgPkgRes)) ||
    (await safeJson<GitHubPackageVersionAPI[]>(userPkgRes));

  const commits = (commitsRaw || []).map((c) => ({
    sha: c.sha,
    shortSha: c.sha.slice(0, 7),
    message: c.commit?.message?.split("\n")[0] || "No message",
    author: c.author?.login || c.commit?.author?.name || "unknown",
    timestamp: c.commit?.author?.date || "",
    url: c.html_url,
  }));

  const workflowRuns = (runsRaw?.workflow_runs || []).map((r) => ({
    id: r.id,
    name: r.name,
    status: r.status,
    conclusion: r.conclusion,
    headSha: r.head_sha.slice(0, 7),
    branch: r.head_branch,
    triggeredBy: r.actor?.login || "unknown",
    startedAt: r.run_started_at,
    url: r.html_url,
  }));

  const imageTags = (pkgRaw || [])
    .flatMap((v) => {
      const tags = v.metadata?.container?.tags || [];
      return tags.map((tag) => ({
        tag,
        pushedAt: v.updated_at || v.created_at,
        pullUrl: `ghcr.io/${repo}:${tag}`,
      }));
    })
    .slice(0, 15);

  return NextResponse.json({
    repo,
    branch,
    commits,
    workflowRuns,
    imageTags,
    fetchedAt: new Date().toISOString(),
  } satisfies CICDData);
}
