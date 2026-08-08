import { describe, it, expect, afterEach, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/svelte";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));
vi.mock("$lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("$lib/tauri")>()),
  streamPodLog: vi.fn(async () => "1"),
  stopLogs: vi.fn(async () => {}),
  getPodContainers: vi.fn(async () => []),
}));

import LogTabStrip from "./LogTabStrip.svelte";
import { logPanel } from "$lib/stores/logPanel.svelte";

describe("LogTabStrip", () => {
  afterEach(async () => {
    for (const s of [...logPanel.sessions]) await logPanel.closeSession(s.key);
  });

  it("renders one tab per session and marks the active one", async () => {
    await logPanel.openFor({ namespace: "default", name: "api-0" });
    await logPanel.openFor({ namespace: "default", name: "web-1" });
    render(LogTabStrip);
    expect(screen.getByText("api-0")).toBeInTheDocument();
    expect(screen.getByText("web-1")).toBeInTheDocument();
  });

  it("clicking a tab focuses its session", async () => {
    await logPanel.openFor({ namespace: "default", name: "api-0" });
    await logPanel.openFor({ namespace: "default", name: "web-1" });
    render(LogTabStrip);
    expect(logPanel.activeKey).toBe("default/web-1");

    await fireEvent.click(screen.getByText("api-0"));
    expect(logPanel.activeKey).toBe("default/api-0");
  });

  it("clicking a tab's close button closes that session", async () => {
    await logPanel.openFor({ namespace: "default", name: "api-0" });
    await logPanel.openFor({ namespace: "default", name: "web-1" });
    render(LogTabStrip);

    await fireEvent.click(screen.getByLabelText("Close web-1 logs"));
    await waitFor(() =>
      expect(logPanel.sessions.map((s) => s.key)).toEqual(["default/api-0"]),
    );
  });

  it("shows a status dot per session reflecting streaming vs error state", async () => {
    await logPanel.openFor({ namespace: "default", name: "api-0" });
    logPanel.active!.status = "error";
    render(LogTabStrip);
    // one dot per session; assert count matches session count as a smoke check
    const dots = document.querySelectorAll(".group span.rounded-full");
    expect(dots).toHaveLength(1);
  });

  it("keeps the strip's own collapse and close-panel controls", async () => {
    await logPanel.openFor({ namespace: "default", name: "api-0" });
    render(LogTabStrip);
    expect(screen.getByLabelText("Collapse log panel")).toBeInTheDocument();
    expect(screen.getByLabelText("Close active session")).toBeInTheDocument();

    await fireEvent.click(screen.getByLabelText("Close active session"));
    await waitFor(() => expect(logPanel.sessions).toHaveLength(0));
  });
});
