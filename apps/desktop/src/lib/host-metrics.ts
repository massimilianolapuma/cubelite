/**
 * Pure helpers of the cluster history (Overview), a node's Metrics section
 * and the Overview's alerts (#530). The charts come from
 * `prometheus_cluster_usage` / `prometheus_node_metrics`, each from the
 * first exporter that has data (node-exporter, else cAdvisor).
 */
import { formatAge } from "#lib/age.ts";
import { formatValue, latest, REFERENCE_COLOR, seriesStyle, type ChartLine, type Unit } from "#lib/metrics.ts";
import type { StatusTone } from "#lib/status.ts";
import type { Alert, HostChart, HostChartData, HostMetrics, MetricSource, PodInfo } from "#lib/tauri.ts";
import { EMPTY } from "./empty";

/** What a panel shows: usage lines and an optional dashed reference line. */
export type HostPanel = {
  title: string;
  unit: Unit;
  /** One line per chart, labelled with `labels` (same order). */
  usage: HostChart[];
  labels?: string[];
  reference?: HostChart;
  /**
   * Name of the reference in the summary ("capacity", "size"); "alloc"
   * when it comes from kube-state-metrics (allocatable).
   */
  referenceLabel?: string;
  emptyText: string;
};

export const CLUSTER_HINT = "Cluster CPU and memory history and firing alerts from Prometheus.";
export const NODE_METRICS_HINT = "CPU, memory, pods, network and filesystem history from Prometheus.";
const NEEDS_CADVISOR = "no data: needs cAdvisor metrics in Prometheus";
const NEEDS_KSM = "not available: needs kube-state-metrics or kubelet metrics in Prometheus";
const NEEDS_EXPORTER = "not available: needs node-exporter or cAdvisor metrics for this node";

const CPU: HostPanel = {
  title: "CPU",
  unit: "cores",
  usage: ["cpu"],
  reference: "cpu-allocatable",
  referenceLabel: "capacity",
  emptyText: NEEDS_CADVISOR,
};
const MEMORY: HostPanel = {
  title: "Memory",
  unit: "bytes",
  usage: ["memory"],
  reference: "memory-allocatable",
  referenceLabel: "capacity",
  emptyText: NEEDS_CADVISOR,
};

export const CLUSTER_PANELS: HostPanel[] = [CPU, MEMORY];

export const NODE_PANELS: HostPanel[] = [
  { ...CPU, emptyText: NEEDS_EXPORTER },
  { ...MEMORY, emptyText: NEEDS_EXPORTER },
  { title: "Pods", unit: "count", usage: ["pods"], emptyText: NEEDS_KSM },
  {
    title: "Network",
    unit: "bytes-per-second",
    usage: ["network-rx", "network-tx"],
    labels: ["rx", "tx"],
    emptyText: NEEDS_EXPORTER,
  },
  {
    title: "Filesystem",
    unit: "bytes",
    usage: ["filesystem"],
    reference: "filesystem-capacity",
    referenceLabel: "size",
    emptyText: NEEDS_EXPORTER,
  },
];

export function hostData(result: HostMetrics, chart: HostChart): HostChartData | null {
  return result.charts.find((c) => c.chart === chart) ?? null;
}

function latestOf(result: HostMetrics, chart: HostChart): number | null {
  const series = hostData(result, chart)?.series[0];
  return series ? latest(series.points) : null;
}

/** The reference's name: "alloc" from kube-state-metrics, else the panel's. */
export function referenceLabel(result: HostMetrics, panel: HostPanel): string {
  const source = panel.reference ? hostData(result, panel.reference)?.source : null;
  return source === "kube-state-metrics" ? "alloc" : (panel.referenceLabel ?? "");
}

/** Usage lines plus the dashed reference. */
export function panelLines(result: HostMetrics, panel: HostPanel): ChartLine[] {
  const lines: ChartLine[] = panel.usage.flatMap((chart, i) =>
    (hostData(result, chart)?.series ?? []).map((s) => ({
      label: panel.labels?.[i] ?? "",
      ...seriesStyle(i),
      points: s.points,
    })),
  );
  const ref = panel.reference ? hostData(result, panel.reference)?.series[0] : undefined;
  if (ref) {
    lines.push({ label: referenceLabel(result, panel), color: REFERENCE_COLOR, points: ref.points, dashed: true });
  }
  return lines;
}

