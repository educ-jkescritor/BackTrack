import { NextRequest, NextResponse } from "next/server";
import { listConnections } from "@/lib/monitoring-store";
import { runCommand } from "@/lib/command";

type RollbackPayload = {
  pullUrl: string; // e.g. "ghcr.io/owner/repo:v1.2.3"
  tag: string;     // e.g. "v1.2.3"
};

type ServiceResult = { service: string; ok: boolean; message: string };

async function rollbackKubernetes(
  services: Array<{ name: string }>,
  namespace: string,
  pullUrl: string,
  tag: string,
): Promise<ServiceResult[]> {
  const results: ServiceResult[] = [];

  for (const svc of services) {
    // Resolve the container name inside the deployment
    const containerRes = await runCommand("kubectl", [
      "get", "deployment", svc.name,
      "-n", namespace,
      "-o", "jsonpath={.spec.template.spec.containers[0].name}",
    ]);

    if (containerRes.code !== 0) {
      results.push({ service: svc.name, ok: false, message: `Deployment not found: ${containerRes.stderr.trim()}` });
      continue;
    }

    const container = containerRes.stdout.trim() || svc.name;

    const setRes = await runCommand("kubectl", [
      "set", "image",
      `deployment/${svc.name}`,
      `${container}=${pullUrl}`,
      "-n", namespace,
    ]);

    if (setRes.code !== 0) {
      results.push({ service: svc.name, ok: false, message: setRes.stderr.trim() });
      continue;
    }

    const statusRes = await runCommand("kubectl", [
      "rollout", "status",
      `deployment/${svc.name}`,
      "-n", namespace,
      "--timeout=90s",
    ]);

    results.push({
      service: svc.name,
      ok: statusRes.code === 0,
      message: statusRes.code === 0 ? `Rolled back to ${tag}` : statusRes.stderr.trim(),
    });
  }

  return results;
}

async function rollbackDocker(
  services: Array<{ name: string }>,
  pullUrl: string,
  tag: string,
): Promise<ServiceResult[]> {
  // Pull once before restarting containers
  const pullRes = await runCommand("docker", ["pull", pullUrl]);
  if (pullRes.code !== 0) {
    return services.map((s) => ({
      service: s.name,
      ok: false,
      message: `docker pull failed: ${pullRes.stderr.trim()}`,
    }));
  }

  const results: ServiceResult[] = [];

  for (const svc of services) {
    // Capture full container config before stopping it
    const inspectRes = await runCommand("docker", ["inspect", svc.name]);

    let networkMode = "bridge";
    const portArgs: string[] = [];
    const envArgs: string[] = [];
    const bindArgs: string[] = [];

    if (inspectRes.code === 0) {
      try {
        const info = JSON.parse(inspectRes.stdout)[0] as {
          HostConfig?: {
            NetworkMode?: string;
            PortBindings?: Record<string, Array<{ HostPort?: string }>>;
            Binds?: string[];
          };
          Config?: { Env?: string[] };
        };
        const hc = info.HostConfig || {};
        const cc = info.Config || {};
        networkMode = hc.NetworkMode || "bridge";
        for (const [containerPort, bindings] of Object.entries(hc.PortBindings || {})) {
          for (const b of (bindings || [])) {
            if (b.HostPort) portArgs.push("-p", `${b.HostPort}:${containerPort.replace("/tcp", "")}`);
          }
        }
        for (const e of (cc.Env || [])) envArgs.push("-e", e);
        for (const v of (hc.Binds || [])) bindArgs.push("-v", v);
      } catch {
        // use defaults
      }
    }

    await runCommand("docker", ["stop", svc.name]);
    await runCommand("docker", ["rm", svc.name]);

    const runRes = await runCommand("docker", [
      "run", "-d",
      "--name", svc.name,
      "--network", networkMode,
      ...portArgs,
      ...envArgs,
      ...bindArgs,
      pullUrl,
    ]);

    results.push({
      service: svc.name,
      ok: runRes.code === 0,
      message: runRes.code === 0 ? `Rolled back to ${tag}` : runRes.stderr.trim(),
    });
  }

  return results;
}

export async function POST(request: NextRequest) {
  try {
    const payload = (await request.json()) as RollbackPayload;

    if (!payload.pullUrl || !payload.tag) {
      return NextResponse.json({ error: "pullUrl and tag are required." }, { status: 400 });
    }

    const connections = listConnections();
    const connection = connections[0];

    if (!connection) {
      return NextResponse.json({ error: "No connection configured." }, { status: 404 });
    }

    const services = (connection.discoveredServices || []).filter((s) => s.name);
    if (services.length === 0) {
      return NextResponse.json({ error: "No services found in the active connection." }, { status: 404 });
    }

    const results =
      connection.platform === "kubernetes"
        ? await rollbackKubernetes(services, connection.namespace || "default", payload.pullUrl, payload.tag)
        : await rollbackDocker(services, payload.pullUrl, payload.tag);

    const allOk = results.every((r) => r.ok);

    return NextResponse.json({
      ok: allOk,
      platform: connection.platform,
      tag: payload.tag,
      results,
      message: allOk
        ? `All services rolled back to ${payload.tag}.`
        : `Rollback completed with errors — check individual service results.`,
    });
  } catch (error: unknown) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}
