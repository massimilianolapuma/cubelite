import { describe, it, expect, beforeEach, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";

vi.mock("$lib/tauri", () => ({
  listContexts: vi.fn(),
  setContext: vi.fn(),
  listPods: vi.fn(),
  listNamespaces: vi.fn(),
  listDeployments: vi.fn(),
  watchResources: vi.fn(),
  unwatchResources: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import EmptyStateView from "./EmptyStateView.svelte";
import UnreachableView from "./UnreachableView.svelte";
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
  it("shows real stats, dashes for missing data and the metrics caption", () => {
    resources.pods = [pod(), pod({ name: "api-1", ready: false, phase: "Pending" })];
    resources.deployments = [{ name: "api", namespace: "default", replicas: 2, ready_replicas: 1 }];
    render(OverviewView);
    expect(screen.getByText("Nodes")).toBeInTheDocument();
    expect(screen.getByText("Pods running")).toBeInTheDocument();
    expect(screen.getByText(/metrics unavailable/)).toBeInTheDocument();
    expect(screen.getByText("default/api-1")).toBeInTheDocument();
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
  it("shows meta grid with real fields, dashes elsewhere, and disabled destructive actions", () => {
    const onClose = vi.fn();
    render(PodDrawer, { props: { pod: pod({ restarts: 2 }), onClose } });
    expect(screen.getByText("api-0")).toBeInTheDocument();
    expect(screen.getByText("Namespace")).toBeInTheDocument();
    expect(screen.getByText("QoS")).toBeInTheDocument();
    const del = screen.getByText("Delete").closest("button");
    expect(del).toBeDisabled();
    const restart = screen.getByText("Restart").closest("button");
    expect(restart).toBeDisabled();
    expect(screen.getByText("Logs").closest("button")).not.toBeDisabled();
  });

  it("closes via the header button", async () => {
    const onClose = vi.fn();
    render(PodDrawer, { props: { pod: pod(), onClose } });
    await fireEvent.click(screen.getByLabelText("Close"));
    expect(onClose).toHaveBeenCalled();
  });
});
