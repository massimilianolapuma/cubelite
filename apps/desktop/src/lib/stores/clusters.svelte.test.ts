import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("$lib/tauri", () => ({
  listContexts: vi.fn(),
  setContext: vi.fn(),
  probeCluster: vi.fn(),
  listPods: vi.fn(),
  listNamespaces: vi.fn(),
  listDeployments: vi.fn(),
  deletePod: vi.fn(async () => undefined),
  restartDeployment: vi.fn(async () => undefined),
  scaleDeployment: vi.fn(async () => undefined),
  listEvents: vi.fn(async () => []),
  listPodMetrics: vi.fn(async () => []),
  clusterCapacity: vi.fn(async () => []),
  watchResources: vi.fn(),
  unwatchResources: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import {
  listContexts,
  listDeployments,
  listNamespaces,
  listPods,
  probeCluster,
  setContext,
  watchResources,
  type ContextInfo,
} from "$lib/tauri";
import { clusters } from "./clusters.svelte";
import { resources } from "./resources.svelte";
import { app } from "./app.svelte";
import { settings } from "./settings.svelte";
import { installLocalStorageMock } from "./storage-mock";

const contexts: ContextInfo[] = [
  { name: "prod", cluster_server: "https://prod:6443", namespace: "default", is_active: true },
  { name: "staging", cluster_server: "https://staging:6443", namespace: "default", is_active: false },
];

beforeEach(() => {
  vi.clearAllMocks();
  installLocalStorageMock();
  vi.mocked(probeCluster).mockResolvedValue({
    reachable: true,
    version: "v1.30.0",
    node_count: 1,
    error: null,
  });
  settings.identityColors.value = {};
  settings.refreshInterval.value = 0;
  app.kubeconfigPath = "/home/u/.kube/config";
  app.activeCluster = "prod";
  app.connecting = null;
  app.view = "dashboard";
  clusters.contexts = [];
  clusters.connectionState = "unknown";
  clusters.unreachableReason = null;
  resources.clear();
});

describe("refresh", () => {
  it("loads contexts and persists identity colors", async () => {
    vi.mocked(listContexts).mockResolvedValue(contexts);
    await clusters.refresh();
    expect(clusters.contexts).toHaveLength(2);
    expect(clusters.identityFor("prod")).toBe("blue");
    expect(clusters.identityFor("staging")).toBe("amber");
    expect(settings.identityColors.value).toEqual({ prod: "blue", staging: "amber" });
  });

  it("records the error when discovery fails", async () => {
    vi.mocked(listContexts).mockRejectedValue(new Error("no kubeconfig"));
    await clusters.refresh();
    expect(clusters.error).toBe("no kubeconfig");
  });
});

describe("switchCluster", () => {
  it("connects when the initial list succeeds", async () => {
    vi.mocked(setContext).mockResolvedValue(undefined);
    vi.mocked(listPods).mockResolvedValue([]);
    vi.mocked(listNamespaces).mockResolvedValue([]);
    vi.mocked(listDeployments).mockResolvedValue([]);
    vi.mocked(watchResources).mockResolvedValue("w1");
    clusters.contexts = [...contexts];

    await clusters.switchCluster("staging");

    expect(setContext).toHaveBeenCalledWith("staging");
    expect(app.activeCluster).toBe("staging");
    expect(app.namespace).toBeNull();
    expect(app.view).toBe("overview");
    expect(app.connecting).toBeNull();
    expect(clusters.connectionState).toBe("connected");
    expect(clusters.contexts.find((c) => c.name === "staging")?.is_active).toBe(true);
    expect(clusters.contexts.find((c) => c.name === "prod")?.is_active).toBe(false);
  });

  it("lands unreachable with the reason when the probe fails", async () => {
    vi.mocked(setContext).mockResolvedValue(undefined);
    vi.mocked(listPods).mockRejectedValue(new Error("connection timed out"));
    vi.mocked(listNamespaces).mockRejectedValue(new Error("connection timed out"));

    await clusters.switchCluster("staging");

    expect(clusters.connectionState).toBe("unreachable");
    expect(clusters.unreachableReason).toBe("connection timed out");
    expect(app.connecting).toBeNull();
  });

  it("keeps the previous active cluster when set_context fails", async () => {
    vi.mocked(setContext).mockRejectedValue(new Error("context not found"));

    await clusters.switchCluster("staging");

    expect(app.activeCluster).toBe("prod");
    expect(listPods).not.toHaveBeenCalled();
    expect(app.connecting).toBeNull();
  });

  it("ignores a switch to the cluster already being connected", async () => {
    app.connecting = "staging";
    await clusters.switchCluster("staging");
    expect(setContext).not.toHaveBeenCalled();
  });

  it("fails fast to unreachable when the probe reports the cluster down", async () => {
    vi.mocked(setContext).mockResolvedValue(undefined);
    vi.mocked(probeCluster).mockResolvedValue({
      reachable: false,
      version: null,
      node_count: null,
      error: "connect timeout",
    });

    await clusters.switchCluster("staging");

    expect(clusters.connectionState).toBe("unreachable");
    expect(clusters.unreachableReason).toBe("connect timeout");
    expect(listPods).not.toHaveBeenCalled();
    expect(app.connecting).toBeNull();
  });

  it("a second switch preempts the in-flight one and its result wins", async () => {
    vi.mocked(setContext).mockResolvedValue(undefined);
    vi.mocked(listNamespaces).mockResolvedValue([]);
    vi.mocked(listDeployments).mockResolvedValue([]);
    vi.mocked(watchResources).mockResolvedValue("w1");
    // First switch hangs on the pod list until released.
    let releaseFirst!: () => void;
    const firstGate = new Promise<never[]>((resolve) => {
      releaseFirst = () => resolve([]);
    });
    vi.mocked(listPods).mockReturnValueOnce(firstGate).mockResolvedValue([]);
    clusters.contexts = [...contexts];

    const first = clusters.switchCluster("staging");
    const second = clusters.switchCluster("prod");
    releaseFirst();
    await Promise.all([first, second]);

    expect(app.activeCluster).toBe("prod");
    expect(app.connecting).toBeNull();
    expect(clusters.connectionState).toBe("connected");
    expect(clusters.contexts.find((c) => c.name === "prod")?.is_active).toBe(true);
  });

  it("cancelSwitch aborts the in-flight switch and discards its result", async () => {
    vi.mocked(setContext).mockResolvedValue(undefined);
    let releaseProbe!: () => void;
    vi.mocked(probeCluster).mockReturnValue(
      new Promise((resolve) => {
        releaseProbe = () =>
          resolve({ reachable: false, version: null, node_count: null, error: "late" });
      }),
    );

    const inFlight = clusters.switchCluster("staging");
    // Let the switch reach the probe await before cancelling.
    await Promise.resolve();
    clusters.cancelSwitch();
    expect(app.connecting).toBeNull();

    releaseProbe();
    await inFlight;

    // The stale unreachable result was discarded.
    expect(clusters.connectionState).toBe("unknown");
    expect(app.connecting).toBeNull();
  });
});
