import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LogSearch, SEARCH_DEBOUNCE_MS } from "./logSearch.svelte";
import type { KeyedLogLine } from "./logs.svelte";

function lines(...messages: string[]): KeyedLogLine[] {
  return messages.map((message, id) => ({
    id, pod: "api-0", namespace: "default", time: null, level: "info", message,
  }));
}

describe("LogSearch", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("debounces query changes and matches case-insensitively", () => {
    const search = new LogSearch();
    const data = lines("GET /health 200", "error: timeout", "get /users 500");
    search.attach(() => data);
    search.setQuery("GET");
    expect(search.matchIds).toEqual([]);
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS + 10);
    expect(search.matchIds).toEqual([0, 2]);
    expect(search.count).toBe(2);
  });

  it("navigates with wrap in both directions", () => {
    const search = new LogSearch();
    const data = lines("a x", "b", "c x");
    search.attach(() => data);
    search.setQuery("x");
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS + 10);
    expect(search.activeId).toBe(0);
    search.next();
    expect(search.activeId).toBe(2);
    search.next(); // wrap
    expect(search.activeId).toBe(0);
    search.prev(); // wrap back
    expect(search.activeId).toBe(2);
  });

  it("clear resets query, matches and filter mode", () => {
    const search = new LogSearch();
    search.attach(() => lines("x"));
    search.setQuery("x");
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS + 10);
    search.filterMode = true;
    search.clear();
    expect(search.query).toBe("");
    expect(search.matchIds).toEqual([]);
    expect(search.filterMode).toBe(false);
  });

  it("stays under 50ms recomputing over a 5k-line buffer", async () => {
    vi.useRealTimers();
    const search = new LogSearch();
    const big = lines(...Array.from({ length: 5000 }, (_, i) => `line ${i} ${i % 7 === 0 ? "needle" : ""}`));
    search.attach(() => big);
    search.setQuery("needle");
    await new Promise(r => setTimeout(r, SEARCH_DEBOUNCE_MS + 20));
    const start = performance.now();
    search.recompute(big);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(50);
    expect(search.count).toBe(Math.ceil(5000 / 7));
  });

  it("provides cached matchSet derived for filter mode", () => {
    const search = new LogSearch();
    const data = lines("a x", "b", "c x");
    search.attach(() => data);
    search.setQuery("x");
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS + 10);
    expect(search.matchSet.has(0)).toBe(true);
    expect(search.matchSet.has(1)).toBe(false);
    expect(search.matchSet.has(2)).toBe(true);
  });
});
