import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("$lib/tauri", () => ({
  streamLogs: vi.fn(async () => "1"),
  stopLogs: vi.fn(async () => undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import { streamLogs, type LogLine } from "$lib/tauri";
import { logs, FLUSH_MS } from "./logs.svelte";
import { app } from "./app.svelte";

function line(overrides: Partial<LogLine> = {}): LogLine {
  return {
    pod: "api-0",
    namespace: "default",
    time: "2026-07-11T10:00:00Z",
    level: "info",
    message: "listening on :8080",
    ...overrides,
  };
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  await logs.stop();
  logs.clear();
  logs.level = "all";
  logs.textFilter = "";
  logs.following = true;
  app.kubeconfigPath = "/home/u/.kube/config";
  app.activeCluster = "prod";
});

afterEach(() => {
  vi.useRealTimers();
});

describe("logs batching", () => {
  it("does not touch lines until the flush interval elapses", () => {
    for (let i = 0; i < 50; i++) logs.push(line({ message: `l${i}` }));
    expect(logs.lines).toHaveLength(0);
    vi.advanceTimersByTime(FLUSH_MS);
    expect(logs.lines).toHaveLength(50);
  });

  it("coalesces many pushes into one batch per interval", () => {
    logs.push(line({ message: "a" }));
    vi.advanceTimersByTime(FLUSH_MS);
    expect(logs.lines).toHaveLength(1);
    for (let i = 0; i < 10; i++) logs.push(line({ message: `b${i}` }));
    vi.advanceTimersByTime(FLUSH_MS);
    expect(logs.lines).toHaveLength(11);
  });

  it("assigns monotonic unique ids across flushes", () => {
    logs.push(line({ message: "a" }));
    vi.advanceTimersByTime(FLUSH_MS);
    logs.push(line({ message: "b" }));
    vi.advanceTimersByTime(FLUSH_MS);
    const ids = logs.lines.map((l) => l.id);
    expect(ids[1]).toBeGreaterThan(ids[0]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("logs buffer", () => {
  it("caps the buffer at 180 lines", () => {
    for (let i = 0; i < 200; i++) logs.push(line({ message: `m${i}` }));
    vi.advanceTimersByTime(FLUSH_MS);
    expect(logs.lines).toHaveLength(180);
    expect(logs.lines[0].message).toBe("m20");
    expect(logs.lines.at(-1)?.message).toBe("m199");
  });

  it("while paused: no flush, counter grows; resume flushes immediately", () => {
    logs.toggleFollow();
    expect(logs.following).toBe(false);
    logs.push(line());
    logs.push(line());
    vi.advanceTimersByTime(FLUSH_MS * 3);
    expect(logs.lines).toHaveLength(0);
    expect(logs.bufferedWhilePaused).toBe(2);
    logs.toggleFollow();
    expect(logs.bufferedWhilePaused).toBe(0);
    expect(logs.lines).toHaveLength(2);
  });

  it("clear empties buffer, pending queue, and paused counter", () => {
    logs.push(line());
    logs.toggleFollow();
    logs.push(line());
    logs.clear();
    vi.advanceTimersByTime(FLUSH_MS);
    expect(logs.lines).toHaveLength(0);
    expect(logs.bufferedWhilePaused).toBe(0);
  });
});

describe("logs filters", () => {
  it("filters by level", () => {
    logs.push(line({ level: "info" }));
    logs.push(line({ level: "error", message: "boom" }));
    vi.advanceTimersByTime(FLUSH_MS);
    logs.level = "error";
    expect(logs.filtered).toHaveLength(1);
    expect(logs.filtered[0].message).toBe("boom");
  });

  it("filters by text across pod and message", () => {
    logs.push(line({ pod: "api-0", message: "hello" }));
    logs.push(line({ pod: "worker-1", message: "crunching" }));
    vi.advanceTimersByTime(FLUSH_MS);
    logs.textFilter = "worker";
    expect(logs.filtered).toHaveLength(1);
    expect(logs.filtered[0].pod).toBe("worker-1");
  });
});

describe("start/stop", () => {
  it("starts a stream with the given pods", async () => {
    await logs.start([{ namespace: "default", name: "api-0" }]);
    expect(streamLogs).toHaveBeenCalledWith(
      "/home/u/.kube/config",
      [{ namespace: "default", name: "api-0" }],
      "prod",
    );
    expect(logs.streaming).toBe(true);
    await logs.stop();
    expect(logs.streaming).toBe(false);
  });

  it("does not start with no pods", async () => {
    await logs.start([]);
    expect(streamLogs).not.toHaveBeenCalled();
  });
});
