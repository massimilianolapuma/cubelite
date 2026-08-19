import { beforeEach, describe, expect, it, vi } from "vitest";

const eventListeners = new Map<string, (event: { payload: unknown }) => void>();
const emitted: Array<{ target: string | null; name: string; payload?: unknown }> = [];
const spawned: Array<{ label: string; options: Record<string, unknown> }> = [];
const focusCalls: string[] = [];

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, cb: (event: { payload: unknown }) => void) => {
    eventListeners.set(name, cb);
    return () => eventListeners.delete(name);
  }),
  emit: vi.fn(async (name: string, payload?: unknown) => {
    emitted.push({ target: null, name, payload });
  }),
  emitTo: vi.fn(async (target: string, name: string, payload?: unknown) => {
    emitted.push({ target, name, payload });
  }),
}));

vi.mock("@tauri-apps/api/webviewWindow", () => {
  class FakeWebviewWindow {
    label: string;
    constructor(label: string, options: Record<string, unknown>) {
      this.label = label;
      spawned.push({ label, options });
    }
    // Tauri fires window lifecycle events through listen(); tests trigger
    // the ready event directly via eventListeners, so `once` here is only
    // used for tauri://destroyed cleanup.
    once = vi.fn(async (name: string, cb: () => void) => {
      eventListeners.set(`${this.label}:${name}`, cb as never);
      return () => eventListeners.delete(`${this.label}:${name}`);
    });
    setFocus = vi.fn(async () => {
      focusCalls.push(this.label);
    });
    static getByLabel = vi.fn(async (label: string) =>
      spawned.some((s) => s.label === label) ? new FakeWebviewWindow(label, {}) : null,
    );
  }
  return { WebviewWindow: FakeWebviewWindow };
});

vi.mock("./logPanel.svelte", () => ({
  logPanel: {
    sessions: [] as unknown[],
    closeSession: vi.fn(async () => {}),
    openSeeded: vi.fn(async () => {}),
  },
}));
vi.mock("./sessionTransfer", async (importOriginal) => {
  const original = await importOriginal<typeof import("./sessionTransfer")>();
  return {
    ...original,
    serializeSession: vi.fn(() => FAKE_TRANSFER),
  };
});

const FAKE_TRANSFER = {
  key: "default/api-0", namespace: "default", pod: "api-0", container: "worker",
  previous: false, tailLines: 500, following: true,
  lines: [], kubeconfigPath: "/tmp/kc", activeCluster: null,
};

import { logPanel } from "./logPanel.svelte";
import { logWindows, windowLabelFor } from "./logWindows.svelte";

describe("logWindows", () => {
  beforeEach(() => {
    eventListeners.clear();
    emitted.length = 0;
    spawned.length = 0;
    focusCalls.length = 0;
    vi.clearAllMocks();
    (logPanel.sessions as unknown[]).length = 0;
  });

  it("windowLabelFor slugs the key", () => {
    expect(windowLabelFor("default/api-0")).toBe("logs-default-api-0");
  });

  it("detach: spawn → ready → seed → close local session", async () => {
    (logPanel.sessions as unknown[]).push({ key: "default/api-0" });
    const detachPromise = logWindows.detach("default/api-0");
    await vi.waitFor(() => {
      expect(eventListeners.has("log-window-ready:default/api-0")).toBe(true);
    });
    expect(spawned[0]?.label).toBe("logs-default-api-0");
    // seed not sent before ready
    expect(emitted.filter((e) => e.name.startsWith("log-window-seed:"))).toHaveLength(0);
    eventListeners.get("log-window-ready:default/api-0")?.({ payload: null });
    await detachPromise;
    const seed = emitted.find((e) => e.name === "log-window-seed:default/api-0");
    expect(seed?.target).toBe("logs-default-api-0");
    expect(seed?.payload).toBe(FAKE_TRANSFER);
    expect(vi.mocked(logPanel.closeSession)).toHaveBeenCalledWith("default/api-0");
    expect(logWindows.has("default/api-0")).toBe(true);
  });

  it("detach is a no-op without a panel session", async () => {
    await logWindows.detach("default/ghost");
    expect(spawned).toHaveLength(0);
  });

  it("init wires re-attach: valid payload → openSeeded, registry cleared", async () => {
    await logWindows.init();
    (logPanel.sessions as unknown[]).push({ key: "default/api-0" });
    const p = logWindows.detach("default/api-0");
    await vi.waitFor(() => eventListeners.has("log-window-ready:default/api-0"));
    eventListeners.get("log-window-ready:default/api-0")?.({ payload: null });
    await p;
    eventListeners.get("log-window-reattach")?.({ payload: FAKE_TRANSFER });
    await vi.waitFor(() => {
      expect(vi.mocked(logPanel.openSeeded)).toHaveBeenCalledWith(FAKE_TRANSFER);
    });
    expect(logWindows.has("default/api-0")).toBe(false);
  });

  it("init ignores malformed re-attach payloads", async () => {
    await logWindows.init();
    eventListeners.get("log-window-reattach")?.({ payload: { junk: true } });
    expect(vi.mocked(logPanel.openSeeded)).not.toHaveBeenCalled();
  });

  it("closeAll broadcasts and clears the registry", async () => {
    (logPanel.sessions as unknown[]).push({ key: "default/api-0" });
    const p = logWindows.detach("default/api-0");
    await vi.waitFor(() => eventListeners.has("log-window-ready:default/api-0"));
    eventListeners.get("log-window-ready:default/api-0")?.({ payload: null });
    await p;
    await logWindows.closeAll();
    expect(emitted.some((e) => e.name === "log-window-close-all")).toBe(true);
    expect(logWindows.has("default/api-0")).toBe(false);
  });

  it("focus targets the window by label", async () => {
    (logPanel.sessions as unknown[]).push({ key: "default/api-0" });
    const p = logWindows.detach("default/api-0");
    await vi.waitFor(() => eventListeners.has("log-window-ready:default/api-0"));
    eventListeners.get("log-window-ready:default/api-0")?.({ payload: null });
    await p;
    await logWindows.focus("default/api-0");
    expect(focusCalls).toContain("logs-default-api-0");
  });
});
