import { describe, it, expect, beforeEach, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, within } from "@testing-library/svelte";

vi.mock("#lib/tauri.ts", () => ({
  listContexts: vi.fn(),
  setContext: vi.fn(),
  listPods: vi.fn(),
  listNamespaces: vi.fn(),
  listDeployments: vi.fn(),
  deletePod: vi.fn(async () => undefined),
  restartDeployment: vi.fn(async () => undefined),
  scaleDeployment: vi.fn(async () => undefined),
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

import EmptyStateView from "./EmptyStateView.svelte";
import UnreachableView from "./UnreachableView.svelte";
import EventsView from "./EventsView.svelte";
import OverviewView from "./OverviewView.svelte";
import AllClustersView from "./AllClustersView.svelte";
import PodsView from "./PodsView.svelte";
import PodDrawer from "#lib/components/pods/PodDrawer.svelte";
import { app } from "#lib/stores/app.svelte.ts";
import { clusters } from "#lib/stores/clusters.svelte.ts";
import { resources } from "#lib/stores/resources.svelte.ts";
import { health } from "#lib/stores/health.svelte.ts";
import { listEvents, listNamespaces, listPods, type EventInfo, type PodInfo } from "#lib/tauri.ts";
import { lists } from "#lib/stores/lists.svelte.ts";

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

beforeEach(() => {
  app.view = "overview";
  app.activeCluster = "prod";
  app.namespace = null;
  app.selectedPod = null;
  app.selectedDeployment = null;
  app.podFilter = "";
  lists.resetSession();
  lists.groupByNamespace = false;
  app.deploymentFilter = "";
  clusters.contexts = [
    { name: "prod", cluster_server: "https://prod:6443", namespace: "default", is_active: true },
    { name: "staging", cluster_server: "https://staging:6443", namespace: "default", is_active: false },
  ];
  clusters.identityColors = { prod: "blue", staging: "magenta" };
  clusters.loaded = true;
  clusters.error = null;
  health.byContext = {};
  clusters.connectionState = "connected";
  clusters.unreachableReason = null;
  resources.pods = [];
  resources.namespaces = [];
  resources.deployments = [];
  resources.events = [];
  resources.clear();
  health.byContext = {};
});

describe("EmptyStateView", () => {
  it("renders the message centered in disabled text", () => {
    render(EmptyStateView, { props: { message: "The Services view requires backend support" } });
    expect(screen.getByText(/Services view/)).toBeInTheDocument();
  });
});

describe("UnreachableView", () => {
  it("shows server, reason and both actions", async () => {
    clusters.connectionState = "unreachable";
    clusters.unreachableReason = "connection timed out";
    render(UnreachableView);
    // A failure hero: the square, the state as the view's title, the reason under it.
    const title = screen.getByRole("heading", { level: 1, name: "Cluster unreachable" });
    const hero = title.closest("[data-hero]")!;
    expect(hero).toHaveAttribute("data-hero", "error");
    expect(hero.querySelector("svg[data-glyph]")).toHaveAttribute("data-glyph", "err");
    expect(hero).toHaveTextContent("connection timed out");
    expect(screen.getByText("https://prod:6443")).toBeInTheDocument();
    // Retry is the one primary action; All Clusters is text.
    expect(screen.getByRole("button", { name: "Retry" })).toHaveAttribute("data-variant", "primary");
    expect(screen.getByRole("button", { name: "All Clusters" })).toHaveAttribute("data-variant", "text");
  });

  it("Retry shows it is running and does not start a second retry", async () => {
    let done: () => void = () => {};
    const retry = vi.spyOn(clusters, "retry").mockReturnValue(new Promise<void>((resolve) => (done = resolve)));
    render(UnreachableView);
    const button = screen.getByRole("button", { name: "Retry" });
    await fireEvent.click(button);
    expect(button).toHaveAttribute("aria-busy", "true");
    await fireEvent.click(button);
    expect(retry).toHaveBeenCalledOnce();
    done();
    await vi.waitFor(() => expect(button).not.toHaveAttribute("aria-busy"));
    retry.mockRestore();
    await fireEvent.click(screen.getByText("All Clusters"));
    expect(app.view).toBe("dashboard");
  });
});

describe("OverviewView", () => {
  it("shows real stats, metrics caption and recent warning events", () => {
    resources.pods = [pod(), pod({ name: "api-1", ready: false, phase: "Pending" })];
    resources.deployments = [{ name: "api", namespace: "default", replicas: 2, ready_replicas: 1, images: [], selector: {}, strategy: null, conditions: [], creation_timestamp: null }];
    resources.events = [
      {
        event_type: "Warning",
        reason: "FailedScheduling",
        object: "Pod/api-1",
        message: "0/3 nodes are available",
        namespace: "default",
        count: 1,
        last_timestamp: null,
      },
    ];
    render(OverviewView);
    expect(screen.getByText("Nodes")).toBeInTheDocument();
    expect(screen.getByText("Pods running")).toBeInTheDocument();
    expect(screen.getByText(/Metrics unavailable/)).toBeInTheDocument();
    expect(screen.getByText("Recent warnings")).toBeInTheDocument();
    expect(screen.getByText("Pod/api-1")).toBeInTheDocument();
    expect(screen.getByText("0/3 nodes are available")).toBeInTheDocument();
    // A recent warning is told by its triangle, not by a coloured dot.
    const row = screen.getByText("Pod/api-1").closest("button")!;
    expect(row.querySelector("svg[data-glyph]")).toHaveAttribute("data-glyph", "warn");
  });

  it("marks a summary count that needs attention by shape and weight, and leaves a zero plain", () => {
    resources.pods = [pod(), pod({ name: "api-1", ready: false, phase: "Pending" })];
    render(OverviewView);
    const value = (label: string) =>
      within(screen.getByRole("region", { name: "Pods" })).getByText(label).nextElementSibling as HTMLElement;
    expect(value("Pending")).toHaveAttribute("data-attention", "warn");
    expect(value("Pending").querySelector("svg[data-glyph]")).toHaveAttribute("data-glyph", "warn");
    expect(value("Failed")).toHaveAttribute("data-attention", "none");
    expect(value("Failed").querySelector("svg")).toBeNull();
    expect(value("Running")).toHaveAttribute("data-attention", "none");
    expect(value("Pending").getAttribute("style")).toBeNull();
  });

  it("gives the resource cards no colour of their own", () => {
    render(OverviewView);
    for (const icon of screen.getByTestId("resource-grid").querySelectorAll("h2")) {
      expect(icon.previousElementSibling?.getAttribute("style")).toBeNull();
    }
  });

  it("shows running/total and healthy/total in the stat row", () => {
    resources.pods = [pod(), pod({ name: "api-1", phase: "Pending" })];
    resources.deployments = [{ name: "api", namespace: "default", replicas: 2, ready_replicas: 1, images: [], selector: {}, strategy: null, conditions: [], creation_timestamp: null }];
    render(OverviewView);
    expect(screen.getByText("1/2")).toBeInTheDocument();
    expect(screen.getByText("Deploys healthy")).toBeInTheDocument();
    expect(screen.getByText("0/1")).toBeInTheDocument();
  });

  it("renders the resource grid and loads its kinds on mount", async () => {
    app.kubeconfigPath = "/home/u/.kube/config";
    render(OverviewView);
    const grid = screen.getByTestId("resource-grid");
    for (const title of ["Pods", "Deployments", "Services", "Namespaces", "Secrets", "ConfigMaps", "Ingresses", "Helm Releases"]) {
      expect(grid).toHaveTextContent(title);
    }
    await vi.waitFor(() => expect(resources.kindCount("services")).toBe(0));
  });

  it("shows the forbidden badge for a kind RBAC denies", async () => {
    resources.forbiddenKinds = new Set(["secrets"]);
    render(OverviewView);
    expect(screen.getByRole("region", { name: "Secrets" })).toHaveTextContent("forbidden");
    expect(screen.getAllByTestId("forbidden-badge")).toHaveLength(1);
    // Unknown, not a warning: the dashed ring.
    expect(screen.getByTestId("forbidden-badge").querySelector("svg[data-glyph]")).toHaveAttribute("data-glyph", "unknown");
  });

  it("adds absolute capacity sub-labels when metrics are available", () => {
    resources.metricsAvailable = true;
    resources.nodes = [{ name: "n1", cpu_used_millis: 1200, cpu_allocatable_millis: 4000, memory_used_bytes: 2 * 1024 ** 3, memory_allocatable_bytes: 8 * 1024 ** 3 }];
    render(OverviewView);
    expect(screen.getByText("1.2 / 4.0 cores")).toBeInTheDocument();
    expect(screen.getByText("2.0 / 8.0 GiB")).toBeInTheDocument();
  });
});

describe("AllClustersView", () => {
  it("renders a card per context with honest unknown state for inactive ones", () => {
    render(AllClustersView);
    expect(screen.getByText("prod")).toBeInTheDocument();
    expect(screen.getByText("staging")).toBeInTheDocument();
    expect(screen.getByText("Healthy")).toBeInTheDocument();
    expect(screen.getByText("Unknown")).toBeInTheDocument();
  });

  it("aggregates stats across clusters and shows bars on every online card", () => {
    resources.pods = [pod(), pod({ name: "api-1", ready: false, phase: "Pending" })];
    health.byContext = {
      staging: {
        state: "connected",
        version: "v1.31.0",
        nodeCount: 2,
        podCount: 30,
        issuePodCount: 3,
        capacity: {
          cpu_used_millis: 500,
          cpu_allocatable_millis: 2000,
          memory_used_bytes: 1,
          memory_allocatable_bytes: 4,
        },
        reason: null,
        lastSeen: null,
      },
    };
    render(AllClustersView);
    expect(screen.getByText("Clusters online")).toBeInTheDocument();
    expect(screen.getByText("Contexts watched")).toBeInTheDocument();
    // 2 live pods on prod + 30 probed on staging.
    expect(screen.getByText("2 contexts · 32 pods")).toBeInTheDocument();
    expect(screen.getByText("32")).toBeInTheDocument();
    // 1 live issue pod on prod + 3 on staging.
    expect(screen.getByText("4")).toBeInTheDocument();
    // staging has probe capacity; prod has no metrics loaded.
    expect(screen.getAllByText("CPU")).toHaveLength(1);
    expect(screen.getByText("metrics unavailable")).toBeInTheDocument();
  });

  it("tints every card with its own cluster's colour", () => {
    render(AllClustersView);
    const card = (name: string) => screen.getByText(name).closest<HTMLElement>("[data-tint]")!;
    expect(card("prod").getAttribute("style")).toContain("--cl-tint-h: var(--cl-hue-blue)");
    expect(card("staging").getAttribute("style")).toContain("--cl-tint-h: var(--cl-hue-magenta)");
  });

  it("tells health by shape: healthy a circle, unknown a dashed ring, unreachable a square with when it was last seen", () => {
    health.byContext = {
      staging: { state: "unreachable", version: null, nodeCount: null, podCount: null, issuePodCount: null, capacity: null, reason: "dial tcp: i/o timeout", lastSeen: "2020-01-01T00:00:00Z" },
    };
    render(AllClustersView);
    const card = (name: string) => screen.getByText(name).closest<HTMLElement>("[data-tint]")!;
    const glyph = (name: string) => card(name).querySelector("[data-state] svg[data-glyph]")?.getAttribute("data-glyph");
    expect(glyph("prod")).toBe("ok");
    expect(glyph("staging")).toBe("err");
    expect(within(card("staging")).getByTestId("unreachable-detail")).toHaveTextContent(/^Last seen \d+d ago · dial tcp: i\/o timeout$/);
    expect(within(card("staging")).getByTestId("unreachable-detail").getAttribute("style")).toBeNull();
  });

  it("marks a cluster's warnings above zero by shape and weight", () => {
    resources.pods = [pod({ ready: false, phase: "Pending" })];
    render(AllClustersView);
    const prod = screen.getByText("prod").closest<HTMLElement>("[data-tint]")!;
    const warnings = within(prod).getByText("Attention").nextElementSibling!;
    expect(warnings).toHaveAttribute("data-attention", "true");
    expect(warnings.querySelector("svg[data-glyph]")).toHaveAttribute("data-glyph", "warn");
  });

  it("with no context at all says where clusters come from and opens Preferences on the kubeconfig files", async () => {
    clusters.contexts = [];
    clusters.loaded = true;
    app.preferencesOpen = false;
    render(AllClustersView);
    expect(screen.getByRole("heading", { name: "No clusters yet" })).toBeInTheDocument();
    expect(screen.getByTestId("no-clusters")).toHaveTextContent("~/.kube/config");
    expect(screen.queryByText("Clusters online")).toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: "Open Preferences" }));
    expect(app.preferencesOpen).toBe(true);
    expect(app.preferencesSection).toBe("kubeconfig");
    app.preferencesOpen = false;
    app.preferencesSection = null;
  });

  it("does not say there are no clusters before the kubeconfig has been read", () => {
    clusters.contexts = [];
    clusters.loaded = false;
    render(AllClustersView);
    expect(screen.queryByText("No clusters yet")).toBeNull();
    expect(screen.getByRole("status", { name: "Loading clusters" })).toBeInTheDocument();
    clusters.loaded = true;
  });

  it("shows why the kubeconfig could not be read, instead of saying there are no clusters", () => {
    clusters.contexts = [];
    clusters.loaded = true;
    clusters.error = "invalid YAML at line 12";
    render(AllClustersView);
    expect(screen.getByRole("alert")).toHaveTextContent("Could not read the kubeconfig");
    expect(screen.getByRole("alert")).toHaveTextContent("invalid YAML at line 12");
    expect(screen.queryByText("No clusters yet")).toBeNull();
    clusters.error = null;
  });

  it("gives every card a disc that shows on the card, and a name that says the cluster and its health", () => {
    render(AllClustersView);
    const staging = screen.getByText("staging").closest<HTMLElement>("[data-tint]")!;
    expect(staging).toHaveAccessibleName("staging, Unknown");
    // The inactive disc is not the card's own surface.
    expect(within(staging).getByTestId("identity-avatar")).toHaveAttribute("data-surface", "container");
  });

  it("counts pods needing attention under that name, not as warnings", () => {
    resources.pods = [pod({ ready: false, phase: "Pending" })];
    render(AllClustersView);
    expect(screen.getByText("Pods needing attention")).toBeInTheDocument();
    expect(screen.queryByText("Warnings")).toBeNull();
    const prod = screen.getByText("prod").closest<HTMLElement>("[data-tint]")!;
    expect(prod).toHaveAccessibleName("prod, Healthy, 1 pod needs attention");
  });

  it("does not warn about clusters online while the others are only not probed yet", () => {
    render(AllClustersView);
    const tile = screen.getByText("Clusters online").closest("[data-tone]")!;
    expect(tile).toHaveAttribute("data-tone", "none");
  });

  it("warns about clusters online when one is unreachable", () => {
    health.byContext = {
      staging: { state: "unreachable", version: null, nodeCount: null, podCount: null, issuePodCount: null, capacity: null, reason: null, lastSeen: null },
    };
    render(AllClustersView);
    expect(screen.getByText("Clusters online").closest("[data-tone]")).toHaveAttribute("data-tone", "warn");
  });

  it("shows a long version whole in a tooltip", () => {
    health.byContext = {
      staging: { state: "connected", version: "v1.29.6-eks-db838b0", nodeCount: 1, podCount: 1, issuePodCount: 0, capacity: null, reason: null, lastSeen: null },
    };
    render(AllClustersView);
    expect(screen.getByText("v1.29.6-eks-db838b0")).toHaveAttribute("title", "v1.29.6-eks-db838b0");
  });

  it("navigates to overview when clicking the active cluster card", async () => {
    app.view = "dashboard";
    render(AllClustersView);
    await fireEvent.click(screen.getByText("prod"));
    expect(app.view).toBe("overview");
  });
});

