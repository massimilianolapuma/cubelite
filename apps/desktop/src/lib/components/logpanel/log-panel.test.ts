import { describe, it, expect, afterEach, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/svelte";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));
vi.mock("#lib/tauri.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#lib/tauri.ts")>()),
  streamPodLog: vi.fn(async () => "1"),
  stopLogs: vi.fn(async () => {}),
  getPodContainers: vi.fn(async () => []),
}));
vi.mock("../../stores/logWindows.svelte", () => ({
  logWindows: { detach: vi.fn(async () => {}) },
}));

import LogPanel from "./LogPanel.svelte";
import { logPanel } from "#lib/stores/logPanel.svelte.ts";
import { layout } from "#lib/stores/layout.svelte.ts";

describe("LogPanel placement (Tonal §5)", () => {
  afterEach(async () => {
    for (const s of [...logPanel.sessions]) await logPanel.closeSession(s.key);
    layout.contentWidth = 0;
  });

  // The lift above the detail panel is only needed while the panel lies over
  // the list: its menus open upwards over it. Docked, nothing covers them.
  it("lifts above the detail panel only while the panel overlays the list", async () => {
    await logPanel.openFor({ namespace: "default", name: "api-0" });
    layout.contentWidth = 800;
    const { rerender } = render(LogPanel);
    const panel = screen.getByRole("region", { name: "Pod logs panel" });
    expect(panel).toHaveAttribute("data-lifted", "true");

    layout.contentWidth = 1200;
    await rerender({});
    expect(panel).not.toHaveAttribute("data-lifted");
  });
});
