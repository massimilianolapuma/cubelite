import { describe, it, expect, beforeEach, vi } from "vitest";
import { installLocalStorageMock } from "./storage-mock";

async function freshSettings() {
  vi.resetModules();
  const mod = await import("./settings.svelte");
  return mod.settings;
}

beforeEach(() => {
  installLocalStorageMock();
});

describe("settings", () => {
  it("returns defaults when storage is empty", async () => {
    const settings = await freshSettings();
    expect(settings.theme.value).toBe("dark");
    expect(settings.refreshInterval.value).toBe(30);
    expect(settings.skipTls.value).toBe(false);
    expect(settings.onboardingSeen.value).toBe(false);
    expect(settings.identityColors.value).toEqual({});
  });

  it("persists and restores values across module reloads", async () => {
    const first = await freshSettings();
    first.refreshInterval.value = 60;
    first.onboardingSeen.value = true;
    first.identityColors.value = { prod: "teal" };

    const second = await freshSettings();
    expect(second.refreshInterval.value).toBe(60);
    expect(second.onboardingSeen.value).toBe(true);
    expect(second.identityColors.value).toEqual({ prod: "teal" });
  });

  it("falls back to defaults for invalid stored values", async () => {
    window.localStorage.setItem("cubelite.refreshInterval", JSON.stringify(45));
    window.localStorage.setItem("cubelite.theme", JSON.stringify("sepia"));
    window.localStorage.setItem("cubelite.identityColors", "not-json{");

    const settings = await freshSettings();
    expect(settings.refreshInterval.value).toBe(30);
    expect(settings.theme.value).toBe("dark");
    expect(settings.identityColors.value).toEqual({});
  });

  it("reset clears storage and restores the default", async () => {
    const settings = await freshSettings();
    settings.skipTls.value = true;
    settings.skipTls.reset();
    expect(settings.skipTls.value).toBe(false);
    expect(window.localStorage.getItem("cubelite.skipTls")).toBeNull();
  });
});
