import { describe, it, expect, beforeEach, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/svelte";

vi.mock("#lib/tauri.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#lib/tauri.ts")>()),
  prometheusMetrics: vi.fn(),
  prometheusSparklines: vi.fn(),
  openGrafanaExplore: vi.fn(async () => {}),
}));

import MetricsSection from "./MetricsSection.svelte";
import { app } from "#lib/stores/app.svelte.ts";
import { prometheus, SPARKLINE_INTERVAL_MS } from "#lib/stores/prometheus.svelte.ts";
import {
  openGrafanaExplore,
  prometheusMetrics,
  prometheusSparklines,
  type Chart,
  type MetricsResult,
  type PromEndpoint,
} from "#lib/tauri.ts";

const endpoint: PromEndpoint = {
  target: { kind: "in-cluster", namespace: "monitoring", service: "prometheus-operated", port: 9090, https: false },
  cluster: null,
  grafanaUrl: "https://grafana.example",
  grafanaDatasource: "prom",
  skipTlsVerify: false,
};

function result(overrides: Partial<Record<Chart, { series?: MetricsResult["charts"][number]["series"]; error?: string }>> = {}): MetricsResult {
  const charts: Chart[] = ["cpu", "cpu-request", "cpu-limit", "memory", "memory-request", "memory-limit", "restarts", "network-rx", "network-tx"];
  return {
    start: 0,
    end: 3600,
    step: 15,
    charts: charts.map((chart) => ({
      chart,
      query: `q-${chart}`,
      series: overrides[chart]?.series ?? [{ label: "web", points: [[0, 0.1], [3600, 0.2]] }],
      error: overrides[chart]?.error ?? null,
    })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  app.activeCluster = "prod";
  app.kubeconfigPath = "/k";
  prometheus.setEndpoint("prod", endpoint);
});

describe("MetricsSection (#510)", () => {
  it("is hidden without a Prometheus endpoint", () => {
    prometheus.setEndpoint("prod", null);
    render(MetricsSection, { namespace: "shop", workload: { kind: "pod", name: "api-0" } });
    expect(screen.queryByTestId("metrics-section")).not.toBeInTheDocument();
    expect(prometheusMetrics).not.toHaveBeenCalled();
  });

  it("charts the pod and reloads for another range", async () => {
    vi.mocked(prometheusMetrics).mockResolvedValue(
      result({ restarts: { series: [{ label: "web", points: [[0, 1], [1800, 3]] }] } }),
    );
    render(MetricsSection, { namespace: "shop", workload: { kind: "pod", name: "api-0" } });
    await waitFor(() => expect(screen.getAllByTestId("metrics-chart")).toHaveLength(4));
    expect(prometheusMetrics).toHaveBeenCalledWith("/k", "prod", endpoint, {
      namespace: "shop",
      workload: { kind: "pod", name: "api-0" },
      range: "1h",
      perContainer: true,
    });
    expect(screen.getByText("2 in range")).toBeInTheDocument();
    expect(screen.getByText("200m / req 200m / lim 200m")).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("radio", { name: "24h" }));
    await waitFor(() =>
      expect(prometheusMetrics).toHaveBeenLastCalledWith("/k", "prod", endpoint, expect.objectContaining({ range: "24h" })),
    );
  });

  it("shows per-chart errors and missing exporters", async () => {
    vi.mocked(prometheusMetrics).mockResolvedValue(
      result({ restarts: { series: [] }, cpu: { error: "Prometheus returned 422: boom" } }),
    );
    render(MetricsSection, { namespace: "shop", workload: { kind: "deployment", name: "api" } });
    await waitFor(() => expect(screen.getByText("Prometheus returned 422: boom")).toBeInTheDocument());
    expect(screen.getByText(/needs kube-state-metrics/)).toBeInTheDocument();
  });

  it("opens Grafana with the chart queries", async () => {
    vi.mocked(prometheusMetrics).mockResolvedValue(result());
    render(MetricsSection, { namespace: "shop", workload: { kind: "pod", name: "api-0" } });
    await fireEvent.click(await screen.findByRole("button", { name: "Open Memory in Grafana" }));
    expect(openGrafanaExplore).toHaveBeenCalledWith({
      grafanaUrl: "https://grafana.example",
      datasource: "prom",
      queries: ["q-memory", "q-memory-request", "q-memory-limit"],
      range: "1h",
    });
  });

  it("shows the connection error once", async () => {
    vi.mocked(prometheusMetrics).mockRejectedValue("Cannot reach Prometheus: timed out after 15 s");
    render(MetricsSection, { namespace: "shop", workload: { kind: "pod", name: "api-0" } });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("timed out"));
  });
});

describe("prometheus sparklines store (#510)", () => {
  it("loads once per scope within the interval and keys by namespace/pod", async () => {
    vi.mocked(prometheusSparklines).mockResolvedValue({ cpu: { "shop/api-0": [[0, 0.1]] }, memory: {} });
    await prometheus.loadSparklines("shop", 1_000_000);
    await prometheus.loadSparklines("shop", 1_000_000 + 1_000);
    expect(prometheusSparklines).toHaveBeenCalledTimes(1);
    expect(prometheus.cpuFor("shop", "api-0")).toEqual([[0, 0.1]]);
    expect(prometheus.memoryFor("shop", "api-0")).toBeNull();
    await prometheus.loadSparklines("shop", 1_000_000 + SPARKLINE_INTERVAL_MS);
    expect(prometheusSparklines).toHaveBeenCalledTimes(2);
    vi.mocked(prometheusSparklines).mockRejectedValueOnce("nope");
    await prometheus.loadSparklines(null, 1_000_000 + 2 * SPARKLINE_INTERVAL_MS);
    expect(prometheus.sparklineError).toBe("nope");
    expect(prometheus.sparklines).toBeNull();
  });
});
