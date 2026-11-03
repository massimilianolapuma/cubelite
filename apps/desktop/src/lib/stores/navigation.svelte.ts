/**
 * Sidebar order and visibility (#496), persisted globally (all clusters).
 */
import type { View } from "#lib/stores/app.svelte.ts";
import {
  DEFAULT_NAV,
  arrange,
  canHide,
  moveItem,
  moveSection,
  normalize,
  setHidden,
  visibleSections,
  type NavPrefs,
  type NavSection,
  type SectionId,
} from "#lib/navigation.ts";
import { persisted } from "./settings.svelte";

const isObject = (v: unknown): v is NavPrefs => typeof v === "object" && v !== null;

class NavigationStore {
  #prefs = persisted<NavPrefs>("navigation", DEFAULT_NAV, isObject);

  get prefs(): NavPrefs {
    return normalize(this.#prefs.value);
  }

  /** Sidebar sections: visible items only. */
  get sections(): NavSection[] {
    return visibleSections(this.prefs);
  }

  /** Preferences list: every item, hidden ones included. */
  get arranged(): NavSection[] {
    return arrange(this.prefs);
  }

  isHidden(view: View): boolean {
    return this.prefs.hidden.includes(view);
  }

  canHide(view: View): boolean {
    return canHide(this.prefs, view);
  }

  moveSection(id: SectionId, delta: -1 | 1): void {
    this.#prefs.value = moveSection(this.prefs, id, delta);
  }

  moveItem(view: View, delta: -1 | 1): void {
    this.#prefs.value = moveItem(this.prefs, view, delta);
  }

  setHidden(view: View, hidden: boolean): void {
    this.#prefs.value = setHidden(this.prefs, view, hidden);
  }

  reset(): void {
    this.#prefs.reset();
  }
}

export const navigation = new NavigationStore();
