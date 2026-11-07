import { describe, it, expect, beforeEach, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";

vi.mock("#lib/tauri.ts", () => ({
  discoverResourceKinds: vi.fn(async () => []),
  listResourceTable: vi.fn(),
  getDynamicResourceYaml: vi.fn(async () => "apiVersion: apps/v1\nkind: DaemonSet\n"),
}));

import { discoverResourceKinds, getDynamicResourceYaml, listResourceTable, type ResourceTable } from "#lib/tauri.ts";
import GenericKindView from "./GenericKindView.svelte";
import { app } from "#lib/stores/app.svelte.ts";
import { dynamic } from "#lib/stores/dynamic.svelte.ts";

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

  it("shows the load error", async () => {
    vi.mocked(listResourceTable).mockRejectedValue("403 Forbidden: daemonsets.apps is forbidden");
    render(GenericKindView, { view: "daemonsets" });
    expect(await screen.findByText("403 Forbidden: daemonsets.apps is forbidden")).toBeInTheDocument();
  });

  it("shows the empty state", async () => {
    vi.mocked(listResourceTable).mockResolvedValue({ columns: daemonsets.columns, rows: [] });
    render(GenericKindView, { view: "daemonsets" });
    expect(await screen.findByText("No daemon sets found.")).toBeInTheDocument();
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
