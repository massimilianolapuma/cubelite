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
import { SEARCH_DEBOUNCE_MS } from "./logSearch.svelte";

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

  it("openFor creates a session and focuses it", async () => {
    await logPanel.openFor({ namespace: "default", name: "api-0" });
    expect(logPanel.open).toBe(true);
    expect(logPanel.activeKey).toBe("default/api-0");
  });

  it("keeps existing sessions when opening a second pod and focuses the new one", async () => {
    await logPanel.openFor({ namespace: "default", name: "api-0" });
    await logPanel.openFor({ namespace: "default", name: "web-1" });
    expect(logPanel.sessions.map((s) => s.key)).toEqual(["default/api-0", "default/web-1"]);
    expect(logPanel.activeKey).toBe("default/web-1");
  });

  it("focus() switches the active session and closing the active tab falls back to the last one", async () => {
    await logPanel.openFor({ namespace: "default", name: "api-0" });
    await logPanel.openFor({ namespace: "default", name: "web-1" });
    logPanel.focus("default/api-0");
    expect(logPanel.activeKey).toBe("default/api-0");
    await logPanel.closeSession("default/api-0");
    expect(logPanel.activeKey).toBe("default/web-1");
  });

  it("evicts the least-recently-focused session past the cap of 6, honoring focus() bumps", async () => {
    for (let i = 0; i < 6; i++) await logPanel.openFor({ namespace: "default", name: `p-${i}` });
    // p-0 was opened first (least-recently-focused by insertion order), but an
    // explicit focus() should move it to the back of the LRU order so the
    // next-opened session evicts p-1 instead.
    logPanel.focus("default/p-0");
    await logPanel.openFor({ namespace: "default", name: "p-6" });
    expect(logPanel.sessions).toHaveLength(6);
    expect(logPanel.sessions.some((s) => s.key === "default/p-1")).toBe(false);
    expect(logPanel.sessions.some((s) => s.key === "default/p-0")).toBe(true);
  });

  it("focus() recomputes the shared query against the newly active session's buffer", async () => {
    await logPanel.openFor({ namespace: "default", name: "api-0" });
    logPanel.active!.ring.append([
      { pod: "api-0", namespace: "default", time: null, level: "info", message: "no match here" },
    ]);
    await logPanel.openFor({ namespace: "default", name: "web-1" });
    logPanel.active!.ring.append([
      { pod: "web-1", namespace: "default", time: null, level: "info", message: "alpha line" },
    ]);

    // Switch to api-0 (no matching line) and set the query while it's active.
    logPanel.focus("default/api-0");
    vi.useFakeTimers();
    logPanel.search.setQuery("alpha");
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS + 10);
    vi.useRealTimers();
    expect(logPanel.search.count).toBe(0);

    // Switching back to web-1 must recompute immediately against its buffer.
    logPanel.focus("default/web-1");
    expect(logPanel.search.query).toBe("alpha");
    expect(logPanel.search.count).toBe(1);
  });

  it("closing the active session re-attaches search to the fallback session's buffer", async () => {
    await logPanel.openFor({ namespace: "default", name: "api-0" });
    logPanel.active!.ring.append([
      { pod: "api-0", namespace: "default", time: null, level: "info", message: "alpha in api" },
    ]);
    await logPanel.openFor({ namespace: "default", name: "web-1" });
    logPanel.active!.ring.append([
      { pod: "web-1", namespace: "default", time: null, level: "info", message: "no match" },
    ]);

    logPanel.focus("default/api-0");
    vi.useFakeTimers();
    logPanel.search.setQuery("alpha");
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS + 10);
    vi.useRealTimers();
    expect(logPanel.search.count).toBe(1);

    await logPanel.closeSession("default/api-0");
    expect(logPanel.activeKey).toBe("default/web-1");
    // The query text survives, but matches must reflect the fallback
    // session's buffer, not the closed (dead) one's.
    expect(logPanel.search.query).toBe("alpha");
    expect(logPanel.search.count).toBe(0);
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

  it("closeAll closes every session (cluster switch teardown path)", async () => {
    await logPanel.openFor({ namespace: "default", name: "api-0" });
    await logPanel.openFor({ namespace: "default", name: "web-1" });
    expect(logPanel.sessions).toHaveLength(2);

    await logPanel.closeAll();

    expect(logPanel.sessions).toHaveLength(0);
    expect(logPanel.activeKey).toBeNull();
    expect(vi.mocked((await import("$lib/tauri")).stopLogs)).toHaveBeenCalledTimes(2);
  });

  it("height persists clamped to bounds", () => {
    logPanel.height = 9999;
    expect(logPanel.height).toBe(PANEL_MAX);
    logPanel.height = 10;
    expect(logPanel.height).toBe(PANEL_MIN);
    logPanel.height = PANEL_DEFAULT;
    expect(JSON.parse(window.localStorage.getItem("cubelite.logPanel.height")!)).toBe(PANEL_DEFAULT);
  });

  it("registerSearchFocus wires focusSearch to the registered callback", () => {
    const fn = vi.fn();
    logPanel.registerSearchFocus(fn);
    logPanel.focusSearch();
    expect(fn).toHaveBeenCalledOnce();

    logPanel.registerSearchFocus(null);
    logPanel.focusSearch(); // no callback registered: must be a no-op, not throw
    expect(fn).toHaveBeenCalledOnce();
  });

  it("openFor clears any prior search and re-attaches to the newly opened session's buffer", async () => {
    await logPanel.openFor({ namespace: "default", name: "api-0" });
    logPanel.active!.ring.append([
      { pod: "api-0", namespace: "default", time: null, level: "info", message: "alpha" },
    ]);
    vi.useFakeTimers();
    logPanel.search.setQuery("alpha");
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS + 10);
    vi.useRealTimers();
    expect(logPanel.search.count).toBe(1);

    await logPanel.openFor({ namespace: "default", name: "web-1" });
    expect(logPanel.search.query).toBe("");
    expect(logPanel.search.count).toBe(0);

    logPanel.active!.ring.append([
      { pod: "web-1", namespace: "default", time: null, level: "info", message: "beta" },
    ]);
    vi.useFakeTimers();
    logPanel.search.setQuery("beta");
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS + 10);
    vi.useRealTimers();
    expect(logPanel.search.count).toBe(1);
  });
});
