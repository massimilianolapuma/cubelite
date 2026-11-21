import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("#lib/tauri.ts", () => ({
  CLUSTER_SETTINGS_CHANGED: "cluster-settings-changed",
  clusterSettings: vi.fn(),
  setClusterEnvironment: vi.fn(),
  setEnvironmentVariants: vi.fn(),
  makeClusterWritable: vi.fn(),
  makeClusterReadOnly: vi.fn(),
  setClusterAccessPreferences: vi.fn(),
}));

const listeners = new Map<string, () => void>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: () => void) => {
    listeners.set(name, handler);
    return () => listeners.delete(name);
  }),
}));

import {
  clusterSettings as fetchClusterSettings,
  setClusterEnvironment,
  setEnvironmentVariants,
  makeClusterWritable,
  makeClusterReadOnly,
  setClusterAccessPreferences,
  type ClusterSettings,
  type ContextEnvironment,
} from "#lib/tauri.ts";
import { defaultVariants, environmentLabel } from "#lib/environment.ts";
import { clusterSettings } from "./cluster-settings.svelte";
import { toasts } from "./toasts.svelte";
import { clock } from "./clock.svelte";

function answer(contexts: ContextEnvironment[], recovered = false): ClusterSettings {
  return { contexts, variants: defaultVariants(), recovered, confirm_unlock: true, read_only_from_start: ["production"] };
}

const prod: ContextEnvironment = {
  name: "aks-prod-01-emm",
  environment: "production",
  source: "detected",
  detected: "production",
  access: "read_only",
  writable_until: null,
};
const mini: ContextEnvironment = {
  name: "minikube",
  environment: null,
  source: "detected",
  detected: null,
  access: "writable",
  writable_until: null,
};

