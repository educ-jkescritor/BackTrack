import { NextRequest, NextResponse } from "next/server";
import {
	ArchitectureType,
	DiscoveredService,
	PlatformType,
} from "@/lib/monitoring-types";
import { listConnections, registerConnection } from "@/lib/monitoring-store";
import { runCommand } from "@/lib/command";

type DiscoveryResult = {
	services: DiscoveredService[];
	warning?: string;
	availableNames?: string[];
};

// Normalizes user input to match Docker/K8s naming conventions.
// "My App" → "my-app", "my_app" → "my-app"
function normalizeAppName(name: string): string {
	return name.toLowerCase().trim().replace(/[\s_]+/g, "-");
}

type ConnectionPayload = {
	action?: "test" | "connect";
	appName?: string;
	platform?: PlatformType;
	architecture?: ArchitectureType;
	clusterName?: string;
	namespace?: string;
	apiServerEndpoint?: string;
	prometheusUrl?: string;
	authToken?: string;
	githubRepo?: string;
	githubBranch?: string;
	githubToken?: string;
};

async function discoverKubernetesServices(
	namespace: string,
	architecture: ArchitectureType,
	appName: string,
): Promise<DiscoveryResult> {
	const svcResult = await runCommand("kubectl", [
		"get",
		"svc",
		"-n",
		namespace,
		"-o",
		"json",
	]);

	if (svcResult.code !== 0) {
		throw new Error(
			`kubectl service discovery failed: ${svcResult.stderr || "unknown error"}`,
		);
	}

	const podResult = await runCommand("kubectl", [
		"get",
		"pods",
		"-n",
		namespace,
		"-o",
		"json",
	]);

	const endpointResult = await runCommand("kubectl", [
		"get",
		"endpoints",
		"-n",
		namespace,
		"-o",
		"json",
	]);

	const svcJson = JSON.parse(svcResult.stdout) as {
		items: Array<{
			metadata?: { name?: string; labels?: Record<string, string> };
			spec?: {
				ports?: Array<{ port?: number; targetPort?: number | string }>;
				selector?: Record<string, string>;
			};
		}>;
	};

	const podJson = podResult.code === 0
		? (JSON.parse(podResult.stdout) as {
				items: Array<{
					metadata?: { name?: string; labels?: Record<string, string> };
					status?: { phase?: string };
					spec?: { nodeName?: string };
				}>;
			})
		: { items: [] };

	const endpointJson = endpointResult.code === 0
		? (JSON.parse(endpointResult.stdout) as {
				items: Array<{
					metadata?: { name?: string };
					subsets?: Array<{
						addresses?: Array<Record<string, unknown>>;
						notReadyAddresses?: Array<Record<string, unknown>>;
					}>;
				}>;
			})
		: { items: [] };

	const norm = normalizeAppName(appName);
	const allItems = (svcJson.items || []).filter(
		(item) => (item.metadata?.name || "").toLowerCase() !== "kubernetes",
	);

	const toService = (item: typeof allItems[number]): DiscoveredService => {
		const name = item.metadata?.name || "unknown-service";
		const ports = (item.spec?.ports || []).map((port) =>
			`${port.port ?? "?"}:${port.targetPort ?? "?"}`,
		);
		const selector = item.spec?.selector || {};
		const endpointItem = (endpointJson.items || []).find(
			(endpoint) => (endpoint.metadata?.name || "").toLowerCase() === name.toLowerCase(),
		);
		const readyEndpointCount = endpointItem?.subsets?.reduce(
			(sum, subset) => sum + (subset.addresses?.length || 0),
			0,
		) ?? 0;
		const serviceSelectorEntries = Object.entries(selector).map(
			([key, value]) => `${key}=${String(value).toLowerCase()}`,
		);
		const relatedPods = (podJson.items || []).filter((pod) => {
			const podName = (pod.metadata?.name || "").toLowerCase();
			const podLabels = Object.entries(pod.metadata?.labels || {}).map(
				([key, value]) => `${key}=${String(value).toLowerCase()}`,
			);
			const selectorMatch =
				serviceSelectorEntries.length > 0 &&
				serviceSelectorEntries.every((entry) => podLabels.includes(entry));
			return (
				podName.includes(name.toLowerCase()) ||
				String(pod.metadata?.labels?.app || "").toLowerCase() === name.toLowerCase() ||
				selectorMatch
			);
		});
		const isRunning =
			readyEndpointCount > 0 || relatedPods.some((pod) => pod.status?.phase === "Running");
		return { name, namespace, status: isRunning ? "running" : "unknown", ports, source: "kubernetes" };
	};

	// Tier 1: explicit app.kubernetes.io/part-of label — highest precision
	const tier1 = allItems.filter((item) => {
		const partOf = (item.metadata?.labels?.["app.kubernetes.io/part-of"] || "").toLowerCase();
		return partOf === norm;
	});
	if (tier1.length > 0) return { services: tier1.map(toService) };

	// Microservices: app name is a logical group label, not a service name filter.
	// Return all services in the namespace — the user named their whole system "microservice-demo"
	// but individual services are named adservice, cartservice, etc.
	if (architecture === "microservices") {
		return { services: allItems.map(toService) };
	}

	// Monolith: service name or app label must contain the app name
	const tier2 = allItems.filter((item) => {
		const name = (item.metadata?.name || "").toLowerCase();
		const appLabel = (item.metadata?.labels?.app || "").toLowerCase();
		return name.includes(norm) || appLabel.includes(norm);
	});
	if (tier2.length > 0) {
		const warning = norm !== appName.toLowerCase()
			? `App name normalized to "${norm}" — matched ${tier2.length} service(s).`
			: undefined;
		return { services: tier2.map(toService), warning };
	}

	// Monolith fallback: return available names as suggestions
	const availableNames = allItems.map((item) => item.metadata?.name).filter(Boolean) as string[];
	return {
		services: [],
		warning: `No services found matching "${appName}" in namespace "${namespace}".`,
		availableNames,
	};
}

