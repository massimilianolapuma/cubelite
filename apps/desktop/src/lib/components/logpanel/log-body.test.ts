import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/svelte";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));
vi.mock("$lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("$lib/tauri")>()),
  streamPodLog: vi.fn(async () => "1"),
  stopLogs: vi.fn(async () => {}),
  getPodContainers: vi.fn(async () => []),
}));

import LogBody from "./LogBody.svelte";
import { LogSession } from "$lib/stores/logSession.svelte";
import { logPanel } from "$lib/stores/logPanel.svelte";
import { SEARCH_DEBOUNCE_MS } from "$lib/stores/logSearch.svelte";

function sessionWith(messages: string[]): LogSession {
  const s = new LogSession("default", "api-0");
  s.ring.append(
    messages.map((m) => ({
      pod: "api-0",
      namespace: "default",
      time: "2026-08-04T10:00:00Z",
      level: "info",
      message: m,
    })),
  );
  s.markSeen();
  return s;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("LogBody", () => {
  it("renders rows for buffered lines", async () => {
    render(LogBody, { props: { session: sessionWith(["hello-log-line"]) } });
    expect(await screen.findByText("hello-log-line")).toBeInTheDocument();
  });

  it("shows the empty state when the buffer is empty", () => {
    render(LogBody, { props: { session: sessionWith([]) } });
    expect(screen.getByText("Waiting for log lines…")).toBeInTheDocument();
  });

  it("shows the new-lines pill when paused and lines arrive", async () => {
    const s = sessionWith(["a"]);
    s.toggleFollow(); // pause
    s.ring.append([
      { pod: "api-0", namespace: "default", time: null, level: "info", message: "b" },
    ]);
    render(LogBody, { props: { session: s } });
    expect(await screen.findByText("↓ 1 new line")).toBeInTheDocument();
  });

  describe("search", () => {
    afterEach(() => {
      logPanel.search.clear();
    });

    it("filter mode hides non-matching lines", async () => {
      const s = sessionWith(["alpha", "beta", "alpha two"]);
      logPanel.search.attach(() => s.ring.lines);
      vi.useFakeTimers();
      logPanel.search.setQuery("alpha");
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS + 10);
      vi.useRealTimers();
      logPanel.search.filterMode = true;
      render(LogBody, { props: { session: s } });
      // Two rows match ("alpha" and the "alpha" segment of "alpha two"), both
      // rendered as <mark>, so assert the match count rather than a single node.
      expect(await screen.findAllByText("alpha")).toHaveLength(2);
      expect(screen.queryByText("beta")).toBeNull();
    });

    it("highlights the query and marks the active match", async () => {
      const s = sessionWith(["needle here", "no match"]);
      logPanel.search.attach(() => s.ring.lines);
      vi.useFakeTimers();
      logPanel.search.setQuery("needle");
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS + 10);
      vi.useRealTimers();
      render(LogBody, { props: { session: s } });
      const mark = await screen.findByText("needle");
      expect(mark.tagName).toBe("MARK");
      expect(mark).toHaveStyle("background: var(--color-status-warn)");
    });

    it("shows a no-matches message when filter mode yields nothing", async () => {
      const s = sessionWith(["alpha", "beta"]);
      logPanel.search.attach(() => s.ring.lines);
      vi.useFakeTimers();
      logPanel.search.setQuery("zzz");
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS + 10);
      vi.useRealTimers();
      logPanel.search.filterMode = true;
      render(LogBody, { props: { session: s } });
      expect(
        await screen.findByText('No matches for "zzz" — esc clears search'),
      ).toBeInTheDocument();
      expect(screen.queryByText("alpha")).toBeNull();
    });

    it("navigating to a match pauses follow", async () => {
      const s = sessionWith(["alpha", "beta", "alpha two"]);
      logPanel.search.attach(() => s.ring.lines);
      vi.useFakeTimers();
      logPanel.search.setQuery("alpha");
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS + 10);
      vi.useRealTimers();
      expect(s.following).toBe(true);

      render(LogBody, { props: { session: s } });
      await screen.findAllByText("alpha"); // let the initial mount settle

      logPanel.search.next(); // same store call Enter-nav in the toolbar makes
      await waitFor(() => expect(s.following).toBe(false));
    });
  });
});
