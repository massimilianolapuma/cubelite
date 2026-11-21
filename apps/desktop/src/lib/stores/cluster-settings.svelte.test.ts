import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("#lib/tauri.ts", () => ({
  CLUSTER_SETTINGS_CHANGED: "cluster-settings-changed",
  clusterSettings: vi.fn(),
  setClusterEnvironment: vi.fn(),
  setEnvironmentVariants: vi.fn(),
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
  type ClusterSettings,
  type ContextEnvironment,
} from "#lib/tauri.ts";
import { defaultVariants, environmentLabel } from "#lib/environment.ts";
import { clusterSettings } from "./cluster-settings.svelte";
import { toasts } from "./toasts.svelte";

function answer(contexts: ContextEnvironment[], recovered = false): ClusterSettings {
  return { contexts, variants: defaultVariants(), recovered };
}

const prod: ContextEnvironment = { name: "aks-prod-01-emm", environment: "production", source: "detected" };
const mini: ContextEnvironment = { name: "minikube", environment: null, source: "detected" };

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
    await clusterSettings.setEnvironment("minikube", { source: "detected" });
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
