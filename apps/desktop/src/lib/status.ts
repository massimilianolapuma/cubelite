/** Status → tone mapping shared by tables, pills and drawers. */

import type { DeploymentInfo, PodInfo } from "$lib/tauri";

export type StatusTone = "ok" | "warn" | "err" | "neutral";

export function podTone(pod: PodInfo): StatusTone {
  switch (pod.phase?.toLowerCase()) {
    case "running":
      return pod.ready ? "ok" : "warn";
    case "succeeded":
      return "neutral";
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
