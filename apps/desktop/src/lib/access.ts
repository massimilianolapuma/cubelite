/**
 * The words of a cluster's access (#662): the unlock durations offered by the
 * cluster menu, the Preferences and the drawers, and the countdown of a
 * timed unlock (spec §5.2).
 */

import type { UnlockFor } from "#lib/tauri.ts";

/** The durations offered, in menu order. */
export const UNLOCK_CHOICES: readonly { value: UnlockFor; label: string }[] = [
  { value: 5, label: "5 minutes" },
  { value: 15, label: "15 minutes" },
  { value: 60, label: "1 hour" },
  { value: "always", label: "Always" },
];

/** "5 minutes", "15 minutes", "1 hour"; "always" for Always. */
export function durationWords(duration: UnlockFor): string {
  return duration === "always" ? "always" : (UNLOCK_CHOICES.find((c) => c.value === duration)?.label ?? `${duration} minutes`);
}

/** What is left of a timed unlock: whole minutes rounded up, the last minute in seconds. */
export function remainingText(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return seconds >= 60 ? `${Math.ceil(seconds / 60)} min` : `${seconds} s`;
}
