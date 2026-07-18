import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("$lib/tauri", () => ({
  startPortForward: vi.fn(async () => ({ id: "1", localPort: 8080 })),
  stopPortForward: vi.fn(async () => undefined),
}));

import { startPortForward, stopPortForward } from "$lib/tauri";
import { portforward } from "./portforward.svelte";
import { app } from "./app.svelte";

beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(startPortForward).mockResolvedValue({ id: "1", localPort: 8080 });
  vi.mocked(stopPortForward).mockResolvedValue(undefined);
  portforward.sessions = [];
  app.kubeconfigPath = "/home/u/.kube/config";
  app.activeCluster = "prod";
});

describe("portforward store", () => {
  it("start records the session with the backend-assigned port", async () => {
    vi.mocked(startPortForward).mockResolvedValue({ id: "7", localPort: 51234 });

    const ok = await portforward.start("default", "api-0", 0, 8080);

    expect(ok).toBe(true);
    expect(startPortForward).toHaveBeenCalledWith(
      "/home/u/.kube/config",
      "default",
      "api-0",
      0,
      8080,
      "prod",
    );
    expect(portforward.sessions).toEqual([
      { id: "7", namespace: "default", pod: "api-0", localPort: 51234, remotePort: 8080 },
    ]);
  });

  it("start failure records nothing and returns false", async () => {
    vi.mocked(startPortForward).mockRejectedValue(new Error("address already in use"));

    const ok = await portforward.start("default", "api-0", 80, 80);

    expect(ok).toBe(false);
    expect(portforward.sessions).toHaveLength(0);
  });

  it("sessionsFor filters by pod identity", async () => {
    await portforward.start("default", "api-0", 80, 80);
    vi.mocked(startPortForward).mockResolvedValue({ id: "2", localPort: 9090 });
    await portforward.start("default", "worker-1", 9090, 9090);

    expect(portforward.sessionsFor("default", "api-0")).toHaveLength(1);
    expect(portforward.sessionsFor("default", "worker-1")[0].localPort).toBe(9090);
  });

  it("stop removes the session and notifies the backend", async () => {
    await portforward.start("default", "api-0", 80, 80);

    await portforward.stop("1");

    expect(portforward.sessions).toHaveLength(0);
    expect(stopPortForward).toHaveBeenCalledWith("1");
  });

  it("stopAll clears every session", async () => {
    await portforward.start("default", "api-0", 80, 80);
    vi.mocked(startPortForward).mockResolvedValue({ id: "2", localPort: 81 });
    await portforward.start("default", "api-1", 81, 81);

    await portforward.stopAll();

    expect(portforward.sessions).toHaveLength(0);
    expect(stopPortForward).toHaveBeenCalledTimes(2);
  });
});
