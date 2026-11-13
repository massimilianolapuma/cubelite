/**
 * What the resources editor shows, worked out from the core's answers
 * (spec #650 §3.2, §5, §6.2). Pure: the check itself is the core's. Nothing
 * here decides whether a value is allowed; it only turns the facts, what was
 * typed and the evaluation into what the screen needs.
 */
import type { GlyphState } from "#lib/components/ui/StatusGlyph.svelte";
import type {
  BeforeAfter,
  ContainerProposal,
  ContainerResourcesInfo,
  Finding,
  ManagerInfo,
  NodeProjection,
  OverrideInfo,
  ResourceChange,
  ResourceEvaluation,
  ResourceFacts,
  ResourceField,
  ResourceName,
  ResourceProposal,
  ResourceTexts,
  WorkloadFacts,
} from "#lib/tauri.ts";
import { EMPTY } from "#lib/empty.ts";
import { formatBytes, formatCpu } from "#lib/units.ts";

export type FieldKey = `${"cpu" | "memory"}.${"request" | "limit"}`;
/** What is typed, per container: "" is a field left empty. */
export type Drafts = Record<string, Record<FieldKey, string>>;
export interface EditableContainer {
  name: string;
  sidecar: boolean;
  resources: ContainerResourcesInfo;
}

/** The four fields in the order the core lists changes: CPU before memory, request before limit. */
const FIELDS: readonly { key: FieldKey; resource: ResourceName; field: ResourceField }[] = [
  { key: "cpu.request", resource: "cpu", field: "request" },
  { key: "cpu.limit", resource: "cpu", field: "limit" },
  { key: "memory.request", resource: "memory", field: "request" },
  { key: "memory.limit", resource: "memory", field: "limit" },
];

/** The template's regular containers, then its native sidecars. */
export function editableContainers(facts: ResourceFacts): EditableContainer[] {
  return [
    ...facts.workload.containers,
    ...facts.workload.init_containers.filter((c) => c.sidecar),
  ].map(({ name, sidecar, resources }) => ({ name, sidecar, resources }));
}

/** The cluster's text of one field, "" when not set. */
function clusterText(resources: ContainerResourcesInfo, resource: ResourceName, field: ResourceField): string {
  return resources[resource][field]?.text ?? "";
}

/** Each field as the cluster wrote it ("" when not set). */
export function initialDrafts(facts: ResourceFacts): Drafts {
  const drafts: Drafts = {};
  for (const c of editableContainers(facts)) {
    const row = {} as Record<FieldKey, string>;
    for (const { key, resource, field } of FIELDS) row[key] = clusterText(c.resources, resource, field);
    drafts[c.name] = row;
  }
  return drafts;
}

/** A typed value as sent: spaces around it dropped, an empty field null. */
function typed(text: string | undefined): string | null {
  const trimmed = (text ?? "").trim();
  return trimmed === "" ? null : trimmed;
}

/** An adjust proposal listing only the containers whose draft differs from the cluster's text. */
export function buildProposal(facts: ResourceFacts, drafts: Drafts): ResourceProposal {
  const containers: ContainerProposal[] = [];
  for (const c of editableContainers(facts)) {
    const draft = drafts[c.name];
    if (draft === undefined) continue;
    const texts: ResourceTexts = {
      cpu: { request: null, limit: null },
      memory: { request: null, limit: null },
    };
    let changed = false;
    for (const { key, resource, field } of FIELDS) {
      const value = typed(draft[key]);
      texts[resource][field] = value;
      if ((value ?? "") !== clusterText(c.resources, resource, field)) changed = true;
    }
    if (changed) containers.push({ name: c.name, resources: texts });
  }
  return { kind: "adjust", containers };
}

export const RESTORE_PROPOSAL: ResourceProposal = Object.freeze({
  kind: "restore",
  containers: [],
}) as ResourceProposal;

const MI = 1024 * 1024;
const GI = 1024 * MI;
/** A float product a hair above a whole step must not round up to the next one. */
const EPSILON = 1e-9;

function ceilTo(value: number, step: number): number {
  return Math.ceil(value / step - EPSILON) * step;
}

/**
 * The text a quick step writes, or null when the cluster has no readable value
 * for the field. Rounded up to a readable quantity: the next 10m for CPU; for
 * memory the next 16Mi under 1Gi, the next 128Mi from 1Gi.
 */
