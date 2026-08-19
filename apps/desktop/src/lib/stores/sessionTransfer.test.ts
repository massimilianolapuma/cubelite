import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));
vi.mock("$lib/tauri", async (importOriginal) => {
  const original = await importOriginal<typeof import("$lib/tauri")>();
  return {
    ...original,
    streamPodLog: vi.fn(async () => "1"),
    stopLogs: vi.fn(async () => {}),
    getPodContainers: vi.fn(async () => []),
  };
});

import { app } from "./app.svelte";
import { LogSession } from "./logSession.svelte";
import { isSessionTransfer, serializeSession } from "./sessionTransfer";

describe("SessionTransfer", () => {
  it("serializes a session round-trip compatible with SessionSeed", () => {
    app.kubeconfigPath = "/tmp/kc";
    app.activeCluster = "ctx-1";
    const session = new LogSession("default", "api-0", "worker", {
      lines: [
        { id: 0, pod: "api-0", namespace: "default", time: "2026-08-19T10:00:00Z", level: "info", message: "hello" },
      ],
      previous: false,
      tailLines: 1000,
      following: false,
    });
    const t = serializeSession(session);
    expect(t).toMatchObject({
      key: "default/api-0",
      namespace: "default",
      pod: "api-0",
      container: "worker",
      previous: false,
      tailLines: 1000,
      following: false,
      kubeconfigPath: "/tmp/kc",
      activeCluster: "ctx-1",
    });
    expect(t.lines).toHaveLength(1);
    expect(t.lines[0]?.message).toBe("hello");
    // JSON round-trip (what the Tauri event does) preserves the guard
    expect(isSessionTransfer(JSON.parse(JSON.stringify(t)))).toBe(true);
  });

  it("isSessionTransfer rejects malformed payloads", () => {
    expect(isSessionTransfer(null)).toBe(false);
    expect(isSessionTransfer({})).toBe(false);
    expect(isSessionTransfer({ key: "a/b", lines: "nope" })).toBe(false);
  });
});
