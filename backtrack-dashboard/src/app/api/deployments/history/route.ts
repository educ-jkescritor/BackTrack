import { NextRequest, NextResponse } from "next/server";
import { getConnection, listConnections } from "@/lib/monitoring-store";
import { runCommand } from "@/lib/command";

type GitHubCommit = {
  sha: string;
  html_url: string;
  commit?: {
    message?: string;
    author?: {
      date?: string;
    };
  };
};

type RolloutVersion = {
  version: string;
  revision?: number;
  status: "Current" | "Available";
  source: "kubernetes" | "github";
  time: string;
  message: string;
  link?: string;
};

type DeploymentHistoryItem = {
  name: string;
  namespace: string;
  status: "Success" | "Unknown";
  deployment: string;
  currentVersion: string;
  deployedTime: string;
  source: string;
  versions: RolloutVersion[];
  versionCount: number;
  commitCount: number;
};


function formatRelativeTime(value?: string) {
  if (!value) return "unknown";
  const inputDate = new Date(value);
  if (Number.isNaN(inputDate.getTime())) return "unknown";

  const deltaSeconds = Math.floor((Date.now() - inputDate.getTime()) / 1000);
  if (deltaSeconds < 60) return `${deltaSeconds}s ago`;
  if (deltaSeconds < 3600) return `${Math.floor(deltaSeconds / 60)}m ago`;
  if (deltaSeconds < 86400) return `${Math.floor(deltaSeconds / 3600)}h ago`;
  return `${Math.floor(deltaSeconds / 86400)}d ago`;
}

function parseRevisionRows(raw: string) {
  const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
  const rows: Array<{ revision: number; cause: string }> = [];

  for (const line of lines) {
    if (!/^\d+\s+/.test(line)) continue;
    const parts = line.split(/\s+/, 2);
    const revision = Number(parts[0]);
    const cause = line.slice(parts[0].length).trim();

    if (Number.isFinite(revision)) {
      rows.push({ revision, cause: cause || "No change-cause" });
    }
  }

  return rows;
}

async function fetchGitHubCommits(repo: string, branch: string, tokenOverride?: string) {
  const token = tokenOverride || process.env.GITHUB_TOKEN;
  const allCommits: GitHubCommit[] = [];

  for (let page = 1; page <= 5; page += 1) {
    const url = new URL(`https://api.github.com/repos/${repo}/commits`);
    url.searchParams.set("sha", branch || "main");
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));

    try {
      const response = await fetch(url, {
        headers: {
          Accept: "application/vnd.github+json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        cache: "no-store",
      });

      if (!response.ok) {
        break;
      }

      const payload = (await response.json()) as GitHubCommit[];
      if (!Array.isArray(payload) || payload.length === 0) {
        break;
      }

      allCommits.push(...payload);

      if (payload.length < 100) {
        break;
      }
    } catch {
      break;
    }
  }

  return allCommits;
}

function extractImageTag(image: string): string {
  if (!image) return "<none>";
  const lastSlash = image.lastIndexOf("/");
  const tail = lastSlash >= 0 ? image.slice(lastSlash + 1) : image;
  const atIdx = tail.indexOf("@");
  if (atIdx >= 0) {
    const digest = tail.slice(atIdx + 1);
    const shortDigest = digest.startsWith("sha256:") ? digest.slice(7, 14) : digest.slice(0, 7);
    return `${tail.slice(0, atIdx)}@${shortDigest}`;
  }
  const colonIdx = tail.indexOf(":");
  if (colonIdx >= 0) return tail.slice(colonIdx + 1);
  return tail;
}