/** Loads pods and events through the store, as the app does on connect. */
async function loadMain(data: { pods?: PodInfo[]; events?: EventInfo[] }) {
  const kubeconfig = app.kubeconfigPath;
  const view = app.view;
  app.kubeconfigPath = "/home/u/.kube/config";
  app.view = "pods";
  vi.mocked(listPods).mockResolvedValueOnce(data.pods ?? []);
  vi.mocked(listNamespaces).mockResolvedValueOnce([]);
  vi.mocked(listEvents).mockResolvedValueOnce(data.events ?? []);
  await resources.load();
  app.kubeconfigPath = kubeconfig;
  app.view = view;
}

const statusChip = (name: RegExp) =>
  within(screen.getByRole("group", { name: "Filter by status" })).getByRole("button", { name });

describe("PodsView", () => {
  it("filters pods and opens the drawer on row click", async () => {
    await loadMain({ pods: [pod(), pod({ name: "worker-0" })] });
    render(PodsView);
    const input = screen.getByPlaceholderText("Filter pods…");
    await fireEvent.input(input, { target: { value: "worker" } });
    expect(screen.queryByText("api-0")).toBeNull();
    await fireEvent.click(screen.getByText("worker-0"));
    expect(app.selectedPod?.name).toBe("worker-0");
  });
});

