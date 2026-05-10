"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import LineChart from "./LineChart";
import CustomSelect from "./CustomSelect";
import type { DashboardService } from "@/lib/monitoring-types";
import { Activity, Cpu, HardDrive, TrendingUp, Wifi, Layers } from "lucide-react";

type TrendView = "overview" | "cpu" | "memory" | "request" | "network";

type ServiceSnapshot = {
  id: string;
  name: string;
  cpuCores: number;
  memoryMiB: number;
  requestRate: number;
};

type TrendSnapshot = {
  at: string;
  services: ServiceSnapshot[];
};

const TAB_META: Record<TrendView, { label: string; icon: React.ReactNode; color: string; key?: string; yAxisLabel: string }> = {
  overview: { label: "Overview", icon: <Layers size={13} />, color: "#5eead4", yAxisLabel: "Utilization" },
  cpu:      { label: "CPU",      icon: <Cpu size={13} />,    color: "#7CFC00", key: "cpu",     yAxisLabel: "CPU Cores" },
  memory:   { label: "Memory",   icon: <HardDrive size={13} />, color: "#38BDF8", key: "memory", yAxisLabel: "MiB" },
  request:  { label: "Request",  icon: <TrendingUp size={13} />, color: "#A855F7", key: "request", yAxisLabel: "Req/s" },
  network:  { label: "Network",  icon: <Wifi size={13} />,   color: "#2563EB", key: "network", yAxisLabel: "Trend" },
};

