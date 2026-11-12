import { describe, expect, it } from "vitest";
import {
  CLUSTER_PANELS,
  NODE_PANELS,
  alertSubject,
  alertTarget,
  alertTone,
  firingBadge,
  firingSince,
  isInformational,
  panelError,
  panelLines,
  panelQueries,
  panelSource,
  panelSummary,
} from "./host-metrics";
import type { Alert, HostChart, HostMetrics, MetricSource, PodInfo } from "./tauri";

function metrics(charts: Partial<Record<HostChart, { value?: number; source?: MetricSource | null; error?: string }>>): HostMetrics {
  return {
    start: 0,
    end: 3600,
    step: 15,
    charts: Object.entries(charts).map(([chart, c]) => ({
      chart: chart as HostChart,
      source: c.source === undefined ? "cadvisor" : c.source,
      query: `q-${chart}`,
      series: c.value === undefined ? [] : [{ label: "", points: [[0, c.value / 2], [3600, c.value]] }],
      error: c.error ?? null,
    })),
  };
}

const [CPU, MEMORY] = CLUSTER_PANELS;
const NETWORK = NODE_PANELS.find((p) => p.title === "Network")!;
const FILESYSTEM = NODE_PANELS.find((p) => p.title === "Filesystem")!;

describe("host panels (#530)", () => {
  it("draws usage against the dashed allocatable line", () => {
    const result = metrics({ cpu: { value: 0.5 }, "cpu-allocatable": { value: 4, source: "kube-state-metrics" } });
    const lines = panelLines(result, CPU);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ label: "", color: "var(--color-data-1)" });
    expect(lines[0].dashed).toBeFalsy();
    expect(lines[1]).toMatchObject({ label: "alloc", dashed: true, color: "var(--color-text-subtle)" });
    expect(panelSummary(result, CPU)).toBe("500m / alloc 4");
    expect(panelQueries(result, CPU)).toEqual(["q-cpu", "q-cpu-allocatable"]);
    expect(panelSource(result, CPU)).toBe("from cAdvisor");
  });

  it("names a node-exporter reference capacity, not allocatable", () => {
    const result = metrics({
      cpu: { value: 0.5, source: "node-exporter" },
      "cpu-allocatable": { value: 4, source: "node-exporter" },
    });
    expect(panelLines(result, CPU)[1].label).toBe("capacity");
    expect(panelSummary(result, CPU)).toBe("500m / capacity 4");
    // No reference for the winning exporter: usage alone.
    const alone = metrics({ cpu: { value: 0.5 }, "cpu-allocatable": { source: null } });
    expect(panelLines(alone, CPU)).toHaveLength(1);
    expect(panelSummary(alone, CPU)).toBe("500m");
  });

  it("summarises memory, network and missing values", () => {
    const result = metrics({
      memory: { value: 1073741824 },
      "network-rx": { value: 2048, source: "node-exporter" },
      "network-tx": { value: 1024, source: "node-exporter" },
    });
    expect(panelSummary(result, MEMORY)).toBe("1Gi");
    expect(panelSummary(result, NETWORK)).toBe("↓ 2Ki/s ↑ 1Ki/s");
    expect(panelLines(result, NETWORK).map((l) => l.label)).toEqual(["rx", "tx"]);
    expect(panelSource(result, NETWORK)).toBe("from node-exporter");
    expect(panelSummary(metrics({}), CPU)).toBe("—");
  });

  it("says why a chart is empty", () => {
    const missing = metrics({ filesystem: { source: null }, "filesystem-capacity": { source: null } });
    expect(panelLines(missing, FILESYSTEM)).toEqual([]);
    expect(panelSource(missing, FILESYSTEM)).toBeNull();
    expect(FILESYSTEM.emptyText).toContain("node-exporter or cAdvisor");
    const failed = metrics({ cpu: { error: "Prometheus returned 422: boom" } });
    expect(panelError(failed, CPU)).toBe("Prometheus returned 422: boom");
    expect(panelError(metrics({ cpu: { value: 1 } }), CPU)).toBeNull();
  });
});

function alert(overrides: Partial<Alert>): Alert {
  return {
    name: "KubePodCrashLooping",
    severity: "warning",
    namespace: null,
    pod: null,
    node: null,
    summary: null,
    activeAt: null,
    expr: "x > 0",
    labels: {},
    ...overrides,
  };
}

const pod = { name: "api-0", namespace: "shop" } as PodInfo;

describe("alerts (#530)", () => {
  it("colours severities", () => {
    expect(alertTone("critical")).toBe("err");
    expect(alertTone("Warning")).toBe("warn");
    expect(alertTone("none")).toBe("neutral");
    expect(alertTone(null)).toBe("neutral");
  });

  it("names and resolves what the alert is about", () => {
    const onPod = alert({ namespace: "shop", pod: "api-0" });
    expect(alertSubject(onPod)).toBe("shop/api-0");
    expect(alertTarget(onPod, [pod], [])).toEqual({ kind: "pod", pod });
    // A pod that is not loaded (another namespace) has no link.
    expect(alertTarget(alert({ namespace: "kube-system", pod: "etcd-0" }), [pod], [])).toBeNull();
    const onNode = alert({ node: "minikube" });
    expect(alertSubject(onNode)).toBe("minikube");
    expect(alertTarget(onNode, [], ["minikube"])).toEqual({ kind: "node", name: "minikube" });
    // A node the cluster does not list (gone, or another cluster's) has no link.
    expect(alertTarget(onNode, [], ["other"])).toBeNull();
    expect(alertSubject(alert({ namespace: "kube-system" }))).toBe("kube-system");
    expect(alertSubject(alert({}))).toBeNull();
    expect(alertTarget(alert({}), [pod], [])).toBeNull();
  });

  it("keeps informational alerts out of the firing badge", () => {
    const watchdog = alert({ name: "Watchdog", severity: "none" });
    expect(isInformational(watchdog)).toBe(true);
    expect(isInformational(alert({}))).toBe(false);
    expect(firingBadge([watchdog])).toEqual({ count: 0, tone: "warn", severities: "" });
    expect(firingBadge([watchdog, alert({})])).toEqual({ count: 1, tone: "warn", severities: "1 warning" });
    expect(firingBadge([alert({ severity: "critical" }), alert({})])).toEqual({
      count: 2,
      tone: "err",
      severities: "1 critical, 1 warning",
    });
    expect(firingBadge(null).count).toBe(0);
  });

  it("splits the firing badge by severity, most severe first (#566)", () => {
    const alerts = [
      alert({}),
      alert({ severity: null }),
      alert({ severity: "Warning" }),
      alert({ severity: "info" }),
      alert({ severity: "critical" }),
      alert({ severity: "warning" }),
      alert({ name: "Watchdog", severity: "none" }),
    ];
    expect(firingBadge(alerts)).toEqual({
      count: 6,
      tone: "err",
      severities: "1 critical, 3 warning, 1 info, 1 no severity",
    });
  });

  it("tells how long it has been firing", () => {
    const now = new Date("2026-11-04T12:00:00Z");
    expect(firingSince("2026-11-04T09:00:00Z", now)).toBe("firing 3h");
    expect(firingSince(null, now)).toBe("firing");
  });
});
