/**
 * Viewing profiles (resource-kinds design §7): a name and an ordered pin
 * list, global to every cluster. Four built-ins ship; users add their own.
 * Pure: the store (`stores/profiles.svelte.ts`) persists the result.
 */
import { isView, type View } from "#lib/stores/app.svelte.ts";

export const MAX_PINS = 9;
export const MAX_PROFILES = 12;
export const NAME_MAX = 24;
export const PIN_LIMIT_MESSAGE = "A profile holds up to 9 pins";
const HIDDEN_MESSAGE = "Hidden in Preferences: show it first to pin it";
const NAME_LENGTH_MESSAGE = "Use 1 to 24 characters";
const NAME_TAKEN_MESSAGE = "A profile with this name already exists";
const PROFILE_LIMIT_MESSAGE = "Up to 12 profiles";
const BUILT_IN_NAME_MESSAGE = "Built-in profiles keep their name";

export type BuiltInId = "oncall" | "developer" | "security" | "all";

export interface Profile {
  id: string;
  name: string;
  builtIn: boolean;
  pins: View[];
}

export interface ProfilesPrefs {
  profiles: Profile[];
  active: string;
}

export type Result = { ok: true; prefs: ProfilesPrefs } | { ok: false; error: string };

const BUILT_INS: Record<BuiltInId, { name: string; pins: View[] }> = {
  oncall: { name: "On-call", pins: ["overview", "nodes", "pods", "deployments", "jobs", "events", "logs"] },
  developer: { name: "Developer", pins: ["pods", "deployments", "services", "ingresses", "configmaps", "secrets", "logs"] },
  security: {
    name: "Security",
    pins: ["serviceaccounts", "roles", "rolebindings", "clusterroles", "secrets", "networkpolicies"],
  },
  all: { name: "All", pins: ["overview", "pods", "deployments", "services", "events"] },
};
const BUILT_IN_IDS = Object.keys(BUILT_INS) as BuiltInId[];
const DEFAULT_ACTIVE: BuiltInId = "oncall";

const builtIn = (id: BuiltInId, pins: View[] = BUILT_INS[id].pins): Profile => ({
  id,
  name: BUILT_INS[id].name,
  builtIn: true,
  pins: [...pins],
});

export const DEFAULT_PROFILES: ProfilesPrefs = {
  profiles: BUILT_IN_IDS.map((id) => builtIn(id)),
  active: DEFAULT_ACTIVE,
};

const isBuiltInId = (id: string): id is BuiltInId => (BUILT_IN_IDS as string[]).includes(id);
const fold = (name: string) => name.trim().toLocaleLowerCase();

/** Known views, no duplicates, at most nine. */
function cleanPins(raw: unknown): View[] {
  const out: View[] = [];
  if (!Array.isArray(raw)) return out;
  for (const v of raw) if (isView(v) && !out.includes(v) && out.length < MAX_PINS) out.push(v);
  return out;
}

/** Repairs stored profiles: see the plan's Task 1 for every rule. */
export function normalizeProfiles(raw: unknown): ProfilesPrefs {
  const obj = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const stored = Array.isArray(obj.profiles) ? obj.profiles : [];
  const profiles: Profile[] = [];
  const names = new Set<string>();
  for (const entry of stored) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.id !== "string" || profiles.some((p) => p.id === e.id)) continue;
    if (isBuiltInId(e.id)) {
      profiles.push(builtIn(e.id, cleanPins(e.pins)));
      names.add(fold(BUILT_INS[e.id].name));
      continue;
    }
    const name = typeof e.name === "string" ? e.name.trim() : "";
    if (name.length < 1 || name.length > NAME_MAX || names.has(fold(name))) continue;
    if (BUILT_IN_IDS.some((id) => fold(BUILT_INS[id].name) === fold(name))) continue;
    names.add(fold(name));
    profiles.push({ id: e.id, name, builtIn: false, pins: cleanPins(e.pins) });
  }
  for (const id of BUILT_IN_IDS) if (!profiles.some((p) => p.id === id)) profiles.push(builtIn(id));
  // Over the cap: drop user profiles from the end, built-ins always stay.
  while (profiles.length > MAX_PROFILES) {
    const last = profiles.map((p) => p.builtIn).lastIndexOf(false);
    profiles.splice(last, 1);
  }
  const active =
    typeof obj.active === "string" && profiles.some((p) => p.id === obj.active) ? obj.active : DEFAULT_ACTIVE;
  return { profiles, active };
}

export function activeProfile(prefs: ProfilesPrefs): Profile {
  return prefs.profiles.find((p) => p.id === prefs.active) ?? prefs.profiles[0];
}

