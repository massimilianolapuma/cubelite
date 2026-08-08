import { describe, it, expect, afterEach, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";

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
import { logPanel } from "$lib/stores/logPanel.svelte";
import { SEARCH_DEBOUNCE_MS } from "$lib/stores/logSearch.svelte";
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

function sessionWith(messages: string[]): LogSession {
  const s = new LogSession("default", "api-0");
  s.ring.append(
    messages.map((m) => ({
      pod: "api-0",
      namespace: "default",
      time: null,
      level: "info" as const,
      message: m,
    })),
  );
  return s;
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

describe("LogToolbar search", () => {
  afterEach(() => {
    logPanel.search.clear();
  });

  it("shows the match count after debounce and navigates with Enter/Shift+Enter", async () => {
    vi.useFakeTimers();
    try {
      const s = sessionWith(["alpha", "beta", "alpha two"]);
      logPanel.search.attach(() => s.ring.lines);
      render(LogToolbar, { props: { session: s } });
      const input = screen.getByPlaceholderText("Search… (⌘F)");

      await fireEvent.input(input, { target: { value: "alpha" } });
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS + 10);
      expect(screen.getByText("1/2")).toBeInTheDocument();

      await fireEvent.keyDown(input, { key: "Enter" });
      expect(screen.getByText("2/2")).toBeInTheDocument();

      await fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
      expect(screen.getByText("1/2")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("recomputes matches as the stream grows, without another setQuery call", async () => {
    const s = sessionWith(["alpha"]);
    logPanel.search.attach(() => s.ring.lines);
    render(LogToolbar, { props: { session: s } });
    const input = screen.getByPlaceholderText("Search… (⌘F)");

    vi.useFakeTimers();
    await fireEvent.input(input, { target: { value: "alpha" } });
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS + 10);
    vi.useRealTimers();
    expect(screen.getByText("1/1")).toBeInTheDocument();

    // New matching lines arrive from the live tail — no further setQuery call.
    s.ring.append([
      { pod: "api-0", namespace: "default", time: null, level: "info", message: "alpha two" },
    ]);
    expect(await screen.findByText("1/2")).toBeInTheDocument();
  });

  it("shows 0 results for a query with no matches", async () => {
    vi.useFakeTimers();
    try {
      const s = sessionWith(["alpha"]);
      logPanel.search.attach(() => s.ring.lines);
      render(LogToolbar, { props: { session: s } });
      const input = screen.getByPlaceholderText("Search… (⌘F)");

      await fireEvent.input(input, { target: { value: "zzz" } });
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS + 10);
      expect(screen.getByText("0 results")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("toggles filter mode via the filter chip", async () => {
    vi.useFakeTimers();
    try {
      const s = sessionWith(["alpha", "beta"]);
      logPanel.search.attach(() => s.ring.lines);
      render(LogToolbar, { props: { session: s } });
      const input = screen.getByPlaceholderText("Search… (⌘F)");

      await fireEvent.input(input, { target: { value: "alpha" } });
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS + 10);

      expect(logPanel.search.filterMode).toBe(false);
      await fireEvent.click(screen.getByText("filter"));
      expect(logPanel.search.filterMode).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("Escape clears the query first (without bubbling), then blurs on the next press", async () => {
    vi.useFakeTimers();
    const outerHandler = vi.fn();
    document.addEventListener("keydown", outerHandler);
    try {
      const s = sessionWith(["alpha"]);
      logPanel.search.attach(() => s.ring.lines);
      render(LogToolbar, { props: { session: s } });
      const input = screen.getByPlaceholderText("Search… (⌘F)") as HTMLInputElement;

      await fireEvent.input(input, { target: { value: "alpha" } });
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS + 10);
      expect(logPanel.search.query).toBe("alpha");

      await fireEvent.keyDown(input, { key: "Escape" });
      expect(logPanel.search.query).toBe("");
      expect(outerHandler).not.toHaveBeenCalled();

      input.focus();
      expect(document.activeElement).toBe(input);
      await fireEvent.keyDown(input, { key: "Escape" });
      expect(document.activeElement).not.toBe(input);
      expect(outerHandler).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      document.removeEventListener("keydown", outerHandler);
    }
  });
});
