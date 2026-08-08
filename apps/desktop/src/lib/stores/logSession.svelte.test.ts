import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LogLine } from "$lib/tauri";

const listeners = new Map<string, (event: { payload: unknown }) => void>();

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, cb: (event: { payload: unknown }) => void) => {
    listeners.set(name, cb);
    return () => listeners.delete(name);
  }),
}));

vi.mock("$lib/tauri", async (importOriginal) => {
  const original = await importOriginal<typeof import("$lib/tauri")>();
  return {
    ...original,
    streamPodLog: vi.fn(async () => "7"),
    stopLogs: vi.fn(async () => {}),
    getPodContainers: vi.fn(async () => [
      { name: "worker", init: false, sidecar: false, restarts: 0, ready: true, state: "running", state_reason: null, last_terminated_reason: null, last_terminated_at: null },
      { name: "istio-init", init: true, sidecar: false, restarts: 2, ready: true, state: "terminated", state_reason: null, last_terminated_reason: null, last_terminated_at: null },
    ]),
  };
});

import { getPodContainers, streamPodLog, stopLogs } from "$lib/tauri";
import { app } from "./app.svelte";
import { ALL_CONTAINERS, LogSession } from "./logSession.svelte";

function emitLine(streamId: string, message: string, time = "2026-08-04T10:00:00Z") {
  const payload: LogLine = { pod: "api-0", namespace: "default", time, level: "info", message };
  listeners.get(`pod-log-line:${streamId}`)?.({ payload });
}

describe("LogSession", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    listeners.clear();
    vi.clearAllMocks();
    app.kubeconfigPath = "/tmp/kubeconfig";
    app.activeCluster = "prod";
  });
  afterEach(() => vi.useRealTimers());

  it("open() loads containers, defaults to first non-init, streams with tail 500", async () => {
    const s = new LogSession("default", "api-0");
    await s.open();
    expect(getPodContainers).toHaveBeenCalledWith("/tmp/kubeconfig", "default", "api-0", "prod");
    expect(s.container).toBe("worker");
    expect(streamPodLog).toHaveBeenCalledWith(
      "/tmp/kubeconfig", "default", "api-0",
      { container: "worker", previous: false, tailLines: 500, sinceTime: undefined },
      "prod",
    );
    expect(s.status).toBe("streaming");
  });

  it("batches incoming lines into the ring on the flush interval", async () => {
    const s = new LogSession("default", "api-0");
    await s.open();
    emitLine("7", "one");
    emitLine("7", "two");
    expect(s.ring.lines).toHaveLength(0); // not flushed yet
    await vi.advanceTimersByTimeAsync(130);
    expect(s.ring.lines.map((l) => l.message)).toEqual(["one", "two"]);
  });

  it("switchContainer restarts the stream with the new container and clears the buffer", async () => {
    const s = new LogSession("default", "api-0");
    await s.open();
    emitLine("7", "old");
    await vi.advanceTimersByTimeAsync(130);
    await s.switchContainer("istio-init");
    expect(stopLogs).toHaveBeenCalledWith("7");
    expect(s.ring.lines).toHaveLength(0);
    expect(vi.mocked(streamPodLog).mock.lastCall?.[3]).toMatchObject({ container: "istio-init" });
  });

  it("previous fetch does not follow and ends as 'ended' on pod-log-end", async () => {
    const s = new LogSession("default", "api-0");
    await s.open();
    await s.setPrevious(true);
    expect(vi.mocked(streamPodLog).mock.lastCall?.[3]).toMatchObject({ previous: true });
    listeners.get("pod-log-end:7")?.({ payload: undefined });
    await vi.advanceTimersByTimeAsync(1);
    expect(s.status).toBe("ended");
  });

  it("toggling follow back on after a drop-while-paused restarts the stream", async () => {
    const s = new LogSession("default", "api-0");
    await s.open();
    s.toggleFollow(); // pause
    expect(s.following).toBe(false);
    listeners.get("pod-log-end:7")?.({ payload: undefined });
    await vi.advanceTimersByTimeAsync(1);
    expect(s.status).toBe("ended");

    vi.mocked(streamPodLog).mockClear();
    s.toggleFollow(); // resume
    await vi.advanceTimersByTimeAsync(1);
    expect(streamPodLog).toHaveBeenCalledTimes(1);
    expect(s.status).toBe("streaming");
  });

  it("close() stops the stream and detaches listeners", async () => {
    const s = new LogSession("default", "api-0");
    await s.open();
    await s.close();
    expect(stopLogs).toHaveBeenCalledWith("7");
    expect(listeners.size).toBe(0);
  });
});