export function setActive(prefs: ProfilesPrefs, id: string): ProfilesPrefs {
  if (id === prefs.active || !prefs.profiles.some((p) => p.id === id)) return prefs;
  return { ...prefs, active: id };
}

function updateProfile(prefs: ProfilesPrefs, id: string, change: (p: Profile) => Profile): ProfilesPrefs {
  return { ...prefs, profiles: prefs.profiles.map((p) => (p.id === id ? change(p) : p)) };
}

/** Pins `view` to the active profile. */
export function pin(prefs: ProfilesPrefs, view: View, hidden: readonly View[]): Result {
  const profile = activeProfile(prefs);
  if (profile.pins.includes(view)) return { ok: true, prefs };
  if (hidden.includes(view)) return { ok: false, error: HIDDEN_MESSAGE };
  if (profile.pins.length >= MAX_PINS) return { ok: false, error: PIN_LIMIT_MESSAGE };
  return { ok: true, prefs: updateProfile(prefs, profile.id, (p) => ({ ...p, pins: [...p.pins, view] })) };
}

export function unpin(prefs: ProfilesPrefs, view: View, profileId: string = prefs.active): ProfilesPrefs {
  const profile = prefs.profiles.find((p) => p.id === profileId);
  if (!profile?.pins.includes(view)) return prefs;
  return updateProfile(prefs, profileId, (p) => ({ ...p, pins: p.pins.filter((v) => v !== view) }));
}

function swapped<T>(list: readonly T[], i: number, delta: -1 | 1): T[] | null {
  const j = i + delta;
  if (i < 0 || j < 0 || j >= list.length) return null;
  const out = [...list];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

export function movePin(prefs: ProfilesPrefs, profileId: string, view: View, delta: -1 | 1): ProfilesPrefs {
  const profile = prefs.profiles.find((p) => p.id === profileId);
  const pins = profile ? swapped(profile.pins, profile.pins.indexOf(view), delta) : null;
  return pins ? updateProfile(prefs, profileId, (p) => ({ ...p, pins })) : prefs;
}

/** The error for `name`, or null when it is usable (ignoring profile `exceptId`). */
export function validateName(prefs: ProfilesPrefs, name: string, exceptId?: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > NAME_MAX) return NAME_LENGTH_MESSAGE;
  const taken = prefs.profiles.some((p) => p.id !== exceptId && fold(p.name) === fold(trimmed));
  return taken ? NAME_TAKEN_MESSAGE : null;
}

/** Adds a profile, empty or with the active profile's pins, and activates it. */
export function createProfile(prefs: ProfilesPrefs, name: string, from: "empty" | "active", id: string): Result {
  if (prefs.profiles.length >= MAX_PROFILES) return { ok: false, error: PROFILE_LIMIT_MESSAGE };
  const error = validateName(prefs, name);
  if (error) return { ok: false, error };
  const pins = from === "active" ? [...activeProfile(prefs).pins] : [];
  const profile: Profile = { id, name: name.trim(), builtIn: false, pins };
  return { ok: true, prefs: { profiles: [...prefs.profiles, profile], active: id } };
}

export function renameProfile(prefs: ProfilesPrefs, id: string, name: string): Result {
  const profile = prefs.profiles.find((p) => p.id === id);
  if (!profile) return { ok: true, prefs };
  if (profile.builtIn) return { ok: false, error: BUILT_IN_NAME_MESSAGE };
  const error = validateName(prefs, name, id);
  if (error) return { ok: false, error };
  return { ok: true, prefs: updateProfile(prefs, id, (p) => ({ ...p, name: name.trim() })) };
}

/** Deletes a user profile; deleting the active one activates On-call. */
export function deleteProfile(prefs: ProfilesPrefs, id: string): ProfilesPrefs {
  const profile = prefs.profiles.find((p) => p.id === id);
  if (!profile || profile.builtIn) return prefs;
  return {
    profiles: prefs.profiles.filter((p) => p.id !== id),
    active: prefs.active === id ? DEFAULT_ACTIVE : prefs.active,
  };
}

export function moveProfile(prefs: ProfilesPrefs, id: string, delta: -1 | 1): ProfilesPrefs {
  const profiles = swapped(prefs.profiles, prefs.profiles.findIndex((p) => p.id === id), delta);
  return profiles ? { ...prefs, profiles } : prefs;
}

export function resetPins(prefs: ProfilesPrefs, id: BuiltInId): ProfilesPrefs {
  return updateProfile(prefs, id, () => builtIn(id));
}
