"use client";

import { useEffect, useRef } from "react";
import Chart from "chart.js/auto";

type TrendDataset = {
  label: string;
  data: number[];
  borderColor: string;
};

type LineChartProps = {
  labels: string[];
  datasets: TrendDataset[];
  yAxisLabel: string;
};

export default function LineChart({ labels, datasets, yAxisLabel }: LineChartProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const chartRef = useRef<Chart | null>(null);

  useEffect(() => {
    if (!canvasRef.current) return;

    if (chartRef.current) {
      const chart = chartRef.current;
      chart.data.labels = labels;
      const ctx2 = canvasRef.current!.getContext("2d");
      chart.data.datasets = datasets.map((dataset) => {
        const h = canvasRef.current!.clientHeight || 200;
        let bg: CanvasGradient | string = "transparent";
        if (ctx2) {
          bg = ctx2.createLinearGradient(0, 0, 0, h);
          bg.addColorStop(0, dataset.borderColor + "38");
          bg.addColorStop(1, dataset.borderColor + "00");
        }
        return {
          label: dataset.label,
          data: dataset.data,
          borderColor: dataset.borderColor,
          backgroundColor: bg,
          pointBackgroundColor: dataset.borderColor,
          pointBorderColor: "transparent",
          pointRadius: 2,
          pointHoverRadius: 4,
          borderWidth: 1.5,
          tension: 0.4,
          fill: true,
        };
      });
      const yScale = chart.options.scales?.y as { title?: { text?: string } } | undefined;
      if (yScale?.title) {
        yScale.title.text = yAxisLabel;
      }
      chart.update("none");
      return;
    }

    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");

    chartRef.current = new Chart(canvas, {
      type: "line",
      data: {
        labels,
        datasets: datasets.map((dataset) => ({
          label: dataset.label,
          data: dataset.data,
          borderColor: dataset.borderColor,
          backgroundColor: (() => {
            if (!ctx) return "transparent";
            const h = canvas.clientHeight || 200;
            const grad = ctx.createLinearGradient(0, 0, 0, h);
            const hex = dataset.borderColor;
            grad.addColorStop(0, hex + "38");
            grad.addColorStop(1, hex + "00");
            return grad;
          })(),
          pointBackgroundColor: dataset.borderColor,
          pointBorderColor: "transparent",
          pointRadius: 2,
          pointHoverRadius: 4,
          borderWidth: 1.5,
          tension: 0.4,
          fill: true,
        })),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: false,
          },
        },
        scales: {
          x: {
            ticks: { color: "#6b7689", font: { family: "'IBM Plex Mono', monospace", size: 10 } },
            grid: { color: "rgba(148, 163, 184, 0.07)" },
            border: { color: "rgba(148,163,184,0.1)" },
          },
          y: {
            beginAtZero: true,
            ticks: { color: "#6b7689", font: { family: "'IBM Plex Mono', monospace", size: 10 } },
            grid: { color: "rgba(148, 163, 184, 0.07)" },
            border: { color: "rgba(148,163,184,0.1)" },
            title: {
              display: true,
              text: yAxisLabel,
              color: "#a5b0c2",
              font: { family: "'IBM Plex Mono', monospace", size: 10 },
            },
          },
        },
      },
    });

    return () => {
      chartRef.current?.destroy();
      chartRef.current = null;
    };
  }, [datasets, labels, yAxisLabel]);

  return (
    <div className="h-full w-full">
      <canvas ref={canvasRef} />
    </div>
  );
}
