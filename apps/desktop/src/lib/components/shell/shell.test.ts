import { describe, it, expect, beforeEach, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";

vi.mock("$lib/tauri", () => ({
  listContexts: vi.fn(),
  setContext: vi.fn(),
  listPods: vi.fn(),
  listNamespaces: vi.fn(),
  listDeployments: vi.fn(),
  listEvents: vi.fn(async () => []),
  watchResources: vi.fn(),
  unwatchResources: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import Titlebar from "./Titlebar.svelte";
import ClusterRail from "./ClusterRail.svelte";
import Sidebar from "./Sidebar.svelte";
import StatusBar from "./StatusBar.svelte";
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
  app.namespace = null;
  app.activeCluster = "prod-aks";
  app.connecting = null;
  clusters.contexts = [
    { name: "prod-aks", cluster_server: "https://prod.azmk8s.io:443", namespace: "default", is_active: true },
    { name: "staging", cluster_server: "https://staging:6443", namespace: "default", is_active: false },
  ];
  clusters.identityColors = { "prod-aks": "blue", staging: "amber" };
  clusters.connectionState = "connected";
  resources.pods = [];
  resources.namespaces = [];
  resources.deployments = [];
  resources.events = [];
});

describe("Titlebar", () => {
  it("shows the active cluster with provider chip and connection state", () => {
    render(Titlebar);
    expect(screen.getByText("prod-aks")).toBeInTheDocument();
    expect(screen.getByText("AKS")).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
  });

  it("shows Unreachable when the active cluster is down", () => {
    clusters.connectionState = "unreachable";
    render(Titlebar);
    expect(screen.getByText("Unreachable")).toBeInTheDocument();
  });

  it("opens the command palette from the search button", async () => {
    render(Titlebar);
    await fireEvent.click(screen.getByText("Search & switch…"));
    expect(app.paletteOpen).toBe(true);
    app.paletteOpen = false;
  });
});

describe("ClusterRail", () => {
  it("renders an avatar per context with initials", () => {
    render(ClusterRail);
    expect(screen.getByText("PA")).toBeInTheDocument();
    expect(screen.getByText("ST")).toBeInTheDocument();
  });

  it("marks the active cluster's health and leaves others unknown", () => {
    render(ClusterRail);
    const dots = screen.getAllByTestId("health-dot");
    expect(dots.map((d) => d.dataset.health)).toEqual(["connected", "unknown"]);
  });

  it("navigates to the dashboard from the home button", async () => {
    render(ClusterRail);
    await fireEvent.click(screen.getByLabelText("All Clusters"));
    expect(app.view).toBe("dashboard");
  });

  it("opens preferences from the gear button", async () => {
    render(ClusterRail);
    await fireEvent.click(screen.getByLabelText("Preferences"));
    expect(app.preferencesOpen).toBe(true);
    app.preferencesOpen = false;
  });
});

describe("Sidebar", () => {
  it("renders every section and item", () => {
    render(Sidebar);
    for (const section of ["Cluster", "Workloads", "Network", "Config", "Observe"]) {
      expect(screen.getByText(section)).toBeInTheDocument();
    }
    for (const item of [
      "Overview",
      "Pods",
      "Deployments",
      "Helm Releases",
      "Services",
      "Ingresses",
      "ConfigMaps",
      "Secrets",
      "Events",
      "Logs",
    ]) {
      expect(screen.getByText(item)).toBeInTheDocument();
    }
  });

  it("shows real counts for pods and deployments", () => {
    resources.pods = [pod(), pod({ name: "api-1" })];
    resources.deployments = [
      { name: "api", namespace: "default", replicas: 2, ready_replicas: 2 },
    ];
    render(Sidebar);
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
  });

  it("navigates on item click", async () => {
    render(Sidebar);
    await fireEvent.click(screen.getByText("Pods"));
    expect(app.view).toBe("pods");
  });
});

describe("StatusBar", () => {
  it("shows server, refresh interval and clickable warning count", async () => {
    resources.events = [
      {
        event_type: "Warning",
        reason: "BackOff",
        object: "Pod/api-0",
        message: "Back-off restarting failed container",
        namespace: "default",
        count: 3,
        last_timestamp: null,
      },
    ];
    render(StatusBar);
    expect(screen.getByText("https://prod.azmk8s.io:443")).toBeInTheDocument();
    expect(screen.getByText(/refresh/)).toBeInTheDocument();
    const warnings = screen.getByText("1 warning");
    await fireEvent.click(warnings);
    expect(app.view).toBe("events");
  });
});
