/**
 * Status chips above a list (Tonal spec §3 #7, §8.1): one chip per state with
 * its count; pressing chips keeps the rows of any pressed one. Pure helpers;
 * the pressed keys live in `stores/lists.svelte.ts` for the session.
 */
import type { GlyphState } from "#lib/components/ui/StatusGlyph.svelte";

/** One chip of a list. Definitions are written worst state first. */
export type ChipDef = { key: string; label: string; state?: GlyphState };

export type ChipView = ChipDef & { count: number; pressed: boolean };

/**
 * The chips to show: a state without rows has no chip, unless it is pressed
 * (it must stay there to be released).
 */
export function chipViews<T>(
  defs: readonly ChipDef[],
  rows: readonly T[],
  keyOf: (row: T) => string,
  pressed: readonly string[],
): ChipView[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = keyOf(row);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return defs
    .map((def) => ({ ...def, count: counts.get(def.key) ?? 0, pressed: pressed.includes(def.key) }))
    .filter((chip) => chip.count > 0 || chip.pressed);
}

/** Rows of the pressed chips; every row when none is pressed. */
export function applyChips<T>(rows: readonly T[], keyOf: (row: T) => string, pressed: readonly string[]): T[] {
  return pressed.length === 0 ? [...rows] : rows.filter((row) => pressed.includes(keyOf(row)));
}

export function toggleChip(pressed: readonly string[], key: string): string[] {
  return pressed.includes(key) ? pressed.filter((k) => k !== key) : [...pressed, key];
}
