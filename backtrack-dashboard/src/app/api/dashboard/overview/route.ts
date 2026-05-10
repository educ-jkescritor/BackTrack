import { NextResponse } from "next/server";
import { listConnections } from "@/lib/monitoring-store";
import { runCommand } from "@/lib/command";
import { getCached } from "@/lib/overview-cache";
import type { DashboardService, DashboardAnomaly } from "@/lib/monitoring-types";

const MEMORY_THRESHOLD_MIB = Number(process.env.BACKTRACK_MEMORY_THRESHOLD_MIB) || 120;
const SCRAPE_INTERVAL_SECONDS = Number(process.env.BACKTRACK_SCRAPE_INTERVAL) || 10;

type RawConnection = {
	id: string;
	appName?: string;
	name?: string;
	platform?: "kubernetes" | "docker";
	kind?: "kubernetes" | "docker";
	namespace?: string;
	workload?: string;
	prometheusUrl?: string;
	authToken?: string;
	discoveredServices?: Array<{
		name?: string;
		namespace?: string;
		status?: "running" | "down" | "unknown";
		ports?: string[];
		source?: "kubernetes" | "docker";
	}>;
};

function workloadFromService(serviceName: string) {
	return serviceName.replaceAll(".", "\\.");
}

function serviceNameRegex(serviceName: string) {
	return serviceName.toLowerCase().replaceAll(".", "-");
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


async function getKubectlStatusByService(namespace: string, serviceNames: string[]) {
	const result = await runCommand("kubectl", [
		"get", "pods", "-n", namespace, "--no-headers",
		"-o", "custom-columns=NAME:.metadata.name,STATUS:.status.phase",
	]);

	const statusMap = new Map<string, "running" | "down">();
	if (result.code !== 0) return statusMap;

	const lines = result.stdout.split("\n").map((l) => l.trim()).filter(Boolean);

	for (const svcName of serviceNames) {
		const needle = serviceNameRegex(svcName);
		const matched = lines.filter((line) => line.toLowerCase().includes(needle));
		if (matched.length === 0) {
			statusMap.set(svcName, "down");
		} else {
			const anyRunning = matched.some((line) => line.toLowerCase().includes("running"));
			statusMap.set(svcName, anyRunning ? "running" : "down");
		}
	}

	return statusMap;
}

async function getDockerStatsByService(containerNames: string[]) {
	const metrics = new Map<string, { cpuCores: number; memoryMiB: number }>();
	if (containerNames.length === 0) return metrics;

	const result = await runCommand("docker", [
		"stats", "--no-stream", "--format",
		"{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}",
		...containerNames,
	]);
	if (result.code !== 0) return metrics;

	for (const line of result.stdout.split("\n").map((l) => l.trim()).filter(Boolean)) {
		const parts = line.split("\t");
		if (parts.length < 3) continue;

		const name = parts[0].trim();
		const cpuPercNum = parseFloat(parts[1].replace("%", "").trim());
		const memUsed = parts[2].split("/")[0].trim()
			.replace(/([KMGT]i)B$/i, "$1")
			.replace(/kB$/i, "K")
			.replace(/^(\d+(?:\.\d+)?)B$/, "$1");

		metrics.set(name, {
			cpuCores: Number.isFinite(cpuPercNum) ? cpuPercNum / 100 : 0,
			memoryMiB: parseMemoryToMiB(memUsed),
		});
	}
	return metrics;
}

async function getKubectlTopByService(namespace: string, services: string[]) {
	const result = await runCommand("kubectl", [
		"top",
		"pods",
		"-n",
		namespace,
		"--no-headers",
	]);

	if (result.code !== 0) {
		return new Map<string, { cpuCores: number; memoryMiB: number }>();
	}

	const lines = result.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);

	const rows = lines
		.map((line) => line.split(/\s+/))
		.filter((parts) => parts.length >= 3)
		.map((parts) => ({
			podName: parts[0].toLowerCase(),
			cpuCores: parseCpuToCores(parts[1]),
			memoryMiB: parseMemoryToMiB(parts[2]),
		}));

	const metrics = new Map<string, { cpuCores: number; memoryMiB: number }>();

	for (const serviceName of services) {
		const needle = serviceNameRegex(serviceName);
		const matched = rows.filter((row) => row.podName.includes(needle));

		metrics.set(serviceName, {
			cpuCores: matched.reduce((sum, row) => sum + row.cpuCores, 0),
			memoryMiB: matched.reduce((sum, row) => sum + row.memoryMiB, 0),
		});
	}

	return metrics;
}