export function quickStep(
  resource: ResourceName,
  clusterAmount: number | null,
  factor: 1.25 | 1.5 | 2,
): string | null {
  if (clusterAmount === null) return null;
  const raw = clusterAmount * factor;
  if (resource === "cpu") return `${ceilTo(raw, 10)}m`;
  const mebibytes = ceilTo(raw / MI, raw < GI ? 16 : 128);
  return mebibytes % 1024 === 0 ? `${mebibytes / 1024}Gi` : `${mebibytes}Mi`;
}

/** Placeholder of an empty request field: "= limit" when the draft has a limit, else the LimitRange default, else "". */
export function requestHint(
  facts: ResourceFacts,
  drafts: Drafts,
  container: string,
  resource: ResourceName,
): string {
  if (typed(drafts[container]?.[`${resource}.limit`]) !== null) return "= limit";
  if (facts.limit_ranges.state !== "known") return "";
  // As the core reads them: the first Container item with a default, LimitRanges in name order.
  const ranges = [...facts.limit_ranges.value].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const range of ranges) {
    for (const item of range.items) {
      if (item.kind !== "Container") continue;
      const amount = item.default_request[resource];
      if (amount !== null) return `= ${resource === "cpu" ? formatCpu(amount) : formatBytes(amount)}`;
    }
  }
  return "";
}

function fieldLabel(resource: ResourceName, field: ResourceField): string {
  return `${resource === "cpu" ? "CPU" : "Memory"} ${field}`;
}

/** "Memory limit", "CPU request". */
export function changeLabel(change: ResourceChange): string {
  return fieldLabel(change.resource, change.field);
}

/** The rollout in the workload's own terms (spec §3.2 step 2). */
export function rolloutSentence(workload: WorkloadFacts): string {
  const { replicas, rollout } = workload;
  if (replicas <= 0) return "The deployment has no replicas: no pod is replaced now.";
  if (rollout.recreate) {
    return replicas === 1
      ? "The deployment rolls out: the pod stops first, then a new one starts (Recreate)."
      : `The deployment rolls out: all ${replicas} pods stop first, then new ones start (Recreate).`;
  }
  const atATime = Math.min(replicas, Math.max(1, rollout.max_surge + rollout.max_unavailable));
  const pods = replicas === 1 ? "1 pod is replaced" : `${replicas} pods are replaced`;
  return `The deployment rolls out: ${pods} (RollingUpdate, ${atATime} at a time).`;
}

/** The sentence of spec §5 for "What happens". */
export function managerSentence(manager: ManagerInfo): string {
  switch (manager.kind) {
    case "argo_cd":
      return "Argo CD manages this workload. If self-heal is on, it will undo this change at its next sync.";
    case "flux_kustomization":
      return "Flux manages this workload. It will undo this change at its next reconciliation.";
    case "flux_helm_release":
      return "Flux manages this workload through a Helm release. The change stays until the next upgrade of the release, or sooner if drift detection is on.";
    case "helm": {
      const who = manager.release === null ? "A Helm release" : `Helm release \`${manager.release}\``;
      return `${who} manages this workload. The change stays until an upgrade of the release sets these values.`;
    }
    case "possibly_managed":
      return "This workload carries labels that GitOps tools use, but no tool was recognised. If one applies it (Argo CD with label tracking, for example), the change will be undone.";
    case "none":
      return "Nothing that manages this workload was recognised. The change stays until something applies it again.";
  }
}

/** Who manages the workload, for the editor's header line; null when nothing was recognised. */
export function managerLabel(manager: ManagerInfo): string | null {
  switch (manager.kind) {
    case "argo_cd":
      return "managed by Argo CD";
    case "flux_kustomization":
      return "managed by Flux";
    case "flux_helm_release":
      return "managed by Flux (Helm release)";
    case "helm":
      return manager.release === null ? "managed by Helm" : `managed by Helm release \`${manager.release}\``;
    case "possibly_managed":
      return "possibly managed";
    case "none":
      return null;
  }
}

export type FindingLook = { glyph: GlyphState; lead: string | null; strong: boolean };

