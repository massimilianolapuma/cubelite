import { describe, it, expect, beforeEach, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";

vi.mock("$lib/tauri", () => ({
  listContexts: vi.fn(),
  setContext: vi.fn(),
  listPods: vi.fn(),
  listNamespaces: vi.fn(),
  listDeployments: vi.fn(),
  deletePod: vi.fn(async () => undefined),
  restartDeployment: vi.fn(async () => undefined),
  scaleDeployment: vi.fn(async () => undefined),
  listEvents: vi.fn(async () => []),
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
import { app } from "$lib/stores/app.svelte";
import { logs } from "$lib/stores/logs.svelte";
import { resources } from "$lib/stores/resources.svelte";
import type { LogLine } from "$lib/tauri";

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

  it("renders lines with time, level, pod and message", () => {
    logs.push(line());
    logs.push(line({ pod: "worker-1", level: "error", message: "ERROR boom" }));
    render(LogsView);
    expect(screen.getByText("listening on :8080")).toBeInTheDocument();
    expect(screen.getByText("ERROR boom")).toBeInTheDocument();
    expect(screen.getByText("worker-1")).toBeInTheDocument();
    const errorRow = screen.getByText("ERROR boom").closest("div");
    expect(errorRow?.getAttribute("style")).toContain("--alpha-log-error-row");
  });

  it("filters by severity chip", async () => {
    logs.push(line({ message: "info line" }));
    logs.push(line({ level: "warn", message: "warn line" }));
    render(LogsView);
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
