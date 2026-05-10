import { NextRequest, NextResponse } from "next/server";
import { spawn } from "node:child_process";

type PodRow = {
  podName: string;
  namespace: string;
  status: string;
  ready: string;
  restarts: number;
  reason: string;
  message: string;
  labels: Record<string, string>;
};

function runCommand(command: string, args: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(command, args, { shell: false });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      resolve({ code: 1, stdout: "", stderr: error.message });
    });

    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function parseCpuToCores(raw: string) {
  const value = raw.trim().toLowerCase();
  if (!value) return 0;
  if (value.endsWith("m")) {
    const milli = Number(value.slice(0, -1));
    return Number.isFinite(milli) ? milli / 1000 : 0;
  }

  const cores = Number(value);
  return Number.isFinite(cores) ? cores : 0;
}

function parseMemoryToMiB(raw: string) {
  const value = raw.trim();
  const match = value.match(/^([0-9]+(?:\.[0-9]+)?)(Ki|Mi|Gi|Ti|K|M|G|T)?$/i);
  if (!match) return 0;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return 0;

  const unit = (match[2] || "Mi").toLowerCase();
  if (unit === "ki" || unit === "k") return amount / 1024;
  if (unit === "mi" || unit === "m") return amount;
  if (unit === "gi" || unit === "g") return amount * 1024;
  if (unit === "ti" || unit === "t") return amount * 1024 * 1024;

  return amount;
}

function parsePodRows(raw: string) {
  try {
    const payload = JSON.parse(raw) as {
      items?: Array<{
        metadata?: { name?: string; namespace?: string; labels?: Record<string, string> };
        status?: {
          phase?: string;
          reason?: string;
          message?: string;
          containerStatuses?: Array<{
            ready?: boolean;
            restartCount?: number;
            state?: {
              waiting?: { reason?: string; message?: string };
              terminated?: { reason?: string; message?: string };
            };
          }>;
        };
      }>;
    };

    return (payload.items || []).map((item) => ({
      podName: item.metadata?.name || "",
      namespace: item.metadata?.namespace || "default",
      status: item.status?.phase || "Unknown",
      ready: (() => {
        const statuses = item.status?.containerStatuses || [];
        const ready = statuses.filter((container) => container.ready).length;
        return `${ready}/${statuses.length || 0}`;
      })(),
      restarts: (item.status?.containerStatuses || []).reduce(
        (sum, container) => sum + (container.restartCount || 0),
        0,
      ),
      reason:
        item.status?.reason ||
        item.status?.containerStatuses?.find((container) => container.state?.waiting?.reason || container.state?.terminated?.reason)?.state?.waiting?.reason ||
        item.status?.containerStatuses?.find((container) => container.state?.waiting?.reason || container.state?.terminated?.reason)?.state?.terminated?.reason ||
        "",
      message:
        item.status?.message ||
        item.status?.containerStatuses?.find((container) => container.state?.waiting?.message || container.state?.terminated?.message)?.state?.waiting?.message ||
        item.status?.containerStatuses?.find((container) => container.state?.waiting?.message || container.state?.terminated?.message)?.state?.terminated?.message ||
        "",
      labels: item.metadata?.labels || {},
    })) as PodRow[];
  } catch {
    return [] as PodRow[];
  }
}

function classifyPodState(pod: PodRow) {
  const phase = pod.status.toLowerCase();
  const reason = pod.reason.toLowerCase();
  const message = pod.message.toLowerCase();

  if (phase === "running") {
    if (pod.restarts > 0 || reason.includes("crashloop") || message.includes("restart")) {
      return "restarting";
    }

    return "running";
  }

  if (phase === "pending") {
    return "pending";
  }

  if (phase === "failed" || phase === "unknown") {
    return "down";
  }

  if (reason.includes("oom") || reason.includes("crashloop") || message.includes("oom") || message.includes("crashloop")) {
    return "restarting";
  }

  return pod.restarts > 0 ? "restarting" : "unknown";
}

async function findMatchingPod(service: string, namespace: string) {
  const serviceNeedle = service.toLowerCase();
  const queries = [
    ["get", "pods", "-n", namespace, "-o", "json"],
    ["get", "pods", "-A", "-o", "json"],
  ];

  for (const args of queries) {
    const result = await runCommand("kubectl", args);

    if (result.code !== 0) {
      continue;
    }

    const podRows = parsePodRows(result.stdout);
    const matchedPods = podRows.filter((pod) => {
      const podName = pod.podName.toLowerCase();
      const labels = Object.entries(pod.labels).map(([key, value]) => `${key}=${String(value).toLowerCase()}`);
      const labelApp = String(pod.labels.app || "").toLowerCase();
      const labelName = String(pod.labels["app.kubernetes.io/name"] || "").toLowerCase();

      return (
        podName.includes(serviceNeedle) ||
        labelApp === serviceNeedle ||
        labelName === serviceNeedle ||
        labels.some((entry) => entry.includes(serviceNeedle))
      );
    });

    const sortedPods = matchedPods.sort((left, right) => {
      const leftScore = (left.status === "Running" ? 0 : 1) + left.restarts;
      const rightScore = (right.status === "Running" ? 0 : 1) + right.restarts;
      return leftScore - rightScore;
    });

    if (sortedPods.length > 0) {
      return sortedPods[0];
    }
  }

  return null;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const service = (searchParams.get("service") || "").trim();
  const namespace = (searchParams.get("namespace") || "default").trim();

  if (!service) {
    return NextResponse.json({ error: "service is required." }, { status: 400 });
  }

  const runningPod = await findMatchingPod(service, namespace);

  if (!runningPod) {
    return NextResponse.json({
      service,
      namespace,
      podName: null,
      podNamespace: namespace,
      podStatus: "down",
      podReady: "0/0",
      restartCount: 0,
      podReason: "NotFound",
      logs: [`[WARN] No matching pod found for ${service} in namespace ${namespace}`],
      metrics: null,
    });
  }

  const logsResult = await runCommand("kubectl", [
    "logs",
    runningPod.podName,
    "-n",
    runningPod.namespace || namespace,
    "--tail=120",
    "--timestamps",
  ]);

  const topResult = await runCommand("kubectl", [
    "top",
    "pod",
    runningPod.podName,
    "-n",
    runningPod.namespace || namespace,
    "--no-headers",
  ]);

  const logs = (logsResult.stdout || logsResult.stderr || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  let cpuCores = 0;
  let memoryMiB = 0;

  if (topResult.code === 0) {
    const parts = topResult.stdout.trim().split(/\s+/);
    if (parts.length >= 3) {
      cpuCores = parseCpuToCores(parts[1]);
      memoryMiB = parseMemoryToMiB(parts[2]);
    }
  }

  return NextResponse.json({
    service,
    namespace: runningPod.namespace || namespace,
    podName: runningPod.podName,
    podNamespace: runningPod.namespace || namespace,
    podStatus: classifyPodState(runningPod),
    podReady: runningPod.ready,
    restartCount: runningPod.restarts,
    podReason: runningPod.reason || "",
    podMessage: runningPod.message || "",
    logs,
    metrics: {
      cpuCores,
      memoryMiB,
      status: classifyPodState(runningPod),
    },
  });
}
