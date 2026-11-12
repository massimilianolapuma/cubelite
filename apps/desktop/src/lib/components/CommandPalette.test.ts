import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
  streamPodLog: vi.fn(async () => "1"),
  stopLogs: vi.fn(async () => {}),
  getPodContainers: vi.fn(async () => []),
  kibanaPortForward: vi.fn(async () => 41000),
  grafanaPortForward: vi.fn(async () => 42000),
  openKibanaHome: vi.fn(async () => {}),
  openGrafanaHome: vi.fn(async () => {}),
  discoverResourceKinds: vi.fn(async () => []),
  listResourceTable: vi.fn(async () => ({ columns: [], rows: [] })),
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
import { health } from "#lib/stores/health.svelte.ts";
import { logPanel } from "#lib/stores/logPanel.svelte.ts";
import { elastic } from "#lib/stores/elastic.svelte.ts";
import { prometheus } from "#lib/stores/prometheus.svelte.ts";
import { navigation } from "#lib/stores/navigation.svelte.ts";
import { profiles } from "#lib/stores/profiles.svelte.ts";
import { resources } from "#lib/stores/resources.svelte.ts";
import { toasts } from "#lib/stores/toasts.svelte.ts";
import { isMac } from "#lib/platform.ts";
import { dynamic } from "#lib/stores/dynamic.svelte.ts";
import { discoverResourceKinds } from "#lib/tauri.ts";
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
  clusters.identityColors = { prod: "blue", staging: "magenta" };
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

