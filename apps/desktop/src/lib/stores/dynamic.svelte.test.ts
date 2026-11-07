import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("#lib/tauri.ts", () => ({
  discoverResourceKinds: vi.fn(),
  listResourceTable: vi.fn(),
}));

import {
  discoverResourceKinds,
  listResourceTable,
  type ResourceKindInfo,
  type ResourceTable,
  type TableRow,
} from "#lib/tauri.ts";
import { dynamic } from "./dynamic.svelte";
import { app } from "./app.svelte";

const discover = vi.mocked(discoverResourceKinds);
const table = vi.mocked(listResourceTable);

function kind(group: string, version: string, plural: string, namespaced = true): ResourceKindInfo {
  return { group, version, kind: plural, plural, namespaced, short_names: [] };
}

function row(name: string, namespace: string | null = "default"): TableRow {
  return { name, namespace, creation_timestamp: null, cells: [] };
}

const tableOf = (...rows: TableRow[]): ResourceTable => ({ columns: [], rows });

// The discovery cache lives for the session: every test uses its own context.
let n = 0;
const fresh = () => `ctx-${++n}`;

beforeEach(() => {
  vi.resetAllMocks();
  app.kubeconfigPath = "/k";
  app.activeCluster = fresh();
  app.namespace = null;
  dynamic.clear();
});

