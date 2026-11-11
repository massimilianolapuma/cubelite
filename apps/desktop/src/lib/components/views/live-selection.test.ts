import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, within } from "@testing-library/svelte";

vi.mock("#lib/tauri.ts", () => ({
  listPods: vi.fn(async () => []),
  listNamespaces: vi.fn(async () => []),
  listDeployments: vi.fn(async () => []),
  listEvents: vi.fn(async () => []),
  listPodMetrics: vi.fn(async () => []),
  clusterCapacity: vi.fn(async () => []),
  deletePod: vi.fn(async () => undefined),
  restartDeployment: vi.fn(async () => undefined),
  scaleDeployment: vi.fn(async () => undefined),
  watchResources: vi.fn(),
  unwatchResources: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import DeploymentsView from "./DeploymentsView.svelte";
import PodsView from "./PodsView.svelte";
import { app } from "#lib/stores/app.svelte.ts";
import { lists } from "#lib/stores/lists.svelte.ts";
import { SCALE_DEBOUNCE_MS } from "#lib/stores/mutations.svelte.ts";
import { resources } from "#lib/stores/resources.svelte.ts";
import { listDeployments, listPods, scaleDeployment, type DeploymentInfo, type PodInfo } from "#lib/tauri.ts";

const pod = (overrides: Partial<PodInfo> = {}): PodInfo =>
  ({
    name: "worker-0",
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
  }) as PodInfo;

const dep = (replicas: number): DeploymentInfo => ({
  name: "api",
  namespace: "default",
  replicas,
  ready_replicas: replicas,
  images: [],
  selector: { app: "api" },
  strategy: null,
  conditions: [],
  creation_timestamp: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  app.kubeconfigPath = "/k";
  app.activeCluster = "prod";
  app.namespace = "default";
  app.view = "pods";
  app.selectedPod = null;
  app.selectedDeployment = null;
  app.podFilter = "";
  app.deploymentFilter = "";
  lists.resetSession();
  resources.clear();
});
afterEach(() => vi.useRealTimers());

const panel = (name: string) => screen.getByRole("dialog", { name });
const tile = (root: HTMLElement, label: string) =>
  within(root).getByText(label, { selector: "[data-tone] *" }).closest("[data-tone]")!;

describe("the panel shows the live object, not the one clicked", () => {
  it("a deployment scaled elsewhere is scaled on from its new count, not from the count at the click", async () => {
    vi.useFakeTimers();
    vi.mocked(listDeployments).mockResolvedValue([dep(2)]);
    await resources.load();
    render(DeploymentsView);
    await fireEvent.click(screen.getByText("api"));
    expect(tile(panel("api"), "Ready")).toHaveTextContent("2/2");

    vi.mocked(listDeployments).mockResolvedValue([dep(5)]);
    await resources.load();
    await vi.waitFor(() => expect(tile(panel("api"), "Ready")).toHaveTextContent("5/5"));

    await fireEvent.click(within(panel("api")).getByRole("button", { name: "Scale up" }));
    await vi.advanceTimersByTimeAsync(SCALE_DEBOUNCE_MS);
    expect(scaleDeployment).toHaveBeenCalledWith("/k", "default", "api", 6, "prod");
  });

  it("a pod that became ready no longer shows the hero it had when it was clicked", async () => {
    vi.mocked(listPods).mockResolvedValue([pod({ phase: "Pending", ready: false, ready_containers: 0 })]);
    await resources.load();
    render(PodsView);
    await fireEvent.click(screen.getByText("worker-0"));
    expect(panel("worker-0").querySelector("[data-hero]")).toHaveAttribute("data-hero", "warning");

    vi.mocked(listPods).mockResolvedValue([pod()]);
    await resources.load();
    await vi.waitFor(() => expect(panel("worker-0").querySelector("[data-hero]")).toHaveAttribute("data-hero", "none"));
  });

  it("closes the panel of a pod that is gone", async () => {
    vi.mocked(listPods).mockResolvedValue([pod(), pod({ name: "other" })]);
    await resources.load();
    render(PodsView);
    await fireEvent.click(screen.getByText("worker-0"));
    expect(panel("worker-0")).toBeInTheDocument();

    vi.mocked(listPods).mockResolvedValue([pod({ name: "other" })]);
    await resources.load();
    await vi.waitFor(() => expect(screen.queryByRole("dialog", { name: "worker-0" })).toBeNull());
    expect(app.selectedPod).toBeNull();
  });

  it("keeps the panel open while a reload is failing: the object may still be there", async () => {
    vi.mocked(listPods).mockResolvedValue([pod()]);
    await resources.load();
    render(PodsView);
    await fireEvent.click(screen.getByText("worker-0"));
    vi.mocked(listPods).mockRejectedValueOnce(new Error("timeout"));
    await resources.load();
    expect(panel("worker-0")).toBeInTheDocument();
  });
});
