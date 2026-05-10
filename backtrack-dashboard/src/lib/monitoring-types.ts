export type PlatformType = "kubernetes" | "docker";
export type ArchitectureType = "monolith" | "microservices";

export interface DiscoveredService {
  name: string;
  namespace?: string;
  status: "running" | "down" | "unknown";
  ports: string[];
  image?: string;
  source: "kubernetes" | "docker";
}

export interface AppConnectionInput {
  appName: string;
  platform: PlatformType;
  architecture: ArchitectureType;
  clusterName: string;
  namespace: string;
  apiServerEndpoint: string;
  prometheusUrl?: string;
  authToken?: string;
  githubRepo?: string;
  githubBranch?: string;
  githubToken?: string;
  discoveredServices: DiscoveredService[];
}

export interface AppConnection extends AppConnectionInput {
  id: string;
  createdAt: string;
  status: "connected" | "error";
}

export type DashboardService = {
  id: string;
  connectionId: string;
  name: string;
  namespace: string;
  platform: PlatformType;
  status: "running" | "down" | "unknown";
  cpuCores: number;
  memoryMiB: number;
  requestRate: number;
  ports: string[];
};

export type CICDCommit = {
  sha: string;
  shortSha: string;
  message: string;
  author: string;
  timestamp: string;
  url: string;
};

export type CICDWorkflowRun = {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  headSha: string;
  branch: string;
  triggeredBy: string;
  startedAt: string;
  url: string;
};

export type CICDImageTag = {
  tag: string;
  pushedAt: string;
  pullUrl: string;
};

export type CICDData = {
  repo: string;
  branch: string;
  commits: CICDCommit[];
  workflowRuns: CICDWorkflowRun[];
  imageTags: CICDImageTag[];
  fetchedAt: string;
};

export type DashboardAnomaly = {
  id: string;
  service: string;
  namespace: string;
  platform?: PlatformType;
  severity: "critical" | "high" | "warning";
  message: string;
  metric: string;
  current: string;
  baseline: string;
  detectedAt?: string;
  autoRollback?: boolean;
};