describe("PodsView load states (#606)", () => {
  it("shows placeholder rows until pods have loaded, then the rows", async () => {
    resources.clear();
    render(PodsView);
    expect(screen.getByRole("status", { name: "Loading pods" })).toBeInTheDocument();
    expect(screen.queryByText(/^No pods/)).toBeNull();
    await loadMain({ pods: [pod()] });
    expect(await screen.findByText("api-0")).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "Loading pods" })).toBeNull();
  });

  it("shows a failed refresh as an error with Retry, not as an empty list", async () => {
    await loadMain({ pods: [pod()] });
    app.kubeconfigPath = "/home/u/.kube/config";
    vi.mocked(listPods).mockRejectedValueOnce(new Error("connection reset"));
    vi.mocked(listNamespaces).mockResolvedValueOnce([]);
    await resources.load();
    render(PodsView);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Could not load pods");
    expect(alert).toHaveTextContent("connection reset");

    vi.mocked(listPods).mockResolvedValueOnce([pod()]);
    vi.mocked(listNamespaces).mockResolvedValueOnce([]);
    await fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("api-0")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    app.kubeconfigPath = "";
  });

  it("says metrics are unavailable when the cluster has no metrics-server", async () => {
    const { listPodMetrics } = await import("#lib/tauri.ts");
    vi.mocked(listPodMetrics).mockRejectedValueOnce(new Error("no metrics-server"));
    await loadMain({ pods: [pod()] });
    render(PodsView);
    expect(await screen.findByTestId("metrics-notice")).toHaveTextContent("CPU and memory are unavailable");
  });
});

