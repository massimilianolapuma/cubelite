import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("#lib/tauri.ts", () => ({
  listPods: vi.fn(),
  listNamespaces: vi.fn(),
  listDeployments: vi.fn(async () => []),
  listEvents: vi.fn(async () => []),
  listPodMetrics: vi.fn(async () => {
    throw new Error("no metrics-server");
  }),
  clusterCapacity: vi.fn(async () => []),
  listServices: vi.fn(),
  listIngresses: vi.fn(async () => []),
  listConfigMaps: vi.fn(async () => []),
  listSecrets: vi.fn(async () => []),
  listHelmReleases: vi.fn(async () => []),
  listNodes: vi.fn(),
  watchResources: vi.fn(),
  unwatchResources: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import {
  listNamespaces,
  listNodes,
  listPods,
  listSecrets,
  listServices,
  type NamespaceInfo,
  type PodInfo,
} from "#lib/tauri.ts";
import { resources } from "./resources.svelte";
import { app } from "./app.svelte";

function pod(name: string, namespace: string): PodInfo {
  return {
    name,
    namespace,
    phase: "Running",
    ready: true,
    restarts: 0,
    ready_containers: 1,
    total_containers: 1,
    node: null,
    pod_ip: null,
    qos_class: null,
    containers: [],
    labels: {},
    creation_timestamp: null,
  };
}

const namespaces: NamespaceInfo[] = ["default", "kube-system", "empty"].map((name) => ({
  name,
  phase: "Active",
}));

beforeEach(() => {
  vi.clearAllMocks();
  resources.clear();
  app.kubeconfigPath = "/home/u/.kube/config";
  app.activeCluster = "prod";
  app.namespace = null;
  app.view = "overview";
  vi.mocked(listNamespaces).mockResolvedValue(namespaces);
});

describe("podCountsByNamespace", () => {
  it("counts every namespace (0 for empty ones) when viewing all namespaces", async () => {
    vi.mocked(listPods).mockResolvedValue([
      pod("a", "default"),
      pod("b", "default"),
      pod("c", "kube-system"),
    ]);
    await resources.load();
    expect(resources.podCountsByNamespace).toEqual({ default: 2, "kube-system": 1, empty: 0 });
  });

  it("keeps the all-namespaces snapshot while a namespace filter is active", async () => {
    vi.mocked(listPods).mockResolvedValueOnce([pod("a", "default"), pod("c", "kube-system")]);
    await resources.load();

    app.namespace = "default";
    vi.mocked(listPods).mockResolvedValueOnce([pod("a", "default"), pod("new", "default")]);
    await resources.load();
    // "default" is live (2), the others come from the earlier snapshot.
    expect(resources.podCountsByNamespace).toEqual({ default: 2, "kube-system": 1, empty: 0 });
  });

  it("only knows the filtered namespace without an all-namespaces snapshot", async () => {
    app.namespace = "default";
    vi.mocked(listPods).mockResolvedValue([pod("a", "default")]);
    await resources.load();
    expect(resources.podCountsByNamespace).toEqual({ default: 1 });
  });
});

describe("kindCount", () => {
  it("is null until a kind is loaded, then follows the namespace it was loaded for", async () => {
    expect(resources.kindCount("services")).toBeNull();

    vi.mocked(listServices).mockResolvedValue([
      {
        name: "api",
        namespace: "default",
        service_type: "ClusterIP",
        cluster_ip: null,
        external_ips: [],
        ports: [],
        creation_timestamp: null,
      },
    ]);
    await resources.loadKind("services");
    expect(resources.kindCount("services")).toBe(1);

    app.namespace = "kube-system";
    expect(resources.kindCount("services")).toBeNull();
  });

  it("treats nodes as cluster-scoped", async () => {
    vi.mocked(listNodes).mockResolvedValue([]);
    await resources.loadKind("nodes");
    app.namespace = "default";
    expect(resources.kindCount("nodes")).toBe(0);
  });

  it("forgets loaded kinds on clear()", async () => {
    vi.mocked(listNodes).mockResolvedValue([]);
    await resources.loadKind("nodes");
    resources.clear();
    expect(resources.kindCount("nodes")).toBeNull();
  });
});

describe("loadOverviewExtras", () => {
  const forbidden = new Error(
    'kubernetes client error: ApiError: secrets is forbidden: User "dev" cannot list resource "secrets" (Forbidden)',
  );

  it("loads every kind the overview grid summarizes", async () => {
    vi.mocked(listServices).mockResolvedValue([]);
    vi.mocked(listNodes).mockResolvedValue([]);
    await resources.loadOverviewExtras();
    for (const kind of ["services", "ingresses", "configmaps", "secrets", "helm", "nodes"] as const) {
      expect(resources.kindCount(kind)).toBe(0);
    }
    expect(resources.forbiddenKinds.size).toBe(0);
  });

  it("records RBAC denials and keeps the other kinds", async () => {
    vi.mocked(listServices).mockResolvedValue([]);
    vi.mocked(listNodes).mockResolvedValue([]);
    vi.mocked(listSecrets).mockRejectedValueOnce(forbidden);
    await resources.loadOverviewExtras();
    expect([...resources.forbiddenKinds]).toEqual(["secrets"]);
    expect(resources.kindCount("secrets")).toBeNull();
    expect(resources.kindCount("services")).toBe(0);
  });

  it("treats other failures as best-effort, not forbidden", async () => {
    vi.mocked(listServices).mockRejectedValueOnce(new Error("connection reset"));
    vi.mocked(listNodes).mockResolvedValue([]);
    await resources.loadOverviewExtras();
    expect(resources.forbiddenKinds.size).toBe(0);
    expect(resources.kindCount("services")).toBeNull();
  });

  it("clears a denial once the kind loads again", async () => {
    vi.mocked(listServices).mockResolvedValue([]);
    vi.mocked(listNodes).mockResolvedValue([]);
    vi.mocked(listSecrets).mockRejectedValueOnce(forbidden);
    await resources.loadOverviewExtras();
    await resources.loadOverviewExtras();
    expect(resources.forbiddenKinds.size).toBe(0);
  });

  it("drops a superseded load", async () => {
    let resolveFirst: (v: never[]) => void = () => {};
    vi.mocked(listServices)
      .mockImplementationOnce(() => new Promise((r) => (resolveFirst = r)))
      .mockResolvedValueOnce([]);
    vi.mocked(listNodes).mockResolvedValue([]);
    const first = resources.loadOverviewExtras();
    resources.clear();
    resolveFirst([]);
    await first;
    expect(resources.kindCount("services")).toBeNull();
  });

  it("runs with the auto-refresh load() while the overview is open", async () => {
    vi.mocked(listPods).mockResolvedValue([]);
    vi.mocked(listServices).mockResolvedValue([]);
    vi.mocked(listNodes).mockResolvedValue([]);
    await resources.load();
    await vi.waitFor(() => expect(resources.kindCount("services")).toBe(0));
  });

  it("marks a forbidden kind from loadKind too, and clear() forgets it", async () => {
    vi.mocked(listSecrets).mockRejectedValueOnce(forbidden);
    await resources.loadKind("secrets");
    expect(resources.forbiddenKinds.has("secrets")).toBe(true);
    resources.clear();
    expect(resources.forbiddenKinds.size).toBe(0);
  });
});
