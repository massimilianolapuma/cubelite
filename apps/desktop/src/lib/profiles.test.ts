import { describe, it, expect } from "vitest";
import {
  DEFAULT_PROFILES,
  PIN_LIMIT_MESSAGE,
  activeProfile,
  createProfile,
  deleteProfile,
  moveProfile,
  movePin,
  normalizeProfiles,
  pin,
  renameProfile,
  resetPins,
  setActive,
  unpin,
  validateName,
  type ProfilesPrefs,
  type Result,
} from "#lib/profiles.ts";

const ok = (r: Result): ProfilesPrefs => {
  if (!r.ok) throw new Error(r.error);
  return r.prefs;
};
const byId = (prefs: ProfilesPrefs, id: string) => prefs.profiles.find((p) => p.id === id);

describe("built-ins", () => {
  it("ships the built-ins of spec §7 with On-call active", () => {
    expect(DEFAULT_PROFILES.active).toBe("oncall");
    expect(DEFAULT_PROFILES.profiles.map((p) => [p.id, p.name, p.builtIn])).toEqual([
      ["oncall", "On-call", true],
      ["developer", "Developer", true],
      ["security", "Security", true],
      ["all", "All", true],
    ]);
    expect(activeProfile(DEFAULT_PROFILES).pins).toEqual(["overview", "nodes", "pods", "deployments", "jobs", "events", "logs"]);
    expect(byId(DEFAULT_PROFILES, "developer")!.pins).toEqual(["pods", "deployments", "services", "ingresses", "configmaps", "secrets", "logs"]);
    expect(byId(DEFAULT_PROFILES, "security")!.pins).toEqual(["serviceaccounts", "roles", "rolebindings", "clusterroles", "secrets", "networkpolicies"]);
    expect(byId(DEFAULT_PROFILES, "all")!.pins).toEqual(["overview", "pods", "deployments", "services", "events"]);
  });

  it("built-ins keep their name and reset their pins", () => {
    expect(renameProfile(DEFAULT_PROFILES, "developer", "Dev")).toEqual({ ok: false, error: "Built-in profiles keep their name" });
    const changed = unpin(DEFAULT_PROFILES, "pods", "developer");
    expect(byId(changed, "developer")!.pins).not.toContain("pods");
    expect(byId(resetPins(changed, "developer"), "developer")!.pins).toEqual(byId(DEFAULT_PROFILES, "developer")!.pins);
    expect(deleteProfile(DEFAULT_PROFILES, "security")).toBe(DEFAULT_PROFILES);
  });
});

describe("normalizeProfiles", () => {
  it("normalize repairs every broken field", () => {
    const prefs = normalizeProfiles({
      active: "gone",
      profiles: [
        { id: "oncall", name: "Hacked", builtIn: false, pins: ["pods", "pods", "nope", "events"] },
        { id: "u1", name: "x".repeat(30), builtIn: false, pins: [] },
        {
          id: "u2",
          name: " Mine ",
          builtIn: false,
          pins: ["pods", "deployments", "services", "ingresses", "configmaps", "secrets", "events", "logs", "nodes", "jobs"],
        },
        { id: "u3", name: "mine", builtIn: false, pins: [] },
        { name: "no id", pins: [] },
        "junk",
      ],
    });
    expect(prefs.active).toBe("oncall");
    expect(prefs.profiles[0]).toEqual({ id: "oncall", name: "On-call", builtIn: true, pins: ["pods", "events"] });
    expect(byId(prefs, "u1")).toBeUndefined();
    expect(byId(prefs, "u3")).toBeUndefined();
    expect(byId(prefs, "u2")).toMatchObject({ name: "Mine", builtIn: false });
    expect(byId(prefs, "u2")!.pins).toHaveLength(9);
    expect(prefs.profiles.map((p) => p.id)).toEqual(["oncall", "u2", "developer", "security", "all"]);
  });

  it("falls back to the defaults for junk and keeps a valid active id", () => {
    expect(normalizeProfiles("junk")).toEqual(DEFAULT_PROFILES);
    expect(normalizeProfiles(undefined)).toEqual(DEFAULT_PROFILES);
    expect(normalizeProfiles({ ...DEFAULT_PROFILES, active: "security" }).active).toBe("security");
  });

  it("keeps at most 12 profiles", () => {
    const many = Array.from({ length: 15 }, (_, i) => ({ id: `u${i}`, name: `P${i}`, builtIn: false, pins: [] }));
    const prefs = normalizeProfiles({ active: "oncall", profiles: many });
    expect(prefs.profiles).toHaveLength(12);
    for (const id of ["oncall", "developer", "security", "all"]) expect(byId(prefs, id)).toBeDefined();
  });
});