describe("each main list shows its own failure (#606)", () => {
  it("Events says it could not load, instead of looking empty", async () => {
    app.kubeconfigPath = "/home/u/.kube/config";
    vi.mocked(listPods).mockResolvedValueOnce([pod()]);
    vi.mocked(listNamespaces).mockResolvedValueOnce([]);
    vi.mocked(listEvents).mockRejectedValueOnce(new Error("etcd timeout"));
    await resources.load();
    app.kubeconfigPath = "";
    render(EventsView);
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load events");
    expect(screen.getByRole("alert")).toHaveTextContent("etcd timeout");
    expect(screen.queryByText(/^No events/)).toBeNull();
  });

  it("Pods still lists when only events failed", async () => {
    app.kubeconfigPath = "/home/u/.kube/config";
    vi.mocked(listPods).mockResolvedValueOnce([pod()]);
    vi.mocked(listNamespaces).mockResolvedValueOnce([]);
    vi.mocked(listEvents).mockRejectedValueOnce(new Error('events is forbidden: User "dev" cannot list'));
    await resources.load();
    app.kubeconfigPath = "";
    render(PodsView);
    expect(screen.getByText("api-0")).toBeInTheDocument();
    expect(screen.queryByText(/not allowed/)).toBeNull();
  });
});

describe("PodsView status chips (#574, Tonal §3 #7)", () => {
  it("Failing and Pending show the pods needing attention, combined with the text filter", async () => {
    await loadMain({
      pods: [pod(), pod({ name: "api-1", ready: false, phase: "Pending" }), pod({ name: "worker-0", restarts: 9 })],
    });
    render(PodsView);
    expect(statusChip(/Failing/)).toHaveAttribute("aria-pressed", "false");
    expect(statusChip(/Failing/)).toHaveTextContent("1");
    expect(statusChip(/Pending/)).toHaveTextContent("1");
    await fireEvent.click(statusChip(/Failing/));
    await fireEvent.click(statusChip(/Pending/));
    expect(lists.pressed("pods")).toEqual(["err", "warn"]);
    expect(screen.queryByText("api-0")).toBeNull();
    expect(screen.getByText("api-1")).toBeInTheDocument();
    expect(screen.getByText("worker-0")).toBeInTheDocument();
    await fireEvent.input(screen.getByPlaceholderText("Filter pods…"), { target: { value: "worker" } });
    expect(screen.queryByText("api-1")).toBeNull();
    expect(screen.getByText("worker-0")).toBeInTheDocument();
  });

  it("has no Failing or Pending chip when every pod is fine", async () => {
    await loadMain({ pods: [pod()] });
    render(PodsView);
    const group = screen.getByRole("group", { name: "Filter by status" });
    expect(within(group).getAllByRole("button").map((b) => b.textContent?.replace(/\s+/g, " ").trim())).toEqual(["Running 1"]);
  });

  it("the chips are released on context switch", () => {
    lists.setStatus("pods", ["err", "warn"]);
    lists.setStatus("events", ["warning"]);
    app.resetForClusterSwitch();
    expect(lists.pressed("pods")).toEqual([]);
    expect(lists.pressed("events")).toEqual([]);
  });
});