function ContainerHealth({ services }: { services: DashboardService[] }) {
  const router = useRouter();
  const [activeView, setActiveView] = useState<TrendView>("overview");
  const [selectedServiceId, setSelectedServiceId] = useState<string>("all");
  const [history, setHistory] = useState<TrendSnapshot[]>([]);

  useEffect(() => {
    if (services.length === 0) return;

    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHistory((prev) => {
      const last = prev[prev.length - 1];
      const unchanged =
        last &&
        last.services.length === services.length &&
        services.every((s, i) => {
          const snap = last.services[i];
          return (
            snap &&
            snap.id === s.id &&
            snap.cpuCores === s.cpuCores &&
            snap.memoryMiB === s.memoryMiB &&
            snap.requestRate === s.requestRate
          );
        });
      if (unchanged) return prev;

      return [
        ...prev,
        {
          at: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
          services: services.map((s) => ({
            id: s.id, name: s.name,
            cpuCores: s.cpuCores, memoryMiB: s.memoryMiB, requestRate: s.requestRate,
          })),
        },
      ].slice(-20);
    });
  }, [services]);

  const serviceOptions = useMemo(() => {
    const unique = new Map<string, { name: string; namespace: string; platform: string }>();
    for (const s of services) {
      if (!unique.has(s.id)) unique.set(s.id, { name: s.name, namespace: s.namespace, platform: s.platform });
    }
    return Array.from(unique.entries()).map(([id, v]) => ({ id, ...v }));
  }, [services]);

  useEffect(() => {
    if (selectedServiceId !== "all" && !serviceOptions.some((s) => s.id === selectedServiceId)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSelectedServiceId("all");
    }
  }, [serviceOptions, selectedServiceId]);

  const trendPoints = useMemo(() => {
    return history.map((snapshot) => {
      const sel = snapshot.services.find((s) => s.id === selectedServiceId);
      const cpu     = selectedServiceId === "all" ? snapshot.services.reduce((a, s) => a + s.cpuCores, 0)    : sel?.cpuCores ?? 0;
      const memory  = selectedServiceId === "all" ? snapshot.services.reduce((a, s) => a + s.memoryMiB, 0)   : sel?.memoryMiB ?? 0;
      const request = selectedServiceId === "all" ? snapshot.services.reduce((a, s) => a + s.requestRate, 0) : sel?.requestRate ?? 0;
      return { at: snapshot.at, cpu, memory, request, network: request };
    });
  }, [history, selectedServiceId]);

  const chartConfig = useMemo(() => {
    const labels = trendPoints.map((p) => p.at);
    if (activeView === "overview") {
      const cpuArr = trendPoints.map((p) => p.cpu);
      const memArr = trendPoints.map((p) => p.memory);
      const reqArr = trendPoints.map((p) => p.request);
      const netArr = trendPoints.map((p) => p.network);
      const norm = (arr: number[]) => {
        const max = Math.max(...arr, 0);
        if (max <= 0) return arr.map(() => 0);
        return arr.map((v) => +((v / max) * 100).toFixed(2));
      };
      // Only show Request/Network lines if they have non-zero data
      const hasRequest = reqArr.some((v) => v > 0);
      const hasNetwork = netArr.some((v) => v > 0);
      return {
        labels, yAxisLabel: "Utilization %",
        datasets: [
          { label: "CPU",     data: norm(cpuArr), borderColor: "#7CFC00" },
          { label: "Memory",  data: norm(memArr), borderColor: "#38BDF8" },
          ...(hasRequest ? [{ label: "Request", data: norm(reqArr), borderColor: "#A855F7" }] : []),
          ...(hasNetwork ? [{ label: "Network", data: norm(netArr), borderColor: "#2563EB" }]  : []),
        ],
      };
    }
    const m = TAB_META[activeView];
    const key = m.key as "cpu" | "memory" | "request" | "network";
    return {
      labels, yAxisLabel: m.yAxisLabel,
      datasets: [{ label: m.label, data: trendPoints.map((p) => +p[key].toFixed(2)), borderColor: m.color }],
    };
  }, [activeView, trendPoints]);

  const totalCpu    = services.reduce((a, s) => a + s.cpuCores, 0);
  const totalMemory = services.reduce((a, s) => a + s.memoryMiB, 0);
  const totalRate   = services.reduce((a, s) => a + s.requestRate, 0);
  const running     = services.filter((s) => s.status === "running").length;

  const handleServiceClick = (svc: { name: string; namespace: string; platform?: string }) => {
    router.push(`/anomalies/${encodeURIComponent(svc.name)}?namespace=${encodeURIComponent(svc.namespace)}&severity=warning&metric=cpu&current=—&baseline=—&message=Inspecting+service&platform=${encodeURIComponent(svc.platform ?? "kubernetes")}`);
  };

  return (
    <div className="bt-panel h-full flex flex-col p-5" style={{ overflow: "visible" }}>
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-shrink-0 mb-4">
        <div className="flex items-center gap-2">
          <Activity size={15} className="text-[var(--accent-teal)]" />
          <span className="bt-label">Container Health</span>
        </div>

        <CustomSelect
          variant="pill"
          value={selectedServiceId}
          onChange={setSelectedServiceId}
          options={[
            { value: "all", label: "All Services" },
            ...serviceOptions.map((s) => ({ value: s.id, label: s.name })),
          ]}
        />
      </div>

      {/* Divider */}
      <div className="bt-card-divider flex-shrink-0" />

      {/* Tabs */}
      <div className="flex gap-2 flex-shrink-0 mb-3">
        {(Object.entries(TAB_META) as [TrendView, typeof TAB_META[TrendView]][]).map(([id, meta]) => (
          <button
            key={id}
            type="button"
            onClick={() => setActiveView(id)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11.5px] transition border ${
              activeView === id
                ? "bt-tab-active"
                : "bt-tab"
            }`}
          >
            <span className={activeView === id ? "text-[var(--accent-teal)]" : "text-[var(--text-muted)]"}>
              {meta.icon}
            </span>
            {meta.label}
          </button>
        ))}
      </div>

      {/* Chart */}
      <div className="flex-1 min-h-0 rounded-xl border border-[var(--border-soft)] bg-[rgba(11,16,26,0.7)] p-3">
        <LineChart
          labels={chartConfig.labels}
          datasets={chartConfig.datasets}
          yAxisLabel={chartConfig.yAxisLabel}
        />
      </div>

      {/* Legend */}
      <div className="mt-2 flex items-center justify-center gap-5 text-[11px] text-[var(--text-muted)] flex-shrink-0">
        {chartConfig.datasets.map((d) => (
          <div key={d.label} className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full inline-block" style={{ backgroundColor: d.borderColor }} />
            <span>{d.label}</span>
          </div>
        ))}
      </div>

      {/* Stats row */}
      <div className="mt-3 grid grid-cols-4 gap-2 flex-shrink-0">
        {[
          { icon: <Cpu size={12} />, label: "CPU", value: totalCpu.toFixed(3), unit: "cores" },
          { icon: <HardDrive size={12} />, label: "MEM", value: totalMemory.toFixed(1), unit: "MiB" },
          { icon: <TrendingUp size={12} />, label: "REQ", value: totalRate > 0 ? totalRate.toFixed(2) : "—", unit: totalRate > 0 ? "req/s" : "no prom" },
          { icon: <Activity size={12} />, label: "UP", value: `${running}/${services.length}`, unit: "svcs" },
        ].map((stat) => (
          <div key={stat.label} className="bt-tile flex flex-col items-center justify-center py-2 gap-0.5">
            <span className="text-[var(--accent-teal)]">{stat.icon}</span>
            <span className="bt-mono text-[13px] font-semibold text-[var(--text-primary)]">{stat.value}</span>
            <span className="text-[9px] uppercase tracking-widest text-[var(--text-muted)]">{stat.unit}</span>
          </div>
        ))}
      </div>

      {/* Clickable service list */}
      {serviceOptions.length > 0 && (
        <div className="mt-3 flex-shrink-0">
          <p className="text-[9px] uppercase tracking-[0.18em] text-[var(--text-muted)] mb-1.5">Inspect Service</p>
          <div className="flex flex-wrap gap-1.5">
            {serviceOptions.map((svc) => (
              <button
                key={svc.id}
                type="button"
                onClick={() => handleServiceClick(svc)}
                className="bt-chip hover:bt-chip-teal transition cursor-pointer"
              >
                {svc.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default ContainerHealth;
