import { describe, it, expect, beforeEach, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, within } from "@testing-library/svelte";

vi.mock("#lib/tauri.ts", () => ({
  discoverResourceKinds: vi.fn(async () => []),
  listResourceTable: vi.fn(async () => ({ columns: [], rows: [] })),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import { discoverResourceKinds, type ResourceKindInfo } from "#lib/tauri.ts";
import Sidebar from "./Sidebar.svelte";
import { app } from "#lib/stores/app.svelte.ts";
import { resources } from "#lib/stores/resources.svelte.ts";
import { navigation } from "#lib/stores/navigation.svelte.ts";
import { profiles } from "#lib/stores/profiles.svelte.ts";
import { sidebar } from "#lib/stores/sidebar.svelte.ts";
import { dynamic } from "#lib/stores/dynamic.svelte.ts";

const k = (group: string, kind: string, plural: string): ResourceKindInfo => ({
  group,
  version: "v1",
  kind,
  plural,
  namespaced: true,
  short_names: [],
});
const KINDS = [
  k("apps", "Deployment", "deployments"),
  k("monitoring.coreos.com", "ServiceMonitor", "servicemonitors"),
  k("monitoring.coreos.com", "PodMonitor", "podmonitors"),
  k("monitoring.coreos.com", "PrometheusRule", "prometheusrules"),
  k("elasticsearch.k8s.elastic.co", "Elasticsearch", "elasticsearches"),
];

const custom = () => screen.getByRole("button", { name: /^Custom Resources \d+$/ });
const groupRow = (group: string) => screen.getByRole("button", { name: new RegExp(`^${group.replace(/\./g, "\\.")} \\d+$`) });

let n = 0;
async function connect(kinds: ResourceKindInfo[] = KINDS) {
  const ctx = `custom-${++n}`;
  vi.mocked(discoverResourceKinds).mockResolvedValueOnce(kinds);
  await dynamic.discover(ctx);
  app.activeCluster = ctx;
}

beforeEach(() => {
  window.localStorage.clear();
  profiles.reset();
  navigation.reset();
  sidebar.close();
  sidebar.customFilter = "";
  app.view = "overview";
  app.namespace = null;
  app.kubeconfigPath = "/k";
  app.activeCluster = `custom-none-${++n}`;
  resources.pods = [];
  dynamic.clear();
});

describe("Custom Resources section", () => {
  it("shows one row per group with its number of kinds", async () => {
    await connect();
    render(Sidebar);
    expect(custom()).toHaveTextContent("2");
    await fireEvent.click(custom());
    expect(custom()).toHaveAttribute("aria-expanded", "true");
    expect(groupRow("elasticsearch.k8s.elastic.co")).toHaveTextContent("1");
    expect(groupRow("monitoring.coreos.com")).toHaveTextContent("3");
    expect(screen.queryByText("Deployment")).toBeNull();
  });

  it("sits right before Observe", async () => {
    await connect();
    render(Sidebar);
    const toggles = [...document.querySelectorAll("[data-section-toggle]")].map((b) => b.textContent?.trim().split(/\s+/)[0]);
    expect(toggles.slice(-3)).toEqual(["Access", "Custom", "Observe"]);
  });

  it("a group opens to its kinds and closes the other group", async () => {
    await connect();
    render(Sidebar);
    await fireEvent.click(custom());
    await fireEvent.click(groupRow("monitoring.coreos.com"));
    expect(groupRow("monitoring.coreos.com")).toHaveAttribute("aria-expanded", "true");
    const kinds = within(screen.getByRole("list", { name: "monitoring.coreos.com kinds" }));
    expect(kinds.getAllByRole("listitem").map((li) => li.textContent?.trim())).toEqual(["PodMonitor", "PrometheusRule", "ServiceMonitor"]);
    await fireEvent.click(groupRow("elasticsearch.k8s.elastic.co"));
    expect(groupRow("monitoring.coreos.com")).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("Elasticsearch")).toBeInTheDocument();
    await fireEvent.click(screen.getByText("Elasticsearch"));
    expect(app.view).toBe("crd:elasticsearch.k8s.elastic.co/elasticsearches");
  });

  it("the filter matches group and kind names", async () => {
    await connect();
    render(Sidebar);
    await fireEvent.click(custom());
    const filter = screen.getByLabelText("Filter custom resources");
    await fireEvent.input(filter, { target: { value: "podmon" } });
    expect(screen.queryByRole("button", { name: /^elasticsearch/ })).toBeNull();
    expect(screen.getByText("PodMonitor")).toBeInTheDocument();
    expect(screen.queryByText("ServiceMonitor")).toBeNull();
    await fireEvent.input(filter, { target: { value: "ELASTIC" } });
    expect(screen.getByText("Elasticsearch")).toBeInTheDocument();
    expect(screen.queryByText("PodMonitor")).toBeNull();
    await fireEvent.input(filter, { target: { value: "zzz" } });
    expect(screen.getByText("No match")).toBeInTheDocument();
  });

  it("says when the cluster has no custom resources, or while discovery is unknown", async () => {
    sidebar.open("custom");
    const { unmount } = render(Sidebar);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    unmount();
    await connect([k("apps", "Deployment", "deployments")]);
    render(Sidebar);
    expect(screen.getByText("No custom resources on this cluster")).toBeInTheDocument();
  });

  it("a pinned custom kind shows its kind name and section dot", async () => {
    await connect();
    app.view = "crd:monitoring.coreos.com/servicemonitors";
    profiles.togglePin("crd:monitoring.coreos.com/servicemonitors");
    app.view = "overview";
    render(Sidebar);
    const pinned = within(screen.getByRole("list", { name: "Pinned · On-call" }));
    const row = pinned.getByText("ServiceMonitor").closest("button")!;
    expect(row).not.toHaveAttribute("title");
    expect(row.querySelector("span")!.getAttribute("style")).toContain("--color-text-tertiary");
  });

  it("a pinned custom kind on a cluster that lacks it", async () => {
    profiles.togglePin("crd:monitoring.coreos.com/servicemonitors");
    await connect([k("apps", "Deployment", "deployments")]);
    render(Sidebar);
    const pinned = within(screen.getByRole("list", { name: "Pinned · On-call" }));
    const row = pinned.getByText("servicemonitors").closest("button")!;
    expect(row).toHaveAttribute("title", "Not available on this cluster");
  });

  it("navigating to a custom kind opens its section and group", async () => {
    await connect();
    render(Sidebar);
    app.navigate("crd:monitoring.coreos.com/prometheusrules");
    await vi.waitFor(() => expect(custom()).toHaveAttribute("aria-expanded", "true"));
    expect(groupRow("monitoring.coreos.com")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("PrometheusRule").closest("button")).toHaveAttribute("aria-current", "page");
  });

  it("navigating to a custom kind clears a filter that would hide it and scrolls its row into view", async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    await connect();
    sidebar.open("custom");
    sidebar.customFilter = "elastic";
    render(Sidebar);
    app.navigate("crd:monitoring.coreos.com/servicemonitors");
    await vi.waitFor(() => expect(screen.getByText("ServiceMonitor").closest("button")).toHaveAttribute("aria-current", "page"));
    expect(sidebar.customFilter).toBe("");
    await vi.waitFor(() => expect(scroll).toHaveBeenCalled());
    expect(scroll.mock.contexts.some((el) => (el as Element).textContent?.includes("ServiceMonitor"))).toBe(true);
  });

  it("says when discovery failed", async () => {
    const ctx = `custom-fail-${++n}`;
    vi.mocked(discoverResourceKinds).mockRejectedValueOnce(new Error("boom"));
    await dynamic.discover(ctx);
    app.activeCluster = ctx;
    sidebar.open("custom");
    render(Sidebar);
    expect(screen.getByText("Couldn't discover custom resources")).toBeInTheDocument();
  });

  it("keyboard: the section toggles like the others", async () => {
    await connect();
    render(Sidebar);
    const access = screen.getByRole("button", { name: /^Access Control \d+$/ });
    access.focus();
    await fireEvent.keyDown(access, { key: "ArrowDown" });
    expect(document.activeElement).toBe(custom());
    await fireEvent.keyDown(custom(), { key: "ArrowRight" });
    expect(custom()).toHaveAttribute("aria-expanded", "true");
    await fireEvent.keyDown(custom(), { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /^Observe \d+$/ }));
  });
});
