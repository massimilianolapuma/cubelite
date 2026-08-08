import { beforeEach, describe, expect, it, vi } from "vitest";
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
    streamPodLog: vi.fn(async () => "1"),
    stopLogs: vi.fn(async () => {}),
  };
});

import { app } from "./app.svelte";
import { ContainerStream } from "./containerStream.svelte";

function emit(name: string, payload: unknown) {
  listeners.get(name)?.({ payload });
}

describe("ContainerStream", () => {
  beforeEach(() => {
    listeners.clear();
    vi.clearAllMocks();
    app.kubeconfigPath = "/tmp/kubeconfig";
    app.activeCluster = "prod";
  });

  it("tags every forwarded line with its container name", async () => {
    const got: LogLine[][] = [];
    const s = new ContainerStream("ns", "pod", "envoy", (lines) => got.push(lines), () => ({
      previous: false,
      tailLines: 500,
      autoReconnect: true,
    }));
    await s.start();
    emit("pod-log-line:1", { pod: "pod", namespace: "ns", time: null, level: "info", message: "hi" });
    expect(got.flat()[0].container).toBe("envoy");
    expect(s.status).toBe("streaming");
  });

  it("backs off and exposes nextRetryAt when the stream ends with autoReconnect", async () => {
    vi.useFakeTimers();
    const s = new ContainerStream("ns", "pod", "worker", () => {}, () => ({
      previous: false, tailLines: 500, autoReconnect: true,
    }));
    await s.start();
    emit("pod-log-end:1", null);
    expect(s.status).toBe("reconnecting");
    expect(s.reconnectAttempt).toBe(1);
    expect(s.nextRetryAt).not.toBeNull();
    vi.useRealTimers();
  });

  it("ends without reconnect when autoReconnect is false", async () => {
    const s = new ContainerStream("ns", "pod", "worker", () => {}, () => ({
      previous: true, tailLines: 500, autoReconnect: false,
    }));
    await s.start();
    emit("pod-log-end:1", null);
    expect(s.status).toBe("ended");
  });
});