/** "250m / alloc 4", or "↓ 1Ki/s ↑ 2Ki/s" for network. */
export function panelSummary(result: HostMetrics, panel: HostPanel): string {
  const fmt = (v: number | null) => (v === null ? EMPTY : formatValue(v, panel.unit));
  if (panel.usage.length === 2) {
    return `↓ ${fmt(latestOf(result, panel.usage[0]))} ↑ ${fmt(latestOf(result, panel.usage[1]))}`;
  }
  const parts = [fmt(latestOf(result, panel.usage[0]))];
  const ref = panel.reference ? latestOf(result, panel.reference) : null;
  if (ref !== null) parts.push(`${referenceLabel(result, panel)} ${fmt(ref)}`);
  return parts.join(" / ");
}

/** The usage charts' error (the reference is optional). */
export function panelError(result: HostMetrics, panel: HostPanel): string | null {
  return panel.usage.map((c) => hostData(result, c)?.error).find((e) => e) ?? null;
}

/** Every query of the panel (Open in Grafana). */
export function panelQueries(result: HostMetrics, panel: HostPanel): string[] {
  return [...panel.usage, ...(panel.reference ? [panel.reference] : [])]
    .map((c) => hostData(result, c)?.query)
    .filter((q): q is string => !!q);
}

const SOURCE_NAMES: Record<MetricSource, string> = {
  "node-exporter": "node-exporter",
  cadvisor: "cAdvisor",
  "kube-state-metrics": "kube-state-metrics",
  kubelet: "kubelet",
};

/** "from node-exporter" for the panel's first usage chart, when known. */
export function panelSource(result: HostMetrics, panel: HostPanel): string | null {
  const source = hostData(result, panel.usage[0])?.source;
  return source ? `from ${SOURCE_NAMES[source]}` : null;
}

// ── Alerts ──────────────────────────────────────────────────────────────

/** Status tone of a severity: critical/error red, warning amber, else neutral. */
export function alertTone(severity: string | null): StatusTone {
  switch (severity?.toLowerCase()) {
    case "critical":
    case "page":
    case "error":
    case "high":
      return "err";
    case "warning":
    case "warn":
      return "warn";
    default:
      return "neutral";
  }
}

/** What the alert is about: `namespace/pod`, the node, or the namespace. */
export function alertSubject(alert: Alert): string | null {
  if (alert.namespace && alert.pod) return `${alert.namespace}/${alert.pod}`;
  if (alert.node) return alert.node;
  return alert.namespace;
}

/** The resource an alert row opens: a loaded pod, or a node by name. */
export type AlertTarget = { kind: "pod"; pod: PodInfo } | { kind: "node"; name: string };

/** A loaded pod, or a node of the loaded node list; else no link. */
export function alertTarget(alert: Alert, pods: PodInfo[], nodes: string[]): AlertTarget | null {
  if (alert.namespace && alert.pod) {
    const pod = pods.find((p) => p.namespace === alert.namespace && p.name === alert.pod);
    if (pod) return { kind: "pod", pod };
  }
  return alert.node && nodes.includes(alert.node) ? { kind: "node", name: alert.node } : null;
}

/**
 * `severity="none"` (Watchdog, InfoInhibitor): listed last and muted, and
 * never counted in the firing badge.
 */
export function isInformational(alert: Alert): boolean {
  return alert.severity?.toLowerCase() === "none";
}

const TONE_RANK: Record<StatusTone, number> = { err: 0, warn: 1, ok: 2, neutral: 2 };

/**
 * The firing badge: actionable alerts only, red with a critical one, else
 * amber, with the split by severity ("1 critical, 3 warning"), most severe
 * first and alerts without a severity last (#566).
 */
export function firingBadge(alerts: Alert[] | null): { count: number; tone: StatusTone; severities: string } {
  const actionable = (alerts ?? []).filter((a) => !isInformational(a));
  const counts = new Map<string, number>();
  for (const a of actionable) {
    const key = a.severity?.toLowerCase() ?? "";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const rank = (severity: string) => (severity === "" ? 3 : TONE_RANK[alertTone(severity)]);
  const severities = [...counts]
    .sort(([a], [b]) => rank(a) - rank(b))
    .map(([severity, n]) => `${n} ${severity || "no severity"}`)
    .join(", ");
  return {
    count: actionable.length,
    tone: actionable.some((a) => alertTone(a.severity) === "err") ? "err" : "warn",
    severities,
  };
}

/** "firing 3h" from `activeAt`, or "firing" when the source has no time. */
export function firingSince(activeAt: string | null, now: Date = new Date()): string {
  return activeAt ? `firing ${formatAge(activeAt, now)}` : "firing";
}
