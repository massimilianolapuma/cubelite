/**
 * Colour of a source in a merged log stream (Tonal §8.5): the containers of a
 * pod, in pod-spec order, take `data-1` … `data-5`. Past five the colours
 * repeat with an underline that changes each round (dashed, dotted, double),
 * as the charts repeat theirs with a dash (§8.4), so no two of the first
 * twenty sources look alike. The name is always written next to it.
 *
 * The class names are written in full: Tailwind only emits a colour whose
 * whole name it can read in the sources.
 */
import type { ContainerDetail } from "#lib/tauri.ts";

const TONES = ["text-data-1", "text-data-2", "text-data-3", "text-data-4", "text-data-5"] as const;
const ROUNDS = [
  "",
  "underline decoration-dashed underline-offset-2",
  "underline decoration-dotted underline-offset-2",
  "underline decoration-double underline-offset-2",
] as const;

/** Position of a container among the sources: regular containers first, then init ones. */
export function sourceIndex(containers: readonly ContainerDetail[], name: string): number {
  const ordered = [...containers.filter((c) => !c.init), ...containers.filter((c) => c.init)];
  return Math.max(0, ordered.findIndex((c) => c.name === name));
}

/** Text colour (and, past five, underline) of the source at `index`. */
export function sourceClass(index: number): string {
  const tone = TONES[index % TONES.length];
  const round = ROUNDS[Math.floor(index / TONES.length) % ROUNDS.length];
  return round ? `${tone} ${round}` : tone;
}
