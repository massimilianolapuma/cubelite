import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installLocalStorageMock } from "./storage-mock";

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
    streamPodLog: vi.fn(async () => "9"),
    stopLogs: vi.fn(async () => {}),
    getPodContainers: vi.fn(async () => [
      { name: "worker", init: false, sidecar: false, restarts: 0, ready: true, state: "running", state_reason: null, last_terminated_reason: null, last_terminated_at: null },
      { name: "envoy", init: false, sidecar: true, restarts: 0, ready: true, state: "running", state_reason: null, last_terminated_reason: null, last_terminated_at: null },
    ]),
  };
});

import { app } from "./app.svelte";
import { logPanel, PANEL_DEFAULT, PANEL_MAX, PANEL_MIN } from "./logPanel.svelte";

describe("logPanel store", () => {
  beforeEach(() => {
    installLocalStorageMock();
    vi.clearAllMocks();
    window.localStorage.clear();
    app.kubeconfigPath = "/tmp/kubeconfig";
    app.activeCluster = "prod";
  });
  afterEach(async () => {
    for (const s of [...logPanel.sessions]) await logPanel.closeSession(s.key);
  });

  it("openFor creates a session and focuses it; a second pod replaces it (single-session PR)", async () => {
    await logPanel.openFor({ namespace: "default", name: "api-0" });
    expect(logPanel.open).toBe(true);
    expect(logPanel.activeKey).toBe("default/api-0");
    await logPanel.openFor({ namespace: "default", name: "web-1" });
    expect(logPanel.sessions).toHaveLength(1);
    expect(logPanel.activeKey).toBe("default/web-1");
  });

  it("openFor on the already-open pod focuses without restarting the stream", async () => {
    await logPanel.openFor({ namespace: "default", name: "api-0" });
    const calls = vi.mocked((await import("$lib/tauri")).streamPodLog).mock.calls.length;
    await logPanel.openFor({ namespace: "default", name: "api-0" });
    expect(vi.mocked((await import("$lib/tauri")).streamPodLog).mock.calls.length).toBe(calls);
  });

  it("remembers the container choice per pod across reopen", async () => {
    await logPanel.openFor({ namespace: "default", name: "api-0" });
    await logPanel.active!.switchContainer("envoy");
    logPanel.rememberContainer("default/api-0", "envoy");
    await logPanel.closeSession("default/api-0");
    await logPanel.openFor({ namespace: "default", name: "api-0" });
    expect(logPanel.active!.container).toBe("envoy");
  });

  it("height persists clamped to bounds", () => {
    logPanel.height = 9999;
    expect(logPanel.height).toBe(PANEL_MAX);
    logPanel.height = 10;
    expect(logPanel.height).toBe(PANEL_MIN);
    logPanel.height = PANEL_DEFAULT;
    expect(JSON.parse(window.localStorage.getItem("cubelite.logPanel.height")!)).toBe(PANEL_DEFAULT);
  });
});
