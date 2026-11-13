/**
 * Display rows for a container's CPU and memory: its request and limit as the
 * cluster wrote them, and what it uses now against the limit (#652).
 */
import type {
  ContainerResourcesInfo,
  ContainerUsageInfo,
  PodMetricsInfo,
  QuantityInfo,
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

/** One pod: what its containers run with, and its metrics (null without a sample). */
export type PodUsage = {
  containers?: readonly { name: string; resources?: ContainerResourcesInfo }[];
  metrics: PodMetricsInfo | null;
};

const RESOURCES = [
  { resource: "cpu", label: "CPU", used: (c: ContainerUsageInfo) => c.cpu_millis, format: formatCpu },
  {
    resource: "memory",
    label: "MEM",
    used: (c: ContainerUsageInfo) => c.memory_bytes,
    format: formatBytes,
  },
] as const;

/** Same limit: both without one, or both with the same amount (the same text when unreadable). */
function sameLimit(a: QuantityInfo | null, b: QuantityInfo | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.amount !== null && b.amount !== null) return a.amount === b.amount;
  return a.amount === b.amount && a.text === b.text;
}

/**
 * The pods whose own container `name` runs with the template's limit for
 * `resource`: a pod of an older ReplicaSet, or of another workload the
 * selector also matches, measures against another limit and does not count.
 */
function countedPods(
  name: string,
  resource: "cpu" | "memory",
  limit: QuantityInfo | null,
  pods: readonly PodUsage[],
): PodUsage[] {
  return pods.filter((pod) => {
    const own = pod.containers?.find((c) => c.name === name)?.resources;
    return own !== undefined && sameLimit(own[resource].limit, limit);
  });
}

/** The highest sample of one container across the given pods, or null when none has one. */
function highest(
  name: string,
  pods: readonly PodUsage[],
  used: (c: ContainerUsageInfo) => number,
): number | null {
  let max: number | null = null;
  for (const pod of pods) {
    for (const sample of pod.metrics?.containers ?? []) {
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
  sampleMissing: boolean,
): ResourceRow {
  // A request or a limit is written in the used value's unit, so the three
  // numbers read together ("954Mi of 954Mi", not "954Mi of 1G"); the
  // cluster's own text only when it could not be read.
  const shown = (q: QuantityInfo) => (q.amount === null ? q.text : spec.format(q.amount));
  const request = pair.request ? `request ${shown(pair.request)}` : "no request";
  const limit = pair.limit;
  let detail: string;
  if (limit) {
    detail =
      used === null
        ? `limit ${shown(limit)} · ${request}`
        : `${spec.format(used)} of ${shown(limit)} · ${request}`;
  } else {
    detail =
      used === null ? `${request} · no limit` : `${spec.format(used)} used · ${request} · no limit`;
  }
  // A sample was expected and none came (just started, crashing): said in
  // words, so an empty track does not read as a value.
  if (sampleMissing) detail = `no sample · ${detail}`;
  const percent =
    limit && limit.amount !== null && used !== null ? percentOf(used, limit.amount) : null;
  return { resource: spec.resource, label: spec.label, percent, meter: limit !== null, detail };
}

/**
 * Rows for each container that has a `resources` field. Usage is the highest
 * among the given pods that run the container with the template's limit.
 * With `expectSample` (pod metrics answered), a row with no sample from any
 * such pod says `no sample`; without such a pod there is nothing to measure.
 */
export function containerRows(
  containers: readonly ContainerLike[],
  pods: readonly PodUsage[],
  { expectSample = false }: { expectSample?: boolean } = {},
): ContainerRows[] {
  const out: ContainerRows[] = [];
  for (const c of containers) {
    const resources = c.resources;
    if (!resources) continue;
    const [cpu, memory] = RESOURCES.map((spec) => {
      const pair = resources[spec.resource];
      const counted = countedPods(c.name, spec.resource, pair.limit, pods);
      const used = highest(c.name, counted, spec.used);
      return row(spec, pair, used, expectSample && counted.length > 0 && used === null);
    });
    out.push({ name: c.name, sidecar: c.sidecar === true, rows: [cpu, memory] });
  }
  return out;
}
