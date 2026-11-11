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
  listResourceTable: vi.fn(async () => ({ columns: [], rows: [] })),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import {
  listDeployments,
  listEvents,
  listNamespaces,
  listNodes,
  listPods,
  listSecrets,
  listServices,
  type NamespaceInfo,
  type PodInfo,
} from "#lib/tauri.ts";
import { listResourceTable } from "#lib/tauri.ts";
import { resources } from "./resources.svelte";
import { dynamic } from "./dynamic.svelte";
import type { View } from "./app.svelte";
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

describe("generic kinds (resource-kinds phase 2)", () => {
  it("a refresh reloads the open generic list, and clear drops its table", async () => {
    vi.mocked(listPods).mockResolvedValue([]);
    app.view = "roles" as View;
    await resources.load();
    await vi.waitFor(() => expect(dynamic.count("roles")).toBe(0));
    expect(listResourceTable).toHaveBeenCalledWith(
      "/home/u/.kube/config",
      expect.objectContaining({ plural: "roles" }),
      undefined,
      "prod",
    );
    resources.clear();
    expect(dynamic.count("roles")).toBeNull();
  });
});

describe("list load state (#606)", () => {
  it("mainLoaded is false until pods, deployments and events have loaded once", async () => {
    vi.mocked(listPods).mockResolvedValue([pod("a", "default")]);
    expect(resources.mainLoaded).toBe(false);
    const pending = resources.load();
    expect(resources.mainLoaded).toBe(false);
    await pending;
    expect(resources.mainLoaded).toBe(true);
  });

  it("mainLoaded stays true during a refresh of the same namespace", async () => {
    vi.mocked(listPods).mockResolvedValue([pod("a", "default")]);
    await resources.load();
    const pending = resources.load();
    expect(resources.mainLoaded).toBe(true);
    await pending;
  });

  it("mainLoaded drops when the namespace changes, until that namespace has loaded", async () => {
    vi.mocked(listPods).mockResolvedValue([pod("a", "default")]);
    await resources.load();
    app.namespace = "default";
    expect(resources.mainLoaded).toBe(false);
    await resources.load();
    expect(resources.mainLoaded).toBe(true);
    resources.clear();
    expect(resources.mainLoaded).toBe(false);
  });

  it("keeps the error of a failed load while the retry is in flight, and clears it on success", async () => {
    vi.mocked(listPods).mockRejectedValueOnce(new Error("connection reset"));
    expect(await resources.load()).toBe(false);
    expect(resources.error).toBe("connection reset");

    vi.mocked(listPods).mockResolvedValue([]);
    const retry = resources.load();
    expect(resources.error).toBe("connection reset");
    await retry;
    expect(resources.error).toBeNull();
  });

  it("kindLoaded follows the namespace a kind was loaded for", async () => {
    vi.mocked(listServices).mockResolvedValue([]);
    expect(resources.kindLoaded("services")).toBe(false);
    await resources.loadKind("services");
    expect(resources.kindLoaded("services")).toBe(true);
    app.namespace = "default";
    expect(resources.kindLoaded("services")).toBe(false);
  });

  it("kindError belongs to the kind that failed", async () => {
    vi.mocked(listServices).mockRejectedValueOnce(new Error("boom"));
    await resources.loadKind("services");
    expect(resources.kindError("services")).toBe("boom");
    expect(resources.kindError("secrets")).toBeNull();
  });

  it("keeps a kind's error while it reloads, and drops it when the reload succeeds", async () => {
    vi.mocked(listServices).mockRejectedValueOnce(new Error("boom"));
    await resources.loadKind("services");
    vi.mocked(listServices).mockResolvedValue([]);
    const retry = resources.loadKind("services");
    expect(resources.kindError("services")).toBe("boom");
    await retry;
    expect(resources.kindError("services")).toBeNull();
  });
});

