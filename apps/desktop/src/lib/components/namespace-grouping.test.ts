import { describe, it, expect, beforeEach, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";

vi.mock("#lib/tauri.ts", () => ({
  listServices: vi.fn(async () => []),
  listPodMetrics: vi.fn(async () => []),
  watchResources: vi.fn(),
  unwatchResources: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import PodTable from "./PodTable.svelte";
import NavigationPreferences from "./NavigationPreferences.svelte";
import ServicesView from "./views/ServicesView.svelte";
import { app } from "#lib/stores/app.svelte.ts";
import { lists } from "#lib/stores/lists.svelte.ts";
import { resources } from "#lib/stores/resources.svelte.ts";
import type { PodInfo, ServiceInfo } from "#lib/tauri.ts";

function pod(name: string, namespace: string, overrides: Partial<PodInfo> = {}): PodInfo {
  return {
    name,
    namespace,
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

function service(name: string, namespace: string): ServiceInfo {
  return { name, namespace, service_type: "ClusterIP", cluster_ip: null, external_ips: [], ports: [], creation_timestamp: null };
}

const pods = [
  pod("api-0", "team-a"),
  pod("dns-0", "kube-system"),
  pod("worker-0", "team-a", { phase: "Failed" }),
  pod("web-0", "team-b"),
];

const groupHeaders = () => [...document.querySelectorAll("[data-group]")].map((el) => el.getAttribute("data-group"));
const header = (name: RegExp) => screen.getByRole("button", { name });
const rowNames = () =>
  screen
    .getAllByRole("button")
    .filter((b) => !b.hasAttribute("data-group"))
    .map((b) => b.textContent?.trim().split(/\s/)[0] ?? "")
    .filter((t) => /-0$/.test(t));

beforeEach(() => {
  app.namespace = null;
  app.activeCluster = "prod";
  // No kubeconfig: the views' loaders return early and keep the rows set here.
  app.kubeconfigPath = "";
  app.view = "pods";
  lists.defaultSort = { field: "api", dir: "asc" };
  lists.groupByNamespace = false;
  lists.resetSession();
  resources.clear();
});

describe("PodTable grouped by namespace (#547)", () => {
  it("stays flat with its Namespace column while the preference is off", () => {
    render(PodTable, { props: { pods } });
    expect(groupHeaders()).toEqual([]);
    expect(screen.getByRole("button", { name: "Sort by Namespace" })).toBeInTheDocument();
    expect(rowNames()).toEqual(["api-0", "dns-0", "worker-0", "web-0"]);
  });

  it("shows one header per namespace, A→Z, and hides the Namespace column", () => {
    lists.groupByNamespace = true;
    render(PodTable, { props: { pods } });
    expect(groupHeaders()).toEqual(["kube-system", "team-a", "team-b"]);
    expect(screen.queryByRole("button", { name: "Sort by Namespace" })).toBeNull();
    expect(screen.queryByText("team-a", { selector: "span.type-data-sm" })).toBeNull();
    expect(rowNames()).toEqual(["dns-0", "api-0", "worker-0", "web-0"]);
    expect(header(/^team-a,/)).toHaveAccessibleName("team-a, 2 pods, 1 with problems, expanded");
    expect(header(/^team-b,/)).toHaveAccessibleName("team-b, 1 pod, expanded");
  });

  it("stays flat with a single namespace selected", () => {
    lists.groupByNamespace = true;
    app.namespace = "team-a";
    render(PodTable, { props: { pods: pods.filter((p) => p.namespace === "team-a") } });
    expect(groupHeaders()).toEqual([]);
    expect(screen.getByRole("button", { name: "Sort by Namespace" })).toBeInTheDocument();
  });

  it("a header click collapses its group, Option-click collapses and expands all", async () => {
    lists.groupByNamespace = true;
    render(PodTable, { props: { pods } });
    await fireEvent.click(header(/^team-a,/));
    expect(header(/^team-a,/)).toHaveAccessibleName(/collapsed$/);
    expect(rowNames()).toEqual(["dns-0", "web-0"]);
    await fireEvent.click(header(/^team-b,/), { altKey: true });
    expect(rowNames()).toEqual([]);
    expect(document.querySelectorAll('[data-expanded="true"]')).toHaveLength(0);
    await fireEvent.click(header(/^kube-system,/), { altKey: true });
    expect(rowNames()).toEqual(["dns-0", "api-0", "worker-0", "web-0"]);
  });

  it("a filter expands every matching group without touching the stored state", async () => {
    lists.groupByNamespace = true;
    lists.collapsed = { "team-a": true };
    const matching = pods.filter((p) => p.name.includes("0") && p.namespace !== "team-b");
    const { rerender } = render(PodTable, { props: { pods: matching, filter: "0" } });
    expect(groupHeaders()).toEqual(["kube-system", "team-a"]);
    expect(rowNames()).toEqual(["dns-0", "api-0", "worker-0"]);
    await fireEvent.click(header(/^kube-system,/));
    expect(rowNames()).toEqual(["api-0", "worker-0"]);
    expect(lists.collapsed).toEqual({ "team-a": true });
    await rerender({ pods, filter: "" });
    expect(rowNames()).toEqual(["dns-0", "web-0"]);
  });

  it("collapse state resets on cluster switch", async () => {
    lists.groupByNamespace = true;
    render(PodTable, { props: { pods } });
    await fireEvent.click(header(/^team-a,/));
    app.resetForClusterSwitch();
    expect(lists.collapsed).toEqual({});
    expect(lists.groupByNamespace).toBe(true);
  });
});

describe("ServicesView grouped by namespace (#547)", () => {
  beforeEach(() => {
    resources.services = [service("web-0", "team-a"), service("db-0", "team-b"), service("api-0", "team-a")];
  });

  it("the title-bar toggle switches grouping, headers have no problem marker", async () => {
    render(ServicesView);
    const toggle = screen.getByRole("button", { name: "Group by namespace" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    await fireEvent.click(toggle);
    expect(lists.groupByNamespace).toBe(true);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(groupHeaders()).toEqual(["team-a", "team-b"]);
    expect(header(/^team-a,/)).toHaveAccessibleName("team-a, 2 services, expanded");
  });

  it("shares collapsed namespaces with the other lists", () => {
    lists.groupByNamespace = true;
    lists.collapsed = { "team-a": true };
    render(ServicesView);
    expect(header(/^team-a,/)).toHaveAccessibleName("team-a, 2 services, collapsed");
    expect(screen.queryByText("web-0")).toBeNull();
    expect(screen.getByText("db-0")).toBeInTheDocument();
  });

  it("hides the toggle with a single namespace selected", () => {
    app.namespace = "team-a";
    render(ServicesView);
    expect(screen.queryByRole("button", { name: "Group by namespace" })).toBeNull();
  });
});

describe("Preferences → Navigation (#547)", () => {
  it("has the Group by namespace switch", async () => {
    render(NavigationPreferences);
    const sw = screen.getByRole("switch", { name: "Group by namespace" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    await fireEvent.click(sw);
    expect(lists.groupByNamespace).toBe(true);
    expect(sw).toHaveAttribute("aria-checked", "true");
  });
});
