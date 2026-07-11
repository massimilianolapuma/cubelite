import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("$lib/tauri", () => ({
  probeCluster: vi.fn(),
  listContexts: vi.fn(),
  setContext: vi.fn(),
  listPods: vi.fn(),
  listNamespaces: vi.fn(),
  listDeployments: vi.fn(),
  listEvents: vi.fn(async () => []),
  listPodMetrics: vi.fn(async () => []),
  clusterCapacity: vi.fn(async () => []),
  watchResources: vi.fn(),
  unwatchResources: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import { probeCluster } from "$lib/tauri";
import { health } from "./health.svelte";
import { app } from "./app.svelte";
import { clusters } from "./clusters.svelte";
import { settings } from "./settings.svelte";
import { installLocalStorageMock } from "./storage-mock";

beforeEach(() => {
  vi.clearAllMocks();
  installLocalStorageMock();
  settings.lastSeen.value = {};
  health.byContext = {};
  app.kubeconfigPath = "/home/u/.kube/config";
  clusters.contexts = [
    { name: "prod", cluster_server: "https://prod:6443", namespace: "default", is_active: true },
    { name: "staging", cluster_server: "https://staging:6443", namespace: "default", is_active: false },
  ];
});

describe("health.probeAll", () => {
  it("records reachable clusters with version/node count and persists lastSeen", async () => {
    vi.mocked(probeCluster).mockImplementation(async (_kc, context) =>
      context === "prod"
        ? { context, reachable: true, version: "v1.30.2", node_count: 3, error: null }
        : { context, reachable: false, version: null, node_count: null, error: "connection timed out" },
    );

    await health.probeAll();

    expect(health.for("prod")).toMatchObject({
      state: "connected",
      version: "v1.30.2",
      nodeCount: 3,
    });
    expect(health.for("prod").lastSeen).not.toBeNull();
    expect(settings.lastSeen.value.prod).toBeDefined();

    expect(health.for("staging")).toMatchObject({
      state: "unreachable",
      reason: "connection timed out",
      lastSeen: null,
    });
  });

  it("keeps the previous lastSeen when a cluster goes down", async () => {
    settings.lastSeen.value = { staging: "2026-07-10T08:00:00Z" };
    vi.mocked(probeCluster).mockResolvedValue({
      context: "staging",
      reachable: false,
      version: null,
      node_count: null,
      error: "timeout",
    });
    clusters.contexts = [
      { name: "staging", cluster_server: null, namespace: "default", is_active: false },
    ];

    await health.probeAll();

    expect(health.for("staging").lastSeen).toBe("2026-07-10T08:00:00Z");
  });

  it("falls back to unknown with persisted lastSeen before any probe", () => {
    settings.lastSeen.value = { prod: "2026-07-09T00:00:00Z" };
    expect(health.for("prod")).toMatchObject({
      state: "unknown",
      lastSeen: "2026-07-09T00:00:00Z",
    });
  });
});
