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
  exportLog: vi.fn(async () => "/tmp/x.log"),
}));

import LogToolbar from "./LogToolbar.svelte";
import { LogSession } from "$lib/stores/logSession.svelte";
import { logPanel } from "$lib/stores/logPanel.svelte";
import { SEARCH_DEBOUNCE_MS } from "$lib/stores/logSearch.svelte";
import { toasts } from "$lib/stores/toasts.svelte";
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
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS + 10);
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
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS + 10);
    vi.useRealTimers();
    expect(screen.getByText("1/1")).toBeInTheDocument();

    // New matching lines arrive from the live tail — no further setQuery call.
    s.ring.append([
      { pod: "api-0", namespace: "default", time: null, level: "info", message: "alpha two" },
    ]);
    expect(await screen.findByText("1/2")).toBeInTheDocument();
  });

  it("does not recompute on every keystroke — the growth effect stays untracked from query/cursor", async () => {
    const s = sessionWith(["alpha"]);
    logPanel.search.attach(() => s.ring.lines);
    render(LogToolbar, { props: { session: s } });
    const input = screen.getByPlaceholderText("Search… (⌘F)");

    const recomputeSpy = vi.spyOn(logPanel.search, "recompute");
    recomputeSpy.mockClear();

    // Typing changes `search.query` (read internally by `recompute`). If the
    // growth-effect tracked that read, it would re-fire immediately here,
    // defeating `setQuery`'s own 150ms debounce.
    await fireEvent.input(input, { target: { value: "a" } });
    expect(recomputeSpy).not.toHaveBeenCalled();

    recomputeSpy.mockRestore();
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

describe("LogToolbar export", () => {
  afterEach(() => {
    logPanel.search.clear();
    toasts.items = [];
  });

  it("export visible writes via exportLog and toasts the path", async () => {
    const { exportLog } = await import("$lib/tauri");
    vi.mocked(exportLog).mockResolvedValueOnce("/Users/x/Downloads/api-0_worker.log");
    const s = new LogSession("default", "api-0");
    s.container = "worker";
    s.ring.append([
      {
        pod: "api-0",
        namespace: "default",
        time: "2026-08-04T10:00:00Z",
        level: "info",
        message: "hello",
      },
    ]);
    render(LogToolbar, { props: { session: s } });
    await fireEvent.click(screen.getByLabelText("More log options"));
    await fireEvent.click(screen.getByText("Export visible…"));

    expect(exportLog).toHaveBeenCalledWith("api-0_worker.log", expect.stringContaining("hello"));
    await waitFor(() =>
      expect(toasts.items[0]).toMatchObject({
        tone: "ok",
        message: "Exported to /Users/x/Downloads/api-0_worker.log",
      }),
    );
  });

  it("export visible respects filter mode — only serializes matching lines", async () => {
    const { exportLog } = await import("$lib/tauri");
    vi.mocked(exportLog).mockResolvedValueOnce("/tmp/api-0_worker.log");
    const s = new LogSession("default", "api-0");
    s.container = "worker";
    s.ring.append([
      { pod: "api-0", namespace: "default", time: null, level: "info", message: "keep" },
      { pod: "api-0", namespace: "default", time: null, level: "info", message: "drop-me" },
    ]);
    logPanel.search.attach(() => s.ring.lines);
    logPanel.search.query = "keep";
    logPanel.search.recompute(s.ring.lines);
    logPanel.search.filterMode = true;

    render(LogToolbar, { props: { session: s } });
    await fireEvent.click(screen.getByLabelText("More log options"));
    await fireEvent.click(screen.getByText("Export visible…"));

    const [, contents] = vi.mocked(exportLog).mock.calls.at(-1)!;
    expect(contents).toContain("keep");
    expect(contents).not.toContain("drop-me");
  });

  it("export full buffer serializes ring.lines regardless of filter mode, with a _full filename", async () => {
    const { exportLog } = await import("$lib/tauri");
    vi.mocked(exportLog).mockResolvedValueOnce("/Users/x/Downloads/api-0_worker_full.log");
    const s = new LogSession("default", "api-0");
    s.container = "worker";
    s.ring.append([
      { pod: "api-0", namespace: "default", time: null, level: "info", message: "keep" },
      { pod: "api-0", namespace: "default", time: null, level: "info", message: "filtered-out" },
    ]);
    logPanel.search.attach(() => s.ring.lines);
    logPanel.search.query = "keep";
    logPanel.search.recompute(s.ring.lines);
    logPanel.search.filterMode = true;

    render(LogToolbar, { props: { session: s } });
    await fireEvent.click(screen.getByLabelText("More log options"));
    await fireEvent.click(screen.getByText("Export full buffer…"));

    expect(exportLog).toHaveBeenCalledWith(
      "api-0_worker_full.log",
      expect.stringContaining("filtered-out"),
    );
  });

  it("toasts an error message when export fails", async () => {
    const { exportLog } = await import("$lib/tauri");
    vi.mocked(exportLog).mockRejectedValueOnce(new Error("disk full"));
    const s = new LogSession("default", "api-0");
    s.container = "worker";
    s.ring.append([
      { pod: "api-0", namespace: "default", time: null, level: "info", message: "hello" },
    ]);
    render(LogToolbar, { props: { session: s } });
    await fireEvent.click(screen.getByLabelText("More log options"));
    await fireEvent.click(screen.getByText("Export visible…"));

    await waitFor(() => expect(toasts.items[0]?.tone).toBe("err"));
    expect(toasts.items[0]?.message).toContain("disk full");
  });
});
