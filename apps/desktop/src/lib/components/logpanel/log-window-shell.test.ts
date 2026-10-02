import { describe, it, expect, afterEach, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: vi.fn(async () => () => {}),
    destroy: vi.fn(async () => {}),
  }),
}));
vi.mock("$lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("$lib/tauri")>()),
  streamPodLog: vi.fn(async () => "1"),
  stopLogs: vi.fn(async () => {}),
  getPodContainers: vi.fn(async () => []),
}));
vi.mock("../../stores/logWindows.svelte", () => ({
  logWindows: { detach: vi.fn(async () => {}) },
}));

import LogWindowShell from "./LogWindowShell.svelte";
import { LogSession } from "$lib/stores/logSession.svelte";
import { logPanel } from "$lib/stores/logPanel.svelte";

function withSession(): void {
  const s = new LogSession("default", "api-0");
  logPanel.sessions = [s];
  logPanel.activeKey = s.key;
}

describe("LogWindowShell shortcuts (#351)", () => {
  afterEach(() => {
    logPanel.sessions = [];
    logPanel.activeKey = null;
  });

  it("mod+F focuses the pop-out's log search", async () => {
    withSession();
    render(LogWindowShell, { windowKey: "default/api-0" });
    const search = screen.getByPlaceholderText(/Search…/);
    expect(search).not.toHaveFocus();
    // jsdom is not macOS, so the modifier is Ctrl.
    const notPrevented = await fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    expect(notPrevented).toBe(false);
    expect(search).toHaveFocus();
  });

  it("leaves other shortcuts to the browser", async () => {
    withSession();
    render(LogWindowShell, { windowKey: "default/api-0" });
    expect(await fireEvent.keyDown(window, { key: "k", ctrlKey: true })).toBe(true);
    expect(await fireEvent.keyDown(window, { key: "l", ctrlKey: true })).toBe(true);
    expect(await fireEvent.keyDown(window, { key: "f" })).toBe(true);
  });

  it("does nothing before the session arrives", async () => {
    render(LogWindowShell, { windowKey: "default/api-0" });
    expect(screen.getByText("Connecting…")).toBeInTheDocument();
    expect(await fireEvent.keyDown(window, { key: "f", ctrlKey: true })).toBe(true);
  });
});
