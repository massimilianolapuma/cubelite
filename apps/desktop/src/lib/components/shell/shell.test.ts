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
  listPodMetrics: vi.fn(async () => []),
  clusterCapacity: vi.fn(async () => []),
  watchResources: vi.fn(),
  unwatchResources: vi.fn(),
  discoverResourceKinds: vi.fn(async () => []),
  listResourceTable: vi.fn(async () => ({ columns: [], rows: [{ name: "a", namespace: "x", creation_timestamp: null, cells: [] }, { name: "b", namespace: "y", creation_timestamp: null, cells: [] }] })),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));
const windowApi = vi.hoisted(() => ({ startDragging: vi.fn(), toggleMaximize: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => windowApi }));

import TopBar from "./TopBar.svelte";
import ClusterRail from "./ClusterRail.svelte";
import Sidebar from "./Sidebar.svelte";
import { app } from "#lib/stores/app.svelte.ts";
import { clusters } from "#lib/stores/clusters.svelte.ts";
import { health } from "#lib/stores/health.svelte.ts";
import { lists } from "#lib/stores/lists.svelte.ts";
import { resources } from "#lib/stores/resources.svelte.ts";
import { dynamic } from "#lib/stores/dynamic.svelte.ts";
import { sidebar } from "#lib/stores/sidebar.svelte.ts";
import { profiles } from "#lib/stores/profiles.svelte.ts";
import { discoverResourceKinds } from "#lib/tauri.ts";
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
  sidebar.close();
  profiles.reset();
  app.view = "overview";
  app.namespace = null;
  app.activeCluster = "prod-aks";
  app.connecting = null;
  app.kubeconfigSources = [];
  clusters.contexts = [
    { name: "prod-aks", cluster_server: "https://prod.azmk8s.io:443", namespace: "default", is_active: true },
    { name: "staging", cluster_server: "https://staging:6443", namespace: "default", is_active: false },
  ];
  clusters.identityColors = { "prod-aks": "blue", staging: "magenta" };
  clusters.connectionState = "connected";
  resources.pods = [];
  resources.namespaces = [];
  resources.deployments = [];
  resources.events = [];
  health.byContext = {};
});

const warning = {
  event_type: "Warning",
  reason: "BackOff",
  object: "Pod/api-0",
  message: "Back-off restarting failed container",
  namespace: "default",
  count: 3,
  last_timestamp: null,
};

