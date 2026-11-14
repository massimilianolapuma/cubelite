/** Status → tone mapping shared by tables, pills and drawers. */

import type { GlyphState } from "#lib/components/ui/StatusGlyph.svelte";
import type { ChipDef } from "#lib/status-chips.ts";
import type { DeploymentInfo, PodInfo } from "#lib/tauri.ts";

export type StatusTone = "ok" | "warn" | "err" | "neutral";

export function podTone(pod: PodInfo): StatusTone {
  switch (pod.phase?.toLowerCase()) {
    case "running":
      return pod.ready ? "ok" : "warn";
    case "succeeded":
      // Spec: Running / Available / Succeeded / deployed / healthy → ok.
      return "ok";
    case "pending":
      return "warn";
    case "failed":
    case "error":
    case "crashloopbackoff":
      return "err";
    default:
      return "neutral";
  }
}

/**
 * A pod that is not ready or restarting hard. A completed pod never is: the
 * restarts of a Job that retried and then succeeded are history.
 */
export function needsAttention(p: PodInfo): boolean {
  return p.phase !== "Succeeded" && (!p.ready || p.restarts > 3);
}

/** The shape of a tone (Tonal §6); a tone-less state is the unknown ring. */
export function toneGlyph(tone: StatusTone): GlyphState {
  return tone === "neutral" ? "unknown" : tone;
}

/** Shape of a pod's status cell: a completed pod is finished, not healthy. */
export function podGlyph(pod: PodInfo): GlyphState {
  return pod.phase?.toLowerCase() === "succeeded" ? "done" : toneGlyph(podTone(pod));
}

/**
 * The status chip a pod is counted under. Failing and Pending together are
 * exactly `needsAttention`, so the sidebar's attention count and the two
 * chips always agree: a running pod that is not ready or restarts hard is
 * failing, whatever its phase says.
 */
export function podChip(pod: PodInfo): "err" | "warn" | "ok" | "done" {
  const phase = pod.phase?.toLowerCase();
  if (phase === "succeeded") return "done";
  if (!needsAttention(pod)) return "ok";
  return phase === "pending" ? "warn" : "err";
}

export function podStatusLabel(pod: PodInfo): string {
  if (!pod.phase) return "Unknown";
  if (pod.phase === "Running" && !pod.ready) return "NotReady";
  return pod.phase;
}

export type DeploymentState = "scaled" | "stalled" | "updating" | "available" | "degraded";

/** How far a rollout is: the counts behind its progress text. */
export type RolloutProgress = {
  /** False while the controller has not picked up the latest change. */
  observed: boolean;
  desired: number;
  updated: number;
  /** Pods of the old template still running. */
  old: number;
  available: number;
};

export type DeploymentStatus = {
  state: DeploymentState;
  /** The state's word: the panel's hero. */
  label: string;
  /** The row's badge: the word with the rollout's progress ("Updating 1/2"), short enough for the narrowest Status column. */
  badge: string;
  /** Sort, chips, group markers and the Overview read this: neutral is not a problem. */
  tone: StatusTone;
  /** The badge's shape; a healthy rollout is healthy, scaled to 0 is at rest. */
  glyph: GlyphState;
  /** Updated replicas of desired ("1/2") while a seen rollout runs or stalls; null otherwise. */
  progress: string | null;
  /** What the label leaves out: the hero's reason. Null when Available. */
  detail: string | null;
  /** The label with its detail, one sentence: the row's tooltip. */
  title: string;
  /** Null when no rollout runs or stalls. */
  rollout: RolloutProgress | null;
};

const replicaWord = (n: number) => (n === 1 ? "replica" : "replicas");

function rolloutOf(dep: DeploymentInfo): RolloutProgress {
  // A payload without the counts (an older core, a fixture) reads as settled.
  const generation = dep.generation ?? 0;
  const updated = dep.updated_replicas ?? dep.replicas;
  const total = dep.total_replicas ?? updated;
  return {
    observed: (dep.observed_generation ?? generation) >= generation,
    desired: dep.replicas,
    updated,
    old: Math.max(0, total - updated),
    available: dep.available_replicas ?? updated,
  };
}

/** A step left, in `kubectl rollout status` order: not seen yet, replicas to update, old ones to retire, updated ones not available. */
function rolloutRunning(r: RolloutProgress): boolean {
  return !r.observed || r.updated < r.desired || r.old > 0 || r.available < r.updated;
}

/** How far the rollout is, as updated of desired; the step left is in the sentence. */
function rolloutFraction(r: RolloutProgress): string | null {
  if (!r.observed || r.desired === 0) return null;
  return `${Math.min(r.updated, r.desired)}/${r.desired}`;
}

function rolloutSentence(r: RolloutProgress): string {
  if (!r.observed) return "The controller has not picked up the change yet";
  const parts = [`${r.updated} of ${r.desired} updated`];
  if (r.old > 0) parts.push(`${r.old} old ${replicaWord(r.old)} still running`);
  parts.push(r.available <= r.desired ? `${r.available} of ${r.desired} available` : `${r.available} available`);
  return parts.join(", ");
}

/**
 * A deployment's state (#660), in the order `kubectl rollout status` checks:
 * scaled to 0; a change the controller has not seen yet; a rollout past its
 * progress deadline (stalled); fewer replicas updated than desired, old
 * replicas still running, updated replicas not available yet (a rollout);
 * otherwise settled. A rollout that keeps every desired replica available is
 * neutral, not a problem; one short of replicas is a warning.
 */
