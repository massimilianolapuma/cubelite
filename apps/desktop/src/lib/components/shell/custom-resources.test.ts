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
// Like minikube with kube-prometheus-stack and ECK: one group with many kinds, many groups with one.
const KINDS = [
  k("apps", "Deployment", "deployments"),
  k("monitoring.coreos.com", "ServiceMonitor", "servicemonitors"),
  k("monitoring.coreos.com", "PodMonitor", "podmonitors"),
  k("monitoring.coreos.com", "PrometheusRule", "prometheusrules"),
  k("elasticsearch.k8s.elastic.co", "Elasticsearch", "elasticsearches"),
  k("kibana.k8s.elastic.co", "Kibana", "kibanas"),
  k("agent.k8s.elastic.co", "Agent", "agents"),
];

const custom = () => screen.getByRole("button", { name: /^Custom Resources \d+$/ });
const list = () => within(screen.getByRole("list", { name: "Custom Resources types" }));
/** Visible lines of the open section: vendor headers in capitals, kinds as their label. */
const lines = () =>
  list()
    .getAllByRole("listitem")
    .map((li) => (li.querySelector("button") ? li.textContent?.trim() : `# ${li.textContent?.trim()}`));

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
  it("shows every kind right away, grouped by vendor", async () => {
    await connect();
    render(Sidebar);
    expect(custom()).toHaveTextContent("6");
    await fireEvent.click(custom());
    expect(lines()).toEqual([
      "# coreos.com",
      "PodMonitor",
      "PrometheusRule",
      "ServiceMonitor",
      "# elastic.co",
      "Agent",
      "Elasticsearch",
      "Kibana",
    ]);
    expect(screen.queryByRole("button", { name: /coreos\.com/ })).toBeNull();
  });

  it("uses the same rows as the other sections, with the API group as tooltip", async () => {
    await connect();
    sidebar.open("custom");
    render(Sidebar);
    const row = list().getByText("Kibana").closest("button")!;
    expect(row).toHaveAttribute("title", "kibana.k8s.elastic.co");
    await fireEvent.click(row);
    expect(app.view).toBe("crd:kibana.k8s.elastic.co/kibanas");
    expect(row.className).toBe(
      within(screen.getByRole("list", { name: "Pinned · On-call" })).getByText("Pods").closest("button")!.className.replace("h-[26px]", "h-6"),
    );
  });

  it("sits right before Observe", async () => {
    await connect();
    render(Sidebar);
    const toggles = [...document.querySelectorAll("[data-section-toggle]")].map((b) => b.textContent?.trim().split(/\s+/)[0]);
    expect(toggles.slice(-3)).toEqual(["Access", "Custom", "Observe"]);
  });

  it("the filter narrows the same rows by kind, API group or vendor", async () => {
    await connect();
    sidebar.open("custom");
    render(Sidebar);
    const filter = screen.getByLabelText("Filter custom resources");
    await fireEvent.input(filter, { target: { value: "podmon" } });
    expect(lines()).toEqual(["# coreos.com", "PodMonitor"]);
    await fireEvent.input(filter, { target: { value: "kibana.k8s" } });
    expect(lines()).toEqual(["# elastic.co", "Kibana"]);
    await fireEvent.input(filter, { target: { value: "ELASTIC" } });
    expect(lines()).toEqual(["# elastic.co", "Agent", "Elasticsearch", "Kibana"]);
    await fireEvent.input(filter, { target: { value: "zzz" } });
    expect(screen.getByText("No match")).toBeInTheDocument();
  });

  it("a kind name that appears twice under one vendor shows its group", async () => {
    await connect([k("cert-manager.io", "Certificate", "certificates"), k("acme.cert-manager.io", "Certificate", "certificates")]);
    sidebar.open("custom");
    render(Sidebar);
    expect(lines()).toEqual(["# cert-manager.io", "Certificate (acme.cert-manager.io)", "Certificate (cert-manager.io)"]);
  });

  it("says when the cluster has no custom resources, while discovery is unknown, or when it failed", async () => {
    sidebar.open("custom");
    const first = render(Sidebar);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    first.unmount();
    await connect([k("apps", "Deployment", "deployments")]);
    const second = render(Sidebar);
    expect(screen.getByText("No custom resources on this cluster")).toBeInTheDocument();
    second.unmount();
    const ctx = `custom-fail-${++n}`;
    vi.mocked(discoverResourceKinds).mockRejectedValueOnce(new Error("boom"));
    await dynamic.discover(ctx);
    app.activeCluster = ctx;
    render(Sidebar);
    expect(screen.getByText("Couldn't discover custom resources")).toBeInTheDocument();
  });

  it("a pinned custom kind shows its kind name, the grey dot and its API group", async () => {
    await connect();
    profiles.togglePin("crd:monitoring.coreos.com/servicemonitors");
    render(Sidebar);
    const pinned = within(screen.getByRole("list", { name: "Pinned · On-call" }));
    const row = pinned.getByText("ServiceMonitor").closest("button")!;
    expect(row).toHaveAttribute("title", "monitoring.coreos.com");
    expect(row.querySelector("span")!.getAttribute("style")).toContain("--color-text-tertiary");
  });

  it("a pinned custom kind on a cluster that lacks it", async () => {
    profiles.togglePin("crd:monitoring.coreos.com/servicemonitors");
    await connect([k("apps", "Deployment", "deployments")]);
    render(Sidebar);
    const pinned = within(screen.getByRole("list", { name: "Pinned · On-call" }));
    expect(pinned.getByText("servicemonitors").closest("button")).toHaveAttribute("title", "Not available on this cluster");
  });

  it("navigating to a custom kind opens its section, clears the filter and scrolls its row into view", async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    await connect();
    sidebar.customFilter = "agent";
    render(Sidebar);
    app.navigate("crd:monitoring.coreos.com/prometheusrules");
    await vi.waitFor(() => expect(custom()).toHaveAttribute("aria-expanded", "true"));
    expect(sidebar.customFilter).toBe("");
    expect(list().getByText("PrometheusRule").closest("button")).toHaveAttribute("aria-current", "page");
    await vi.waitFor(() => expect(scroll.mock.contexts.some((el) => (el as Element).textContent?.includes("PrometheusRule"))).toBe(true));
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
