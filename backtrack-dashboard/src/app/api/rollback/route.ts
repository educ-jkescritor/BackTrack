import { NextRequest, NextResponse } from "next/server";
import { getConnection, findConnectionByNamespace } from "@/lib/monitoring-store";
import { runCommand } from "@/lib/command";
import { addMttrEntry } from "@/lib/metrics-store";

type RollbackPayload = {
  connectionId?: string;
  service?: string;
  namespace?: string;
  revision?: number;
  anomaly_detected_at?: string;
  anomaly_type?: "TSD" | "LSI" | "BOTH" | "MANUAL";
};

const AGENT_URL = process.env.BACKTRACK_AGENT_URL || "http://127.0.0.1:8847";

export async function POST(request: NextRequest) {
  try {
    const payload = (await request.json()) as RollbackPayload;

    if (!payload.service) {
      return NextResponse.json(
        { error: "service is required." },
        { status: 400 },
      );
    }

    const connection = payload.connectionId
      ? getConnection(payload.connectionId)
      : findConnectionByNamespace(payload.namespace ?? "default");

    if (!connection) {
      return NextResponse.json({ error: "No matching connection found. Register a cluster first." }, { status: 404 });
    }

    // Docker rollback: forward to backtrack-agent
    if (connection.platform === "docker") {
      try {
        const response = await fetch(`${AGENT_URL}/rollback/trigger`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: `Dashboard rollback for ${payload.service}` }),
        });

        const agentResult = await response.json();

        if (!response.ok) {
          return NextResponse.json(
            { error: agentResult.message || "Agent rollback failed." },
            { status: 500 },
          );
        }

        return NextResponse.json({
          ok: true,
          message: "Docker rollback triggered via agent.",
          output: agentResult.message || "Rollback initiated.",
        });
      } catch {
        return NextResponse.json(
          { error: "Agent unreachable. Is backtrack-agent running?" },
          { status: 502 },
        );
      }
    }

    // Kubernetes rollback: restore replicas if scaled to 0, then rollout undo
    const ns = connection.namespace || "default";

    const replicaCheck = await runCommand("kubectl", [
      "get", "deployment", payload.service, "-n", ns,
      "-o", "jsonpath={.spec.replicas}",
    ]);
    const currentReplicas = parseInt(replicaCheck.stdout.trim() || "1", 10);

    if (currentReplicas === 0) {
      await runCommand("kubectl", [
        "scale", "deployment", payload.service, "--replicas=1", "-n", ns,
      ]);
    }

    const args = [
      "rollout",
      "undo",
      `deployment/${payload.service}`,
      "-n",
      ns,
    ];

    if (payload.revision && Number.isFinite(payload.revision)) {
      args.push(`--to-revision=${payload.revision}`);
    }

    const rollbackResult = await runCommand("kubectl", args);

    if (rollbackResult.code !== 0) {
      return NextResponse.json(
        { error: rollbackResult.stderr || "Rollback failed." },
        { status: 500 },
      );
    }

    const rollbackTriggeredAt = new Date().toISOString();

    const statusResult = await runCommand("kubectl", [
      "rollout",
      "status",
      `deployment/${payload.service}`,
      "-n",
      ns,
      "--timeout=90s",
    ]);

    const rollbackCompletedAt = new Date().toISOString();
    const detectedAt = payload.anomaly_detected_at ?? rollbackTriggeredAt;

    addMttrEntry({
      service: payload.service,
      connectionId: payload.connectionId,
      anomaly_type: payload.anomaly_type ?? "MANUAL",
      anomaly_detected_at: detectedAt,
      rollback_triggered_at: rollbackTriggeredAt,
      rollback_completed_at: rollbackCompletedAt,
      mttr_seconds: Math.round(
        (new Date(rollbackCompletedAt).getTime() - new Date(detectedAt).getTime()) / 1000,
      ),
      success: statusResult.code === 0,
    });

    // Ensure app is accessible after rollback — create NodePort service if none exists
    let accessUrl: string | null = null;
    try {
      // Get existing NodePort if service already exists
      const svcCheck = await runCommand("kubectl", [
        "get", "svc", payload.service, "-n", ns,
        "-o", "jsonpath={.spec.type}:{.spec.ports[0].nodePort}:{.spec.ports[0].port}",
      ]);

      if (svcCheck.code === 0 && svcCheck.stdout.trim()) {
        const [svcType, nodePort, clusterPort] = svcCheck.stdout.trim().split(":");
        if (svcType === "NodePort" && nodePort) {
          accessUrl = `http://localhost:${nodePort}`;
        } else if (svcType === "LoadBalancer") {
          // Get external IP assigned by cloud LB
          const lbIp = await runCommand("kubectl", [
            "get", "svc", payload.service, "-n", ns,
            "-o", "jsonpath={.status.loadBalancer.ingress[0].ip}",
          ]);
          const ip = lbIp.stdout.trim() || "localhost";
          accessUrl = `http://${ip}:${clusterPort}`;
        } else {
          // Patch existing ClusterIP service to NodePort
          await runCommand("kubectl", [
            "patch", "svc", payload.service, "-n", ns,
            "-p", '{"spec":{"type":"NodePort"}}',
          ]);
          const patched = await runCommand("kubectl", [
            "get", "svc", payload.service, "-n", ns,
            "-o", "jsonpath={.spec.ports[0].nodePort}",
          ]);
          if (patched.stdout.trim()) accessUrl = `http://localhost:${patched.stdout.trim()}`;
        }
      } else {
        // No service — get container port and create NodePort service
        const portResult = await runCommand("kubectl", [
          "get", "deployment", payload.service, "-n", ns,
          "-o", "jsonpath={.spec.template.spec.containers[0].ports[0].containerPort}",
        ]);
        const containerPort = portResult.stdout.trim() || "80";

        const expose = await runCommand("kubectl", [
          "expose", "deployment", payload.service,
          "--type=NodePort", `--port=${containerPort}`,
          "-n", ns,
        ]);

        if (expose.code === 0) {
          const newSvc = await runCommand("kubectl", [
            "get", "svc", payload.service, "-n", ns,
            "-o", "jsonpath={.spec.ports[0].nodePort}",
          ]);
          if (newSvc.stdout.trim()) accessUrl = `http://localhost:${newSvc.stdout.trim()}`;
        }
      }
    } catch {
      // Non-fatal — rollback succeeded, just can't determine access URL
    }

    return NextResponse.json({
      ok: true,
      message: "Rollback executed.",
      output: rollbackResult.stdout,
      rolloutStatus: statusResult.stdout || statusResult.stderr,
      accessUrl,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