describe("LogSession reconnect", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    listeners.clear();
    vi.clearAllMocks();
    app.kubeconfigPath = "/tmp/kubeconfig";
    app.activeCluster = "prod";
  });
  afterEach(() => vi.useRealTimers());

  it("server drop while following → reconnecting with 1s backoff, resumes from last timestamp", async () => {
    const s = new LogSession("default", "api-0");
    await s.open();
    emitLine("7", "one", "2026-08-04T10:00:05Z");
    await vi.advanceTimersByTimeAsync(130);
    listeners.get("pod-log-end:7")?.({ payload: undefined });
    await vi.advanceTimersByTimeAsync(1);
    expect(s.status).toBe("reconnecting");
    expect(s.reconnectAttempt).toBe(1);
    expect(s.nextRetryAt).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    expect(vi.mocked(streamPodLog).mock.lastCall?.[3]).toMatchObject({
      sinceTime: "2026-08-04T10:00:05Z",
    });
    expect(s.status).toBe("streaming");
  });

  it("backoff doubles per attempt and caps at 30s", async () => {
    const s = new LogSession("default", "api-0");
    await s.open();
    for (let attempt = 1; attempt <= 7; attempt++) {
      listeners.get("pod-log-end:7")?.({ payload: undefined });
      await vi.advanceTimersByTimeAsync(1);
      expect(s.reconnectAttempt).toBe(attempt);
      const delay = Math.min(30_000, 1000 * 2 ** (attempt - 1));
      await vi.advanceTimersByTimeAsync(delay);
      expect(s.status).toBe("streaming");
    }
  });

  it("a received line resets the attempt counter", async () => {
    const s = new LogSession("default", "api-0");
    await s.open();
    listeners.get("pod-log-end:7")?.({ payload: undefined });
    await vi.advanceTimersByTimeAsync(1001);
    expect(s.reconnectAttempt).toBe(1);
    emitLine("7", "back");
    expect(s.reconnectAttempt).toBe(0);
  });

  it("retryNow() short-circuits the backoff", async () => {
    const s = new LogSession("default", "api-0");
    await s.open();
    listeners.get("pod-log-end:7")?.({ payload: undefined });
    await vi.advanceTimersByTimeAsync(1);
    listeners.get("pod-log-end:7")?.({ payload: undefined });
    // second drop arrives before restart: still one scheduled retry
    s.retryNow();
    await vi.advanceTimersByTimeAsync(1);
    expect(s.status).toBe("streaming");
  });

  it("close() during backoff cancels the scheduled retry", async () => {
    const s = new LogSession("default", "api-0");
    await s.open();
    listeners.get("pod-log-end:7")?.({ payload: undefined });
    await vi.advanceTimersByTimeAsync(1);
    await s.close();
    vi.clearAllMocks();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(streamPodLog).not.toHaveBeenCalled();
  });
});

describe("merged all-containers mode", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    listeners.clear();
    vi.clearAllMocks();
    app.kubeconfigPath = "/tmp/kubeconfig";
    app.activeCluster = "prod";
    let nextId = 0;
    vi.mocked(streamPodLog).mockImplementation(async () => String(++nextId));
    vi.mocked(getPodContainers).mockResolvedValue([
      { name: "worker", init: false, sidecar: false, restarts: 0, ready: true, state: "running", state_reason: null, last_terminated_reason: null, last_terminated_at: null },
      { name: "envoy", init: false, sidecar: true, restarts: 0, ready: true, state: "running", state_reason: null, last_terminated_reason: null, last_terminated_at: null },
      { name: "init-migrate", init: true, sidecar: false, restarts: 0, ready: true, state: "terminated", state_reason: null, last_terminated_reason: null, last_terminated_at: null },
    ]);
  });
  afterEach(() => vi.useRealTimers());

  it("opens one stream per container, init included", async () => {
    const s = new LogSession("default", "api-0", ALL_CONTAINERS);
    await s.open();
    expect(streamPodLog).toHaveBeenCalledTimes(3);
    const containersArg = vi.mocked(streamPodLog).mock.calls.map((c) => c[3]!.container);
    expect(containersArg).toEqual(["worker", "envoy", "init-migrate"]);
  });

  it("interleaves tagged lines into one ring by receive order", async () => {
    const s = new LogSession("default", "api-0", ALL_CONTAINERS);
    await s.open();
    emitLine("1", "from worker");
    emitLine("2", "from envoy");
    emitLine("1", "worker again");
    await vi.advanceTimersByTimeAsync(130);
    expect(s.ring.lines.map((l) => l.container)).toEqual(["worker", "envoy", "worker"]);
  });

  it("stays streaming when one stream drops, reconnecting when all drop", async () => {
    const s = new LogSession("default", "api-0", ALL_CONTAINERS);
    await s.open();
    listeners.get("pod-log-end:1")?.({ payload: undefined });
    await vi.advanceTimersByTimeAsync(1);
    expect(s.status).toBe("streaming"); // envoy + init-migrate still live
    listeners.get("pod-log-end:2")?.({ payload: undefined });
    listeners.get("pod-log-end:3")?.({ payload: undefined });
    await vi.advanceTimersByTimeAsync(1);
    expect(s.status).toBe("reconnecting");
  });

  it("retryNow fans out to every waiting stream", async () => {
    const s = new LogSession("default", "api-0", ALL_CONTAINERS);
    await s.open();
    vi.mocked(streamPodLog).mockClear();
    listeners.get("pod-log-end:1")?.({ payload: undefined });
    listeners.get("pod-log-end:2")?.({ payload: undefined });
    listeners.get("pod-log-end:3")?.({ payload: undefined });
    await vi.advanceTimersByTimeAsync(1);
    s.retryNow();
    await vi.waitFor(() => expect(streamPodLog).toHaveBeenCalledTimes(3));
  });

  it("setPrevious is a no-op in merged mode", async () => {
    const s = new LogSession("default", "api-0", ALL_CONTAINERS);
    await s.open();
    await s.setPrevious(true);
    expect(s.previous).toBe(false);
  });
});
