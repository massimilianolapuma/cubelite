import { describe, it, expect, beforeEach, vi } from "vitest";
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
  listServices: vi.fn(async () => []),
  listIngresses: vi.fn(async () => []),
  listConfigMaps: vi.fn(async () => []),
  listSecrets: vi.fn(async () => []),
  listHelmReleases: vi.fn(async () => []),
  streamLogs: vi.fn(async () => "1"),
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
    for (const chip of ["ALL", "INFO", "WARN", "ERROR"]) {
      expect(screen.getByText(chip)).toBeInTheDocument();
    }
    expect(screen.getByText("● Following")).toBeInTheDocument();
    expect(screen.getByText("Clear")).toBeInTheDocument();
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
    const errorRow = screen.getByText("ERROR boom").closest("div");
    expect(errorRow?.getAttribute("style")).toContain("--alpha-log-error-row");
  });

  it("filters by severity chip", async () => {
    render(LogsView);
    await new Promise((r) => setTimeout(r, 0));
    logs.push(line({ message: "info line" }));
    logs.push(line({ level: "warn", message: "warn line" }));
    await screen.findByText("warn line");
    await fireEvent.click(screen.getByText("WARN"));
    expect(screen.queryByText("info line")).toBeNull();
    expect(screen.getByText("warn line")).toBeInTheDocument();
  });

  it("shows the paused pill when paused with buffered lines", async () => {
    render(LogsView);
    await fireEvent.click(screen.getByText("● Following"));
    logs.push(line());
    expect(await screen.findByText("paused — new lines buffered")).toBeInTheDocument();
    expect(screen.getByText("⏸ Paused")).toBeInTheDocument();
  });

  it("clears the buffer", async () => {
    logs.push(line());
    render(LogsView);
    await fireEvent.click(screen.getByText("Clear"));
    expect(logs.lines).toHaveLength(0);
  });
});

describe("LogsView JSON view (#461)", () => {
  const json =
    '{"level":"warn","msg":"disk almost full","disk":"/var","pct":91}';

  beforeEach(() => {
    window.localStorage.removeItem("cubelite.logs.jsonView");
    logs.jsonView = false;
  });

  it("header toggle flips logs.jsonView and persists it", async () => {
    render(LogsView);
    const toggle = screen.getByRole("button", { name: "JSON view" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    await fireEvent.click(toggle);
    expect(logs.jsonView).toBe(true);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(window.localStorage.getItem("cubelite.logs.jsonView")).toBe("true");
  });

  it("toggle off: a JSON line renders raw", async () => {
    render(LogsView);
    await new Promise((r) => setTimeout(r, 0));
    logs.push(line({ message: json }));
    expect(await screen.findByText(json)).toBeInTheDocument();
    expect(screen.queryByTestId("json-row")).toBeNull();
  });

  it("toggle on: humanised row with JSON level, click expands the tree, Clear collapses", async () => {
    logs.jsonView = true;
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

    await fireEvent.click(screen.getByText("Clear"));
    expect(logs.expanded.size).toBe(0);
  });

  it("pod column is wide and carries the full name as title", async () => {
    render(LogsView);
    await new Promise((r) => setTimeout(r, 0));
    logs.push(line({ pod: "simulator-bff-5dd4ff54cf-9bq7n" }));
    const pod = await screen.findByText("simulator-bff-5dd4ff54cf-9bq7n");
    expect(pod).toHaveAttribute("title", "simulator-bff-5dd4ff54cf-9bq7n");
    expect(pod.className).toContain("w-[140px]");
  });
});