describe("TopBar", () => {
  it("shows the active cluster with provider tag and connection state", () => {
    render(TopBar);
    expect(screen.getByText("prod-aks")).toBeInTheDocument();
    expect(screen.getByText("AKS")).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
  });

  it("shows the connection state as a shape and a word", () => {
    render(TopBar);
    const state = () => screen.getByTestId("connection-state");
    expect(state().querySelector("svg")).toHaveAttribute("data-glyph", "ok");
    clusters.connectionState = "unreachable";
    render(TopBar);
    const last = screen.getAllByTestId("connection-state").at(-1)!;
    expect(last).toHaveTextContent("Unreachable");
    expect(last.querySelector("svg")).toHaveAttribute("data-glyph", "err");
  });

  it("carries the Kubernetes version the status bar used to show", () => {
    health.byContext = {
      "prod-aks": { ...health.for("prod-aks"), state: "connected", version: "v1.30.2" },
    };
    render(TopBar);
    expect(screen.getByText("v1.30.2")).toBeInTheDocument();
  });

  it("tints the cluster chip with the cluster's own colour, whatever the window shows", () => {
    clusters.identityColors = { "prod-aks": "teal", staging: "magenta" };
    app.view = "dashboard";
    render(TopBar);
    const chip = screen.getByRole("button", { name: /prod-aks/ });
    expect(chip).toHaveAttribute("data-tint");
    expect(chip.getAttribute("style")).toContain("--cl-tint-h: var(--cl-hue-teal)");
  });

  it("opens a menu with the server address, copy and reconnect", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const retry = vi.spyOn(clusters, "retry").mockResolvedValue();
    render(TopBar);
    await fireEvent.click(screen.getByRole("button", { name: /prod-aks/ }));
    expect(await screen.findByText("https://prod.azmk8s.io:443")).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("menuitem", { name: "Copy server address" }));
    expect(writeText).toHaveBeenCalledWith("https://prod.azmk8s.io:443");
    await fireEvent.click(screen.getByRole("button", { name: /prod-aks/ }));
    await fireEvent.click(await screen.findByRole("menuitem", { name: "Reconnect" }));
    expect(retry).toHaveBeenCalled();
    retry.mockRestore();
    vi.unstubAllGlobals();
  });

  it("opens the command palette from the search button", async () => {
    render(TopBar);
    await fireEvent.click(screen.getByText("Search & switch…"));
    expect(app.paletteOpen).toBe(true);
    app.paletteOpen = false;
  });

  it("counts warnings in a chip that opens Events, with the warning shape", async () => {
    resources.events = [warning];
    render(TopBar);
    const chip = screen.getByRole("button", { name: "1 warning" });
    expect(chip.querySelector("svg")).toHaveAttribute("data-glyph", "warn");
    // Whatever was pressed in Events before, the chip shows the warnings it counts.
    lists.setStatus("events", ["normal"]);
    await fireEvent.click(chip);
    expect(app.view).toBe("events");
    expect(lists.pressed("events")).toEqual(["warning"]);
  });

  it("drags the window from its empty space, not from a chip", async () => {
    windowApi.startDragging.mockClear();
    const { container } = render(TopBar);
    const header = container.querySelector("header")!;
    expect(header).toHaveAttribute("data-tauri-drag-region");
    await fireEvent.mouseDown(screen.getByRole("button", { name: /prod-aks/ }), { button: 0 });
    await new Promise((r) => setTimeout(r, 0));
    expect(windowApi.startDragging).not.toHaveBeenCalled();
    await fireEvent.mouseDown(header, { button: 0 });
    await vi.waitFor(() => expect(windowApi.startDragging).toHaveBeenCalledTimes(1));
  });

  it("has no warnings chip when there is nothing to warn about", () => {
    render(TopBar);
    expect(screen.queryByRole("button", { name: /warning/ })).toBeNull();
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

  it("shows health as a shape, not as a colour alone", () => {
    clusters.connectionState = "unreachable";
    render(ClusterRail);
    const glyphs = screen.getAllByTestId("health-dot").map((d) => d.querySelector("svg")?.dataset.glyph);
    expect(glyphs).toEqual(["err", "unknown"]);
    clusters.connectionState = "connected";
  });

  it("names each cluster button with the context and its health, not just initials", () => {
    render(ClusterRail);
    expect(screen.getByRole("button", { name: "prod-aks, connected" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "staging, not connected" })).toBeInTheDocument();
  });

  it("gives every avatar its own cluster's tint and marks the active one", () => {
    render(ClusterRail);
    const avatars = screen.getAllByTestId("identity-avatar");
    expect(avatars.map((a) => a.getAttribute("style"))).toEqual([
      expect.stringContaining("--cl-tint-h: var(--cl-hue-blue)"),
      expect.stringContaining("--cl-tint-h: var(--cl-hue-magenta)"),
    ]);
    expect(avatars.every((a) => a.hasAttribute("data-tint"))).toBe(true);
    expect(avatars.map((a) => a.dataset.active)).toEqual(["true", "false"]);
  });

  it("keeps All Clusters and Preferences outside the list that scrolls", () => {
    render(ClusterRail);
    const list = screen.getByRole("list", { name: "Contexts" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(within(list).queryByLabelText("All Clusters")).toBeNull();
    expect(within(list).queryByLabelText("Preferences")).toBeNull();
  });

  it("names the defining kubeconfig file in the tooltip only with several files", () => {
    clusters.contexts = clusters.contexts.map((c) => ({
      ...c,
      source: c.name === "staging" ? "/home/u/.kube/team.yaml" : "/home/u/.kube/config",
    }));
    const { unmount } = render(ClusterRail);
    expect(screen.getByTitle("staging")).toBeInTheDocument();
    unmount();

    app.kubeconfigSources = [
      { path: "/home/u/.kube/config", exists: true, contexts: 1, shadowed: [] },
      { path: "/home/u/.kube/team.yaml", exists: true, contexts: 1, shadowed: [] },
    ];
    render(ClusterRail);
    expect(screen.getByTitle("staging — /home/u/.kube/team.yaml")).toBeInTheDocument();
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
  it("renders every section and the On-call pins (sidebar C)", () => {
    render(Sidebar);
    for (const section of ["Cluster", "Workloads", "Network", "Storage", "Config", "Access Control", "Observe"]) {
      expect(screen.getByText(section)).toBeInTheDocument();
    }
    for (const item of ["Overview", "Nodes", "Pods", "Deployments", "Jobs", "Events", "Logs"]) {
      expect(screen.getByText(item)).toBeInTheDocument();
    }
  });

  it("shows a loaded count for a new kind and greys kinds the cluster does not serve", async () => {
    app.kubeconfigPath = "/k";
    app.activeCluster = "sidebar-ctx";
    app.namespace = null;
    vi.mocked(discoverResourceKinds).mockResolvedValueOnce([
      { group: "apps", version: "v1", kind: "DaemonSet", plural: "daemonsets", namespaced: true, short_names: ["ds"] },
    ]);
    await dynamic.discover("sidebar-ctx");
    await dynamic.load("daemonsets");
    sidebar.open("workloads");
    render(Sidebar);
    const daemonsets = screen.getByText("DaemonSets").closest("button")!;
    expect(daemonsets.querySelector("[data-testid=nav-count]")).toHaveTextContent("2");
    expect(daemonsets).not.toHaveAttribute("title");
    sidebar.open("storage");
    const storageClasses = (await screen.findByText("Storage Classes")).closest("button")!;
    expect(storageClasses).toHaveAttribute("title", "Not available on this cluster");
    // Stays in place, marked, with an en dash where the count would be.
    expect(storageClasses).toHaveAttribute("data-unavailable", "true");
    expect(storageClasses).toHaveTextContent("–");
    expect(storageClasses.querySelector("[data-testid=nav-count]")).toBeNull();
    dynamic.clear();
  });

  it("shows real counts for pods and deployments", () => {
    resources.pods = [pod(), pod({ name: "api-1" })];
    resources.deployments = [
      { name: "api", namespace: "default", replicas: 2, ready_replicas: 2, images: [], selector: {}, strategy: null, conditions: [], creation_timestamp: null },
    ];
    render(Sidebar);
    const count = (label: string) => screen.getByText(label).closest("button")!.querySelector("[data-testid=nav-count]");
    expect(count("Pods")).toHaveTextContent("2");
    expect(count("Deployments")).toHaveTextContent("1");
  });

  it("keeps the pods total neutral and badges only the pods needing attention (#574)", async () => {
    lists.resetSession();
    resources.pods = [pod(), pod({ name: "api-1", ready: false, phase: "Pending" }), pod({ name: "api-2" })];
    render(Sidebar);
    const row = screen.getByText("Pods").closest("button")!;
    expect(row).toHaveTextContent("3");
    // The total is its own neutral number, outside the toned badge.
    expect(row.querySelector("[data-testid=nav-count]")!.closest("[data-tone]")).toBeNull();
    expect(row.querySelector("[data-testid=nav-count]")).toHaveTextContent(/^3$/);
    const badge = screen.getByRole("button", { name: "1 pod needs attention: show them" });
    expect(badge).toHaveTextContent("1");
    // Failure is a square as well as a colour.
    expect(badge).toHaveAttribute("data-tone", "err");
    expect(badge.querySelector("svg")).toHaveAttribute("data-glyph", "err");

    await fireEvent.click(badge);
    expect(app.view).toBe("pods");
    // Failing and Pending together are the pods needing attention.
    expect(lists.pressed("pods")).toEqual(["err", "warn"]);
  });

  it("badges warning events in amber and opens Events filtered (#574)", async () => {
    lists.resetSession();
    const event = (event_type: string) => ({
      event_type,
      reason: "x",
      object: "Pod/api-0",
      message: null,
      namespace: "default",
      count: 1,
      last_timestamp: null,
    });
    resources.events = [event("Warning"), event("Warning"), event("Normal")];
    render(Sidebar);
    const badge = screen.getByRole("button", { name: "2 warnings: show them" });
    expect(badge).toHaveAttribute("data-tone", "warn");
    expect(badge.querySelector("svg")).toHaveAttribute("data-glyph", "warn");
    await fireEvent.click(badge);
    expect(app.view).toBe("events");
    expect(lists.pressed("events")).toEqual(["warning"]);
  });

  it("rows carry no section dot: colour is for the tint and for state", () => {
    render(Sidebar);
    const row = screen.getByText("Pods").closest("button")!;
    expect(row.firstElementChild).toHaveTextContent("Pods");
    expect(row.querySelector("[style*='background']")).toBeNull();
  });

  it("marks the current view on its row", async () => {
    render(Sidebar);
    await fireEvent.click(screen.getByText("Deployments"));
    expect(screen.getByText("Deployments").closest("[data-active]")).toHaveAttribute("data-active", "true");
    expect(screen.getByText("Pods").closest("[data-active]")).toHaveAttribute("data-active", "false");
  });

  it("has no badge when nothing needs attention (#574)", () => {
    resources.pods = [pod()];
    resources.events = [];
    render(Sidebar);
    expect(screen.queryByTestId("nav-attention")).not.toBeInTheDocument();
  });

  it("shows counts for on-demand kinds only once loaded for the current namespace", () => {
    resources.clear();
    resources.services = [
      {
        name: "api",
        namespace: "default",
        service_type: "ClusterIP",
        cluster_ip: null,
        external_ips: [],
        ports: [],
        creation_timestamp: null,
      },
    ];
    const row = () => screen.getByText("Services").closest("button");
    sidebar.open("network");
    const { unmount } = render(Sidebar);
    expect(row()).not.toHaveTextContent("1");
    unmount();

    resources.loadedKinds = { services: null };
    render(Sidebar);
    expect(row()).toHaveTextContent("1");
  });

  it("navigates on item click", async () => {
    render(Sidebar);
    await fireEvent.click(screen.getByText("Pods"));
    expect(app.view).toBe("pods");
  });
});
