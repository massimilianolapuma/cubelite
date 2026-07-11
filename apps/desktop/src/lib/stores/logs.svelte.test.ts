import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("$lib/tauri", () => ({
  streamLogs: vi.fn(async () => "1"),
  stopLogs: vi.fn(async () => undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import { streamLogs, type LogLine } from "$lib/tauri";
import { logs } from "./logs.svelte";
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
  vi.clearAllMocks();
  await logs.stop();
  logs.clear();
  logs.level = "all";
  logs.textFilter = "";
  logs.following = true;
  app.kubeconfigPath = "/home/u/.kube/config";
  app.activeCluster = "prod";
});

describe("logs buffer", () => {
  it("caps the buffer at 180 lines", () => {
    for (let i = 0; i < 200; i++) logs.push(line({ message: `m${i}` }));
    expect(logs.lines).toHaveLength(180);
    expect(logs.lines[0].message).toBe("m20");
  });

  it("counts lines arriving while paused and resets on resume", () => {
    logs.toggleFollow();
    expect(logs.following).toBe(false);
    logs.push(line());
    logs.push(line());
    expect(logs.bufferedWhilePaused).toBe(2);
    logs.toggleFollow();
    expect(logs.bufferedWhilePaused).toBe(0);
  });

  it("clear empties buffer and paused counter", () => {
    logs.push(line());
    logs.toggleFollow();
    logs.push(line());
    logs.clear();
    expect(logs.lines).toHaveLength(0);
    expect(logs.bufferedWhilePaused).toBe(0);
  });
});

describe("logs filters", () => {
  it("filters by level", () => {
    logs.push(line({ level: "info" }));
    logs.push(line({ level: "error", message: "boom" }));
    logs.level = "error";
    expect(logs.filtered).toHaveLength(1);
    expect(logs.filtered[0].message).toBe("boom");
  });

  it("filters by text across pod and message", () => {
    logs.push(line({ pod: "api-0", message: "hello" }));
    logs.push(line({ pod: "worker-1", message: "crunching" }));
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
