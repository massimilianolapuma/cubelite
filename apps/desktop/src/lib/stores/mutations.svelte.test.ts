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

import { deletePod, listPods, restartDeployment, scaleDeployment } from "#lib/tauri.ts";
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
  mutations.cancelDrafts();
  mutations.pendingScales = {};
  app.kubeconfigPath = "/home/u/.kube/config";
  app.activeCluster = "prod";
  app.connecting = null;
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

describe("a held scale goes to the cluster it was made on (#682)", () => {
  it("is sent with the kubeconfig and context of the step, whatever is active when it fires", async () => {
    vi.useFakeTimers();
    mutations.nudgeScale("default", "api", 3, 1);
    // Not the switch path: only the active cluster and kubeconfig change.
    app.activeCluster = "staging";
    app.kubeconfigPath = "/other/kubeconfig";
    await vi.advanceTimersByTimeAsync(SCALE_DEBOUNCE_MS);
    expect(scaleDeployment).toHaveBeenCalledOnce();
    expect(scaleDeployment).toHaveBeenCalledWith("/home/u/.kube/config", "default", "api", 4, "prod");
  });

  it("checks the lock of the cluster it was made on, not of the active one", async () => {
    vi.useFakeTimers();
    const entry = setAccess("prod", "timed", 5);
    setAccess("staging", "writable");
    mutations.nudgeScale("default", "api", 3, 1);
    app.activeCluster = "staging";
    clock.now = (entry.writable_until ?? 0) + 1;
    await vi.advanceTimersByTimeAsync(SCALE_DEBOUNCE_MS);
    expect(scaleDeployment).not.toHaveBeenCalled();
    expect(toasts.items.at(-1)?.message).toBe(
      "Scale failed: prod is read-only. Make it writable from the cluster menu.",
    );
  });

  it("is sent even when the active cluster is read-only by then", async () => {
    vi.useFakeTimers();
    setAccess("staging", "read_only");
    mutations.nudgeScale("default", "api", 3, 1);
    app.activeCluster = "staging";
    await vi.advanceTimersByTimeAsync(SCALE_DEBOUNCE_MS);
    expect(scaleDeployment).toHaveBeenCalledWith("/home/u/.kube/config", "default", "api", 4, "prod");
  });

  it("cancelDrafts drops every held scale and sends nothing", async () => {
    vi.useFakeTimers();
    mutations.nudgeScale("default", "api", 3, 1);
    mutations.nudgeScale("default", "web", 1, -1);
    mutations.cancelDrafts();
    expect(mutations.draftScales).toEqual({});
    expect(mutations.pendingScale("default", "api")).toBeNull();
    await vi.advanceTimersByTimeAsync(SCALE_DEBOUNCE_MS * 2);
    expect(scaleDeployment).not.toHaveBeenCalled();
  });

  it("a step after cancelDrafts starts from the deployment's replicas", async () => {
    vi.useFakeTimers();
    mutations.nudgeScale("default", "api", 3, 1);
    mutations.cancelDrafts();
    mutations.nudgeScale("default", "api", 3, 1);
    expect(mutations.pendingScale("default", "api")).toBe(4);
    await vi.advanceTimersByTimeAsync(SCALE_DEBOUNCE_MS);
    expect(scaleDeployment).toHaveBeenCalledOnce();
    expect(scaleDeployment).toHaveBeenCalledWith("/home/u/.kube/config", "default", "api", 4, "prod");
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

describe("an action stays on the cluster it was started on (#685)", () => {
  const KC = "/home/u/.kube/config";
  const PROD = { kubeconfig: KC, cluster: "prod" };

  function deferred() {
    let resolve!: () => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<undefined>((res, rej) => {
      resolve = () => res(undefined);
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  /** Lets every settled promise run its continuation. */
  async function settle(): Promise<void> {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  }

  it("a delete confirmed after a switch goes to the cluster its dialog was opened on, and says where", async () => {
    app.activeCluster = "staging";
    expect(await mutations.deletePod("default", "api-0", PROD)).toBe(true);
    expect(deletePod).toHaveBeenCalledWith(KC, "default", "api-0", "prod");
    expect(toasts.items.at(-1)).toMatchObject({ message: "Pod api-0 deleted on prod", tone: "ok" });
    await settle();
    // The list on screen is staging's: nothing of prod to reload.
    expect(listPods).not.toHaveBeenCalled();
  });

  it("checks the lock of the cluster the delete was opened on, not of the active one", async () => {
    setAccess("prod", "read_only");
    setAccess("staging", "writable");
    app.activeCluster = "staging";
    expect(await mutations.deletePod("default", "api-0", PROD)).toBe(false);
    expect(deletePod).not.toHaveBeenCalled();
    expect(toasts.items.at(-1)?.message).toBe(
      "Delete failed: prod is read-only. Make it writable from the cluster menu.",
    );
  });

  it("a delete in flight on prod does not show on staging's pod of the same name", async () => {
    const request = deferred();
    vi.mocked(deletePod).mockReturnValueOnce(request.promise);
    const pending = mutations.deletePod("default", "api-0");
    expect(mutations.isDeleting("default", "api-0")).toBe(true);
    app.activeCluster = "staging";
    expect(mutations.isDeleting("default", "api-0")).toBe(false);
    app.activeCluster = "prod";
    expect(mutations.isDeleting("default", "api-0")).toBe(true);
    app.activeCluster = "staging";
    request.reject(new Error("forbidden"));
    expect(await pending).toBe(false);
    expect(toasts.items.at(-1)).toMatchObject({ message: "Delete on prod failed: forbidden", tone: "err" });
  });

  it("a restart in flight on prod does not show on staging, and its toast names prod", async () => {
    const request = deferred();
    vi.mocked(restartDeployment).mockReturnValueOnce(request.promise);
    const pending = mutations.restartDeployment("default", "api");
    expect(mutations.isRestarting("default", "api")).toBe(true);
    app.activeCluster = "staging";
    expect(mutations.isRestarting("default", "api")).toBe(false);
    request.resolve();
    expect(await pending).toBe(true);
    expect(restartDeployment).toHaveBeenCalledWith(KC, "default", "api", "prod");
    expect(toasts.items.at(-1)).toMatchObject({ message: "Rollout restart of api triggered on prod", tone: "ok" });
    await settle();
    expect(listPods).not.toHaveBeenCalled();
  });

  it("a scale in flight on prod neither shows on staging nor locks its stepper", async () => {
    vi.useFakeTimers();
    const request = deferred();
    vi.mocked(scaleDeployment).mockReturnValueOnce(request.promise);
    mutations.nudgeScale("default", "api", 3, 1);
    await vi.advanceTimersByTimeAsync(SCALE_DEBOUNCE_MS);
    expect(mutations.isApplyingScale("default", "api")).toBe(true);
    expect(mutations.pendingScale("default", "api")).toBe(4);

    // A switch: the debounce is over, the request is on its way to prod.
    mutations.cancelDrafts();
    app.activeCluster = "staging";
    expect(mutations.isApplyingScale("default", "api")).toBe(false);
    expect(mutations.pendingScale("default", "api")).toBeNull();
    // staging's api has its own stepper, free.
    mutations.nudgeScale("default", "api", 1, 1);
    expect(mutations.pendingScale("default", "api")).toBe(2);
    mutations.cancelDrafts();

    request.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(scaleDeployment).toHaveBeenCalledWith(KC, "default", "api", 4, "prod");
    expect(toasts.items.at(-1)).toMatchObject({ message: "api scaled to 4 on prod", tone: "ok" });
    expect(listPods).not.toHaveBeenCalled();
  });

  it("an explicit scale goes to the cluster it is given", async () => {
    app.activeCluster = "staging";
    expect(await mutations.scaleDeployment("default", "api", 2, PROD)).toBe(true);
    expect(scaleDeployment).toHaveBeenCalledWith(KC, "default", "api", 2, "prod");
    expect(toasts.items.at(-1)?.message).toBe("api scaled to 2 on prod");
  });

  it("an action that ends while a switch to another cluster runs names its cluster and reloads nothing", async () => {
    const request = deferred();
    vi.mocked(deletePod).mockReturnValueOnce(request.promise);
    const pending = mutations.deletePod("default", "api-0");
    // The switch has started; the active cluster changes once the context is set.
    app.connecting = "staging";
    request.resolve();
    await pending;
    app.connecting = null;
    expect(toasts.items.at(-1)?.message).toBe("Pod api-0 deleted on prod");
    await settle();
    expect(listPods).not.toHaveBeenCalled();
  });

  it("a delete in flight stays shown, and its toast names no cluster, when only the kubeconfig list changes", async () => {
    const request = deferred();
    vi.mocked(deletePod).mockReturnValueOnce(request.promise);
    const pending = mutations.deletePod("default", "api-0");
    // Preferences: another kubeconfig file added; the context is the same.
    app.kubeconfigPath = "/home/u/.kube/config:/home/u/.kube/extra.yaml";
    expect(mutations.isDeleting("default", "api-0")).toBe(true);
    request.resolve();
    await pending;
    expect(toasts.items.at(-1)?.message).toBe("Pod api-0 deleted");
  });

  it("on the cluster still on screen, the toast names none and the lists reload", async () => {
    expect(await mutations.deletePod("default", "api-0")).toBe(true);
    expect(toasts.items.at(-1)?.message).toBe("Pod api-0 deleted");
    await settle();
    expect(listPods).toHaveBeenCalled();
  });
});
