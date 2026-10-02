import { describe, it, expect, beforeEach, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";

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
import type { PodInfo } from "#lib/tauri.ts";

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
  app.deploymentFilter = "";
  clusters.contexts = [
    { name: "prod", cluster_server: "https://prod:6443", namespace: "default", is_active: true },
    { name: "staging", cluster_server: "https://staging:6443", namespace: "default", is_active: false },
  ];
  clusters.identityColors = { prod: "blue", staging: "amber" };
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
    expect(screen.getByText("Cluster unreachable")).toBeInTheDocument();
    expect(screen.getByText("https://prod:6443")).toBeInTheDocument();
    expect(screen.getByText("connection timed out")).toBeInTheDocument();
    expect(screen.getByText("Retry")).toBeInTheDocument();
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
    expect(screen.getByText(/metrics unavailable/)).toBeInTheDocument();
    expect(screen.getByText("Recent warnings")).toBeInTheDocument();
    expect(screen.getByText("Pod/api-1")).toBeInTheDocument();
    expect(screen.getByText("0/3 nodes are available")).toBeInTheDocument();
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

  it("navigates to overview when clicking the active cluster card", async () => {
    app.view = "dashboard";
    render(AllClustersView);
    await fireEvent.click(screen.getByText("prod"));
    expect(app.view).toBe("overview");
  });
});

describe("PodsView", () => {
  it("filters pods and opens the drawer on row click", async () => {
    resources.pods = [pod(), pod({ name: "worker-0" })];
    render(PodsView);
    const input = screen.getByPlaceholderText("Filter pods…");
    await fireEvent.input(input, { target: { value: "worker" } });
    expect(screen.queryByText("api-0")).toBeNull();
    await fireEvent.click(screen.getByText("worker-0"));
    expect(app.selectedPod?.name).toBe("worker-0");
  });
});

describe("PodDrawer", () => {
  it("shows meta grid with real fields and live footer actions", async () => {
    const onClose = vi.fn();
    const onDelete = vi.fn();
    render(PodDrawer, { props: { pod: pod({ restarts: 2 }), onClose, onDelete } });
    expect(screen.getByText("api-0")).toBeInTheDocument();
    expect(screen.getByText("Namespace")).toBeInTheDocument();
    expect(screen.getByText("QoS")).toBeInTheDocument();
    expect(screen.getByText("Logs").closest("button")).not.toBeDisabled();
    expect(screen.getByText("Restart").closest("button")).not.toBeDisabled();
    await fireEvent.click(screen.getByText("Delete"));
    expect(onDelete).toHaveBeenCalled();
  });

  it("shows label chips sorted by key", () => {
    render(PodDrawer, {
      props: { pod: pod({ labels: { tier: "api", app: "shop" } }), onClose: vi.fn() },
    });
    expect(screen.getByText("Labels")).toBeInTheDocument();
    const chips = screen.getAllByTitle(/=/).map((el) => el.textContent?.trim());
    expect(chips).toEqual(["app=shop", "tier=api"]);
  });

  it("portals into the app's drawer host so it stays pinned while the view scrolls", () => {
    const host = document.createElement("main");
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
  it("renders type pills, warning row tint and count suffix", () => {
    resources.events = [
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
    render(EventsView);
    for (const h of ["Type", "Reason", "Object", "Message", "Age"]) {
      expect(screen.getByText(h)).toBeInTheDocument();
    }
    expect(screen.getByText("Warning")).toBeInTheDocument();
    expect(screen.getByText("Normal")).toBeInTheDocument();
    expect(screen.getByText(/BackOff ×7/)).toBeInTheDocument();
    const warningRow = screen.getByText("Pod/api-0").closest("div");
    expect(warningRow?.getAttribute("style")).toContain("--alpha-log-warn-row");
  });

  it("shows the empty state", () => {
    render(EventsView);
    expect(screen.getByText("No events found.")).toBeInTheDocument();
  });
});