function normalizeConnectionServices(connection: RawConnection) {
	if (Array.isArray(connection.discoveredServices) && connection.discoveredServices.length > 0) {
		return connection.discoveredServices.map((service) => ({
			name: service.name || connection.appName || connection.name || "unknown-service",
			namespace: service.namespace || connection.namespace || "default",
			status: service.status || "unknown",
			ports: Array.isArray(service.ports) ? service.ports : [],
			source: service.source || (connection.platform || connection.kind || "kubernetes"),
		}));
	}

	// Empty discoveredServices array means discovery ran and found nothing — don't
	// synthesize a fake service, just skip this connection silently.
	if (Array.isArray(connection.discoveredServices)) {
		return [];
	}

	// Legacy connections with no discoveredServices field at all: fall back to workload/appName.
	const workload = connection.workload || "";
	const fallbackName = workload.includes("/")
		? workload.split("/")[1]
		: connection.appName || connection.name || "unknown-service";

	return [
		{
			name: fallbackName,
			namespace: connection.namespace || "default",
			status: "unknown" as const,
			ports: [] as string[],
			source: (connection.platform || connection.kind || "kubernetes") as "kubernetes" | "docker",
		},
	];
}

async function queryScalarOptional(
	baseUrl: string,
	query: string,
	authToken?: string,
) {
	try {
		const url = new URL("/api/v1/query", baseUrl);
		url.searchParams.set("query", query);

		const response = await fetch(url, {
			headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined,
			cache: "no-store",
		});

		if (!response.ok) {
			return null;
		}

		const payload = (await response.json()) as {
			data?: { result?: Array<{ value?: [number, string] }> };
		};

		const value = payload.data?.result?.[0]?.value?.[1];
		if (value === undefined) {
			return null;
		}

		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

async function queryFirstScalar(
	baseUrl: string,
	queries: string[],
	authToken?: string,
) {
	for (const query of queries) {
		const value = await queryScalarOptional(baseUrl, query, authToken);
		if (value !== null) {
			return value;
		}
	}

	return 0;
}

export async function GET() {
	const connections = listConnections() as RawConnection[];
	const services: DashboardService[] = [];

	for (const connection of connections) {
		const connectionPlatform = (connection.platform || connection.kind || "kubernetes") as "kubernetes" | "docker";
		const connectionNamespace = connection.namespace || "default";
		const normalizedServices = normalizeConnectionServices(connection);
		const ttlMs = SCRAPE_INTERVAL_SECONDS * 1000;
		const containerNames = normalizedServices.map((s) => s.name);

		const dockerStatsByService = connectionPlatform === "docker"
			? await getCached(
				`docker-stats-${containerNames.join(",")}`,
				ttlMs,
				() => getDockerStatsByService(containerNames),
			)
			: new Map<string, { cpuCores: number; memoryMiB: number }>();

		const kubectlTopByService = connectionPlatform === "kubernetes"
			? await getCached(
				`kubectl-top-${connectionNamespace}`,
				ttlMs,
				() => getKubectlTopByService(connectionNamespace, containerNames),
			)
			: new Map<string, { cpuCores: number; memoryMiB: number }>();

		const kubectlStatusByService = connectionPlatform === "kubernetes"
			? await getCached(
				`kubectl-status-${connectionNamespace}`,
				ttlMs,
				() => getKubectlStatusByService(connectionNamespace, containerNames),
			)
			: new Map<string, "running" | "down">();

		for (const service of normalizedServices) {
			if (connectionPlatform === "docker") {
				const dockerStats = dockerStatsByService.get(service.name);
				let cpuCores = dockerStats?.cpuCores ?? 0;
				let memoryMiB = dockerStats?.memoryMiB ?? 0;
				let requestRate = 0;

				if (connection.prometheusUrl) {
					const [promCpu, promMem, promReq] = await Promise.all([
						queryFirstScalar(connection.prometheusUrl, [
							`sum(rate(process_cpu_seconds_total{job="${service.name}"}[5m]))`,
							`sum(rate(container_cpu_usage_seconds_total{name="${service.name}"}[5m]))`,
							`sum(rate(container_cpu_usage_seconds_total{container_label_com_docker_compose_service="${service.name}"}[5m]))`,
						], connection.authToken),
						queryFirstScalar(connection.prometheusUrl, [
							`sum(process_resident_memory_bytes{job="${service.name}"})`,
							`sum(container_memory_usage_bytes{name="${service.name}"})`,
							`sum(container_memory_usage_bytes{container_label_com_docker_compose_service="${service.name}"})`,
						], connection.authToken),
						queryFirstScalar(connection.prometheusUrl, [
							`sum(rate(http_requests_total{job="${service.name}"}[5m]))`,
							`sum(rate(http_server_requests_seconds_count{job="${service.name}"}[5m]))`,
						], connection.authToken),
					]);
					if (promCpu > 0) cpuCores = promCpu;
					if (promMem > 0) memoryMiB = promMem / 1024 / 1024;
					if (promReq > 0) requestRate = promReq;
				}

				services.push({
					id: `${connection.id}:${service.name}`,
					connectionId: connection.id,
					name: service.name,
					namespace: connectionNamespace,
					platform: "docker",
					status: service.status,
					cpuCores,
					memoryMiB,
					requestRate,
					ports: service.ports,
				});
				continue;
			}

			const svcName = workloadFromService(service.name);
			const podRegex = `${svcName}-.*|.*${svcName}.*`;
			const ns = connectionNamespace;
			const prometheusUrl = connection.prometheusUrl || "";

			if (!prometheusUrl) {
				const fallbackUsageNoPrometheus = kubectlTopByService.get(service.name);
				const liveStatus = kubectlStatusByService.get(service.name) ?? "unknown";
				services.push({
					id: `${connection.id}:${service.name}`,
					connectionId: connection.id,
					name: service.name,
					namespace: ns,
					platform: "kubernetes",
					status: liveStatus,
					cpuCores: fallbackUsageNoPrometheus?.cpuCores ?? 0,
					memoryMiB: fallbackUsageNoPrometheus?.memoryMiB ?? 0,
					requestRate: 0,
					ports: service.ports,
				});
				continue;
			}

			const [podUp, tcpProbe, cpu, memoryBytes, requestRate] = await Promise.all([
				queryScalarOptional(
					prometheusUrl,
					`max(up{job="kubernetes-pods",kubernetes_namespace="${ns}",kubernetes_pod_name=~"${svcName}-.*"} or up{job="kubernetes-pods",kubernetes_namespace="${ns}",app="${service.name}"})`,
					connection.authToken,
				),
				queryScalarOptional(
					prometheusUrl,
					`max(probe_success{job="kubernetes-services-tcp",kubernetes_namespace="${ns}",service="${service.name}"})`,
					connection.authToken,
				),
				queryFirstScalar(
					prometheusUrl,
					[
						`sum(rate(container_cpu_usage_seconds_total{namespace="${ns}",pod=~"${podRegex}",container!="POD"}[5m]))`,
						`sum(rate(container_cpu_usage_seconds_total{kubernetes_namespace="${ns}",pod_name=~"${podRegex}",container_name!="POD"}[5m]))`,
						`sum(node_namespace_pod_container:container_cpu_usage_seconds_total:sum_irate{namespace="${ns}",pod=~"${podRegex}"})`,
						`sum(rate(process_cpu_seconds_total{kubernetes_namespace="${ns}",pod=~"${podRegex}"}[5m]))`,
						`sum(rate(process_cpu_seconds_total{namespace="${ns}",pod=~"${podRegex}"}[5m]))`,
					],
					connection.authToken,
				),
				queryFirstScalar(
					prometheusUrl,
					[
						`sum(container_memory_working_set_bytes{namespace="${ns}",pod=~"${podRegex}",container!="POD"})`,
						`sum(container_memory_working_set_bytes{kubernetes_namespace="${ns}",pod_name=~"${podRegex}",container_name!="POD"})`,
						`sum(node_namespace_pod_container:container_memory_working_set_bytes{namespace="${ns}",pod=~"${podRegex}"})`,
						`sum(process_resident_memory_bytes{kubernetes_namespace="${ns}",pod=~"${podRegex}"})`,
						`sum(process_resident_memory_bytes{namespace="${ns}",pod=~"${podRegex}"})`,
					],
					connection.authToken,
				),
				queryFirstScalar(
					prometheusUrl,
					[
						`sum(rate(http_requests_total{kubernetes_namespace="${ns}",app="${service.name}"}[5m]))`,
						`sum(rate(http_server_requests_seconds_count{kubernetes_namespace="${ns}",app="${service.name}"}[5m]))`,
						`sum(rate(http_requests_total{namespace="${ns}",service="${service.name}"}[5m]))`,
					],
					connection.authToken,
				),
			]);

			const fallbackUsage = kubectlTopByService.get(service.name);
			const cpuFinal = cpu > 0 ? cpu : (fallbackUsage?.cpuCores ?? 0);
			const memoryMiBFinal = memoryBytes > 0
				? memoryBytes / 1024 / 1024
				: (fallbackUsage?.memoryMiB ?? 0);

			let status: "running" | "down" | "unknown" = "unknown";
			const observedValues = [podUp, tcpProbe].filter(
				(value): value is number => value !== null,
			);

			if (observedValues.length > 0) {
				status = observedValues.some((value) => value >= 1) ? "running" : "down";
			}

			services.push({
				id: `${connection.id}:${service.name}`,
				connectionId: connection.id,
				name: service.name,
				namespace: ns,
				platform: "kubernetes",
				status,
				cpuCores: cpuFinal,
				memoryMiB: memoryMiBFinal,
				requestRate,
				ports: service.ports,
			});
		}
	}

	// Fetch agent anomaly signals (LSI + TSD) and per-service metrics
	const agentUrl = process.env.BACKTRACK_AGENT_URL || "http://127.0.0.1:8847";
	type AgentService = { name: string; is_drifting: boolean; is_anomalous: boolean; is_error_anomalous: boolean };
	type AgentMetrics = { current?: { cpu_percent?: number; memory_mb?: number; latency_ms?: number; error_rate_percent?: number } };
	let agentServices: AgentService[] = [];
	const agentMetricsMap = new Map<string, AgentMetrics>();

	try {
		const res = await fetch(`${agentUrl}/services`, { cache: "no-store", signal: AbortSignal.timeout(3000) });
		if (res.ok) {
			agentServices = (await res.json()) as AgentService[];
			// Fetch TSD metrics for each monitored service
			await Promise.all(agentServices.map(async (svc) => {
				try {
					const mRes = await fetch(`${agentUrl}/metrics?service=${encodeURIComponent(svc.name)}`, {
						cache: "no-store", signal: AbortSignal.timeout(2000),
					});
					if (mRes.ok) agentMetricsMap.set(svc.name, await mRes.json() as AgentMetrics);
				} catch { /* non-fatal */ }
			}));
		}
	} catch { /* agent unavailable */ }

	const agentAnomalyMap = new Map<string, AgentService>(
		agentServices.filter((s) => s.is_drifting || s.is_anomalous || s.is_error_anomalous).map((s) => [s.name, s])
	);

	// Backfill agent TSD metrics into services that have no Prometheus data
	for (const svc of services) {
		const agentM = agentMetricsMap.get(svc.name);
		if (!agentM?.current) continue;
		if (svc.cpuCores === 0 && (agentM.current.cpu_percent ?? 0) > 0) {
			svc.cpuCores = parseFloat(((agentM.current.cpu_percent ?? 0) / 100).toFixed(4));
		}
		if (svc.memoryMiB === 0 && (agentM.current.memory_mb ?? 0) > 0) {
			svc.memoryMiB = agentM.current.memory_mb ?? 0;
		}
		// latency_ms > 0 means agent is actively probing the service — use as request signal
		if (svc.requestRate === 0 && (agentM.current.latency_ms ?? 0) > 0) {
			// 1 probe per scrape_interval seconds — express as req/s
			svc.requestRate = parseFloat((1 / SCRAPE_INTERVAL_SECONDS).toFixed(3));
		}
	}

	const anomalies: DashboardAnomaly[] = services
		.flatMap((service) => {
			const issues: DashboardAnomaly[] = [];
			const now = new Date().toISOString();

			if (service.status === "down") {
				issues.push({
					id: `${service.id}-down`,
					service: service.name,
					namespace: service.namespace,
					platform: service.platform,
					severity: "critical",
					message: "Service scrape status is down.",
					metric: "up",
					baseline: "1",
					current: "0",
					detectedAt: now,
					autoRollback: true,
				});
			}

			if (service.memoryMiB > MEMORY_THRESHOLD_MIB) {
				issues.push({
					id: `${service.id}-memory`,
					service: service.name,
					namespace: service.namespace,
					platform: service.platform,
					severity: "warning",
					message: "Memory usage above baseline threshold.",
					metric: "memory",
					baseline: "< 120 MiB",
					current: `${service.memoryMiB.toFixed(1)} MiB`,
					detectedAt: now,
				});
			}

			const agentSvc = agentAnomalyMap.get(service.name);
			if (agentSvc) {
				const lsiSignal = agentSvc.is_error_anomalous
					? "LSI error anomaly (will rollback)"
					: agentSvc.is_anomalous
					? "LSI warn/novel anomaly (informational)"
					: "";
				const signals = [agentSvc.is_drifting ? "TSD drift" : "", lsiSignal]
					.filter(Boolean).join(" + ");
				issues.push({
					id: `${service.id}-agent`,
					service: service.name,
					namespace: service.namespace,
					platform: service.platform,
					severity: (agentSvc.is_drifting || agentSvc.is_error_anomalous) ? "critical" : "high",
					message: `BackTrack agent detected: ${signals}`,
					metric: agentSvc.is_drifting ? "cpu" : "logs",
					baseline: "nominal",
					current: signals,
					detectedAt: now,
					autoRollback: true,
				});
			}

			return issues;
		})
		.slice(0, 20);

	// Also surface agent anomalies for services the dashboard doesn't know about
	const dashboardServiceNames = new Set(services.map((s) => s.name));
	const now = new Date().toISOString();
	for (const agentSvc of agentServices) {
		if (!agentSvc.is_drifting && !agentSvc.is_anomalous && !agentSvc.is_error_anomalous) continue;
		if (dashboardServiceNames.has(agentSvc.name)) continue;
		const lsiSignal = agentSvc.is_error_anomalous
			? "LSI error anomaly (will rollback)"
			: agentSvc.is_anomalous
			? "LSI warn/novel anomaly (informational)"
			: "";
		const signals = [agentSvc.is_drifting ? "TSD drift" : "", lsiSignal]
			.filter(Boolean).join(" + ");
		anomalies.push({
			id: `agent-${agentSvc.name}`,
			service: agentSvc.name,
			namespace: "default",
			severity: (agentSvc.is_drifting || agentSvc.is_error_anomalous) ? "critical" : "high",
			message: `BackTrack agent detected: ${signals}`,
			metric: agentSvc.is_drifting ? "cpu" : "logs",
			baseline: "nominal",
			current: signals,
			detectedAt: now,
			autoRollback: true,
		});
	}

	return NextResponse.json({
		generatedAt: new Date().toISOString(),
		services,
		anomalies,
	});
}
