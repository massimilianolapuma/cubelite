import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("$lib/tauri", () => ({
  listContexts: vi.fn(),
  setContext: vi.fn(),
  listPods: vi.fn(),
  listNamespaces: vi.fn(),
  listDeployments: vi.fn(),
  listEvents: vi.fn(async () => []),
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

  it("ignores switches while one is already in flight", async () => {
    app.connecting = "staging";
    await clusters.switchCluster("prod");
    expect(setContext).not.toHaveBeenCalled();
  });
});
