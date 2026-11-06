/** Status → tone mapping shared by tables, pills and drawers. */

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

export const toneColor: Record<StatusTone, string> = {
  ok: "var(--color-status-ok)",
  warn: "var(--color-status-warn)",
  err: "var(--color-status-err)",
  neutral: "var(--color-text-tertiary)",
};

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
