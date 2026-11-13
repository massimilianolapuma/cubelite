import { describe, it, expect, beforeEach, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, within } from "@testing-library/svelte";

vi.mock("#lib/tauri.ts", () => ({
  discoverResourceKinds: vi.fn(async () => []),
  listResourceTable: vi.fn(),
  getDynamicResourceYaml: vi.fn(async () => "apiVersion: apps/v1\nkind: DaemonSet\n"),
}));

import { discoverResourceKinds, getDynamicResourceYaml, listResourceTable, type ResourceTable } from "#lib/tauri.ts";
import GenericKindView from "./GenericKindView.svelte";
import { viewEntry } from "./index.ts";
import { app } from "#lib/stores/app.svelte.ts";
import { dynamic } from "#lib/stores/dynamic.svelte.ts";
import { layout } from "#lib/stores/layout.svelte.ts";

const col = (name: string, column_type = "string", format = "") => ({ name, column_type, format, description: "" });

const daemonsets: ResourceTable = {
  columns: [col("Name", "string", "name"), col("Desired", "integer"), col("Node Selector"), col("Age", "date")],
  rows: [
    { name: "fluent-bit", namespace: "logging", creation_timestamp: "2026-11-01T00:00:00Z", cells: ["fluent-bit", 3, "<none>", "2026-11-01T00:00:00Z"] },
    { name: "kube-proxy", namespace: "kube-system", creation_timestamp: "2026-10-01T00:00:00Z", cells: ["kube-proxy", 1, "kubernetes.io/os=linux", "2026-10-01T00:00:00Z"] },
  ],
};

let n = 0;

beforeEach(() => {
  vi.mocked(listResourceTable).mockReset();
  vi.mocked(listResourceTable).mockResolvedValue(daemonsets);
  app.kubeconfigPath = "/k";
  app.activeCluster = `ctx-${++n}`;
  app.namespace = null;
  app.selectedObject = null;
  layout.contentWidth = 0;
  dynamic.clear();
});

