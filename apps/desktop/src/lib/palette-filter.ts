/**
 * ⌘K palette ranking on top of bits-ui's fuzzy score.
 *
 * - An exact keyword (a short name such as `ing` or `po`) scores 1, so its
 *   own type ranks strictly first instead of tying with every word that
 *   starts the same way (ties fall back to the previous query's DOM order).
 * - Resource rows drop scattered matches: with ~40 types and their keywords,
 *   "netpol" also fuzzy-matches letters spread across
 *   "persistentvolumeclaims" (0.015), while real matches score far higher
 *   (a prefix or word ~0.9, "cfgmap" → ConfigMaps 0.026). Cluster contexts
 *   and actions keep plain fuzzy matching: context names are long and
 *   user-chosen ("prdclstr" → …production-cluster scores 0.004).
 */
import { computeCommandScore } from "bits-ui";

export const MIN_SCORE = 0.02;
/** Prefix of every resource row's value (keeps it apart from cluster names). */
export const RESOURCE_PREFIX = "Go to ";

export function paletteFilter(value: string, search: string, keywords?: string[]): number {
  const needle = search.trim().toLowerCase();
  if (needle && keywords?.includes(needle)) return 1;
  const score = computeCommandScore(value, search, keywords);
  if (!value.startsWith(RESOURCE_PREFIX)) return score;
  return score >= MIN_SCORE ? score : 0;
}
