import { describe, it, expect, beforeEach, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";

vi.mock("$lib/tauri", () => ({
  listContexts: vi.fn(),
  setContext: vi.fn(),
  listPods: vi.fn(),
  listNamespaces: vi.fn(),
  listDeployments: vi.fn(),
  listEvents: vi.fn(async () => []),
  watchResources: vi.fn(),
  unwatchResources: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

/**
 * bits-ui Command schedules microtasks (item registration, scroll sync).
 * Flush them while the component is still mounted so they don't surface
 * as unhandled rejections after test teardown.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

import CommandPalette from "./CommandPalette.svelte";
import { app } from "$lib/stores/app.svelte";
import { clusters } from "$lib/stores/clusters.svelte";

beforeEach(() => {
  app.paletteOpen = true;
  app.activeCluster = "prod";
  app.preferencesOpen = false;
  clusters.contexts = [
    { name: "prod", cluster_server: "https://prod:6443", namespace: "default", is_active: true },
    { name: "staging", cluster_server: "https://staging:6443", namespace: "default", is_active: false },
  ];
  clusters.identityColors = { prod: "blue", staging: "amber" };
  clusters.connectionState = "connected";
});

describe("CommandPalette", () => {
  it("renders nothing when closed", () => {
    app.paletteOpen = false;
    render(CommandPalette);
    expect(document.querySelector("[data-command-root]")).toBeNull();
  });

  it("renders cluster and action sections when open", async () => {
    render(CommandPalette);
    await flush();
    expect(screen.getByText("Switch cluster")).toBeInTheDocument();
    expect(screen.getByText("Actions")).toBeInTheDocument();
    expect(screen.getByText("prod")).toBeInTheDocument();
    expect(screen.getByText("staging")).toBeInTheDocument();
    expect(screen.getByText("All Clusters dashboard")).toBeInTheDocument();
  });

  it("navigates and closes when selecting an action", async () => {
    render(CommandPalette);
    await flush();
    await fireEvent.click(screen.getByText("Go to Pods"));
    await flush();
    expect(app.view).toBe("pods");
    expect(app.paletteOpen).toBe(false);
  });

  it("opens preferences from the Preferences action", async () => {
    render(CommandPalette);
    await flush();
    await fireEvent.click(screen.getByText("Preferences"));
    await flush();
    expect(app.preferencesOpen).toBe(true);
    expect(app.paletteOpen).toBe(false);
    app.preferencesOpen = false;
  });

  it("closes on backdrop click", async () => {
    render(CommandPalette);
    await flush();
    const backdrop = document.querySelector('[role="presentation"]');
    expect(backdrop).not.toBeNull();
    if (backdrop) await fireEvent.click(backdrop);
    await flush();
    expect(app.paletteOpen).toBe(false);
  });
});