// The pod panel's content is covered in components/panels.test.ts.
describe("PodDrawer in the app shell", () => {
  it("renders into the app's panel host, beside the list card", () => {
    const host = document.createElement("div");
    host.setAttribute("data-drawer-host", "");
    document.body.appendChild(host);
    try {
      render(PodDrawer, { props: { pod: pod(), onClose: vi.fn() } });
      expect(host.querySelector('[role="dialog"]')).not.toBeNull();
    } finally {
      host.remove();
    }
  });

  it("closes via the header button", async () => {
    const onClose = vi.fn();
    render(PodDrawer, { props: { pod: pod(), onClose } });
    await fireEvent.click(screen.getByLabelText("Close"));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("EventsView", () => {
  it("renders the warning as a pill on an untinted row, and the count suffix", async () => {
    const events: EventInfo[] = [
      {
        event_type: "Warning",
        reason: "BackOff",
        object: "Pod/api-0",
        message: "Back-off restarting failed container",
        namespace: "default",
        count: 7,
        last_timestamp: null,
      },
      {
        event_type: "Normal",
        reason: "Scheduled",
        object: "Pod/api-1",
        message: "Successfully assigned default/api-1",
        namespace: "default",
        count: 1,
        last_timestamp: null,
      },
    ];
    await loadMain({ events });
    render(EventsView);
    for (const h of ["Type", "Reason", "Object", "Message", "Age"]) {
      expect(screen.getByText(h)).toBeInTheDocument();
    }
    expect(screen.getByText(/BackOff ×7/)).toBeInTheDocument();
    const warningRow = screen.getByText("Pod/api-0").closest<HTMLElement>("[data-event-type]")!;
    const pill = within(warningRow).getByText("Warning").closest("[data-state]")!;
    expect(pill).toHaveAttribute("data-state", "warn");
    expect(pill.querySelector("svg[data-glyph]")).toHaveAttribute("data-glyph", "warn");
    expect(warningRow.getAttribute("style")).toBeNull();
    const normalRow = screen.getByText("Pod/api-1").closest<HTMLElement>("[data-event-type]")!;
    expect(within(normalRow).getByText("Normal").closest("[data-state]")).toBeNull();
  });

  it("shows the empty state", async () => {
    await loadMain({});
    render(EventsView);
    expect(screen.getByRole("heading", { name: "No events in any namespace" })).toBeInTheDocument();
  });

  it("shows placeholder rows until events have loaded (#606)", () => {
    resources.clear();
    render(EventsView);
    expect(screen.getByRole("status", { name: "Loading events" })).toBeInTheDocument();
    expect(screen.queryByText(/^No events/)).toBeNull();
  });

  it("filters to warnings with the Warning chip (#574)", async () => {
    const event = (event_type: string, object: string): EventInfo => ({
      event_type,
      reason: "x",
      object,
      message: null,
      namespace: "default",
      count: 1,
      last_timestamp: null,
    });
    await loadMain({ events: [event("Warning", "Pod/bad"), event("Normal", "Pod/good")] });
    render(EventsView);
    const toggle = statusChip(/Warning/);
    expect(toggle).toHaveTextContent("1");
    expect(statusChip(/Normal/)).toHaveTextContent("1");
    await fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Pod/bad")).toBeInTheDocument();
    expect(screen.queryByText("Pod/good")).toBeNull();
  });
});

describe("OverviewView stat cards navigate (#463)", () => {
  const cases: [string, string][] = [
    ["Nodes", "nodes"],
    ["Pods running", "pods"],
    ["Deploys healthy", "deployments"],
    ["Warnings", "events"],
  ];

  for (const [label, view] of cases) {
    it(`${label} card opens the ${view} view`, async () => {
      app.view = "overview";
      render(OverviewView);
      const card = screen.getByRole("button", { name: new RegExp(`^${label}:.*Open `) });
      await fireEvent.click(card);
      expect(app.view).toBe(view);
    });
  }

  it("cards expose label and value in the accessible name", () => {
    resources.pods = [pod(), pod({ name: "api-1", phase: "Pending" })];
    render(OverviewView);
    expect(screen.getByRole("button", { name: "Pods running: 1/2. Open Pods" })).toBeInTheDocument();
  });
});

describe("StatCard (#463)", () => {
  it("stays a static card without onclick", async () => {
    const { default: StatCard } = await import("#lib/components/ui/StatCard.svelte");
    render(StatCard, { label: "Total pods", value: 7 });
    expect(screen.getByText("Total pods")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
