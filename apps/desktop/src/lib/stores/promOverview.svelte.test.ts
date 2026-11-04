import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("#lib/tauri.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#lib/tauri.ts")>()),
  prometheusClusterUsage: vi.fn(),
  prometheusAlerts: vi.fn(),
}));

import { app } from "./app.svelte";
import { prometheus } from "./prometheus.svelte";
import { OVERVIEW_INTERVAL_MS, promOverview } from "./promOverview.svelte";
import { prometheusAlerts, prometheusClusterUsage, type HostMetrics, type PromEndpoint } from "#lib/tauri.ts";

const endpoint: PromEndpoint = {
  target: { kind: "in-cluster", namespace: "monitoring", service: "prometheus-operated", port: 9090, https: false },
  cluster: "eu",
  grafanaUrl: null,
  grafanaDatasource: null,
  skipTlsVerify: false,
};

const usage = (end: number): HostMetrics => ({ start: end - 3600, end, step: 15, charts: [] });
const watchdog = {
  name: "Watchdog",
  severity: "none",
  namespace: null,
  pod: null,
  node: null,
  summary: "pipeline check",
  activeAt: "2026-11-04T00:00:00Z",
  expr: "vector(1)",
  labels: {},
};

let clock = 1_000_000;

beforeEach(() => {
  vi.clearAllMocks();
  clock += 10 * OVERVIEW_INTERVAL_MS;
  app.activeCluster = "prod";
  app.kubeconfigPath = "/k";
  prometheus.setEndpoint("prod", endpoint);
  promOverview.range = "1h";
  vi.mocked(prometheusClusterUsage).mockResolvedValue(usage(3600));
  vi.mocked(prometheusAlerts).mockResolvedValue({ alerts: [watchdog], source: "alerts-api" });
});

describe("promOverview (#530)", () => {
  it("loads the cluster history and the alerts, at most every 30 s", async () => {
    // A new scope (another context) forgets the previous test's loads.
    app.activeCluster = "fresh";
    prometheus.setEndpoint("fresh", endpoint);
    await promOverview.load(clock);
    expect(prometheusClusterUsage).toHaveBeenCalledWith("/k", "fresh", endpoint, "1h");
    expect(prometheusAlerts).toHaveBeenCalledWith("/k", "fresh", endpoint);
    expect(promOverview.usage?.end).toBe(3600);
    expect(promOverview.alerts?.map((a) => a.name)).toEqual(["Watchdog"]);

    await promOverview.load(clock + 1_000);
    expect(prometheusClusterUsage).toHaveBeenCalledTimes(1);
    expect(prometheusAlerts).toHaveBeenCalledTimes(1);

    await promOverview.load(clock + OVERVIEW_INTERVAL_MS);
    expect(prometheusClusterUsage).toHaveBeenCalledTimes(2);
    expect(prometheusAlerts).toHaveBeenCalledTimes(2);
  });

  it("reloads the history at once for another range, not the alerts", async () => {
    app.activeCluster = "ranges";
    prometheus.setEndpoint("ranges", endpoint);
    await promOverview.load(clock);
    promOverview.range = "7d";
    await promOverview.load(clock + 1_000);
    expect(prometheusClusterUsage).toHaveBeenLastCalledWith("/k", "ranges", endpoint, "7d");
    expect(promOverview.usageRange).toBe("7d");
    expect(prometheusAlerts).toHaveBeenCalledTimes(1);
  });

  it("clears everything without an endpoint and drops late answers", async () => {
    app.activeCluster = "late";
    prometheus.setEndpoint("late", endpoint);
    let resolve: (v: HostMetrics) => void = () => {};
    vi.mocked(prometheusClusterUsage).mockReturnValue(new Promise((r) => (resolve = r)));
    const pending = promOverview.load(clock);
    prometheus.setEndpoint("late", null);
    await promOverview.load(clock + 1);
    resolve(usage(99));
    await pending;
    expect(promOverview.usage).toBeNull();
    expect(promOverview.alerts).toBeNull();
  });

  it("keeps errors apart", async () => {
    app.activeCluster = "errors";
    prometheus.setEndpoint("errors", endpoint);
    vi.mocked(prometheusAlerts).mockRejectedValue("Prometheus returned 404: not found");
    await promOverview.load(clock);
    expect(promOverview.alertsError).toBe("Prometheus returned 404: not found");
    expect(promOverview.usageError).toBeNull();
    expect(promOverview.usage).not.toBeNull();
  });
});
