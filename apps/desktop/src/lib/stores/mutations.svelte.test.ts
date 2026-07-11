import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("$lib/tauri", () => ({
  deletePod: vi.fn(async () => undefined),
  restartDeployment: vi.fn(async () => undefined),
  scaleDeployment: vi.fn(async () => undefined),
  listPods: vi.fn(async () => []),
  listNamespaces: vi.fn(async () => []),
  listDeployments: vi.fn(async () => []),
  listEvents: vi.fn(async () => []),
  listServices: vi.fn(async () => []),
  listIngresses: vi.fn(async () => []),
  listConfigMaps: vi.fn(async () => []),
  listSecrets: vi.fn(async () => []),
  listHelmReleases: vi.fn(async () => []),
  watchResources: vi.fn(),
  unwatchResources: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import { deletePod, restartDeployment, scaleDeployment } from "$lib/tauri";
import { mutations } from "./mutations.svelte";
import { app } from "./app.svelte";
import { toasts } from "./toasts.svelte";

beforeEach(() => {
  vi.clearAllMocks();
  toasts.items = [];
  app.kubeconfigPath = "/home/u/.kube/config";
  app.activeCluster = "prod";
});

describe("deletePod", () => {
  it("deletes, toasts ok and clears the pending flag", async () => {
    const promise = mutations.deletePod("default", "api-0");
    expect(mutations.isDeleting("default", "api-0")).toBe(true);
    const ok = await promise;
    expect(ok).toBe(true);
    expect(deletePod).toHaveBeenCalledWith("/home/u/.kube/config", "default", "api-0", "prod");
    expect(mutations.isDeleting("default", "api-0")).toBe(false);
    expect(toasts.items[0]).toMatchObject({ tone: "ok" });
  });

  it("toasts err on failure and returns false", async () => {
    vi.mocked(deletePod).mockRejectedValueOnce(new Error("forbidden"));
    const ok = await mutations.deletePod("default", "api-0");
    expect(ok).toBe(false);
    expect(toasts.items[0].tone).toBe("err");
    expect(toasts.items[0].message).toContain("forbidden");
  });
});

describe("restartDeployment", () => {
  it("tracks the pending flag and toasts the outcome", async () => {
    const promise = mutations.restartDeployment("default", "api");
    expect(mutations.isRestarting("default", "api")).toBe(true);
    expect(await promise).toBe(true);
    expect(restartDeployment).toHaveBeenCalledWith("/home/u/.kube/config", "default", "api", "prod");
    expect(mutations.isRestarting("default", "api")).toBe(false);
  });
});

describe("scaleDeployment", () => {
  it("exposes the target replicas while applying", async () => {
    const promise = mutations.scaleDeployment("default", "api", 4);
    expect(mutations.pendingScale("default", "api")).toBe(4);
    expect(await promise).toBe(true);
    expect(scaleDeployment).toHaveBeenCalledWith("/home/u/.kube/config", "default", "api", 4, "prod");
    expect(mutations.pendingScale("default", "api")).toBeNull();
  });

  it("rejects negative replica counts without calling the backend", async () => {
    expect(await mutations.scaleDeployment("default", "api", -1)).toBe(false);
    expect(scaleDeployment).not.toHaveBeenCalled();
  });
});
