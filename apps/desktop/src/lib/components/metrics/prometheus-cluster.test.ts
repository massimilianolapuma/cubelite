import { describe, it, expect, beforeEach, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/svelte";

vi.mock("#lib/tauri.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#lib/tauri.ts")>()),
  prometheusClusterUsage: vi.fn(),
  prometheusNodeMetrics: vi.fn(),
  prometheusAlerts: vi.fn(),
  prometheusAlertExpr: vi.fn(async () => "crash > 0"),
  openGrafanaExplore: vi.fn(async () => {}),
  grafanaPortForward: vi.fn(async () => 43000),
}));

import AlertsCard from "./AlertsCard.svelte";
import ClusterHistory from "./ClusterHistory.svelte";
import NodeMetricsSection from "./NodeMetricsSection.svelte";
import { app } from "#lib/stores/app.svelte.ts";
import { prometheus } from "#lib/stores/prometheus.svelte.ts";
import { OVERVIEW_INTERVAL_MS, promOverview } from "#lib/stores/promOverview.svelte.ts";
import { resources } from "#lib/stores/resources.svelte.ts";
import { settings } from "#lib/stores/settings.svelte.ts";
import {
  openGrafanaExplore,
  prometheusAlertExpr,
  prometheusAlerts,
  prometheusClusterUsage,
  prometheusNodeMetrics,
  type Alert,
  type HostChart,
  type HostMetrics,
  type MetricSource,
  type PodInfo,
  type PromEndpoint,
} from "#lib/tauri.ts";

const endpoint: PromEndpoint = {
  target: { kind: "in-cluster", namespace: "monitoring", service: "prometheus-operated", port: 9090, https: false },
  cluster: null,
  grafanaUrl: "https://grafana.example",
  grafanaDatasource: "prom",
  skipTlsVerify: false,
};

const cadvisorAndKsm = (c: HostChart): MetricSource => (c.endsWith("allocatable") ? "kube-state-metrics" : "cadvisor");

function host(charts: HostChart[], source: (c: HostChart) => MetricSource | null = cadvisorAndKsm): HostMetrics {
  return {
    start: 0,
    end: 3600,
    step: 15,
    charts: charts.map((chart) => ({
      chart,
      source: source(chart),
      query: `q-${chart}`,
      series: source(chart) ? [{ label: "", points: [[0, 1], [3600, 2]] }] : [],
      error: null,
    })),
  };
}

const alert = (overrides: Partial<Alert>): Alert => ({
  name: "Watchdog",
  severity: "none",
  namespace: null,
  pod: null,
  node: null,
  summary: null,
  activeAt: null,
  expr: "vector(1)",
  labels: {},
  ...overrides,
});

let clock = 10_000_000;
let context = 0;

/** A fresh context (so the Overview store forgets earlier loads) with `endpoint`. */
function useContext(ep: PromEndpoint | null = endpoint) {
  context += 1;
  app.activeCluster = `ctx-${context}`;
  prometheus.setEndpoint(app.activeCluster, ep);
}

beforeEach(() => {
  vi.clearAllMocks();
  clock += 10 * OVERVIEW_INTERVAL_MS;
  app.kubeconfigPath = "/k";
  settings.integrationHints.value = true;
  promOverview.range = "1h";
});

describe("Overview alerts (#530)", () => {
  it("lists firing alerts with links to the pod, the node and Grafana", async () => {
    useContext();
    const pod = { name: "api-0", namespace: "shop" } as PodInfo;
    resources.pods = [pod];
    resources.nodeInventory = [{ name: "minikube", status: "Ready", roles: [], version: null, creation_timestamp: null }];
    vi.mocked(prometheusAlerts).mockResolvedValue({
      source: "alerts-api",
      alerts: [
        alert({ name: "KubePodCrashLooping", severity: "warning", namespace: "shop", pod: "api-0", summary: "Pod is crash looping.", expr: "ALERTS-crash" }),
        alert({ name: "KubeNodeNotReady", severity: "critical", node: "minikube" }),
        alert({ name: "Watchdog", summary: "pipeline check" }),
      ],
    });
    vi.mocked(prometheusClusterUsage).mockResolvedValue(host(["cpu"]));
    render(AlertsCard);
    await promOverview.load(clock);
    await waitFor(() => expect(screen.getAllByTestId("alert-row")).toHaveLength(3));
    // Watchdog (severity none) is listed, muted and last, but not counted.
    expect(screen.getByTestId("alerts-count")).toHaveTextContent("2");
    expect(screen.getByTestId("alerts-informational")).toHaveTextContent("1 informational");
    expect(screen.getAllByTestId("alert-row")[2]).toHaveTextContent("Watchdog");
    expect(screen.getByText("Pod is crash looping.")).toBeInTheDocument();

    await fireEvent.click(screen.getByRole("button", { name: "shop/api-0" }));
    expect(app.view).toBe("pods");
    expect(app.selectedPod).toEqual(pod);

    await fireEvent.click(screen.getByRole("button", { name: "minikube" }));
    expect(app.view).toBe("nodes");
    expect(app.selectedNode).toBe("minikube");

    await fireEvent.click(screen.getByRole("button", { name: "Open KubePodCrashLooping in Grafana" }));
    await waitFor(() =>
      expect(openGrafanaExplore).toHaveBeenCalledWith({
        grafanaUrl: "https://grafana.example",
        datasource: "prom",
        queries: ["crash > 0"],
        range: "1h",
      }),
    );
    // The rule's expression is asked for on click only.
    expect(prometheusAlertExpr).toHaveBeenCalledTimes(1);
    expect(vi.mocked(prometheusAlertExpr).mock.calls[0][3]).toMatchObject({ name: "KubePodCrashLooping" });
    vi.mocked(prometheusAlertExpr).mockRejectedValueOnce("rules unavailable");
    await fireEvent.click(screen.getByRole("button", { name: "Open KubePodCrashLooping in Grafana" }));
    await waitFor(() =>
      expect(openGrafanaExplore).toHaveBeenLastCalledWith(expect.objectContaining({ queries: ["ALERTS-crash"] })),
    );
  });

  it("says when nothing fires and shows the error inline", async () => {
    useContext();
    vi.mocked(prometheusClusterUsage).mockResolvedValue(host([]));
    vi.mocked(prometheusAlerts).mockResolvedValue({ source: "alerts-metric", alerts: [] });
    render(AlertsCard);
    await promOverview.load(clock);
    await waitFor(() => expect(screen.getByText("No firing alerts.")).toBeInTheDocument());

    useContext();
    vi.mocked(prometheusAlerts).mockRejectedValue("Prometheus returned 403: access denied");
    await promOverview.load(clock);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("403"));
  });

  it("offers setting up Prometheus without an endpoint, unless hints are off", async () => {
    useContext(null);
    const { unmount } = render(AlertsCard);
    expect(screen.queryByTestId("alerts-card")).not.toBeInTheDocument();
    expect(screen.getByTestId("overview-prometheus-hint")).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Set up Prometheus" }));
    expect(app.preferencesSection).toBe("prometheus");
    unmount();
    settings.integrationHints.value = false;
    render(AlertsCard);
    expect(screen.queryByTestId("overview-prometheus-hint")).not.toBeInTheDocument();
    expect(prometheusAlerts).not.toHaveBeenCalled();
  });
});