/** A promise and the function that resolves it. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  clusterSettings.reset();
  toasts.items = [];
});

describe("environmentLabel", () => {
  it("names each environment and Not set", () => {
    expect(environmentLabel("production")).toBe("Production");
    expect(environmentLabel("development")).toBe("Development");
    expect(environmentLabel(null)).toBe("Not set");
  });
});

describe("clusterSettings store", () => {
  it("load maps contexts by name", async () => {
    vi.mocked(fetchClusterSettings).mockResolvedValue(answer([prod, mini]));
    await clusterSettings.load(["aks-prod-01-emm", "minikube"]);
    expect(fetchClusterSettings).toHaveBeenCalledWith(["aks-prod-01-emm", "minikube"]);
    expect(clusterSettings.environmentOf("aks-prod-01-emm")).toBe("production");
    expect(clusterSettings.sourceOf("aks-prod-01-emm")).toBe("detected");
    expect(clusterSettings.environmentOf("minikube")).toBeNull();
    expect(clusterSettings.byName.minikube).toEqual(mini);
    expect(clusterSettings.variants.production).toContain("prod");
  });

  it("environmentOf unknown name is null", () => {
    expect(clusterSettings.environmentOf("nowhere")).toBeNull();
    expect(clusterSettings.sourceOf("nowhere")).toBeNull();
  });

  it("a load drops the names it was not asked for", async () => {
    vi.mocked(fetchClusterSettings).mockResolvedValueOnce(answer([prod, mini]));
    await clusterSettings.load(["aks-prod-01-emm", "minikube"]);
    vi.mocked(fetchClusterSettings).mockResolvedValueOnce(answer([mini]));
    await clusterSettings.load(["minikube"]);
    expect(Object.keys(clusterSettings.byName)).toEqual(["minikube"]);
  });

  it("stale load is dropped", async () => {
    const first = deferred<ClusterSettings>();
    const second = deferred<ClusterSettings>();
    vi.mocked(fetchClusterSettings).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const a = clusterSettings.load(["aks-prod-01-emm"]);
    const b = clusterSettings.load(["aks-prod-01-emm"]);
    second.resolve(answer([{ ...prod, environment: "test", source: "manual" }]));
    await b;
    first.resolve(answer([prod]));
    await a;
    expect(clusterSettings.environmentOf("aks-prod-01-emm")).toBe("test");
  });

  it("event triggers reload with the last names", async () => {
    vi.mocked(fetchClusterSettings).mockResolvedValue(answer([mini]));
    await clusterSettings.start();
    await clusterSettings.load(["minikube"]);
    vi.mocked(fetchClusterSettings).mockClear();
    vi.mocked(fetchClusterSettings).mockResolvedValue(
      answer([{ ...mini, environment: "development", source: "manual" }]),
    );
    listeners.get("cluster-settings-changed")?.();
    await vi.waitFor(() => expect(clusterSettings.environmentOf("minikube")).toBe("development"));
    expect(fetchClusterSettings).toHaveBeenCalledWith(["minikube"]);
  });

  it("start listens once", async () => {
    const { listen } = await import("@tauri-apps/api/event");
    await clusterSettings.start();
    await clusterSettings.start();
    expect(listen).toHaveBeenCalledTimes(1);
  });

  it("recovered shows one error toast", async () => {
    vi.mocked(fetchClusterSettings).mockResolvedValueOnce(answer([mini], true));
    await clusterSettings.load(["minikube"]);
    vi.mocked(fetchClusterSettings).mockResolvedValueOnce(answer([mini]));
    await clusterSettings.load(["minikube"]);
    expect(toasts.items).toEqual([
      expect.objectContaining({ message: "Cluster settings could not be read and were reset", tone: "err" }),
    ]);
  });

  it("the reset toast is not lost with an answer that came too late", async () => {
    const first = deferred<ClusterSettings>();
    vi.mocked(fetchClusterSettings)
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(answer([mini]));
    const a = clusterSettings.load(["minikube"]);
    await clusterSettings.load(["minikube"]);
    first.resolve(answer([mini], true));
    await a;
    expect(toasts.items).toEqual([
      expect.objectContaining({ message: "Cluster settings could not be read and were reset", tone: "err" }),
    ]);
  });

  it("a failed load keeps what was shown", async () => {
    vi.mocked(fetchClusterSettings).mockResolvedValueOnce(answer([prod]));
    await clusterSettings.load(["aks-prod-01-emm"]);
    vi.mocked(fetchClusterSettings).mockRejectedValueOnce("backend down");
    await clusterSettings.load(["aks-prod-01-emm"]);
    expect(clusterSettings.environmentOf("aks-prod-01-emm")).toBe("production");
  });

  it("an answer without contexts changes nothing and does not throw", async () => {
    vi.mocked(fetchClusterSettings).mockResolvedValueOnce(answer([prod]));
    await clusterSettings.load(["aks-prod-01-emm"]);
    vi.mocked(fetchClusterSettings).mockResolvedValueOnce(null as unknown as ClusterSettings);
    await expect(clusterSettings.load(["aks-prod-01-emm"])).resolves.toBeUndefined();
    expect(clusterSettings.environmentOf("aks-prod-01-emm")).toBe("production");
  });

  it("setEnvironment sends the setting and takes the answer", async () => {
    vi.mocked(fetchClusterSettings).mockResolvedValue(answer([prod, mini]));
    await clusterSettings.load(["aks-prod-01-emm", "minikube"]);
    vi.mocked(setClusterEnvironment).mockResolvedValue(
      answer([{ ...mini, environment: "test", source: "manual" }]),
    );
    await clusterSettings.setEnvironment("minikube", { source: "manual", value: "test" });
    expect(setClusterEnvironment).toHaveBeenCalledWith("minikube", { source: "manual", value: "test" });
    expect(clusterSettings.environmentOf("minikube")).toBe("test");
    expect(clusterSettings.sourceOf("minikube")).toBe("manual");
    expect(clusterSettings.environmentOf("aks-prod-01-emm")).toBe("production");
  });

  it("setEnvironment drops an older load still in flight", async () => {
    const stale = deferred<ClusterSettings>();
    vi.mocked(fetchClusterSettings).mockReturnValueOnce(stale.promise);
    const loading = clusterSettings.load(["minikube"]);
    vi.mocked(setClusterEnvironment).mockResolvedValue(
      answer([{ ...mini, environment: "test", source: "manual" }]),
    );
    await clusterSettings.setEnvironment("minikube", { source: "manual", value: "test" });
    stale.resolve(answer([mini]));
    await loading;
    expect(clusterSettings.environmentOf("minikube")).toBe("test");
  });

  it("setEnvironment failure is a toast", async () => {
    vi.mocked(setClusterEnvironment).mockRejectedValue("disk full");
    expect(await clusterSettings.setEnvironment("minikube", { source: "detected" })).toBe(false);
    expect(toasts.items).toEqual([
      expect.objectContaining({ message: "Could not set the environment: disk full", tone: "err" }),
    ]);
  });

  it("setVariants returns backend error text and leaves variants unchanged", async () => {
    vi.mocked(setEnvironmentVariants).mockRejectedValue('"prod" is already in Production');
    const next = { ...defaultVariants(), test: ["test", "prod"] };
    const error = await clusterSettings.setVariants(next);
    expect(error).toBe('"prod" is already in Production');
    expect(clusterSettings.variants).toEqual(defaultVariants());
  });

  it("setVariants keeps what the backend saved and reloads the labels", async () => {
    vi.mocked(fetchClusterSettings).mockResolvedValue(answer([mini]));
    await clusterSettings.load(["minikube"]);
    const saved = { ...defaultVariants(), production: ["prod", "live"] };
    vi.mocked(setEnvironmentVariants).mockResolvedValue(saved);
    vi.mocked(fetchClusterSettings).mockClear();
    vi.mocked(fetchClusterSettings).mockResolvedValue({ ...answer([mini]), variants: saved });
    const error = await clusterSettings.setVariants({ ...defaultVariants(), production: ["Prod", "LIVE"] });
    expect(error).toBeNull();
    expect(clusterSettings.variants.production).toEqual(["prod", "live"]);
    expect(fetchClusterSettings).toHaveBeenCalledWith(["minikube"]);
  });
});

describe("clusterSettings access (#662)", () => {
  const NOW = Date.parse("2026-11-21T10:00:00Z");
  /** prod unlocked until `until` (the backend: saved read-only, view writable). */
  const timed = (until: number): ContextEnvironment => ({ ...prod, access: "writable", writable_until: until });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    clock.run(false);
    vi.useRealTimers();
  });

  it("starts asking before an unlock, with Production read-only from the start", () => {
    expect(clusterSettings.confirmUnlock).toBe(true);
    expect(clusterSettings.readOnlyFromStart).toEqual(["production"]);
    expect(clusterSettings.pendingUnlock).toBeNull();
  });

  it("load takes the preferences", async () => {
    vi.mocked(fetchClusterSettings).mockResolvedValue({
      ...answer([mini]),
      confirm_unlock: false,
      read_only_from_start: ["staging", "production"],
    });
    await clusterSettings.load(["minikube"]);
    expect(clusterSettings.confirmUnlock).toBe(false);
    expect(clusterSettings.readOnlyFromStart).toEqual(["staging", "production"]);
  });

  it("accessOf tells read-only, writable and writable for a while", async () => {
    const test = { ...mini, name: "aks-test-01-emm" };
    vi.mocked(fetchClusterSettings).mockResolvedValue(
      answer([prod, mini, { ...timed(NOW + 5 * 60_000), name: "aks-stg-01" }, test]),
    );
    await clusterSettings.load(["aks-prod-01-emm", "minikube", "aks-stg-01", "aks-test-01-emm"]);
    expect(clusterSettings.accessOf("aks-prod-01-emm")).toBe("read_only");
    expect(clusterSettings.accessOf("minikube")).toBe("writable");
    expect(clusterSettings.accessOf("aks-stg-01")).toBe("timed");
    expect(clusterSettings.writableUntil("aks-stg-01")).toBe(NOW + 5 * 60_000);
    expect(clusterSettings.writableUntil("minikube")).toBeNull();
    expect(clusterSettings.writableUntil("aks-prod-01-emm")).toBeNull();
    // Unknown to the backend: nothing to show; the backend decides at the write.
    expect(clusterSettings.accessOf("nowhere")).toBe("writable");
  });

  it("timed becomes read_only when the clock passes writable_until, before the backend says so", async () => {
    vi.mocked(fetchClusterSettings).mockResolvedValue(answer([timed(NOW + 60_000)]));
    await clusterSettings.load(["aks-prod-01-emm"]);
    expect(clock.running).toBe(true);
    expect(clusterSettings.accessOf("aks-prod-01-emm")).toBe("timed");
    expect(clusterSettings.lockReason("aks-prod-01-emm")).toBeNull();
    vi.advanceTimersByTime(59_000);
    expect(clusterSettings.accessOf("aks-prod-01-emm")).toBe("timed");
    vi.advanceTimersByTime(1_000);
    expect(clusterSettings.accessOf("aks-prod-01-emm")).toBe("read_only");
    expect(clusterSettings.writableUntil("aks-prod-01-emm")).toBeNull();
    expect(clusterSettings.lockReason("aks-prod-01-emm")).toBe("aks-prod-01-emm is read-only");
  });

  it("the clock runs only while an unlock runs", async () => {
    vi.mocked(fetchClusterSettings).mockResolvedValueOnce(answer([prod, mini]));
    await clusterSettings.load(["aks-prod-01-emm", "minikube"]);
    expect(clock.running).toBe(false);
    vi.mocked(fetchClusterSettings).mockResolvedValueOnce(answer([timed(NOW + 60_000), mini]));
    await clusterSettings.load(["aks-prod-01-emm", "minikube"]);
    expect(clock.running).toBe(true);
    // The backend's event after the end: the unlock is gone, so is the clock.
    vi.mocked(fetchClusterSettings).mockResolvedValueOnce(answer([prod, mini]));
    await clusterSettings.load(["aks-prod-01-emm", "minikube"]);
    expect(clock.running).toBe(false);
  });

  it("lockReason names the read-only cluster, and nothing otherwise", async () => {
    vi.mocked(fetchClusterSettings).mockResolvedValue(answer([prod, mini]));
    await clusterSettings.load(["aks-prod-01-emm", "minikube"]);
    expect(clusterSettings.lockReason("aks-prod-01-emm")).toBe("aks-prod-01-emm is read-only");
    expect(clusterSettings.lockReason("minikube")).toBeNull();
    expect(clusterSettings.lockReason(null)).toBeNull();
  });

  it("requestUnlock with confirm on sets pendingUnlock and calls nothing", async () => {
    await clusterSettings.requestUnlock("aks-prod-01-emm", 15);
    // Nothing has the focus here: nowhere to give it back to.
    expect(clusterSettings.pendingUnlock).toEqual({ name: "aks-prod-01-emm", duration: 15, returnFocus: null });
    expect(makeClusterWritable).not.toHaveBeenCalled();
    expect(setClusterAccessPreferences).not.toHaveBeenCalled();
  });

  it("requestUnlock records where the focus goes back, the opener of a menu", async () => {
    const trigger = document.createElement("button");
    trigger.setAttribute("aria-controls", "durations");
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    menu.id = "durations";
    const item = document.createElement("div");
    item.setAttribute("role", "menuitem");
    item.tabIndex = -1;
    menu.append(item);
    document.body.append(trigger, menu);
    item.focus();
    await clusterSettings.requestUnlock("aks-prod-01-emm", 5);
    expect(clusterSettings.pendingUnlock?.returnFocus).toBe(trigger);
    trigger.remove();
    menu.remove();
  });

  it("confirmPendingUnlock(true) sends makeClusterWritable then setClusterAccessPreferences({confirmUnlock:false})", async () => {
    vi.mocked(makeClusterWritable).mockResolvedValue(answer([timed(NOW + 15 * 60_000)]));
    vi.mocked(setClusterAccessPreferences).mockResolvedValue({ ...answer([]), confirm_unlock: false });
    await clusterSettings.requestUnlock("aks-prod-01-emm", 15);
    await clusterSettings.confirmPendingUnlock(true);
    expect(clusterSettings.pendingUnlock).toBeNull();
    expect(makeClusterWritable).toHaveBeenCalledWith("aks-prod-01-emm", 15);
    expect(setClusterAccessPreferences).toHaveBeenCalledWith({ confirmUnlock: false });
    expect(vi.mocked(makeClusterWritable).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(setClusterAccessPreferences).mock.invocationCallOrder[0],
    );
    expect(clusterSettings.accessOf("aks-prod-01-emm")).toBe("timed");
    expect(clusterSettings.confirmUnlock).toBe(false);
  });

  it("confirmPendingUnlock(false) leaves the preference alone", async () => {
    vi.mocked(makeClusterWritable).mockResolvedValue(answer([{ ...prod, access: "writable" }]));
    await clusterSettings.requestUnlock("aks-prod-01-emm", "always");
    await clusterSettings.confirmPendingUnlock(false);
    expect(makeClusterWritable).toHaveBeenCalledWith("aks-prod-01-emm", "always");
    expect(setClusterAccessPreferences).not.toHaveBeenCalled();
    expect(clusterSettings.accessOf("aks-prod-01-emm")).toBe("writable");
  });

  it("confirmPendingUnlock with nothing pending does nothing", async () => {
    await clusterSettings.confirmPendingUnlock(true);
    expect(makeClusterWritable).not.toHaveBeenCalled();
    expect(setClusterAccessPreferences).not.toHaveBeenCalled();
  });

  it("requestUnlock with confirm off calls makeClusterWritable at once", async () => {
    vi.mocked(fetchClusterSettings).mockResolvedValue({ ...answer([prod]), confirm_unlock: false });
    await clusterSettings.load(["aks-prod-01-emm"]);
    vi.mocked(makeClusterWritable).mockResolvedValue(answer([timed(NOW + 5 * 60_000)]));
    await clusterSettings.requestUnlock("aks-prod-01-emm", 5);
    expect(clusterSettings.pendingUnlock).toBeNull();
    expect(makeClusterWritable).toHaveBeenCalledWith("aks-prod-01-emm", 5);
    expect(clusterSettings.accessOf("aks-prod-01-emm")).toBe("timed");
  });

  it("cancelPendingUnlock clears", async () => {
    await clusterSettings.requestUnlock("aks-prod-01-emm", 60);
    clusterSettings.cancelPendingUnlock();
    expect(clusterSettings.pendingUnlock).toBeNull();
    expect(makeClusterWritable).not.toHaveBeenCalled();
  });

  it("makeReadOnly calls makeClusterReadOnly and takes the answer", async () => {
    vi.mocked(fetchClusterSettings).mockResolvedValue(answer([prod, mini]));
    await clusterSettings.load(["aks-prod-01-emm", "minikube"]);
    vi.mocked(makeClusterReadOnly).mockResolvedValue(answer([{ ...mini, access: "read_only" }]));
    expect(await clusterSettings.makeReadOnly("minikube")).toBe(true);
    expect(makeClusterReadOnly).toHaveBeenCalledWith("minikube");
    expect(clusterSettings.accessOf("minikube")).toBe("read_only");
    expect(clusterSettings.accessOf("aks-prod-01-emm")).toBe("read_only");
  });

  it("makeReadOnly that could not be saved holds for the session and says so", async () => {
    vi.mocked(fetchClusterSettings).mockResolvedValue(answer([mini]));
    await clusterSettings.load(["minikube"]);
    vi.mocked(makeClusterReadOnly).mockResolvedValue({
      ...answer([{ ...mini, access: "read_only" }]),
      save_error: "Read-only file system (os error 30)",
    });
    expect(await clusterSettings.makeReadOnly("minikube")).toBe(true);
    expect(clusterSettings.accessOf("minikube")).toBe("read_only");
    expect(toasts.items.map((t) => [t.message, t.tone])).toEqual([
      ["Made read-only for this session; could not save: Read-only file system (os error 30)", "warn"],
    ]);
  });

  it("makeReadOnly drops an older load still in flight", async () => {
    const stale = deferred<ClusterSettings>();
    vi.mocked(fetchClusterSettings).mockReturnValueOnce(stale.promise);
    const loading = clusterSettings.load(["minikube"]);
    vi.mocked(makeClusterReadOnly).mockResolvedValue(answer([{ ...mini, access: "read_only" }]));
    await clusterSettings.makeReadOnly("minikube");
    stale.resolve(answer([mini]));
    await loading;
    expect(clusterSettings.accessOf("minikube")).toBe("read_only");
  });

  it("a refused change is an error toast with readable text", async () => {
    vi.useRealTimers();
    vi.mocked(fetchClusterSettings).mockResolvedValue({ ...answer([prod]), confirm_unlock: false });
    await clusterSettings.load(["aks-prod-01-emm"]);
    vi.mocked(makeClusterWritable).mockRejectedValue("disk full");
    await clusterSettings.requestUnlock("aks-prod-01-emm", 5);
    vi.mocked(makeClusterReadOnly).mockRejectedValue({
      kind: "no_context",
      message: "No cluster was named for this change.",
    });
    expect(await clusterSettings.makeReadOnly("minikube")).toBe(false);
    vi.mocked(setClusterAccessPreferences).mockRejectedValue("The cluster settings are not loaded yet.");
    await clusterSettings.setAccessPreferences({ confirmUnlock: true });
    expect(toasts.items.map((t) => [t.message, t.tone])).toEqual([
      ["Could not make aks-prod-01-emm writable: disk full", "err"],
      ["Could not make minikube read-only: No cluster was named for this change.", "err"],
      ["Could not save the setting: The cluster settings are not loaded yet.", "err"],
    ]);
    expect(clusterSettings.accessOf("aks-prod-01-emm")).toBe("read_only");
    expect(clusterSettings.confirmUnlock).toBe(false);
  });

  it("setAccessPreferences sends what changed and keeps the contexts it was not answered", async () => {
    vi.mocked(fetchClusterSettings).mockResolvedValue(answer([prod, mini]));
    await clusterSettings.load(["aks-prod-01-emm", "minikube"]);
    vi.mocked(setClusterAccessPreferences).mockResolvedValue({
      ...answer([]),
      read_only_from_start: ["test", "production"],
    });
    await clusterSettings.setAccessPreferences({ readOnlyFromStart: ["test", "production"] });
    expect(setClusterAccessPreferences).toHaveBeenCalledWith({ readOnlyFromStart: ["test", "production"] });
    expect(clusterSettings.readOnlyFromStart).toEqual(["test", "production"]);
    expect(Object.keys(clusterSettings.byName)).toEqual(["aks-prod-01-emm", "minikube"]);
  });
});
