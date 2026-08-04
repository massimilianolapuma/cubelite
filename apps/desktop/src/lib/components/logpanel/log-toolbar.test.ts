import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/svelte";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));
vi.mock("$lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("$lib/tauri")>()),
  streamPodLog: vi.fn(async () => "1"),
  stopLogs: vi.fn(async () => {}),
  getPodContainers: vi.fn(async () => []),
}));

import LogToolbar from "./LogToolbar.svelte";
import { LogSession } from "$lib/stores/logSession.svelte";
import type { ContainerDetail } from "$lib/tauri";

function container(overrides: Partial<ContainerDetail> = {}): ContainerDetail {
  return {
    name: "worker",
    init: false,
    sidecar: false,
    restarts: 0,
    ready: true,
    state: "running",
    state_reason: null,
    last_terminated_reason: null,
    last_terminated_at: null,
    ...overrides,
  };
}

describe("LogToolbar", () => {
  it("hides the previous chip when the container has no restarts", () => {
    const s = new LogSession("default", "api-0");
    s.containers = [container({ restarts: 0 })];
    s.container = "worker";
    render(LogToolbar, { props: { session: s } });
    expect(screen.queryByText("prev")).toBeNull();
  });

  it("shows the previous chip when restarts > 0", () => {
    const s = new LogSession("default", "api-0");
    s.containers = [container({ restarts: 3 })];
    s.container = "worker";
    render(LogToolbar, { props: { session: s } });
    expect(screen.getByText("prev")).toBeInTheDocument();
  });
});
