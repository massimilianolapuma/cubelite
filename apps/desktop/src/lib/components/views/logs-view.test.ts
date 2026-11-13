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
  listServices: vi.fn(async () => []),
  listIngresses: vi.fn(async () => []),
  listConfigMaps: vi.fn(async () => []),
  listSecrets: vi.fn(async () => []),
  listHelmReleases: vi.fn(async () => []),
  streamLogs: vi.fn(async () => "1"),
  listDaemonSets: vi.fn(async () => []),
  stopLogs: vi.fn(async () => undefined),
  watchResources: vi.fn(),
  unwatchResources: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import LogsView from "./LogsView.svelte";
import { app } from "#lib/stores/app.svelte.ts";
import { logs } from "#lib/stores/logs.svelte.ts";
import { resources } from "#lib/stores/resources.svelte.ts";
import type { LogLine } from "#lib/tauri.ts";

function line(overrides: Partial<LogLine> = {}): LogLine {
  return {
    pod: "api-0",
    namespace: "default",
    time: "2026-07-11T10:00:00Z",
    level: "info",
    message: "listening on :8080",
    ...overrides,
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  await logs.stop();
  logs.clear();
  logs.level = "all";
  logs.textFilter = "";
  logs.following = true;
  app.view = "logs";
  app.activeCluster = "prod";
  app.kubeconfigPath = "/home/u/.kube/config";
  app.namespace = null;
  resources.pods = [];
});

describe("LogsView", () => {
  it("renders severity chips, follow toggle and clear", () => {
    render(LogsView);
    const levels = within(screen.getByRole("radiogroup", { name: "Level" }));
    for (const chip of ["All", "INFO", "WARN", "ERROR"]) {
      expect(levels.getByRole("radio", { name: chip })).toBeInTheDocument();
    }
    expect(levels.getByRole("radio", { name: "All" })).toHaveAttribute("aria-checked", "true");
    // Following is a chip with the circle, not a coloured word (Tonal §8.5).
    const follow = screen.getByRole("button", { name: "Following" });
    expect(follow).toHaveAttribute("data-state", "following");
    expect(follow.querySelector('[data-glyph="ok"]')).not.toBeNull();
    expect(screen.getByRole("button", { name: "Clear" })).toBeInTheDocument();
  });

  it("renders lines with time, level, pod and message", async () => {
    render(LogsView);
    // Mounting restarts the stream, which clears the buffer — let the
    // restart settle, then seed lines and wait for the flush to publish.
    await new Promise((r) => setTimeout(r, 0));
    logs.push(line());
    logs.push(line({ pod: "worker-1", level: "error", message: "ERROR boom" }));
    expect(await screen.findByText("listening on :8080")).toBeInTheDocument();
    expect(screen.getByText("ERROR boom")).toBeInTheDocument();
    expect(screen.getByText("worker-1")).toBeInTheDocument();
    const errorRow = screen.getByText("ERROR boom").closest("[data-level]");
    expect(errorRow).toHaveAttribute("data-level", "error");
  });

  it("filters by severity chip", async () => {
    render(LogsView);
    await new Promise((r) => setTimeout(r, 0));
    logs.push(line({ message: "info line" }));
    logs.push(line({ level: "warn", message: "warn line" }));
    await screen.findByText("warn line");
    await fireEvent.click(screen.getByRole("radio", { name: "WARN" }));
    expect(screen.queryByText("info line")).toBeNull();
    expect(screen.getByText("warn line")).toBeInTheDocument();
  });

  it("shows the paused pill when paused with buffered lines", async () => {
    render(LogsView);
    await fireEvent.click(screen.getByRole("button", { name: "Following" }));
    logs.push(line());
    expect(await screen.findByText("paused, new lines buffered")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Paused" })).toHaveAttribute("data-state", "paused");
  });

  it("clears the buffer", async () => {
    logs.push(line());
    render(LogsView);
    await fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(logs.lines).toHaveLength(0);
  });
});

describe("LogsView JSON view (#461)", () => {
  const json =
    '{"level":"warn","msg":"disk almost full","disk":"/var","pct":91}';

  beforeEach(() => {
    window.localStorage.removeItem("cubelite.logs.viewMode");
    logs.viewMode = "raw";
  });

  it("header mode control selects a mode and persists it", async () => {
    render(LogsView);
    const json = screen.getByRole("radio", { name: "JSON" });
    expect(json).toHaveAttribute("aria-checked", "false");
    await fireEvent.click(json);
    expect(logs.viewMode).toBe("json");
    expect(json).toHaveAttribute("aria-checked", "true");
    expect(window.localStorage.getItem("cubelite.logs.viewMode")).toBe('"json"');
  });

  it("toggle off: a JSON line renders raw", async () => {
    render(LogsView);
    await new Promise((r) => setTimeout(r, 0));
    logs.push(line({ message: json }));
    expect(await screen.findByText(json)).toBeInTheDocument();
    expect(screen.queryByTestId("json-row")).toBeNull();
  });

  it("toggle on: humanised row with JSON level, click expands the tree, Clear collapses", async () => {
    logs.viewMode = "json";
    render(LogsView);
    await new Promise((r) => setTimeout(r, 0));
    logs.push(line({ message: json }));
    const row = await screen.findByTestId("json-row");
    expect(row).toHaveTextContent("disk almost full");
    expect(row).toHaveTextContent("disk=/var");
    expect(row).toHaveTextContent("pct=91");
    expect(screen.getByText("warn")).toBeInTheDocument();
    expect(screen.queryByText(json)).toBeNull();

    await fireEvent.click(row);
    expect(row).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("json-tree")).toBeInTheDocument();
    expect(logs.expanded.has(logs.lines[0]!.id)).toBe(true);

    await fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(logs.expanded.size).toBe(0);
  });

  // Its width is checked on the rendered page (logs-tonal.spec.ts).
  it("pod column carries the full name as title", async () => {
    render(LogsView);
    await new Promise((r) => setTimeout(r, 0));
    logs.push(line({ pod: "simulator-bff-5dd4ff54cf-9bq7n" }));
    const pod = await screen.findByText("simulator-bff-5dd4ff54cf-9bq7n");
    expect(pod).toHaveAttribute("title", "simulator-bff-5dd4ff54cf-9bq7n");
  });
});
