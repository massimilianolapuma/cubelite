import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("#lib/tauri.ts", () => ({
  deletePod: vi.fn(async () => undefined),
  restartDeployment: vi.fn(async () => undefined),
  scaleDeployment: vi.fn(async () => undefined),
  listPods: vi.fn(async () => []),
  listNamespaces: vi.fn(async () => []),
  listDeployments: vi.fn(async () => []),
  listEvents: vi.fn(async () => []),
  listPodMetrics: vi.fn(async () => []),
  clusterCapacity: vi.fn(async () => []),
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

import { deletePod, restartDeployment, scaleDeployment } from "#lib/tauri.ts";
import { mutations, SCALE_DEBOUNCE_MS } from "./mutations.svelte";
import { app } from "./app.svelte";
import { clock } from "./clock.svelte";
import { clusterSettings } from "./cluster-settings.svelte";
import { setAccess } from "./access-mock";
import { toasts } from "./toasts.svelte";

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  toasts.items = [];
  clusterSettings.reset();
  mutations.draftScales = {};
  mutations.pendingScales = {};
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

describe("on a read-only cluster (#662)", () => {
  const REASON = "prod is read-only. Make it writable from the cluster menu.";

  it("deletes, restarts and scales nothing, and says why", async () => {
    setAccess("prod", "read_only");
    expect(await mutations.deletePod("default", "api-0")).toBe(false);
    expect(await mutations.restartDeployment("default", "api")).toBe(false);
    expect(await mutations.scaleDeployment("default", "api", 4)).toBe(false);
    expect(deletePod).not.toHaveBeenCalled();
    expect(restartDeployment).not.toHaveBeenCalled();
    expect(scaleDeployment).not.toHaveBeenCalled();
    expect(toasts.items.map((t) => [t.tone, t.message])).toEqual([
      ["err", `Delete failed: ${REASON}`],
      ["err", `Restart failed: ${REASON}`],
      ["err", `Scale failed: ${REASON}`],
    ]);
    expect(mutations.isDeleting("default", "api-0")).toBe(false);
    expect(mutations.isRestarting("default", "api")).toBe(false);
    expect(mutations.pendingScale("default", "api")).toBeNull();
  });

  it("starts no scale draft on a read-only cluster", () => {
    setAccess("prod", "read_only");
    mutations.nudgeScale("default", "api", 3, 1);
    expect(mutations.pendingScale("default", "api")).toBeNull();
  });

  it("drops a scale held in the debounce when the unlock ends, says why, and shows the cluster's replicas", async () => {
    vi.useFakeTimers();
    const entry = setAccess("prod", "timed", 5);
    mutations.nudgeScale("default", "api", 3, 1);
    expect(mutations.pendingScale("default", "api")).toBe(4);
    clock.now = (entry.writable_until ?? 0) + 1;
    await vi.advanceTimersByTimeAsync(SCALE_DEBOUNCE_MS);
    expect(scaleDeployment).not.toHaveBeenCalled();
    expect(mutations.pendingScale("default", "api")).toBeNull();
    expect(toasts.items.at(-1)?.message).toBe(`Scale failed: ${REASON}`);
  });

  it("Review Focus 4: a held scale the backend refuses shows the refusal as text and the cluster's replicas", async () => {
    vi.useFakeTimers();
    vi.mocked(scaleDeployment).mockRejectedValueOnce({ kind: "read_only", context: "prod", message: REASON });
    mutations.nudgeScale("default", "api", 3, 1);
    await vi.advanceTimersByTimeAsync(SCALE_DEBOUNCE_MS);
    expect(scaleDeployment).toHaveBeenCalledOnce();
    const message = toasts.items.at(-1)?.message ?? "";
    expect(message).toBe(`Scale failed: ${REASON}`);
    expect(message).not.toContain("{");
    expect(mutations.pendingScale("default", "api")).toBeNull();
    expect(mutations.isApplyingScale("default", "api")).toBe(false);
  });
});