describe("Cluster history (#530)", () => {
  it("charts cluster CPU and memory against allocatable and switches range", async () => {
    useContext();
    vi.mocked(prometheusAlerts).mockResolvedValue({ source: "alerts-api", alerts: [] });
    vi.mocked(prometheusClusterUsage).mockResolvedValue(
      host(["cpu", "cpu-allocatable", "memory", "memory-allocatable"]),
    );
    render(ClusterHistory);
    await promOverview.load(clock);
    await waitFor(() => expect(screen.getAllByTestId("metrics-chart")).toHaveLength(2));
    expect(screen.getAllByText("from cAdvisor")).toHaveLength(2);
    expect(screen.getByText("2 / alloc 2")).toBeInTheDocument();

    await fireEvent.click(screen.getByRole("radio", { name: "24h" }));
    expect(promOverview.range).toBe("24h");
    await promOverview.load(clock + 1);
    expect(prometheusClusterUsage).toHaveBeenLastCalledWith("/k", app.activeCluster, endpoint, "24h");
  });

  it("is absent without an endpoint", () => {
    useContext(null);
    render(ClusterHistory);
    expect(screen.queryByTestId("cluster-history")).not.toBeInTheDocument();
  });
});

describe("Node metrics (#530)", () => {
  it("charts the node, naming each chart's exporter and the missing ones", async () => {
    useContext();
    vi.mocked(prometheusNodeMetrics).mockResolvedValue(
      host(
        ["cpu", "cpu-allocatable", "memory", "memory-allocatable", "pods", "network-rx", "network-tx", "filesystem", "filesystem-capacity"],
        (c) => (c.startsWith("filesystem") ? null : c === "pods" ? "kube-state-metrics" : "node-exporter"),
      ),
    );
    render(NodeMetricsSection, { node: "minikube" });
    await waitFor(() => expect(screen.getAllByTestId("metrics-chart")).toHaveLength(5));
    expect(prometheusNodeMetrics).toHaveBeenCalledWith("/k", app.activeCluster, endpoint, "minikube", "1h");
    expect(screen.getAllByText("from node-exporter")).toHaveLength(3);
    expect(screen.getByText("from kube-state-metrics")).toBeInTheDocument();
    expect(
      screen.getByText("not available — needs node-exporter or cAdvisor metrics for this node"),
    ).toBeInTheDocument();

    await fireEvent.click(screen.getByRole("button", { name: "Open CPU in Grafana" }));
    await waitFor(() =>
      expect(openGrafanaExplore).toHaveBeenCalledWith(
        expect.objectContaining({ queries: ["q-cpu", "q-cpu-allocatable"], range: "1h" }),
      ),
    );

    await fireEvent.click(screen.getByRole("radio", { name: "6h" }));
    await waitFor(() =>
      expect(prometheusNodeMetrics).toHaveBeenLastCalledWith("/k", app.activeCluster, endpoint, "minikube", "6h"),
    );
  });

  it("shows a failed load inline", async () => {
    useContext();
    vi.mocked(prometheusNodeMetrics).mockRejectedValue("Cannot reach Prometheus: timed out after 15 s");
    render(NodeMetricsSection, { node: "minikube" });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("timed out"));
  });

  it("shows the setup hint without an endpoint", () => {
    useContext(null);
    render(NodeMetricsSection, { node: "minikube" });
    expect(screen.getByTestId("node-metrics-hint")).toBeInTheDocument();
    expect(prometheusNodeMetrics).not.toHaveBeenCalled();
  });
});
