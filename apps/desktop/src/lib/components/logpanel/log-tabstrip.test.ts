import { describe, it, expect, afterEach, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/svelte";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));
vi.mock("#lib/tauri.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#lib/tauri.ts")>()),
  streamPodLog: vi.fn(async () => "1"),
  stopLogs: vi.fn(async () => {}),
  getPodContainers: vi.fn(async () => []),
}));

import LogTabStrip from "./LogTabStrip.svelte";
import { logPanel } from "#lib/stores/logPanel.svelte.ts";

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

  // Tonal §9.3: the stream state is a shape and a word, not a coloured dot.
  it("shows each session's stream state as a shape and a word", async () => {
    await logPanel.openFor({ namespace: "default", name: "api-0" });
    await logPanel.openFor({ namespace: "default", name: "web-1" });
    logPanel.sessions[0]!.status = "error";
    logPanel.sessions[1]!.status = "streaming";
    render(LogTabStrip);
    const failing = screen.getByRole("button", { name: /^(?!Close ).*api-0/ });
    expect(failing).toHaveAccessibleName(/Error/);
    expect(failing.querySelector('[data-glyph="err"]')).not.toBeNull();
    const streaming = screen.getByRole("button", { name: /^(?!Close ).*web-1/ });
    expect(streaming).toHaveAccessibleName(/Streaming/);
    expect(streaming.querySelector('[data-glyph="ok"]')).not.toBeNull();
  });

  it("marks the active tab as the current one", async () => {
    await logPanel.openFor({ namespace: "default", name: "api-0" });
    await logPanel.openFor({ namespace: "default", name: "web-1" });
    render(LogTabStrip);
    expect(screen.getByRole("button", { name: /^(?!Close ).*web-1/ })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("button", { name: /^(?!Close ).*api-0/ })).not.toHaveAttribute("aria-current");
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
