import { describe, it, expect, beforeEach, vi } from "vitest";
import { profiles } from "./profiles.svelte";
import { toasts } from "./toasts.svelte";
import { navigation } from "./navigation.svelte";

beforeEach(() => {
  window.localStorage.clear();
  profiles.reset();
  navigation.reset();
  vi.restoreAllMocks();
});

describe("profiles store", () => {
  it("persists to cubelite.profiles and repairs on load", async () => {
    profiles.activate("security");
    expect(JSON.parse(window.localStorage.getItem("cubelite.profiles")!).active).toBe("security");

    window.localStorage.setItem("cubelite.profiles", JSON.stringify({ active: "gone", profiles: [{ id: "oncall", pins: ["pods", "nope"] }] }));
    vi.resetModules();
    const fresh = (await import("./profiles.svelte")).profiles;
    expect(fresh.active.id).toBe("oncall");
    expect(fresh.active.pins).toEqual(["pods"]);
    expect(fresh.list.map((p) => p.id)).toEqual(["oncall", "developer", "security", "all"]);
  });

  it("togglePin pins and unpins in the active profile", () => {
    expect(profiles.isPinned("secrets")).toBe(false);
    profiles.togglePin("secrets");
    expect(profiles.isPinned("secrets")).toBe(true);
    expect(profiles.active.pins.at(-1)).toBe("secrets");
    profiles.togglePin("secrets");
    expect(profiles.isPinned("secrets")).toBe(false);
  });

  it("the 10th pin pushes the toast", () => {
    const push = vi.spyOn(toasts, "push");
    profiles.togglePin("services");
    profiles.togglePin("ingresses");
    expect(profiles.active.pins).toHaveLength(9);
    profiles.togglePin("secrets");
    expect(push).toHaveBeenCalledWith("A profile holds up to 9 pins", "err");
    expect(profiles.isPinned("secrets")).toBe(false);
  });

  it("a hidden type cannot be pinned", () => {
    const push = vi.spyOn(toasts, "push");
    navigation.setHidden("services", true);
    profiles.togglePin("services");
    expect(profiles.isPinned("services")).toBe(false);
    expect(push).toHaveBeenCalledWith("Hidden in Preferences: show it first to pin it", "err");
  });

  it("create returns the validation error, or null and activates the new profile", () => {
    expect(profiles.create("On-call", "empty")).toBe("A profile with this name already exists");
    expect(profiles.create("Team A", "active")).toBeNull();
    expect(profiles.active.name).toBe("Team A");
    expect(profiles.active.id).toMatch(/^user-/);
    expect(profiles.active.pins).toEqual(["overview", "nodes", "pods", "deployments", "jobs", "events", "logs"]);
    expect(profiles.rename(profiles.active.id, "")).toBe("Use 1 to 24 characters");
    profiles.remove(profiles.active.id);
    expect(profiles.active.id).toBe("oncall");
  });

  it("the profile shortcut follows the menu order", () => {
    profiles.move("all", -1);
    profiles.move("all", -1);
    profiles.move("all", -1);
    profiles.activateIndex(0);
    expect(profiles.active.id).toBe("all");
    profiles.activateIndex(8);
    expect(profiles.active.id).toBe("all");
  });
});
