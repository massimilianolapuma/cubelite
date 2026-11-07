import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
  listPodMetrics: vi.fn(async () => []),
  clusterCapacity: vi.fn(async () => []),
  watchResources: vi.fn(),
  unwatchResources: vi.fn(),
  streamPodLog: vi.fn(async () => "1"),
  stopLogs: vi.fn(async () => {}),
  getPodContainers: vi.fn(async () => []),
  kibanaPortForward: vi.fn(async () => 41000),
  grafanaPortForward: vi.fn(async () => 42000),
  openKibanaHome: vi.fn(async () => {}),
  openGrafanaHome: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

/**
 * bits-ui Command schedules microtasks (item registration, scroll sync).
 * Flush them while the component is still mounted so they don't surface
 * as unhandled rejections after test teardown.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

import CommandPalette from "./CommandPalette.svelte";
import { app } from "#lib/stores/app.svelte.ts";
import { clusters } from "#lib/stores/clusters.svelte.ts";
import { logPanel } from "#lib/stores/logPanel.svelte.ts";
import { elastic } from "#lib/stores/elastic.svelte.ts";
import { prometheus } from "#lib/stores/prometheus.svelte.ts";
import { navigation } from "#lib/stores/navigation.svelte.ts";
import { profiles } from "#lib/stores/profiles.svelte.ts";
import { resources } from "#lib/stores/resources.svelte.ts";
import { toasts } from "#lib/stores/toasts.svelte.ts";
import { isMac } from "#lib/platform.ts";
import {
  grafanaPortForward,
  kibanaPortForward,
  openGrafanaHome,
  openKibanaHome,
  type EsEndpoint,
  type PodInfo,
  type PromEndpoint,
} from "#lib/tauri.ts";

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
  app.paletteOpen = true;
  app.activeCluster = "prod";
  app.preferencesOpen = false;
  app.selectedPod = null;
  clusters.contexts = [
    { name: "prod", cluster_server: "https://prod:6443", namespace: "default", is_active: true },
    { name: "staging", cluster_server: "https://staging:6443", namespace: "default", is_active: false },
  ];
  clusters.identityColors = { prod: "blue", staging: "amber" };
  clusters.connectionState = "connected";
});

afterEach(async () => {
  for (const s of [...logPanel.sessions]) await logPanel.closeSession(s.key);
  app.selectedPod = null;
});

describe("CommandPalette", () => {
  it("renders nothing when closed", () => {
    app.paletteOpen = false;
    render(CommandPalette);
    expect(document.querySelector("[data-command-root]")).toBeNull();
  });

  it("renders cluster and action sections when open", async () => {
    render(CommandPalette);
    await flush();
    expect(screen.getByText("Switch cluster")).toBeInTheDocument();
    expect(screen.getByText("Actions")).toBeInTheDocument();
    expect(screen.getByText("prod")).toBeInTheDocument();
    expect(screen.getByText("staging")).toBeInTheDocument();
    expect(screen.getByText("All Clusters dashboard")).toBeInTheDocument();
  });

  it("navigates and closes when selecting an action", async () => {
    render(CommandPalette);
    await flush();
    await fireEvent.click(screen.getByText("Tail logs"));
    await flush();
    expect(app.view).toBe("logs");
    expect(app.paletteOpen).toBe(false);
  });

  it("opens preferences from the Preferences action", async () => {
    render(CommandPalette);
    await flush();
    await fireEvent.click(screen.getByText("Preferences"));
    await flush();
    expect(app.preferencesOpen).toBe(true);
    expect(app.paletteOpen).toBe(false);
    app.preferencesOpen = false;
  });

  it("closes on backdrop click", async () => {
    render(CommandPalette);
    await flush();
    const backdrop = document.querySelector('[role="presentation"]');
    expect(backdrop).not.toBeNull();
    if (backdrop) await fireEvent.click(backdrop);
    await flush();
    expect(app.paletteOpen).toBe(false);
  });

  it("omits 'Open pod logs' when no pod is selected", async () => {
    render(CommandPalette);
    await flush();
    expect(screen.queryByText("Open pod logs")).toBeNull();
  });

  it("lists 'Open pod logs' when a pod is selected, and opens its log session on select", async () => {
    app.selectedPod = pod();
    render(CommandPalette);
    await flush();
    expect(screen.getByText("Open pod logs")).toBeInTheDocument();

    await fireEvent.click(screen.getByText("Open pod logs"));
    await flush();
    expect(app.paletteOpen).toBe(false);
    expect(logPanel.activeKey).toBe("default/api-0");
  });
});

describe("CommandPalette integrations (#526)", () => {
  const es: EsEndpoint = {
    target: { kind: "in-cluster", namespace: "logging", service: "es-http", port: 9200, https: true },
    indexPattern: "logs-*",
    preset: "ecs",
    kibanaUrl: null,
    kibanaService: { namespace: "logging", service: "kb-http", port: 5601, https: true },
    skipTlsVerify: false,
  };
  const prom: PromEndpoint = {
    target: { kind: "external", url: "https://prom.example" },
    cluster: null,
    grafanaUrl: "https://grafana.example",
    grafanaDatasource: null,
    skipTlsVerify: false,
  };

  afterEach(() => {
    elastic.setEndpoint("prod", null);
    prometheus.setEndpoint("prod", null);
    app.preferencesOpen = false;
    app.preferencesSection = null;
  });

  it("offers only Integrations settings when the context has no web UI", async () => {
    elastic.setEndpoint("prod", { ...es, kibanaService: null });
    prometheus.setEndpoint("prod", { ...prom, grafanaUrl: " " });
    render(CommandPalette);
    await flush();
    expect(screen.queryByText("Open Kibana")).toBeNull();
    expect(screen.queryByText("Open Grafana")).toBeNull();
    await fireEvent.click(screen.getByText("Integrations settings"));
    await flush();
    expect(app.preferencesOpen).toBe(true);
    expect(app.preferencesSection).toBe("integrations");
    expect(app.paletteOpen).toBe(false);
  });

  it("opens the active context's Kibana and Grafana", async () => {
    app.kubeconfigPath = "/k";
    elastic.setEndpoint("prod", es);
    prometheus.setEndpoint("prod", prom);
    // Another context's endpoints never show up.
    elastic.setEndpoint("staging", { ...es, kibanaUrl: "https://other" });
    render(CommandPalette);
    await flush();
    await fireEvent.click(screen.getByText("Open Kibana"));
    await flush();
    expect(kibanaPortForward).toHaveBeenCalledWith("/k", "prod", es.kibanaService);
    expect(openKibanaHome).toHaveBeenCalledWith("https://127.0.0.1:41000");
    app.paletteOpen = true;
    await flush();
    await fireEvent.click(screen.getByText("Open Grafana"));
    await flush();
    expect(openGrafanaHome).toHaveBeenCalledWith("https://grafana.example");
    expect(grafanaPortForward).not.toHaveBeenCalled();
    elastic.setEndpoint("staging", null);
  });
});

describe("Go to resource (resource-kinds §6)", () => {
  const mod = isMac ? { metaKey: true } : { ctrlKey: true };
  const shown = () =>
    [...document.querySelectorAll<HTMLElement>("[data-resource]")].filter((el) => !el.closest("[hidden]") && !el.hidden);
  const row = (view: string) => document.querySelector<HTMLElement>(`[data-resource="${view}"]`);
  async function search(text: string) {
    await fireEvent.input(screen.getByPlaceholderText("Search clusters, resources, actions…"), { target: { value: text } });
    await flush();
  }

  beforeEach(() => {
    window.localStorage.clear();
    profiles.reset();
    navigation.reset();
    resources.pods = [];
    app.view = "overview";
  });

  it("lists every type with its section, after Actions", async () => {
    render(CommandPalette);
    await flush();
    const headings = [...document.querySelectorAll("[data-command-group-heading]")].map((h) => h.textContent?.trim());
    expect(headings).toEqual(["Switch cluster", "Actions", "Go to resource"]);
    const views = shown().map((el) => el.dataset.resource);
    expect(views).toHaveLength(navigation.arranged.flatMap((sec) => sec.items).length);
    expect(views[0]).toBe("overview");
    expect(views).toContain("clusterrolebindings");
    expect(row("networkpolicies")).toHaveTextContent("Network Policies");
    expect(row("networkpolicies")).toHaveTextContent("Network");
    expect(screen.queryByText("Go to Pods")).toBeNull();
  });

  it("finds a type by short name", async () => {
    render(CommandPalette);
    await flush();
    await search("netpol");
    expect(shown().map((el) => el.dataset.resource)).toEqual(["networkpolicies"]);
  });

  it("a short name ranks its own type first", async () => {
    render(CommandPalette);
    await flush();
    await search("ing");
    expect(shown()[0]?.dataset.resource).toBe("ingresses");
  });

  it("shows the count once loaded and tags pinned and hidden types", async () => {
    resources.pods = [pod(), pod({ name: "api-1" })];
    navigation.setHidden("services", true);
    render(CommandPalette);
    await flush();
    expect(row("pods")).toHaveTextContent("2");
    expect(row("pods")).toHaveTextContent("Pinned");
    expect(row("services")).toHaveTextContent("Hidden in Preferences");
    expect(row("secrets")).not.toHaveTextContent("Pinned");
  });

  it("↵ opens the type", async () => {
    render(CommandPalette);
    await flush();
    await fireEvent.click(row("pvs")!);
    await flush();
    expect(app.view).toBe("pvs");
    expect(app.paletteOpen).toBe(false);
  });

  it("⌘↵ opens and pins to the active profile", async () => {
    render(CommandPalette);
    await flush();
    await search("secrets");
    await fireEvent.keyDown(screen.getByPlaceholderText("Search clusters, resources, actions…"), { key: "Enter", ...mod });
    await flush();
    expect(app.view).toBe("secrets");
    expect(profiles.isPinned("secrets")).toBe(true);
    expect(app.paletteOpen).toBe(false);
  });

  it("⌘↵ on a full profile still opens the type", async () => {
    profiles.togglePin("services");
    profiles.togglePin("ingresses");
    const push = vi.spyOn(toasts, "push");
    render(CommandPalette);
    await flush();
    await search("secrets");
    await fireEvent.keyDown(screen.getByPlaceholderText("Search clusters, resources, actions…"), { key: "Enter", ...mod });
    await flush();
    expect(push).toHaveBeenCalledWith("A profile holds up to 9 pins", "err");
    expect(app.view).toBe("secrets");
    expect(app.paletteOpen).toBe(false);
    push.mockRestore();
  });

  it("⌘↵ on a non-resource row just selects it", async () => {
    const switchCluster = vi.spyOn(clusters, "switchCluster").mockResolvedValue();
    const before = [...profiles.active.pins];
    render(CommandPalette);
    await flush();
    await search("staging");
    await fireEvent.keyDown(screen.getByPlaceholderText("Search clusters, resources, actions…"), { key: "Enter", ...mod });
    await flush();
    expect(switchCluster).toHaveBeenCalledWith("staging");
    expect(profiles.active.pins).toEqual(before);
    switchCluster.mockRestore();
  });

  it("a context named like a type keeps both rows", async () => {
    clusters.contexts = [...clusters.contexts, { name: "Nodes", cluster_server: "https://n:6443", namespace: "default", is_active: false }];
    const switchCluster = vi.spyOn(clusters, "switchCluster").mockResolvedValue();
    render(CommandPalette);
    await flush();
    await search("nodes");
    expect(screen.getAllByText("Nodes")).toHaveLength(2);
    await fireEvent.keyDown(screen.getByPlaceholderText("Search clusters, resources, actions…"), { key: "Enter", ...mod });
    await flush();
    // The cluster row is first and highlighted: ⌘↵ switches, it does not pin Nodes.
    expect(switchCluster).toHaveBeenCalledWith("Nodes");
    switchCluster.mockRestore();
  });

  it("hidden types stay reachable", async () => {
    navigation.setHidden("networkpolicies", true);
    render(CommandPalette);
    await flush();
    await search("netpol");
    await fireEvent.click(row("networkpolicies")!);
    await flush();
    expect(app.view).toBe("networkpolicies");
  });

  it("shows the ↵ / ⌘↵ hint for the active profile", async () => {
    render(CommandPalette);
    await flush();
    expect(screen.getByText(/open and pin to On-call/)).toBeInTheDocument();
  });
});