async function discoverDockerServices(
	appName: string,
	_architecture: ArchitectureType,
): Promise<DiscoveryResult> {
	const dockerResult = await runCommand("docker", ["ps", "--format", "{{json .}}"]);

	if (dockerResult.code !== 0) {
		throw new Error(`docker discovery failed: ${dockerResult.stderr || "unknown error"}`);
	}

	const allContainers = dockerResult.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, string>);

	const norm = normalizeAppName(appName);

	const getComposeProject = (c: Record<string, string>) => {
		const m = (c.Labels || "").match(/(?:^|,)com\.docker\.compose\.project=([^,]+)/);
		return m ? m[1].toLowerCase() : "";
	};

	const toService = (c: Record<string, string>): DiscoveredService => ({
		name: c.Names || "unknown-container",
		status: (c.State || "").toLowerCase() === "running" ? "running" : "unknown",
		ports: c.Ports ? [c.Ports] : [],
		image: c.Image,
		source: "docker",
	});

	// Tier 1: exact compose project name match
	const tier1 = allContainers.filter((c) => getComposeProject(c) === norm);
	if (tier1.length > 0) return { services: tier1.map(toService) };

	// Tier 2: container name or image contains normalized appName
	const tier2 = allContainers.filter(
		(c) =>
			(c.Names || "").toLowerCase().includes(norm) ||
			(c.Image || "").toLowerCase().includes(norm),
	);
	if (tier2.length > 0) {
		const warning = norm !== appName.toLowerCase()
			? `App name normalized to "${norm}" — matched ${tier2.length} container(s).`
			: undefined;
		return { services: tier2.map(toService), warning };
	}

	// Tier 3: partial compose project name match (e.g. user typed "demo" but project is "microservice-demo")
	const tier3 = allContainers.filter((c) => {
		const proj = getComposeProject(c);
		return proj && (proj.includes(norm) || norm.includes(proj));
	});
	if (tier3.length > 0) {
		return {
			services: tier3.map(toService),
			warning: `No exact match for "${appName}" — showing containers from a similarly named compose project. Verify these are correct.`,
		};
	}

	// No results — return all container names so the user can correct their input
	const availableNames = allContainers.map((c) => c.Names).filter(Boolean);
	return {
		services: [],
		warning: `No containers found matching "${appName}".`,
		availableNames,
	};
}

export async function GET() {
	return NextResponse.json({ connections: listConnections() });
}

export async function POST(request: NextRequest) {
	try {
		const payload = (await request.json()) as ConnectionPayload;
		const action = payload.action || "connect";
		const appName = (payload.appName || "").trim();
		const platform = (payload.platform || "kubernetes") as PlatformType;
		const architecture = (payload.architecture || "microservices") as ArchitectureType;
		const clusterName = (payload.clusterName || (platform === "docker" ? "local-docker" : "")).trim();
		const namespace = (payload.namespace || "default").trim();
		const apiServerEndpoint = (payload.apiServerEndpoint || "").trim();
		const prometheusUrl = (payload.prometheusUrl || "").trim() || undefined;
		const authToken = (payload.authToken || "").trim();
		const githubRepo = (payload.githubRepo || "").trim();
		const githubBranch = (payload.githubBranch || "main").trim();
		const githubToken = (payload.githubToken || "").trim();

		if (!appName || (platform !== "docker" && !clusterName)) {
			return NextResponse.json(
				{ error: "App name and cluster name are required." },
				{ status: 400 },
			);
		}

		let result: DiscoveryResult;

		if (platform === "kubernetes") {
			result = await discoverKubernetesServices(namespace, architecture, appName);
		} else {
			result = await discoverDockerServices(appName, architecture);
		}

		const { services: discoveredServices, warning, availableNames } = result;

		if (action === "test") {
			return NextResponse.json({
				ok: true,
				discoveredServices,
				warning,
				availableNames,
				message: discoveredServices.length > 0
					? `Discovered ${discoveredServices.length} service(s).`
					: `No services found for "${appName}".`,
			});
		}

		const connection = registerConnection({
			appName,
			platform,
			architecture,
			clusterName,
			namespace,
			apiServerEndpoint,
			prometheusUrl,
			authToken: authToken || undefined,
			githubRepo: githubRepo || undefined,
			githubBranch,
			githubToken: githubToken || undefined,
			discoveredServices,
		});

		return NextResponse.json({
			ok: true,
			connection,
			discoveredServices,
			warning,
			availableNames,
			message: discoveredServices.length > 0
				? `Connected ${appName} with ${discoveredServices.length} discovered service(s).`
				: `Connected "${appName}" but no services were discovered. Check the app name.`,
		});
	} catch (error: unknown) {
		return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
	}
}
