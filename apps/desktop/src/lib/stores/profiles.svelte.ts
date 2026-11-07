/**
 * Viewing profiles (resource-kinds §7), persisted globally next to the
 * navigation preferences. Every rule lives in `#lib/profiles.ts`.
 */
import type { View } from "#lib/stores/app.svelte.ts";
import {
  DEFAULT_PROFILES,
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
  type BuiltInId,
  type Profile,
  type ProfilesPrefs,
  type Result,
} from "#lib/profiles.ts";
import { navigation } from "./navigation.svelte";
import { persisted } from "./settings.svelte";
import { toasts } from "./toasts.svelte";

const isObject = (v: unknown): v is ProfilesPrefs => typeof v === "object" && v !== null;

class ProfilesStore {
  #prefs = persisted<ProfilesPrefs>("profiles", DEFAULT_PROFILES, isObject);

  get prefs(): ProfilesPrefs {
    return normalizeProfiles(this.#prefs.value);
  }

  get active(): Profile {
    return activeProfile(this.prefs);
  }

  /** Every profile in menu order (= ⌥⌘1…9 order). */
  get list(): Profile[] {
    return this.prefs.profiles;
  }

  isPinned(view: View): boolean {
    return this.active.pins.includes(view);
  }

  #apply(result: Result): string | null {
    if (!result.ok) return result.error;
    this.#prefs.value = result.prefs;
    return null;
  }

  /** Pins or unpins `view` in the active profile; a refused pin shows a toast. */
  togglePin(view: View): void {
    if (this.isPinned(view)) this.#prefs.value = unpin(this.prefs, view);
    else this.pin(view);
  }

  /** Pins `view` to the active profile (never unpins); a refusal shows a toast. */
  pin(view: View): void {
    if (this.isPinned(view)) return;
    const error = this.#apply(pin(this.prefs, view, navigation.prefs.hidden));
    if (error) toasts.push(error, "err");
  }

  activate(id: string): void {
    this.#prefs.value = setActive(this.prefs, id);
  }

  activateIndex(index: number): void {
    const profile = this.list[index];
    if (profile) this.activate(profile.id);
  }

  /** Returns the validation error, or null once created (and activated). */
  create(name: string, from: "empty" | "active"): string | null {
    return this.#apply(createProfile(this.prefs, name, from, `user-${crypto.randomUUID()}`));
  }

  rename(id: string, name: string): string | null {
    return this.#apply(renameProfile(this.prefs, id, name));
  }

  remove(id: string): void {
    this.#prefs.value = deleteProfile(this.prefs, id);
  }

  move(id: string, delta: -1 | 1): void {
    this.#prefs.value = moveProfile(this.prefs, id, delta);
  }

  unpin(view: View, profileId?: string): void {
    this.#prefs.value = unpin(this.prefs, view, profileId);
  }

  movePin(profileId: string, view: View, delta: -1 | 1): void {
    this.#prefs.value = movePin(this.prefs, profileId, view, delta);
  }

  resetPins(id: BuiltInId): void {
    this.#prefs.value = resetPins(this.prefs, id);
  }

  /** Back to the four built-ins (tests, and a future "Reset to default"). */
  reset(): void {
    this.#prefs.reset();
  }
}

export const profiles = new ProfilesStore();
