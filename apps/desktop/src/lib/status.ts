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

export function pvcTone(status: string | null): StatusTone {
  switch (status) {
    case "Bound":
      return "ok";
    case "Pending":
      return "warn";
    case "Lost":
      return "err";
    default:
      return "neutral";
  }
}

export function helmTone(status: string | null): StatusTone {
  const s = status?.toLowerCase() ?? "";
  if (s === "deployed") return "ok";
  if (s === "failed") return "err";
  if (s.startsWith("pending")) return "warn";
  return "neutral";
}
