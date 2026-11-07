/**
 * ⌘K palette ranking: bits-ui's fuzzy score, minus the scattered matches.
 *
 * With ~40 types and their keywords, a short query such as "netpol" also
 * fuzzy-matches letters spread across "persistentvolumeclaims" (0.015). Real
 * matches score far higher — a prefix or word ~0.9, an abbreviation like
 * "cfgmap" → ConfigMaps 0.026, "stg" → staging 0.17 — so a floor of 0.02
 * keeps fuzzy search and drops the noise.
 */
import { computeCommandScore } from "bits-ui";

export const MIN_SCORE = 0.02;

export function paletteFilter(value: string, search: string, keywords?: string[]): number {
  const score = computeCommandScore(value, search, keywords);
  return score >= MIN_SCORE ? score : 0;
}
