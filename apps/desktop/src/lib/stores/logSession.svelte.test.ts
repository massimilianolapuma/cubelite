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
import { LogSession } from "./logSession.svelte";

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

  it("close() stops the stream and detaches listeners", async () => {
    const s = new LogSession("default", "api-0");
    await s.open();
    await s.close();
    expect(stopLogs).toHaveBeenCalledWith("7");
    expect(listeners.size).toBe(0);
  });
});
