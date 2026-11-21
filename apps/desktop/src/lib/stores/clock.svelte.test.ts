import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { clock } from "./clock.svelte";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-21T10:00:00Z"));
  clock.run(false);
});

afterEach(() => {
  clock.run(false);
  vi.useRealTimers();
});

describe("clock (#662)", () => {
  it("keeps no timer while no unlock runs", () => {
    clock.run(false);
    expect(vi.getTimerCount()).toBe(0);
    const before = clock.now;
    vi.advanceTimersByTime(5_000);
    expect(clock.now).toBe(before);
  });

  it("ticks once a second while it runs, with one timer for the whole app", () => {
    clock.run(true);
    clock.run(true);
    expect(vi.getTimerCount()).toBe(1);
    // Started from now, not from when it last stopped.
    expect(clock.now).toBe(Date.parse("2026-11-21T10:00:00Z"));
    vi.advanceTimersByTime(1_000);
    expect(clock.now).toBe(Date.parse("2026-11-21T10:00:01Z"));
    vi.advanceTimersByTime(2_000);
    expect(clock.now).toBe(Date.parse("2026-11-21T10:00:03Z"));
  });

  it("stops when told", () => {
    clock.run(true);
    clock.run(false);
    expect(vi.getTimerCount()).toBe(0);
    const before = clock.now;
    vi.advanceTimersByTime(3_000);
    expect(clock.now).toBe(before);
  });
});
