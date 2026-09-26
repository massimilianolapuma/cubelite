import { describe, it, expect } from "vitest";
import { buildSnapshot, dashboardTotals, type LiveCluster } from "./all-clusters";
import type { ClusterHealth } from "$lib/stores/health.svelte";

const capacity = {
  cpu_used_millis: 500,
  cpu_allocatable_millis: 2000,
  memory_used_bytes: 1,
  memory_allocatable_bytes: 4,
};

function health(overrides: Partial<ClusterHealth> = {}): ClusterHealth {
  return {
    state: "connected",
    version: "v1.31.0",
    nodeCount: 3,
    podCount: 40,
    issuePodCount: 2,
    capacity,
    reason: null,
    lastSeen: null,
    ...overrides,
  };
}

const live: LiveCluster = { state: "connected", pods: 12, warnings: 1, nodes: 2, capacity: null };

describe("buildSnapshot", () => {
  it("uses probe data for inactive clusters", () => {
    expect(buildSnapshot("staging", health(), null)).toEqual({
      name: "staging",
      state: "connected",
      version: "v1.31.0",
      nodes: 3,
      pods: 40,
      warnings: 2,
      capacity,
    });
  });

  it("prefers live pods/warnings for the active cluster and falls back to probe capacity", () => {
    const snap = buildSnapshot("prod", health(), live);
    expect(snap.pods).toBe(12);
    expect(snap.warnings).toBe(1);
    expect(snap.capacity).toEqual(capacity);
  });

  it("uses live capacity when metrics are loaded", () => {
    const liveCap = { ...capacity, cpu_used_millis: 900 };
    expect(buildSnapshot("prod", health({ capacity: null }), { ...live, capacity: liveCap }).capacity).toEqual(liveCap);
  });

  it("falls back to live node count when the probe could not list nodes", () => {
    expect(buildSnapshot("prod", health({ nodeCount: null }), live).nodes).toBe(2);
  });

  it("shows nothing but the state for unreachable clusters", () => {
    const snap = buildSnapshot("down", health({ state: "unreachable" }), null);
    expect(snap).toMatchObject({ state: "unreachable", pods: null, warnings: null, capacity: null });
  });

  it("lets the live connection state override the probe", () => {
    const snap = buildSnapshot("prod", health({ state: "connected" }), { ...live, state: "unreachable" });
    expect(snap).toMatchObject({ state: "unreachable", pods: null, warnings: null });
  });
});

describe("dashboardTotals", () => {
  it("sums pods and warnings over online clusters only", () => {
    const snaps = [
      buildSnapshot("prod", health(), live),
      buildSnapshot("staging", health(), null),
      buildSnapshot("down", health({ state: "unreachable" }), null),
      buildSnapshot("new", health({ state: "unknown" }), null),
    ];
    expect(dashboardTotals(snaps)).toEqual({ online: 2, pods: 52, warnings: 3, watched: 4 });
  });

  it("treats unknown pod counts as zero", () => {
    const snaps = [buildSnapshot("rbac", health({ podCount: null, issuePodCount: null }), null)];
    expect(dashboardTotals(snaps)).toEqual({ online: 1, pods: 0, warnings: 0, watched: 1 });
  });
});
