import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("#lib/tauri.ts", () => ({
  discoverResourceKinds: vi.fn(async () => []),
  listResourceTable: vi.fn(async () => ({
    columns: [],
    rows: [{ name: "a", namespace: "x", creation_timestamp: null, cells: [] }],
  })),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import { countFor } from "./nav-counts.svelte";
import { app } from "./app.svelte";
import { resources } from "./resources.svelte";
import { dynamic } from "./dynamic.svelte";
import { lists } from "./lists.svelte";
import type { PodInfo } from "#lib/tauri.ts";

const pod = (ready: boolean): PodInfo => ({
  name: "p",
  namespace: "default",
  phase: ready ? "Running" : "Pending",
  ready,
  restarts: 0,
  ready_containers: 1,
  total_containers: 1,
  node: null,
  pod_ip: null,
  qos_class: null,
  containers: [],
  labels: {},
  creation_timestamp: null,
});

beforeEach(() => {
  app.kubeconfigPath = "/k";
  app.activeCluster = "counts";
  app.namespace = null;
  resources.clear();
});

describe("countFor", () => {
  it("counts pods with a separate attention badge", async () => {
    resources.pods = [pod(true), pod(false)];
    const count = countFor("pods")!;
    expect(count.value).toBe(2);
    expect(count.attention).toMatchObject({ value: 1, label: "1 pod needs attention", tone: "err" });
    count.attention!.open();
    expect(app.view).toBe("pods");
    expect(lists.pressed("pods")).toEqual(["err", "warn"]);
  });

  it("shows a ★ kind only once loaded for the current namespace", async () => {
    expect(countFor("roles")).toBeNull();
    await dynamic.load("roles");
    expect(countFor("roles")).toEqual({ value: 1, attention: null });
    app.namespace = "other";
    expect(countFor("roles")).toBeNull();
  });

  it("is null for views without a list", () => {
    expect(countFor("logs")).toBeNull();
    expect(countFor("overview")).toBeNull();
  });
});