/** Level to look: a glyph and a weight, never colour alone. */
export function findingLook(finding: Finding): FindingLook {
  switch (finding.level) {
    case "blocked":
      return { glyph: "err", lead: null, strong: true };
    case "warning":
      return { glyph: "warn", lead: null, strong: true };
    case "not_checked":
      // Its message already starts with "Not checked:".
      return { glyph: "unknown", lead: null, strong: false };
    case "note":
      return { glyph: finding.code === "note_fits" ? "ok" : "done", lead: null, strong: false };
  }
}

/** Any warning or not-checked finding: the primary button reads "Apply anyway". */
export function needsConfirmation(evaluation: ResourceEvaluation): boolean {
  return evaluation.findings.some((f) => f.level === "warning" || f.level === "not_checked");
}

export function isBlocked(evaluation: ResourceEvaluation): boolean {
  return evaluation.findings.some((f) => f.level === "blocked");
}

/** The blocked finding on that field of that container, if any. */
export function fieldFinding(
  evaluation: ResourceEvaluation | null,
  container: string,
  key: FieldKey,
): Finding | null {
  if (evaluation === null) return null;
  const [resource, field] = key.split(".") as [ResourceName, ResourceField];
  return (
    evaluation.findings.find(
      (f) =>
        f.level === "blocked" && f.container === container && f.resource === resource && f.field === field,
    ) ?? null
  );
}

export interface NodeRows {
  caption: string;
  hosting: NodeRow[];
  others: NodeRow[];
}
export interface NodeRow {
  name: string;
  ownPods: number;
  schedulable: boolean;
  before: number;
  after: number | null;
}

type Measure = { caption: string; pick: (node: NodeProjection) => BeforeAfter };

const MEMORY_LIMITS: Measure = { caption: "memory limits", pick: (n) => n.memory_limits };

/** The measure a finding is about, or null for a finding that is not about the nodes. */
function measureOf(finding: Finding): Measure | null {
  switch (finding.code) {
    case "w3":
      return {
        caption: "memory, if the pods use their limit",
        pick: (n) => n.memory_if_full ?? n.memory_limits,
      };
    case "w2":
      return MEMORY_LIMITS;
    case "note_cpu_limits":
      return { caption: "CPU limits", pick: (n) => n.cpu_limits };
    case "w0":
    case "w1":
    case "w1r":
      return finding.resource === "cpu"
        ? { caption: "CPU requests", pick: (n) => n.cpu_requests }
        : { caption: "memory requests", pick: (n) => n.memory_requests };
    default:
      return null;
  }
}

/**
 * The node rows: one measure for every node, the one the worst finding about
 * the nodes is about (the findings come worst first), memory limits when no
 * finding is. Null when the projection is empty.
 */
export function nodeRows(evaluation: ResourceEvaluation): NodeRows | null {
  if (evaluation.nodes.length === 0) return null;
  let measure = MEMORY_LIMITS;
  for (const f of evaluation.findings) {
    const m = measureOf(f);
    if (m !== null) {
      measure = m;
      break;
    }
  }
  const rows = evaluation.nodes.map((n): NodeRow => {
    const { before, after } = measure.pick(n);
    return {
      name: n.name,
      ownPods: n.own_pods,
      schedulable: n.schedulable,
      before,
      after: after === before ? null : after,
    };
  });
  return {
    caption: measure.caption,
    hosting: rows.filter((r) => r.ownPods > 0),
    others: rows.filter((r) => r.ownPods <= 0),
  };
}

/** The fields an override changed: original and applied differ as texts. */
export function overrideChanges(
  override: OverrideInfo,
): { container: string; label: string; before: string | null; after: string | null }[] {
  const out: { container: string; label: string; before: string | null; after: string | null }[] = [];
  for (const c of override.containers) {
    for (const { resource, field } of FIELDS) {
      const before = c.original[resource][field];
      const after = c.applied[resource][field];
      if (before !== after) out.push({ container: c.name, label: fieldLabel(resource, field), before, after });
    }
  }
  return out;
}

/**
 * When an override was applied, for its banner: the day, the short month, the
 * hour and the minute in the user's locale ("13 Nov, 12:20"); an empty value
 * for a time that cannot be read. `locale` and `timeZone` are for tests.
 */
export function overrideDate(at: string, locale?: string, timeZone?: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return EMPTY;
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  }).format(date);
}