async function fetchReplicaSetImages(
  serviceName: string,
  namespace: string,
): Promise<Map<number, string>> {
  const result = await runCommand("kubectl", [
    "get",
    "rs",
    "-n",
    namespace,
    "-l",
    `app=${serviceName}`,
    "-o",
    "json",
  ]);

  const map = new Map<number, string>();
  if (result.code !== 0) {
    const fallback = await runCommand("kubectl", [
      "get",
      "rs",
      "-n",
      namespace,
      "-o",
      "json",
    ]);
    if (fallback.code !== 0) return map;
    try {
      const parsed = JSON.parse(fallback.stdout) as {
        items: Array<{
          metadata?: {
            annotations?: Record<string, string>;
            ownerReferences?: Array<{ kind?: string; name?: string }>;
          };
          spec?: {
            template?: {
              spec?: { containers?: Array<{ image?: string }> };
            };
          };
        }>;
      };
      for (const item of parsed.items || []) {
        const owner = item.metadata?.ownerReferences?.find((o) => o.kind === "Deployment");
        if (owner?.name !== serviceName) continue;
        const rev = Number(item.metadata?.annotations?.["deployment.kubernetes.io/revision"] || "0");
        const image = item.spec?.template?.spec?.containers?.[0]?.image || "";
        if (rev && image) map.set(rev, image);
      }
    } catch {
      // ignore
    }
    return map;
  }

  try {
    const parsed = JSON.parse(result.stdout) as {
      items: Array<{
        metadata?: {
          annotations?: Record<string, string>;
          ownerReferences?: Array<{ kind?: string; name?: string }>;
        };
        spec?: {
          template?: {
            spec?: { containers?: Array<{ image?: string }> };
          };
        };
      }>;
    };
    for (const item of parsed.items || []) {
      const owner = item.metadata?.ownerReferences?.find((o) => o.kind === "Deployment");
      if (!owner || owner.name !== serviceName) continue;
      const rev = Number(item.metadata?.annotations?.["deployment.kubernetes.io/revision"] || "0");
      const image = item.spec?.template?.spec?.containers?.[0]?.image || "";
      if (rev && image) map.set(rev, image);
    }
  } catch {
    // ignore
  }
  return map;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const connectionId = searchParams.get("connectionId");

  const allConnections = listConnections();
  const k8sConnections = connectionId
    ? [getConnection(connectionId)].filter((c): c is NonNullable<typeof c> => Boolean(c))
    : allConnections.filter((c) => c.platform === "kubernetes");

  if (k8sConnections.length === 0) {
    return NextResponse.json({ deployments: [], warning: "No connection available." });
  }

  type ServiceCtx = {
    serviceName: string;
    namespace: string;
    repo: string;
    branch: string;
    connectionId: string;
  };

  const serviceCtxs: ServiceCtx[] = [];
  const seen = new Set<string>();
  for (const conn of k8sConnections) {
    const ns = conn.namespace || "default";
    const repo = conn.githubRepo || "";
    const branch = conn.githubBranch || "main";
    for (const svc of conn.discoveredServices || []) {
      const key = `${svc.name}::${ns}`;
      if (seen.has(key)) continue;
      seen.add(key);
      serviceCtxs.push({
        serviceName: svc.name,
        namespace: ns,
        repo,
        branch,
        connectionId: conn.id,
      });
    }
  }

  const repoTokenMap = new Map<string, string | undefined>();
  for (const conn of k8sConnections) {
    if (conn.githubRepo) repoTokenMap.set(conn.githubRepo, conn.githubToken);
  }

  const repoCommitCache = new Map<string, GitHubCommit[]>();
  async function commitsFor(repo: string, branch: string) {
    if (!repo) return [];
    const key = `${repo}@${branch}`;
    const cached = repoCommitCache.get(key);
    if (cached) return cached;
    const commits = await fetchGitHubCommits(repo, branch, repoTokenMap.get(repo));
    repoCommitCache.set(key, commits);
    return commits;
  }

  const settled = await Promise.all(
    serviceCtxs.map(async (ctx) => {
      const [deploymentJsonResult, historyResult, rsImages, commits] = await Promise.all([
        runCommand("kubectl", ["get", "deployment", ctx.serviceName, "-n", ctx.namespace, "-o", "json"]),
        runCommand("kubectl", ["rollout", "history", `deployment/${ctx.serviceName}`, "-n", ctx.namespace]),
        fetchReplicaSetImages(ctx.serviceName, ctx.namespace),
        commitsFor(ctx.repo, ctx.branch),
      ]);
      return { ctx, deploymentJsonResult, historyResult, rsImages, commits };
    }),
  );

  const deployments: DeploymentHistoryItem[] = [];

  for (const { ctx, deploymentJsonResult, historyResult, rsImages, commits } of settled) {
    if (deploymentJsonResult.code !== 0) {
      continue;
    }

    let currentRevision = 0;
    let replicas = "0/0";
    let deployedTime = "unknown";
    let currentImage = "";

    try {
      const parsed = JSON.parse(deploymentJsonResult.stdout) as {
        metadata?: {
          creationTimestamp?: string;
          annotations?: Record<string, string>;
        };
        spec?: {
          template?: {
            spec?: { containers?: Array<{ image?: string }> };
          };
        };
        status?: {
          availableReplicas?: number;
          replicas?: number;
        };
      };

      currentRevision = Number(
        parsed.metadata?.annotations?.["deployment.kubernetes.io/revision"] || "0",
      );
      const available = parsed.status?.availableReplicas ?? 0;
      const total = parsed.status?.replicas ?? 0;
      replicas = `${available}/${total}`;
      deployedTime = formatRelativeTime(parsed.metadata?.creationTimestamp);
      currentImage = parsed.spec?.template?.spec?.containers?.[0]?.image || "";
    } catch {
      currentRevision = 0;
    }

    const revisions = historyResult.code === 0 ? parseRevisionRows(historyResult.stdout) : [];

    const k8sVersions: RolloutVersion[] = revisions
      .sort((a, b) => b.revision - a.revision)
      .map((row) => {
        const image =
          rsImages.get(row.revision) || (row.revision === currentRevision ? currentImage : "");
        const tag = extractImageTag(image);
        return {
          version: tag !== "<none>" ? tag : `rev-${row.revision}`,
          revision: row.revision,
          status: row.revision === currentRevision ? "Current" : "Available",
          source: "kubernetes" as const,
          time: image ? `rev-${row.revision} · ${image}` : `rev-${row.revision} · k8s rollout`,
          message: row.cause,
        };
      });

    const serviceNeedle = ctx.serviceName.toLowerCase().replaceAll("-", "");
    const githubVersions: RolloutVersion[] = commits
      .filter((commit) => {
        const message = (commit.commit?.message || "").toLowerCase().replaceAll("-", "");
        return message.includes(serviceNeedle);
      })
      .map((commit) => ({
        version: commit.sha.slice(0, 7),
        status: "Available" as const,
        source: "github" as const,
        time: formatRelativeTime(commit.commit?.author?.date),
        message: commit.commit?.message?.split("\n")[0] || "GitHub commit",
        link: commit.html_url,
      }));

    const merged = [...k8sVersions, ...githubVersions];
    const currentTag = extractImageTag(currentImage);

    deployments.push({
      name: ctx.serviceName,
      namespace: ctx.namespace,
      status: "Success",
      deployment: replicas,
      currentVersion: currentTag !== "<none>" ? currentTag : (currentRevision > 0 ? `rev-${currentRevision}` : "unknown"),
      deployedTime,
      source: ctx.repo ? `github/${ctx.repo}` : "kubernetes",
      versions: merged,
      versionCount: k8sVersions.length,
      commitCount: githubVersions.length,
    });
  }

  return NextResponse.json({
    connectionId: k8sConnections[0].id,
    namespace: k8sConnections[0].namespace || "default",
    githubRepo: k8sConnections[0].githubRepo || null,
    deployments,
  });
}