describe("discovery", () => {
  it("caches discovery per context", async () => {
    discover.mockResolvedValueOnce([kind("apps", "v1", "daemonsets")]);
    await dynamic.discover("a");
    await dynamic.discover("a");
    expect(discover).toHaveBeenCalledTimes(1);
    app.activeCluster = "b";
    expect(dynamic.isUnavailable("daemonsets")).toBe(false);
    expect(dynamic.isUnavailable("storageclasses")).toBe(false);
    app.activeCluster = "a";
    expect(dynamic.isUnavailable("daemonsets")).toBe(false);
    expect(dynamic.isUnavailable("storageclasses")).toBe(true);
  });

  it("force refreshes the cache", async () => {
    discover.mockResolvedValue([]);
    await dynamic.discover("c");
    await dynamic.discover("c", true);
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it("failed discovery greys nothing and uses the registry version", async () => {
    const ctx = fresh();
    discover.mockRejectedValueOnce(new Error("boom"));
    await dynamic.discover(ctx);
    app.activeCluster = ctx;
    expect(dynamic.isUnavailable("hpas")).toBe(false);
    expect(dynamic.refFor("hpas")).toEqual({
      group: "autoscaling",
      version: "v2",
      plural: "horizontalpodautoscalers",
      namespaced: true,
    });
  });

  it("a null discovery answer counts as failed", async () => {
    const ctx = fresh();
    discover.mockResolvedValueOnce(null as unknown as ResourceKindInfo[]);
    await dynamic.discover(ctx);
    app.activeCluster = ctx;
    expect(dynamic.isUnavailable("roles")).toBe(false);
    discover.mockResolvedValueOnce([]);
    await dynamic.discover(ctx);
    expect(discover).toHaveBeenCalledTimes(2);
    expect(dynamic.isUnavailable("roles")).toBe(true);
  });

  it("picks the discovered version", async () => {
    const ctx = fresh();
    discover.mockResolvedValueOnce([kind("autoscaling", "v1", "horizontalpodautoscalers")]);
    await dynamic.discover(ctx);
    app.activeCluster = ctx;
    expect(dynamic.refFor("hpas").version).toBe("v1");
  });

  it("matches on group as well as plural", async () => {
    const ctx = fresh();
    discover.mockResolvedValueOnce([kind("example.com", "v1", "roles")]);
    await dynamic.discover(ctx);
    app.activeCluster = ctx;
    expect(dynamic.isUnavailable("roles")).toBe(true);
  });
});

describe("tables", () => {
  it("loads a cluster-scoped kind without namespace and counts it in any namespace", async () => {
    app.namespace = "team-a";
    table.mockResolvedValueOnce(tableOf(row("fast", null)));
    await dynamic.load("storageclasses");
    expect(table).toHaveBeenCalledWith(
      "/k",
      expect.objectContaining({ plural: "storageclasses", namespaced: false }),
      undefined,
      app.activeCluster,
    );
    expect(dynamic.count("storageclasses")).toBe(1);
    app.namespace = "team-b";
    expect(dynamic.count("storageclasses")).toBe(1);
  });

  it("counts a namespaced kind only for the namespace it was loaded for", async () => {
    table.mockResolvedValueOnce(tableOf(row("a"), row("b")));
    await dynamic.load("serviceaccounts");
    expect(table).toHaveBeenCalledWith("/k", expect.objectContaining({ plural: "serviceaccounts" }), undefined, app.activeCluster);
    expect(dynamic.count("serviceaccounts")).toBe(2);
    app.namespace = "x";
    expect(dynamic.count("serviceaccounts")).toBeNull();
    expect(dynamic.count("daemonsets")).toBeNull();
  });

  it("drops a late answer after the namespace changed", async () => {
    let resolve!: (t: ResourceTable) => void;
    table.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const first = dynamic.load("roles");
    await vi.waitFor(() => expect(table).toHaveBeenCalledTimes(1));
    app.namespace = "b";
    table.mockResolvedValueOnce(tableOf());
    await dynamic.load("roles");
    resolve(tableOf(row("stale")));
    await first;
    expect(dynamic.tables.roles?.rows).toEqual([]);
    expect(dynamic.count("roles")).toBe(0);
  });

  it("drops a late answer after clear (cluster switch)", async () => {
    let resolve!: (t: ResourceTable) => void;
    table.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const first = dynamic.load("roles");
    await vi.waitFor(() => expect(table).toHaveBeenCalledTimes(1));
    dynamic.clear();
    resolve(tableOf(row("old-cluster")));
    await first;
    expect(dynamic.tables.roles).toBeUndefined();
    expect(dynamic.count("roles")).toBeNull();
  });

  it("records the error and skips unavailable kinds", async () => {
    table.mockRejectedValueOnce("403 Forbidden: roles.rbac.authorization.k8s.io is forbidden");
    await dynamic.load("roles");
    expect(dynamic.errors.roles).toContain("Forbidden");
    expect(dynamic.loading.roles).toBe(false);

    const ctx = fresh();
    discover.mockResolvedValueOnce([]);
    await dynamic.discover(ctx);
    app.activeCluster = ctx;
    table.mockClear();
    await dynamic.load("roles");
    expect(table).not.toHaveBeenCalled();
  });

  it("a successful load clears the previous error", async () => {
    table.mockRejectedValueOnce(new Error("boom"));
    await dynamic.load("pdbs");
    table.mockResolvedValueOnce(tableOf());
    await dynamic.load("pdbs");
    expect(dynamic.errors.pdbs).toBeUndefined();
  });

  it("waits for the in-flight discovery before loading", async () => {
    let resolve!: (k: ResourceKindInfo[]) => void;
    discover.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const ctx = app.activeCluster as string;
    const discovering = dynamic.discover(ctx);
    table.mockResolvedValueOnce(tableOf());
    const loading = dynamic.load("hpas");
    resolve([kind("autoscaling", "v1", "horizontalpodautoscalers")]);
    await Promise.all([discovering, loading]);
    expect(table).toHaveBeenCalledWith("/k", expect.objectContaining({ version: "v1" }), undefined, ctx);
  });

  it("does nothing without a cluster, and never rejects", async () => {
    app.activeCluster = null;
    await dynamic.load("roles");
    expect(table).not.toHaveBeenCalled();
    app.activeCluster = fresh();
    table.mockImplementationOnce(() => {
      throw new Error("No export on the mock");
    });
    await expect(dynamic.load("roles")).resolves.toBeUndefined();
    discover.mockImplementationOnce(() => {
      throw new Error("No export on the mock");
    });
    await expect(dynamic.discover(fresh())).resolves.toBeUndefined();
  });

  it("clear drops tables but keeps discovery", async () => {
    const ctx = app.activeCluster as string;
    discover.mockResolvedValueOnce([kind("rbac.authorization.k8s.io", "v1", "roles")]);
    await dynamic.discover(ctx);
    table.mockResolvedValueOnce(tableOf(row("r")));
    await dynamic.load("roles");
    dynamic.clear();
    expect(dynamic.tables).toEqual({});
    expect(dynamic.count("roles")).toBeNull();
    expect(dynamic.isUnavailable("daemonsets")).toBe(true);
    expect(dynamic.isUnavailable("roles")).toBe(false);
  });
});