describe("pins", () => {
  it("pins to the active profile and ignores a repeat", () => {
    const prefs = ok(pin(DEFAULT_PROFILES, "secrets", []));
    expect(activeProfile(prefs).pins.at(-1)).toBe("secrets");
    expect(ok(pin(prefs, "secrets", []))).toBe(prefs);
  });

  it("refuses the 10th pin and hidden types", () => {
    let prefs = DEFAULT_PROFILES;
    for (const v of ["services", "ingresses"] as const) prefs = ok(pin(prefs, v, []));
    expect(activeProfile(prefs).pins).toHaveLength(9);
    expect(pin(prefs, "secrets", [])).toEqual({ ok: false, error: PIN_LIMIT_MESSAGE });
    expect(PIN_LIMIT_MESSAGE).toBe("A profile holds up to 9 pins");
    expect(pin(DEFAULT_PROFILES, "services", ["services"])).toEqual({
      ok: false,
      error: "Hidden in Preferences: show it first to pin it",
    });
  });

  it("unpins from the active profile by default", () => {
    expect(activeProfile(unpin(DEFAULT_PROFILES, "pods")).pins).not.toContain("pods");
  });

  it("moves pins and stops at the edges", () => {
    const prefs = movePin(DEFAULT_PROFILES, "oncall", "nodes", -1);
    expect(activeProfile(prefs).pins.slice(0, 2)).toEqual(["nodes", "overview"]);
    expect(movePin(prefs, "oncall", "nodes", -1)).toBe(prefs);
    expect(movePin(prefs, "oncall", "logs", 1)).toBe(prefs);
  });
});

describe("profiles", () => {
  it("validates names", () => {
    expect(validateName(DEFAULT_PROFILES, "  ")).toBe("Use 1 to 24 characters");
    expect(validateName(DEFAULT_PROFILES, "x".repeat(25))).toBe("Use 1 to 24 characters");
    expect(validateName(DEFAULT_PROFILES, "x".repeat(24))).toBeNull();
    expect(validateName(DEFAULT_PROFILES, " on-CALL ")).toBe("A profile with this name already exists");
    const prefs = ok(createProfile(DEFAULT_PROFILES, "Mine", "empty", "u1"));
    expect(validateName(prefs, "mine", "u1")).toBeNull();
  });

  it("creates empty or as a copy of the active profile, and caps at 12", () => {
    const empty = ok(createProfile(DEFAULT_PROFILES, " Team A ", "empty", "u1"));
    expect(byId(empty, "u1")).toEqual({ id: "u1", name: "Team A", builtIn: false, pins: [] });
    expect(empty.active).toBe("u1");
    const copy = ok(createProfile(setActive(DEFAULT_PROFILES, "security"), "Audit", "active", "u2"));
    expect(byId(copy, "u2")!.pins).toEqual(byId(DEFAULT_PROFILES, "security")!.pins);
    let full = DEFAULT_PROFILES;
    for (let i = 0; i < 8; i++) full = ok(createProfile(full, `P${i}`, "empty", `u${i}`));
    expect(full.profiles).toHaveLength(12);
    expect(createProfile(full, "One more", "empty", "u99")).toEqual({ ok: false, error: "Up to 12 profiles" });
    expect(createProfile(DEFAULT_PROFILES, "", "empty", "u1")).toEqual({ ok: false, error: "Use 1 to 24 characters" });
  });

  it("renames a user profile", () => {
    const prefs = ok(renameProfile(ok(createProfile(DEFAULT_PROFILES, "Mine", "empty", "u1")), "u1", " Ours "));
    expect(byId(prefs, "u1")!.name).toBe("Ours");
  });

  it("deleting the active profile activates On-call", () => {
    const prefs = ok(createProfile(DEFAULT_PROFILES, "Mine", "empty", "u1"));
    const gone = deleteProfile(prefs, "u1");
    expect(byId(gone, "u1")).toBeUndefined();
    expect(gone.active).toBe("oncall");
    const other = deleteProfile(setActive(prefs, "developer"), "u1");
    expect(other.active).toBe("developer");
  });

  it("moves profiles and sets the active one", () => {
    const prefs = moveProfile(DEFAULT_PROFILES, "all", -1);
    expect(prefs.profiles.map((p) => p.id)).toEqual(["oncall", "developer", "all", "security"]);
    expect(moveProfile(DEFAULT_PROFILES, "oncall", -1)).toBe(DEFAULT_PROFILES);
    expect(setActive(DEFAULT_PROFILES, "nope")).toBe(DEFAULT_PROFILES);
    expect(setActive(DEFAULT_PROFILES, "all").active).toBe("all");
  });
});
