import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/svelte";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));
vi.mock("#lib/tauri.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#lib/tauri.ts")>()),
  streamPodLog: vi.fn(async () => "1"),
  stopLogs: vi.fn(async () => {}),
  getPodContainers: vi.fn(async () => []),
}));

const virtualizers: unknown[] = [];
vi.mock("@tanstack/svelte-virtual", async (importOriginal) => {
  const m = await importOriginal<typeof import("@tanstack/svelte-virtual")>();
  return {
    ...m,
    createVirtualizer: ((o: Parameters<typeof m.createVirtualizer>[0]) => {
      const store = m.createVirtualizer(o);
      virtualizers.push(store);
      return store;
    }) as typeof m.createVirtualizer,
  };
});

import LogBody from "./LogBody.svelte";
import { LogSession, ALL_CONTAINERS } from "#lib/stores/logSession.svelte.ts";
import { logPanel } from "#lib/stores/logPanel.svelte.ts";
import { SEARCH_DEBOUNCE_MS } from "#lib/stores/logSearch.svelte.ts";
import type { ContainerDetail } from "#lib/tauri.ts";

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

  it("shows the reconnecting banner with attempt count and retry-now", async () => {
    const s = sessionWith(["a"]);
    s.status = "reconnecting";
    s.reconnectAttempt = 3;
    s.nextRetryAt = Date.now() + 4000;
    const retry = vi.spyOn(s, "retryNow");
    const { getByText } = render(LogBody, { props: { session: s } });
    expect(getByText(/Reconnecting — attempt 3/)).toBeInTheDocument();
    await getByText("Retry now").click();
    expect(retry).toHaveBeenCalled();
  });

  describe("merged mode source column", () => {
    const containers: ContainerDetail[] = [
      { name: "worker", init: false } as ContainerDetail,
      { name: "envoy", init: false } as ContainerDetail,
    ];

    it("shows the container name with identity styling when merged", async () => {
      const s = new LogSession("default", "api-0", ALL_CONTAINERS);
      s.containers = containers;
      s.ring.append([
        {
          pod: "api-0",
          namespace: "default",
          time: "2026-08-04T10:00:00Z",
          level: "info",
          message: "hello-from-envoy",
          container: "envoy",
        },
      ]);
      s.markSeen();

      render(LogBody, { props: { session: s } });

      const sourceLabel = await screen.findByText("envoy");
      expect(sourceLabel).toBeInTheDocument();
      // Assert the rendered inline style, not the computed one: jsdom resolves
      // shorthands/custom properties differently across releases (#444).
      expect(sourceLabel.getAttribute("style")).toContain("var(--color-cluster-teal)");
    });

    it("omits the source column in single-container mode", async () => {
      const s = sessionWith(["plain-line"]);
      render(LogBody, { props: { session: s } });
      await screen.findByText("plain-line");
      expect(screen.queryByText("envoy")).toBeNull();
    });
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
      expect(mark.getAttribute("style")).toContain("background: var(--color-status-warn)");
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

describe("JSON view (#454)", () => {
  const json = '{"level":"warn","msg":"order accepted","orderId":"A-1931","meta":{"a":1}}';
  afterEach(() => {
    logPanel.jsonView = false;
  });
  it("renders raw lines unchanged with the toggle on", async () => {
    logPanel.jsonView = true;
    render(LogBody, { props: { session: sessionWith(["plain text"]) } });
    expect(await screen.findByText("plain text")).toBeInTheDocument();
    expect(screen.queryByTestId("json-row")).toBeNull();
  });
  it("humanises a JSON line: message, tail and JSON level", async () => {
    logPanel.jsonView = true;
    render(LogBody, { props: { session: sessionWith([json]) } });
    const row = await screen.findByTestId("json-row");
    expect(row).toHaveTextContent("order accepted");
    expect(row).toHaveTextContent("orderId=A-1931");
    expect(row).toHaveTextContent('meta={"a":1}');
    expect(screen.getByText("warn")).toBeInTheDocument(); // badge from the JSON level, core level is info
    expect(row).toHaveAttribute("aria-expanded", "false");
  });
  it("leaves the JSON line raw with the toggle off", async () => {
    render(LogBody, { props: { session: sessionWith([json]) } });
    expect(await screen.findByText(json)).toBeInTheDocument();
  });
  it("click expands the tree and toggles session.expanded", async () => {
    logPanel.jsonView = true;
    const s = sessionWith([json]);
    render(LogBody, { props: { session: s } });
    const row = await screen.findByTestId("json-row");
    await fireEvent.click(row);
    expect(row).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("json-tree")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy raw" })).toBeInTheDocument();
    expect(s.expanded.size).toBe(1);
    await fireEvent.click(row);
    expect(screen.queryByTestId("json-tree")).toBeNull();
  });
  it("expanding while following keeps follow and scrolls to the end", async () => {
    logPanel.jsonView = true;
    const s = sessionWith([json]);
    expect(s.following).toBe(true);
    render(LogBody, { props: { session: s } });
    const row = await screen.findByTestId("json-row");
    const { get } = await import("svelte/store");
    const v = get(virtualizers[virtualizers.length - 1] as Parameters<typeof get>[0]) as {
      scrollToIndex: (i: number, o: unknown) => void;
    };
    const spy = vi.spyOn(v, "scrollToIndex");
    vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((cb) => {
      cb(0);
      return 0;
    });
    await fireEvent.click(row);
    expect(s.following).toBe(true);
    await waitFor(() => expect(spy).toHaveBeenCalledWith(0, { align: "end" }));
  });
  it("highlights the search query inside the humanised message", async () => {
    logPanel.jsonView = true;
    const s = sessionWith([json]);
    logPanel.search.attach(() => s.ring.lines);
    vi.useFakeTimers();
    logPanel.search.setQuery("accepted");
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS + 10);
    vi.useRealTimers();
    render(LogBody, { props: { session: s } });
    const mark = await screen.findByText("accepted");
    expect(mark.tagName).toBe("MARK");
  });
});