describe("each main list reports its own failure (#606)", () => {
  const refused = (what: string) => new Error(`${what} is forbidden: User "dev" cannot list`);

  beforeEach(() => {
    vi.mocked(listPods).mockResolvedValue([pod("a", "default")]);
    vi.mocked(listDeployments).mockResolvedValue([]);
    vi.mocked(listEvents).mockResolvedValue([]);
  });

  it("a failed events load is an error of the events list only", async () => {
    vi.mocked(listEvents).mockRejectedValueOnce(refused("events"));
    expect(await resources.load()).toBe(true);
    expect(resources.listError("events")).toContain("events is forbidden");
    expect(resources.listError("pods")).toBeNull();
    expect(resources.pods).toHaveLength(1);
    expect(resources.mainLoaded).toBe(true);
  });

  it("a failed deployments load in one namespace does not fail pods", async () => {
    app.namespace = "default";
    vi.mocked(listDeployments).mockRejectedValueOnce(refused("deployments.apps"));
    expect(await resources.load()).toBe(true);
    expect(resources.listError("deployments")).toContain("deployments.apps is forbidden");
    expect(resources.listError("pods")).toBeNull();
    expect(resources.pods).toHaveLength(1);
  });

  it("deployments refused in every namespace is a failed list, not an empty one", async () => {
    vi.mocked(listDeployments).mockRejectedValue(refused("deployments.apps"));
    expect(await resources.load()).toBe(true);
    expect(resources.listError("deployments")).toContain("deployments.apps is forbidden");
  });

  it("deployments refused in some namespaces keeps the rows of the others", async () => {
    vi.mocked(listDeployments).mockRejectedValueOnce(refused("deployments.apps"));
    expect(await resources.load()).toBe(true);
    expect(resources.listError("deployments")).toBeNull();
  });

  it("a failed pods load fails the load but keeps what the other lists answered", async () => {
    vi.mocked(listPods).mockRejectedValueOnce(new Error("connection reset"));
    vi.mocked(listEvents).mockResolvedValueOnce([
      { event_type: "Normal", reason: "x", object: "Pod/a", message: null, namespace: "default", count: 1, last_timestamp: null },
    ]);
    expect(await resources.load()).toBe(false);
    expect(resources.error).toBe("connection reset");
    expect(resources.listError("pods")).toBe("connection reset");
    expect(resources.listError("events")).toBeNull();
    expect(resources.events).toHaveLength(1);
  });

  it("an error belongs to the namespace it was loaded for", async () => {
    app.namespace = "default";
    vi.mocked(listPods).mockRejectedValueOnce(refused("pods"));
    await resources.load();
    expect(resources.listError("pods")).toContain("forbidden");
    app.namespace = "kube-system";
    expect(resources.listError("pods")).toBeNull();
    expect(resources.mainLoaded).toBe(false);
  });

  it("a kind's error belongs to the namespace it was loaded for; nodes are cluster-scoped", async () => {
    app.namespace = "default";
    vi.mocked(listServices).mockRejectedValueOnce(refused("services"));
    vi.mocked(listNodes).mockRejectedValueOnce(refused("nodes"));
    await resources.loadKind("services");
    expect(resources.kindError("services")).toContain("forbidden");
    app.namespace = "kube-system";
    expect(resources.kindError("services")).toBeNull();
    await resources.loadKind("nodes");
    app.namespace = "default";
    expect(resources.kindError("nodes")).toContain("forbidden");
  });

  it("an overview batch that answers after a namespace change does not replace the new namespace's kinds", async () => {
    let answer: (rows: never[]) => void = () => {};
    vi.mocked(listServices).mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    const batch = resources.loadOverviewExtras();
    app.namespace = "default";
    vi.mocked(listServices).mockResolvedValueOnce([]);
    await resources.loadKind("services");
    expect(resources.kindLoaded("services")).toBe(true);
    answer([]);
    await batch;
    expect(resources.kindLoaded("services")).toBe(true);
  });
});
