/**
 * What the aggregated Logs view shows (#529): every pod in the namespace
 * scope, or one workload's pods, and the Elasticsearch history query that
 * matches it. Plain (non-reactive) helpers, kept out of the `.svelte.ts`
 * stores.
 */
import type { Workload } from "#lib/tauri.ts";

/** Workloads the Logs view can narrow to (one pod opens the log panel instead). */
export type ScopedWorkload = Exclude<Workload, { kind: "pod" }>;

/** A workload in its namespace. */
export type LogScope = { namespace: string; workload: ScopedWorkload };

/**
 * What a history search covers: one pod (a name), a workload's pods, or the
 * whole namespace (`null`).
 */
export type HistoryTarget = string | Workload | null;

/** History query of the Logs view's filter, or why History cannot express it. */
export type HistoryMapping =
  | { namespace: string; target: Workload | null; reason: null }
  | { namespace: null; target: null; reason: string };

export const SELECTOR_HISTORY_HINT = "History can't filter by label selector: clear it to search Elasticsearch";
export const NAMESPACE_HISTORY_HINT = "Pick a namespace (or a workload) to search its history";

/** Kind labels, as the picker and the scope chip show them. */
const KIND_LABELS: Record<ScopedWorkload["kind"], string> = {
  deployment: "Deployment",
  "stateful-set": "StatefulSet",
  "daemon-set": "DaemonSet",
  job: "Job",
};

export function kindLabel(kind: ScopedWorkload["kind"]): string {
  return KIND_LABELS[kind];
}

/** Stable key of a scope (picker values, history identity). */
export function scopeKey(scope: LogScope): string {
  return `${scope.workload.kind}:${scope.namespace}/${scope.workload.name}`;
}

/**
 * Maps the Logs view's filter to a history query: a workload's pods, else
 * the selected namespace. A label selector has no Elasticsearch equivalent
 * (labels are stored dedotted, per shipper), and every namespace at once is
 * too broad a search.
 */
export function logsHistoryMapping(
  namespace: string | null,
  scope: LogScope | null,
  selector: string,
): HistoryMapping {
  if (selector.trim()) return { namespace: null, target: null, reason: SELECTOR_HISTORY_HINT };
  if (scope) return { namespace: scope.namespace, target: scope.workload, reason: null };
  if (!namespace) return { namespace: null, target: null, reason: NAMESPACE_HISTORY_HINT };
  return { namespace, target: null, reason: null };
}

/** Alphabet of generated name suffixes (Kubernetes' `SafeEncodeString`). */
const SAFE = "[bcdfghjklmnpqrstvwxz2456789]";
/** Generated names are cut to 58 characters before the 5-character suffix. */
const GENERATED_PREFIX_MAX = 58;

/**
 * Digits of an Indexed Job's completion index (`name-<index>-<suffix>`).
 * Capped at 7 so a CronJob's pods (`backup-28000000-x7k2p`, an 8-digit
 * scheduled minute) stay out of the Job `backup` — see the core.
 */
const JOB_INDEX_DIGITS_MAX = 7;

function literal(name: string): string {
  return name.replace(/[\\.+*?()|[\]{}^$]/g, "\\$&");
}

/** A Job's pods, indexed or not, with Kubernetes' cuts — the core's `job_pods_regex`. */
function jobPodsSource(name: string): string {
  if (name.length + JOB_INDEX_DIGITS_MAX + 2 <= GENERATED_PREFIX_MAX) {
    return `${literal(name)}-([0-9]{1,${JOB_INDEX_DIGITS_MAX}}-)?${SAFE}{5}`;
  }
  const alternatives = [literal(`${name}-`.slice(0, GENERATED_PREFIX_MAX))];
  const kept = (digits: number) => Math.min(name.length, GENERATED_PREFIX_MAX - digits - 2);
  let digits = 1;
  while (digits <= JOB_INDEX_DIGITS_MAX) {
    let last = digits;
    while (last < JOB_INDEX_DIGITS_MAX && kept(last + 1) === kept(digits)) last++;
    alternatives.push(`${literal(name.slice(0, kept(digits)))}-[0-9]{${digits},${last}}-`);
    digits = last + 1;
  }
  return `(${alternatives.join("|")})${SAFE}{5}`;
}

/**
 * Regexp source of a workload's pod names — the core's
 * `workload_pods_regex`, used here to pick the live pods of a scope.
 */
export function workloadPodsSource(workload: ScopedWorkload): string {
  const { name } = workload;
  switch (workload.kind) {
    case "deployment":
      return name.length + 12 <= GENERATED_PREFIX_MAX
        ? `${literal(name)}-${SAFE}{6,10}-${SAFE}{5}`
        : `${literal(name.slice(0, GENERATED_PREFIX_MAX))}(-${SAFE}{0,10}-?)?${SAFE}{5}`;
    case "stateful-set":
      return `${literal(name)}-[0-9]+`;
    case "job":
      return jobPodsSource(name);
    default:
      return `${literal(`${name}-`.slice(0, GENERATED_PREFIX_MAX))}${SAFE}{5}`;
  }
}

/** Predicate: whether a pod belongs to the scope's workload (in its namespace). */
export function scopeMatcher(scope: LogScope): (pod: { namespace: string; name: string }) => boolean {
  const pods = new RegExp(`^(?:${workloadPodsSource(scope.workload)})$`);
  return (pod) => pod.namespace === scope.namespace && pods.test(pod.name);
}
