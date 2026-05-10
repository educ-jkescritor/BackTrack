import { Container } from "lucide-react";
import type { DashboardService } from "@/lib/monitoring-types";

function StatusChip({ status }: { status: DashboardService["status"] }) {
  if (status === "running")
    return <span className="bt-chip bt-chip-green">Running</span>;
  if (status === "down")
    return <span className="bt-chip bt-chip-rose">Down</span>;
  return <span className="bt-chip bt-chip-amber">Unknown</span>;
}

function PlatformChip({ platform }: { platform: DashboardService["platform"] }) {
  return (
    <span className={platform === "kubernetes" ? "bt-chip bt-chip-teal" : "bt-chip bt-chip-violet"}>
      {platform === "kubernetes" ? "k8s" : "docker"}
    </span>
  );
}

function ActiveContainers({ services }: { services: DashboardService[] }) {
  return (
    <div className="bt-panel h-full flex flex-col overflow-hidden p-5">
      <div className="flex items-center gap-2 mb-4 flex-shrink-0">
        <Container size={15} className="text-[var(--accent-teal)]" />
        <span className="bt-label">Active Containers</span>
        <span className="bt-chip ml-auto">{services.length}</span>
      </div>

      <div className="bt-card-divider flex-shrink-0" />

      <div className="overflow-y-auto overflow-x-auto flex-1 min-h-0 scrollbar-hide mt-3">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-[var(--border-soft)]">
                {["ID", "Name", "Platform", "Status", "Namespace", "Ports"].map((h) => (
                  <th
                    key={h}
                    className="text-[10px] uppercase tracking-[0.14em] text-[var(--text-muted)] font-medium px-3 py-2.5"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {services.length === 0 ? (
                <tr>
                  <td className="text-[var(--text-muted)] px-3 py-4 text-xs" colSpan={6}>
                    No services yet — connect an app via Configure Cluster.
                  </td>
                </tr>
              ) : (
                services.map((service) => (
                  <tr
                    className="border-b border-[var(--border-soft)] hover:bg-white/[0.015] transition-colors"
                    key={service.id}
                  >
                    <td className="px-3 py-2.5 bt-mono text-[11px] text-[var(--text-muted)]">
                      {service.id.slice(0, 8)}
                    </td>
                    <td className="px-3 py-2.5 text-[13px] text-[var(--text-primary)] font-medium">
                      {service.name}
                    </td>
                    <td className="px-3 py-2.5">
                      <PlatformChip platform={service.platform} />
                    </td>
                    <td className="px-3 py-2.5">
                      <StatusChip status={service.status} />
                    </td>
                    <td className="px-3 py-2.5 text-[12px] text-[var(--text-secondary)] bt-mono">
                      {service.namespace || "—"}
                    </td>
                    <td className="px-3 py-2.5 text-[11px] text-[var(--text-muted)] bt-mono">
                      {service.ports.join(", ") || "—"}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
      </div>
    </div>
  );
}

export default ActiveContainers;
