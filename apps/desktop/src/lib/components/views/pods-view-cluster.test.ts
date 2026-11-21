import { describe, it, expect, beforeEach, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, within } from "@testing-library/svelte";
import { flushSync, tick } from "svelte";

vi.mock("#lib/tauri.ts", () => ({
  listContexts: vi.fn(),
  setContext: vi.fn(),
  listPods: vi.fn(async () => []),
  listNamespaces: vi.fn(async () => []),
  listDeployments: vi.fn(async () => []),
  deletePod: vi.fn(async () => undefined),
  restartDeployment: vi.fn(async () => undefined),
  scaleDeployment: vi.fn(async () => undefined),
  getResourceYaml: vi.fn(async () => "kind: Pod\nmetadata:\n  name: api-0\n"),
  applyResourceYaml: vi.fn(async () => undefined),
  listEvents: vi.fn(async () => []),
  listServices: vi.fn(async () => []),
  listIngresses: vi.fn(async () => []),
  listConfigMaps: vi.fn(async () => []),
  listSecrets: vi.fn(async () => []),
  listHelmReleases: vi.fn(async () => []),
  listNodes: vi.fn(async () => []),
  listPodMetrics: vi.fn(async () => []),
  clusterCapacity: vi.fn(async () => []),
  watchResources: vi.fn(),
  unwatchResources: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import PodsView from "./PodsView.svelte";
import { app } from "#lib/stores/app.svelte.ts";
import { clusterSettings } from "#lib/stores/cluster-settings.svelte.ts";
import { resources } from "#lib/stores/resources.svelte.ts";
import { toasts } from "#lib/stores/toasts.svelte.ts";
import { applyResourceYaml, deletePod, type PodInfo } from "#lib/tauri.ts";

// The pod panel and the Delete pod dialog across a cluster switch (#685): an
// action started on prod goes to prod; what is on screen after the switch is
// staging's and is left alone.

const KC = "/home/u/.kube/config";

function pod(overrides: Partial<PodInfo> = {}): PodInfo {
  return {
    name: "api-0",
    namespace: "default",
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
    ...overrides,
  };
}

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
  await tick();
}

/** As clusters.switchCluster does, minus the backend: the switch starts, the context changes, selections reset. */
function switchTo(name: string): void {
  app.connecting = name;
  flushSync();
  app.activeCluster = name;
  app.resetForClusterSwitch();
  app.connecting = null;
  flushSync();
}

const panel = () => screen.getByRole("dialog", { name: "api-0" });
const deleteDialog = () => screen.queryByRole("dialog", { name: "Delete Pod" });

beforeEach(() => {
  vi.clearAllMocks();
  toasts.items = [];
  clusterSettings.reset();
  resources.clear();
  app.view = "pods";
  app.kubeconfigPath = KC;
  app.activeCluster = "prod";
  app.connecting = null;
  app.namespace = null;
  app.podFilter = "";
  app.selectedPod = pod();
});

describe("the Delete pod dialog and a cluster switch", () => {
  it("closes as the switch starts, and deletes nothing", async () => {
    render(PodsView);
    await fireEvent.click(within(panel()).getByRole("button", { name: "Delete" }));
    expect(deleteDialog()).toBeInTheDocument();

    app.connecting = "staging";
    flushSync();
    expect(deleteDialog()).toBeNull();
    switchTo("staging");
    expect(deleteDialog()).toBeNull();
    expect(deletePod).not.toHaveBeenCalled();
  });

  it("a delete already confirmed goes to prod, and leaves the panel opened on staging", async () => {
    const request = deferred();
    vi.mocked(deletePod).mockReturnValueOnce(request.promise);
    render(PodsView);
    await fireEvent.click(within(panel()).getByRole("button", { name: "Delete" }));
    await fireEvent.click(screen.getByRole("button", { name: "Delete Pod" }));

    switchTo("staging");
    // staging's pod of the same name, opened by the user on the new cluster.
    app.selectedPod = pod();
    request.resolve();
    await settle();

    expect(deletePod).toHaveBeenCalledWith(KC, "default", "api-0", "prod");
    expect(toasts.items.at(-1)?.message).toBe("Pod api-0 deleted on prod");
    expect(app.selectedPod).not.toBeNull();
  });

  it("sends one delete when Delete Pod is clicked twice, and says it is running", async () => {
    const request = deferred();
    vi.mocked(deletePod).mockReturnValueOnce(request.promise);
    render(PodsView);
    await fireEvent.click(within(panel()).getByRole("button", { name: "Delete" }));
    const confirm = screen.getByRole("button", { name: "Delete Pod" });
    await fireEvent.click(confirm);
    await fireEvent.click(confirm);
    expect(deletePod).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Delete Pod" })).toHaveAttribute("aria-busy", "true");
    request.resolve();
    await settle();
    expect(deleteDialog()).toBeNull();
  });
});

describe("the panel's Restart across a switch", () => {
  it("goes to prod and leaves the panel opened on staging", async () => {
    const request = deferred();
    vi.mocked(deletePod).mockReturnValueOnce(request.promise);
    render(PodsView);
    await fireEvent.click(within(panel()).getByRole("button", { name: "Restart" }));

    switchTo("staging");
    app.selectedPod = pod();
    request.resolve();
    await settle();

    expect(deletePod).toHaveBeenCalledWith(KC, "default", "api-0", "prod");
    expect(app.selectedPod).not.toBeNull();
  });
});

describe("a YAML apply that runs through a switch", () => {
  async function applying() {
    const request = deferred();
    vi.mocked(applyResourceYaml).mockReturnValueOnce(request.promise);
    render(PodsView);
    await fireEvent.click(within(panel()).getByRole("button", { name: "YAML" }));
    const modal = await screen.findByRole("dialog", { name: "api-0.yaml" });
    await within(modal).findByText(/kind: Pod/);
    await fireEvent.click(within(modal).getByRole("button", { name: "Edit" }));
    await fireEvent.click(within(modal).getByRole("button", { name: "Apply" }));
    // The switch closes the panel, and the modal with it.
    switchTo("staging");
    expect(screen.queryByRole("dialog", { name: "api-0.yaml" })).toBeNull();
    return request;
  }

  it("says in a toast that it was applied on prod", async () => {
    const request = await applying();
    request.resolve();
    await settle();
    expect(applyResourceYaml).toHaveBeenCalledWith(KC, "pod", "default", "api-0", expect.any(String), "prod");
    expect(toasts.items.at(-1)).toMatchObject({ message: "api-0 applied on prod", tone: "ok" });
  });

  it("says in a toast that it failed on prod", async () => {
    const request = await applying();
    request.reject(new Error("conflict"));
    await settle();
    expect(toasts.items.at(-1)).toMatchObject({ message: "Apply on prod failed: conflict", tone: "err" });
  });

  it("on the cluster still on screen, closes without a toast", async () => {
    render(PodsView);
    await fireEvent.click(within(panel()).getByRole("button", { name: "YAML" }));
    const modal = await screen.findByRole("dialog", { name: "api-0.yaml" });
    await within(modal).findByText(/kind: Pod/);
    await fireEvent.click(within(modal).getByRole("button", { name: "Edit" }));
    await fireEvent.click(within(modal).getByRole("button", { name: "Apply" }));
    await settle();
    expect(screen.queryByRole("dialog", { name: "api-0.yaml" })).toBeNull();
    expect(toasts.items).toHaveLength(0);
  });
});
