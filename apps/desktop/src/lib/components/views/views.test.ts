import { describe, it, expect, beforeEach, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";

vi.mock("$lib/tauri", () => ({
  listContexts: vi.fn(),
  setContext: vi.fn(),
  listPods: vi.fn(),
  listNamespaces: vi.fn(),
  listDeployments: vi.fn(),
  deletePod: vi.fn(async () => undefined),
  restartDeployment: vi.fn(async () => undefined),
  scaleDeployment: vi.fn(async () => undefined),
  listEvents: vi.fn(async () => []),
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
import PodDrawer from "$lib/components/pods/PodDrawer.svelte";
import { app } from "$lib/stores/app.svelte";
import { clusters } from "$lib/stores/clusters.svelte";
import { resources } from "$lib/stores/resources.svelte";
import type { PodInfo } from "$lib/tauri";

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
});

describe("AllClustersView", () => {
  it("renders a card per context with honest unknown state for inactive ones", () => {
    render(AllClustersView);
    expect(screen.getByText("prod")).toBeInTheDocument();
    expect(screen.getByText("staging")).toBeInTheDocument();
    expect(screen.getByText("Healthy")).toBeInTheDocument();
    expect(screen.getByText("Unknown")).toBeInTheDocument();
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
