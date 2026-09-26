/**
 * Pure aggregation for the All Clusters dashboard: one snapshot per kube
 * context (live store data for the active cluster, background probe data for
 * the rest) and the cross-cluster totals shown in the stat cards.
 */

import type { ClusterHealth } from "$lib/stores/health.svelte";
import type { CapacityTotals } from "$lib/tauri";

export type ClusterState = "connected" | "unreachable" | "unknown";

/** Live data for the active cluster, from the resources store. */
export interface LiveCluster {
  state: ClusterState;
  pods: number;
  warnings: number;
  /** Node count from capacity data; null when metrics are unavailable. */
  nodes: number | null;
  capacity: CapacityTotals | null;
}

export interface ClusterSnapshot {
  name: string;
  state: ClusterState;
  version: string | null;
  nodes: number | null;
  pods: number | null;
  warnings: number | null;
  capacity: CapacityTotals | null;
}

export interface DashboardTotals {
  online: number;
  pods: number;
  warnings: number;
  watched: number;
}

/**
 * Merge probe data with live data. Live values win for the active cluster
 * (they refresh more often); probe values fill whatever live data lacks.
 */
export function buildSnapshot(
  name: string,
  health: ClusterHealth,
  live: LiveCluster | null,
): ClusterSnapshot {
  const state = live && live.state !== "unknown" ? live.state : health.state;
  const online = state === "connected";
  const liveOnline = online && live !== null;
  return {
    name,
    state,
    version: health.version,
    nodes: health.nodeCount ?? (liveOnline ? live.nodes : null),
    pods: liveOnline ? live.pods : online ? health.podCount : null,
    warnings: liveOnline ? live.warnings : online ? health.issuePodCount : null,
    capacity: (liveOnline ? live.capacity : null) ?? (online ? health.capacity : null),
  };
}

/** Stat-card totals: online clusters, and pods/warnings summed over them. */
export function dashboardTotals(snapshots: ClusterSnapshot[]): DashboardTotals {
  const online = snapshots.filter((s) => s.state === "connected");
  return {
    online: online.length,
    pods: online.reduce((sum, s) => sum + (s.pods ?? 0), 0),
    warnings: online.reduce((sum, s) => sum + (s.warnings ?? 0), 0),
    watched: snapshots.length,
  };
}