describe("GenericKindView", () => {
  it("renders kubectl's columns and the rows", async () => {
    render(GenericKindView, { view: "daemonsets" });
    expect(await screen.findByText("fluent-bit")).toBeInTheDocument();
    for (const h of ["Name", "Namespace", "Age"]) expect(screen.getByRole("button", { name: `Sort by ${h}` })).toBeInTheDocument();
    for (const h of ["Desired", "Node Selector"]) expect(screen.getByText(h, { exact: true })).toBeInTheDocument();
    expect(screen.getByText("kubernetes.io/os=linux")).toBeInTheDocument();
    expect(screen.getByText("logging")).toBeInTheDocument();
  });

  it("says cluster-scoped and hides the group toggle for cluster-scoped kinds", async () => {
    vi.mocked(listResourceTable).mockResolvedValue({
      columns: [col("Name", "string", "name"), col("Provisioner"), col("Age", "date")],
      rows: [{ name: "standard", namespace: null, creation_timestamp: null, cells: ["standard", "k8s.io/minikube-hostpath", null] }],
    });
    render(GenericKindView, { view: "storageclasses" });
    expect(await screen.findByText("standard")).toBeInTheDocument();
    expect(screen.getByText("cluster-scoped")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Group by namespace" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Sort by Namespace" })).toBeNull();
  });

  it("filters by name", async () => {
    render(GenericKindView, { view: "daemonsets" });
    await screen.findByText("fluent-bit");
    await fireEvent.input(screen.getByLabelText("Filter DaemonSets"), { target: { value: "FLU" } });
    expect(screen.getByText("fluent-bit")).toBeInTheDocument();
    expect(screen.queryByText("kube-proxy")).toBeNull();
  });

  it("shows Not available on this cluster when discovery lacks the kind", async () => {
    await dynamic.discover(app.activeCluster as string);
    render(GenericKindView, { view: "daemonsets" });
    expect(await screen.findByText("Not available on this cluster")).toBeInTheDocument();
    expect(listResourceTable).not.toHaveBeenCalled();
    expect(discoverResourceKinds).toHaveBeenCalled();
  });

  it("shows the load error with Retry", async () => {
    vi.mocked(listResourceTable).mockRejectedValueOnce("connection refused");
    render(GenericKindView, { view: "daemonsets" });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not load daemon sets");
    expect(alert).toHaveTextContent("connection refused");
    await fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("fluent-bit")).toBeInTheDocument();
  });

  it("says so when RBAC forbids the list", async () => {
    vi.mocked(listResourceTable).mockRejectedValue("403 Forbidden: daemonsets.apps is forbidden");
    render(GenericKindView, { view: "daemonsets" });
    expect(await screen.findByText("You are not allowed to list daemon sets in any namespace.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("a filter that matches nothing offers Clear filter", async () => {
    render(GenericKindView, { view: "daemonsets" });
    await screen.findByText("fluent-bit");
    await fireEvent.input(screen.getByLabelText("Filter DaemonSets"), { target: { value: "zzz" } });
    expect(screen.getByRole("heading", { name: 'No daemon sets match "zzz"' })).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Clear filter" }));
    expect(screen.getByLabelText("Filter DaemonSets")).toHaveValue("");
    expect(screen.getByText("fluent-bit")).toBeInTheDocument();
  });

  it("shows the empty state", async () => {
    vi.mocked(listResourceTable).mockResolvedValue({ columns: daemonsets.columns, rows: [] });
    render(GenericKindView, { view: "daemonsets" });
    expect(await screen.findByRole("heading", { name: "No daemon sets in any namespace" })).toBeInTheDocument();
  });

  it("opens the read-only YAML drawer on row click", async () => {
    render(GenericKindView, { view: "daemonsets" });
    await fireEvent.click(await screen.findByRole("button", { name: /fluent-bit/ }));
    const drawer = await screen.findByRole("dialog", { name: "fluent-bit" });
    await vi.waitFor(() => expect(drawer).toHaveTextContent("kind: DaemonSet"));
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(getDynamicResourceYaml).toHaveBeenCalledWith(
      "/k",
      { group: "apps", version: "v1", plural: "daemonsets", namespaced: true },
      "logging",
      "fluent-bit",
      app.activeCluster,
    );
  });

  it("marks the open row as current, not by colour alone", async () => {
    render(GenericKindView, { view: "daemonsets" });
    const row = await screen.findByRole("button", { name: /fluent-bit/ });
    expect(row).not.toHaveAttribute("aria-current");
    await fireEvent.click(row);
    expect(row).toHaveAttribute("aria-current", "true");
    expect(row).toHaveAttribute("data-selected", "true");
    expect(screen.getByRole("button", { name: /kube-proxy/ })).not.toHaveAttribute("aria-current");
  });

  it("a namespace change shows Loading instead of the previous namespace's rows", async () => {
    render(GenericKindView, { view: "daemonsets" });
    await screen.findByRole("button", { name: /fluent-bit/ });
    vi.mocked(listResourceTable).mockReturnValueOnce(new Promise(() => {}));
    app.namespace = "logging";
    await vi.waitFor(() => expect(screen.getByRole("status", { name: "Loading daemon sets" })).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /fluent-bit/ })).toBeNull();
  });

  it("the panel lists every column the server returned, above the YAML", async () => {
    render(GenericKindView, { view: "daemonsets" });
    await fireEvent.click(await screen.findByRole("button", { name: /fluent-bit/ }));
    const drawer = await screen.findByRole("dialog", { name: "fluent-bit" });
    const summary = within(drawer).getByRole("group", { name: "Summary" });
    expect(within(summary).getAllByRole("term").map((el) => el.textContent)).toEqual(["Namespace", "Desired", "Node Selector", "Age"]);
    expect(within(summary).getByText("<none>")).toBeInTheDocument();
    expect(within(drawer).getByText("daemon set")).toBeInTheDocument();
  });

  it("the Summary's age is the object's age, whatever the server put in the cell", async () => {
    vi.mocked(listResourceTable).mockResolvedValue({
      columns: [col("Name", "string", "name"), col("Age", "date"), col("Last Seen", "date")],
      rows: [{ name: "x", namespace: "default", creation_timestamp: "2020-01-01T00:00:00Z", cells: ["x", "10d", "3h"] }],
    });
    render(GenericKindView, { view: "daemonsets" });
    await fireEvent.click(await screen.findByRole("button", { name: /^x/ }));
    const summary = within(await screen.findByRole("dialog", { name: "x" })).getByRole("group", { name: "Summary" });
    const values = within(summary).getAllByRole("definition").map((el) => el.textContent?.trim());
    // Namespace, Age (from the creation timestamp, years ago), Last Seen (the server's own text).
    expect(values[0]).toBe("default");
    expect(values[1]).toMatch(/^\d+d$/);
    expect(values[2]).toBe("3h");
  });

  it("opens the panel of a kind whose columns repeat a label", async () => {
    vi.mocked(listResourceTable).mockResolvedValue({
      columns: [col("Name", "string", "name"), col("Namespace"), col("Status"), col("Status")],
      rows: [{ name: "x", namespace: "default", creation_timestamp: null, cells: ["x", "default", "a", "b"] }],
    });
    render(GenericKindView, { view: "daemonsets" });
    await fireEvent.click(await screen.findByRole("button", { name: /^x/ }));
    const summary = within(await screen.findByRole("dialog", { name: "x" })).getByRole("group", { name: "Summary" });
    expect(within(summary).getAllByRole("term").map((el) => el.textContent)).toEqual(["Namespace", "Namespace", "Status", "Status"]);
  });

  it("beside a docked panel the list keeps at most five columns; the rest is in the panel", async () => {
    const wide = ["A", "B", "C", "D", "E", "F"];
    vi.mocked(listResourceTable).mockResolvedValue({
      columns: [col("Name", "string", "name"), ...wide.map((n) => col(n))],
      rows: [{ name: "x", namespace: "default", creation_timestamp: null, cells: ["x", ...wide.map((n) => n.toLowerCase())] }],
    });
    layout.contentWidth = 1200;
    render(GenericKindView, { view: "daemonsets" });
    const row = await screen.findByRole("button", { name: /^x/ });
    expect(document.querySelectorAll(".list-head > *")).toHaveLength(8);
    await fireEvent.click(row);
    expect([...document.querySelectorAll(".list-head > *")].map((el) => el.textContent?.trim())).toEqual(["Name", "Namespace", "A", "B", "C"]);
    const summary = within(await screen.findByRole("dialog", { name: "x" })).getByRole("group", { name: "Summary" });
    expect(within(summary).getAllByRole("term").map((el) => el.textContent)).toEqual(["Namespace", ...wide]);
  });

  it("filter and drawer reset when the kind changes", async () => {
    const view = render(GenericKindView, { view: "daemonsets" });
    await screen.findByText("fluent-bit");
    await fireEvent.input(screen.getByLabelText("Filter DaemonSets"), { target: { value: "flu" } });
    await fireEvent.click(screen.getByRole("button", { name: /fluent-bit/ }));
    expect(await screen.findByRole("dialog", { name: "fluent-bit" })).toBeInTheDocument();

    app.navigate("replicasets");
    await view.rerender({ view: "replicasets" });
    expect(screen.getByLabelText("Filter ReplicaSets")).toHaveValue("");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("custom kinds (resource-kinds §5.3)", () => {
  const kindInfo = (group: string, kind: string, plural: string) => ({ group, version: "v1", kind, plural, namespaced: true, short_names: [] });

  async function discovered(...kinds: ReturnType<typeof kindInfo>[]) {
    vi.mocked(discoverResourceKinds).mockResolvedValueOnce(kinds);
    await dynamic.discover(app.activeCluster as string);
  }

  it("viewEntry falls back to Overview for a view it does not know", () => {
    const entry = viewEntry("crd:x" as never);
    expect(entry).toBeDefined();
    expect(entry.component).toBe(viewEntry("overview").component);
  });

  it("viewEntry renders GenericKindView for a custom id", () => {
    const entry = viewEntry("crd:monitoring.coreos.com/servicemonitors");
    expect(entry.component).toBe(GenericKindView);
    expect(entry.props).toEqual({ view: "crd:monitoring.coreos.com/servicemonitors" });
    expect(viewEntry("daemonsets").props).toEqual({ view: "daemonsets" });
  });

  it("a custom kind lists with its kind as title and its group as caption", async () => {
    await discovered(kindInfo("monitoring.coreos.com", "ServiceMonitor", "servicemonitors"));
    vi.mocked(listResourceTable).mockResolvedValue({ columns: daemonsets.columns, rows: [] });
    render(GenericKindView, { view: "crd:monitoring.coreos.com/servicemonitors" });
    expect(screen.getByRole("heading", { name: "ServiceMonitor" })).toBeInTheDocument();
    expect(screen.getByText("monitoring.coreos.com")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "No servicemonitors in any namespace" })).toBeInTheDocument();
    expect(screen.getByLabelText("Filter ServiceMonitor")).toHaveAttribute("placeholder", "Filter servicemonitors…");
  });

  it("same kind name in two groups", async () => {
    await discovered(kindInfo("cert-manager.io", "Certificate", "certificates"), kindInfo("acme.example.com", "Certificate", "certificates"));
    vi.mocked(listResourceTable).mockResolvedValue({ columns: [], rows: [] });
    const view = render(GenericKindView, { view: "crd:cert-manager.io/certificates" });
    await vi.waitFor(() => expect(listResourceTable).toHaveBeenCalledWith("/k", expect.objectContaining({ group: "cert-manager.io" }), undefined, app.activeCluster));
    await view.rerender({ view: "crd:acme.example.com/certificates" });
    await vi.waitFor(() => expect(listResourceTable).toHaveBeenCalledWith("/k", expect.objectContaining({ group: "acme.example.com" }), undefined, app.activeCluster));
    expect(screen.getByText("acme.example.com")).toBeInTheDocument();
  });

  it("an unserved custom kind says Not available on this cluster", async () => {
    await discovered(kindInfo("monitoring.coreos.com", "ServiceMonitor", "servicemonitors"));
    render(GenericKindView, { view: "crd:example.com/widgets" });
    expect(await screen.findByText("Not available on this cluster")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "widgets" })).toBeInTheDocument();
    expect(listResourceTable).not.toHaveBeenCalled();
  });
});