describe("cluster rows (Tonal §8.6)", () => {
  const clusterRow = (name: string) => document.querySelector<HTMLElement>(`[data-cluster-row="${name}"]`);

  afterEach(() => {
    health.byContext = {};
  });

  it("each row carries its own cluster's tint, not the active one's", async () => {
    render(CommandPalette);
    await flush();
    expect(clusterRow("prod")).toHaveAttribute("data-tint");
    expect(clusterRow("staging")).toHaveAttribute("data-tint");
    expect(clusterRow("prod")?.getAttribute("style")).toContain("--cl-hue-blue");
    expect(clusterRow("staging")?.getAttribute("style")).toContain("--cl-hue-magenta");
  });

  it("shows health as a shape and a word", async () => {
    health.byContext = { staging: { ...health.for("staging"), state: "unreachable" } };
    render(CommandPalette);
    await flush();
    const prod = clusterRow("prod")!;
    const staging = clusterRow("staging")!;
    expect(prod).toHaveTextContent("Connected");
    expect(prod.querySelector("[data-glyph]")).toHaveAttribute("data-glyph", "ok");
    expect(staging).toHaveTextContent("Unreachable");
    expect(staging.querySelector("[data-glyph]")).toHaveAttribute("data-glyph", "err");
    clusters.connectionState = "unknown";
    await flush();
    expect(prod).toHaveTextContent("Not connected");
    expect(prod.querySelector("[data-glyph]")).toHaveAttribute("data-glyph", "unknown");
  });

  it("writes the health word out only when a cluster is not connected; connected keeps it for screen readers", async () => {
    health.byContext = { staging: { ...health.for("staging"), state: "unreachable" } };
    render(CommandPalette);
    await flush();
    // The circle carries "connected"; the word would only take room from a long name.
    const word = (name: string, text: string) =>
      [...clusterRow(name)!.querySelectorAll<HTMLElement>('[data-testid="cluster-health"] *')].find(
        (el) => el.textContent === text,
      );
    expect(word("prod", "Connected")).toHaveClass("sr-only");
    expect(word("staging", "Unreachable")).not.toHaveClass("sr-only");
    expect(clusterRow("prod")).toHaveTextContent("Connected");
  });

  it("draws no section dot on a resource row, and tells a cluster's state by a glyph and a word", async () => {
    health.byContext = { staging: { ...health.for("staging"), state: "unreachable" } };
    render(CommandPalette);
    await flush();
    // The old section dot was an empty disc before the label (`span.rounded-full`, painted inline).
    const dots = (row: Element) => row.querySelectorAll(":empty.rounded-full, [style*='background']");
    const resourceRows = document.querySelectorAll("[data-resource]");
    expect(resourceRows.length).toBeGreaterThan(5);
    for (const row of resourceRows) expect(dots(row), row.getAttribute("data-resource")!).toHaveLength(0);
    // A cluster's state is a shape inside the row and a word in its accessible name.
    for (const [name, glyph, word] of [
      ["prod", "ok", "Connected"],
      ["staging", "err", "Unreachable"],
    ]) {
      const row = screen.getByRole("option", { name: new RegExp(`^${name}\\b.*\\b${word}\\b`) });
      expect(row).toBe(clusterRow(name));
      expect(within(row).getByTestId("cluster-health").querySelector("[data-glyph]")).toHaveAttribute("data-glyph", glyph);
    }
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
    // The exact keyword ranks the type first: ⌘↵ opens Nodes (already pinned) and switches nothing.
    await fireEvent.keyDown(screen.getByPlaceholderText("Search clusters, resources, actions…"), { key: "Enter", ...mod });
    await flush();
    expect(app.view).toBe("nodes");
    expect(switchCluster).not.toHaveBeenCalled();
    // The cluster row still selects the cluster.
    app.paletteOpen = true;
    await flush();
    await search("nodes");
    const clusterRow = screen.getAllByText("Nodes").find((el) => !el.closest("[data-resource]"))!;
    await fireEvent.click(clusterRow);
    await flush();
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

  it("reopening starts from the top, not the last highlighted type", async () => {
    render(CommandPalette);
    await flush();
    await search("secrets");
    expect(row("secrets")).toHaveAttribute("data-selected");
    app.paletteOpen = false; // Esc closes through closeTopOverlay, not close()
    await flush();
    app.paletteOpen = true;
    await flush();
    expect(row("secrets")).not.toHaveAttribute("data-selected");
  });

  it("ranking does not depend on the previous query", async () => {
    render(CommandPalette);
    await flush();
    await search("ingressc");
    await search("ing");
    expect(shown()[0]?.dataset.resource).toBe("ingresses");
  });

  it("clearing the query restores the list order", async () => {
    render(CommandPalette);
    await flush();
    const initial = shown().map((el) => el.dataset.resource);
    await search("ing");
    expect(shown()[0]?.dataset.resource).toBe("ingresses");
    await search("");
    expect(shown().map((el) => el.dataset.resource)).toEqual(initial);
  });

  it("⌘↵ during IME composition does nothing", async () => {
    render(CommandPalette);
    await flush();
    await search("secrets");
    await fireEvent.keyDown(screen.getByPlaceholderText("Search clusters, resources, actions…"), {
      key: "Enter",
      isComposing: true,
      ...mod,
    });
    await flush();
    expect(app.paletteOpen).toBe(true);
    expect(profiles.isPinned("secrets")).toBe(false);
  });

  it("the row count says what it counts and the key hint describes the input", async () => {
    resources.pods = [pod(), pod({ name: "api-1" })];
    render(CommandPalette);
    await flush();
    expect(row("pods")).toHaveTextContent("2 objects");
    const input = screen.getByPlaceholderText("Search clusters, resources, actions…");
    expect(input).toHaveAccessibleDescription(/↵ open.*open and pin to On-call/);
  });

  it("shows the ↵ / ⌘↵ hint for the active profile", async () => {
    render(CommandPalette);
    await flush();
    expect(screen.getByText(/open and pin to On-call/)).toBeInTheDocument();
  });
});

describe("custom kinds in Go to resource (resource-kinds §5.3)", () => {
  const mod = isMac ? { metaKey: true } : { ctrlKey: true };
  const k = (group: string, kind: string, plural: string, short_names: string[] = []) => ({
    group, version: "v1", kind, plural, namespaced: true, short_names,
  });
  const row = (view: string) => document.querySelector<HTMLElement>(`[data-resource="${view}"]`);
  const shown = () =>
    [...document.querySelectorAll<HTMLElement>("[data-resource]")].filter((el) => !el.closest("[hidden]") && !el.hidden);
  async function search(text: string) {
    await fireEvent.input(screen.getByPlaceholderText("Search clusters, resources, actions…"), { target: { value: text } });
    await flush();
  }
  let n = 0;

  beforeEach(async () => {
    window.localStorage.clear();
    profiles.reset();
    navigation.reset();
    app.view = "overview";
    app.kubeconfigPath = "/k";
    const ctx = `palette-custom-${++n}`;
    vi.mocked(discoverResourceKinds).mockResolvedValueOnce([
      k("monitoring.coreos.com", "ServiceMonitor", "servicemonitors", ["smon"]),
      k("cert-manager.io", "Certificate", "certificates", ["cert"]),
      k("acme.example.com", "Certificate", "certificates"),
    ]);
    await dynamic.discover(ctx);
    app.activeCluster = ctx;
    clusters.contexts = [{ name: ctx, cluster_server: "https://c:6443", namespace: "default", is_active: true }];
  });

  it("custom kinds of the active cluster are in Go to resource", async () => {
    render(CommandPalette);
    await flush();
    const r = row("crd:monitoring.coreos.com/servicemonitors")!;
    expect(r).toHaveTextContent("ServiceMonitor");
    expect(r).toHaveTextContent("monitoring.coreos.com");
    expect(r).toHaveTextContent("Custom Resources");
  });

  it("finds a custom kind by short name and by group", async () => {
    render(CommandPalette);
    await flush();
    await search("smon");
    expect(shown()[0]?.dataset.resource).toBe("crd:monitoring.coreos.com/servicemonitors");
    await search("coreos");
    expect(shown().map((el) => el.dataset.resource)).toContain("crd:monitoring.coreos.com/servicemonitors");
  });

  it("same kind name in two groups", async () => {
    render(CommandPalette);
    await flush();
    await search("certificate");
    const views = shown().map((el) => el.dataset.resource);
    expect(views).toEqual(expect.arrayContaining(["crd:cert-manager.io/certificates", "crd:acme.example.com/certificates"]));
    await fireEvent.click(row("crd:acme.example.com/certificates")!);
    await flush();
    expect(app.view).toBe("crd:acme.example.com/certificates");
  });

  it("⌘↵ pins a custom kind", async () => {
    render(CommandPalette);
    await flush();
    await search("smon");
    await fireEvent.keyDown(screen.getByPlaceholderText("Search clusters, resources, actions…"), { key: "Enter", ...mod });
    await flush();
    expect(app.view).toBe("crd:monitoring.coreos.com/servicemonitors");
    expect(profiles.isPinned("crd:monitoring.coreos.com/servicemonitors")).toBe(true);
  });
});
