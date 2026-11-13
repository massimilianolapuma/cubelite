/**
 * Display rows for a container's CPU and memory: its request and limit as the
 * cluster wrote them, and what it uses now against the limit (#652).
 */
import type {
  ContainerResourcesInfo,
  ContainerUsageInfo,
  PodMetricsInfo,
  ResourcePairInfo,
} from "#lib/tauri.ts";
import { formatBytes, formatCpu, percentOf } from "#lib/units.ts";

export type ResourceRow = {
  resource: "cpu" | "memory";
  /** "CPU" | "MEM", as the pod panel's meters are labelled today. */
  label: "CPU" | "MEM";
  /** 0–100 when a limit with an amount above 0 and a usage sample exist, else null. */
  percent: number | null;
  /** True when the container has a limit: the row is a meter (possibly empty). */
  meter: boolean;
  /** The sentence beside or under the meter. */
  detail: string;
};

export type ContainerRows = {
  name: string;
  sidecar: boolean;
  rows: readonly [ResourceRow, ResourceRow];
};

type ContainerLike = { name: string; sidecar?: boolean; resources?: ContainerResourcesInfo };

const RESOURCES = [
  { resource: "cpu", label: "CPU", used: (c: ContainerUsageInfo) => c.cpu_millis, format: formatCpu },
  {
    resource: "memory",
    label: "MEM",
    used: (c: ContainerUsageInfo) => c.memory_bytes,
    format: formatBytes,
  },
] as const;

/** The highest sample of one container across the given pods, or null when none has one. */
function highest(
  name: string,
  podMetrics: readonly (PodMetricsInfo | null)[],
  used: (c: ContainerUsageInfo) => number,
): number | null {
  let max: number | null = null;
  for (const pod of podMetrics) {
    for (const sample of pod?.containers ?? []) {
      if (sample.name !== name) continue;
      const value = used(sample);
      if (max === null || value > max) max = value;
    }
  }
  return max;
}

function row(
  spec: (typeof RESOURCES)[number],
  pair: ResourcePairInfo,
  used: number | null,
): ResourceRow {
  const request = pair.request ? `request ${pair.request.text}` : "no request";
  const limit = pair.limit;
  let detail: string;
  if (limit) {
    detail =
      used === null
        ? `limit ${limit.text} · ${request}`
        : `${spec.format(used)} of ${limit.text} · ${request}`;
  } else {
    detail =
      used === null ? `${request} · no limit` : `${spec.format(used)} used · ${request} · no limit`;
  }
  const percent =
    limit && limit.amount !== null && used !== null ? percentOf(used, limit.amount) : null;
  return { resource: spec.resource, label: spec.label, percent, meter: limit !== null, detail };
}

/** Rows for each container that has a `resources` field; usage is the highest of the given pods. */
export function containerRows(
  containers: readonly ContainerLike[],
  podMetrics: readonly (PodMetricsInfo | null)[],
): ContainerRows[] {
  const out: ContainerRows[] = [];
  for (const c of containers) {
    const resources = c.resources;
    if (!resources) continue;
    const [cpu, memory] = RESOURCES.map((spec) =>
      row(spec, resources[spec.resource], highest(c.name, podMetrics, spec.used)),
    );
    out.push({ name: c.name, sidecar: c.sidecar === true, rows: [cpu, memory] });
  }
  return out;
}
