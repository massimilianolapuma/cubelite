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

export function deploymentStatus(dep: DeploymentInfo): {
  label: string;
  tone: StatusTone;
} {
  if (dep.replicas > 0 && dep.ready_replicas >= dep.replicas) {
    return { label: "Available", tone: "ok" };
  }
  return { label: "Progressing", tone: "warn" };
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