export function deploymentStatus(dep: DeploymentInfo): DeploymentStatus {
  const s = deploymentState(dep);
  const detail = s.detail && /^[A-Z][a-z]/.test(s.detail) ? s.detail[0].toLowerCase() + s.detail.slice(1) : s.detail;
  return {
    ...s,
    badge: s.progress ? `${s.label} ${s.progress}` : s.label,
    title: detail ? `${s.label}: ${detail}` : s.label,
  };
}

function deploymentState(dep: DeploymentInfo): Omit<DeploymentStatus, "title" | "badge"> {
  const r = rolloutOf(dep);
  const settled = { progress: null, rollout: null } as const;
  if (dep.replicas === 0 && dep.ready_replicas === 0 && r.updated + r.old === 0) {
    return { state: "scaled", label: "Scaled to 0", tone: "neutral", glyph: "done", detail: "No replicas requested, none running", ...settled };
  }
  const progressing = dep.conditions.find((c) => c.condition_type === "Progressing");
  if (r.observed && progressing?.reason === "ProgressDeadlineExceeded") {
    return {
      state: "stalled",
      label: "Stalled",
      tone: "err",
      glyph: "err",
      progress: rolloutFraction(r),
      detail: `Progress deadline exceeded with ${rolloutSentence(r)}`,
      rollout: r,
    };
  }
  // Updated replicas short of available after the controller declared the
  // rollout complete is a pod that failed since, not a rollout. Only once the
  // status is observed: before that the condition is the last rollout's.
  const completed = r.observed && progressing?.reason === "NewReplicaSetAvailable" && r.updated >= r.desired && r.old === 0;
  if (rolloutRunning(r) && !completed) {
    const short = r.available < r.desired;
    return {
      state: "updating",
      label: "Updating",
      tone: short ? "warn" : "neutral",
      glyph: short ? "warn" : "ok",
      progress: rolloutFraction(r),
      detail: rolloutSentence(r),
      rollout: r,
    };
  }
  if (dep.ready_replicas >= dep.replicas) {
    return { state: "available", label: "Available", tone: "ok", glyph: "ok", detail: null, ...settled };
  }
  return {
    state: "degraded",
    label: "Degraded",
    tone: "warn",
    glyph: "warn",
    detail: `${dep.ready_replicas} of ${dep.replicas} replicas ready`,
    ...settled,
  };
}

/** The status chip a deployment counts under: a rollout short of replicas is Degraded. */
export function deploymentChip(dep: DeploymentInfo): DeploymentState {
  const s = deploymentStatus(dep);
  return s.tone === "warn" ? "degraded" : s.state;
}

/** Stalled or short of replicas: what the Overview counts as degraded. */
export function deploymentProblem(dep: DeploymentInfo): boolean {
  const tone = deploymentStatus(dep).tone;
  return tone === "warn" || tone === "err";
}

// Tones for the Status sort (#496): problems sort first.

export function replicaTone(replicas: number, ready: number): StatusTone {
  return replicas > 0 && ready >= replicas ? "ok" : "warn";
}

export function nodeTone(status: string): StatusTone {
  return status === "Ready" ? "ok" : "err";
}

/** Mirrors the PVC row colour: Bound ok, Lost err, anything else warn. */
export function pvcTone(status: string | null): StatusTone {
  if (status === "Bound") return "ok";
  if (status === "Lost") return "err";
  return "warn";
}

/**
 * One mapping for the Helm status pill, the Status sort and the namespace
 * group marker (#547): deployed / superseded → ok, pending-* → warn,
 * failed / unknown → err, anything else (uninstalling, …) neutral.
 */
export function helmTone(status: string | null): StatusTone {
  const s = status?.toLowerCase() ?? "";
  if (s === "deployed" || s === "superseded") return "ok";
  if (s.startsWith("pending")) return "warn";
  if (s === "failed" || s === "unknown") return "err";
  return "neutral";
}

/** Chips of each list with a status column, worst first (Tonal §8.1). */
export const STATUS_CHIPS = {
  pods: [
    { key: "err", label: "Failing", state: "err" },
    { key: "warn", label: "Pending", state: "warn" },
    { key: "ok", label: "Running", state: "ok" },
    { key: "done", label: "Completed", state: "done" },
  ],
  replicas: [
    { key: "warn", label: "Progressing", state: "warn" },
    { key: "ok", label: "Available", state: "ok" },
  ],
  // Keys are `deploymentChip`'s; a healthy rollout and one scaled to 0 have
  // their own chip, apart from the problems (#660).
  deployments: [
    { key: "stalled", label: "Stalled", state: "err" },
    { key: "degraded", label: "Degraded", state: "warn" },
    { key: "updating", label: "Updating", state: "ok" },
    { key: "available", label: "Available", state: "ok" },
    { key: "scaled", label: "Scaled to 0", state: "done" },
  ],
  pvcs: [
    { key: "err", label: "Lost", state: "err" },
    { key: "warn", label: "Pending", state: "warn" },
    { key: "ok", label: "Bound", state: "ok" },
  ],
  helm: [
    { key: "err", label: "Failed", state: "err" },
    { key: "warn", label: "Pending", state: "warn" },
    { key: "ok", label: "Deployed", state: "ok" },
    { key: "neutral", label: "Other", state: "unknown" },
  ],
  nodes: [
    { key: "err", label: "Not ready", state: "err" },
    { key: "ok", label: "Ready", state: "ok" },
  ],
  events: [
    { key: "warning", label: "Warning", state: "warn" },
    { key: "normal", label: "Normal" },
  ],
} as const satisfies Record<string, readonly ChipDef[]>;
