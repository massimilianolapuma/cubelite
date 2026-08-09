import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockCheck, mockRelaunch } = vi.hoisted(() => ({
  mockCheck: vi.fn(),
  mockRelaunch: vi.fn(async () => {}),
}));

vi.mock("@tauri-apps/plugin-updater", () => ({
  check: mockCheck,
}));
vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: mockRelaunch,
}));

import { updater } from "./updater.svelte";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Resets the private #update reference too, so tests don't leak state
  // (e.g. a mocked update object) into the next one.
  updater.dismiss();
});

describe("updater.checkForUpdates", () => {
  it("goes idle -> checking -> available when an update is found", async () => {
    const downloadAndInstall = vi.fn(async () => {});
    mockCheck.mockResolvedValue({ version: "1.2.0", downloadAndInstall });

    const promise = updater.checkForUpdates(true);
    expect(updater.status).toBe("checking");
    await promise;

    expect(updater.status).toBe("available");
    expect(updater.version).toBe("1.2.0");
    expect(updater.error).toBeNull();
  });

  it("goes idle -> checking -> idle when there is no update", async () => {
    mockCheck.mockResolvedValue(null);

    await updater.checkForUpdates(true);

    expect(updater.status).toBe("idle");
    expect(updater.version).toBeNull();
  });

  it("silent=true drops a failed check back to idle without an error", async () => {
    mockCheck.mockRejectedValue(new Error("offline"));

    await updater.checkForUpdates(true);

    expect(updater.status).toBe("idle");
    expect(updater.error).toBeNull();
  });

  it("silent=false surfaces a failed check as an error", async () => {
    mockCheck.mockRejectedValue(new Error("network unreachable"));

    await updater.checkForUpdates(false);

    expect(updater.status).toBe("error");
    expect(updater.error).toBe("network unreachable");
  });

  it("a concurrent check while one is in flight is a no-op", async () => {
    const { promise, resolve } = deferred<null>();
    mockCheck.mockReturnValue(promise);

    const first = updater.checkForUpdates(true);
    const second = updater.checkForUpdates(true);
    resolve(null);
    await Promise.all([first, second]);

    expect(mockCheck).toHaveBeenCalledTimes(1);
  });
});

describe("updater.downloadAndInstall", () => {
  it("moves available -> downloading -> ready and does NOT relaunch", async () => {
    const downloadAndInstall = vi.fn(async () => {});
    mockCheck.mockResolvedValue({ version: "1.2.0", downloadAndInstall });
    await updater.checkForUpdates(true);

    const promise = updater.downloadAndInstall();
    expect(updater.status).toBe("downloading");
    await promise;

    expect(updater.status).toBe("ready");
    expect(downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(mockRelaunch).not.toHaveBeenCalled();
  });

  it("surfaces a failed download/install as an error", async () => {
    const downloadAndInstall = vi.fn(async () => {
      throw new Error("disk full");
    });
    mockCheck.mockResolvedValue({ version: "1.2.0", downloadAndInstall });
    await updater.checkForUpdates(true);

    await updater.downloadAndInstall();

    expect(updater.status).toBe("error");
    expect(updater.error).toBe("disk full");
    expect(mockRelaunch).not.toHaveBeenCalled();
  });

  it("is a no-op when there is no checked update", async () => {
    await updater.downloadAndInstall();

    expect(updater.status).toBe("idle");
  });
});

describe("updater.restartNow", () => {
  it("calls relaunch", async () => {
    await updater.restartNow();

    expect(mockRelaunch).toHaveBeenCalledTimes(1);
  });
});

describe("updater.dismiss", () => {
  it("resets to idle", async () => {
    mockCheck.mockResolvedValue({ version: "1.2.0", downloadAndInstall: vi.fn() });
    await updater.checkForUpdates(true);

    updater.dismiss();

    expect(updater.status).toBe("idle");
    expect(updater.version).toBeNull();
    expect(updater.error).toBeNull();
  });
});
