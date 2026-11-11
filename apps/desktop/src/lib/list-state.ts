/**
 * What a resource list shows instead of rows (Tonal spec §8.2, bug #606):
 * loading, empty, filtered to nothing, error, forbidden, not served. One
 * decision for every list, so a load in flight never reads as "nothing here"
 * and a failed load never reads as an empty list.
 */
import { isForbiddenError } from "#lib/overview-summary.ts";

export type ListState =
  | { kind: "ready" }
  | { kind: "loading" }
  | { kind: "unavailable" }
  | { kind: "forbidden"; title: string }
  | { kind: "error"; title: string; message: string }
  | { kind: "empty"; title: string; hint: string }
  | { kind: "filtered"; title: string };

export type ListInput = {
  /** Row noun, e.g. ['pod', 'pods']. */
  nouns: readonly [singular: string, plural: string];
  /** Selected namespace; null = all namespaces. */
  namespace: string | null;
  /** false for cluster-scoped kinds: the namespace does not apply. */
  namespaced?: boolean;
  /** A load for the current cluster and namespace has finished. */
  loaded: boolean;
  /** Message of the last failed load, if the last load failed. */
  error: string | null;
  /** The cluster does not serve this kind. */
  unavailable?: boolean;
  /** Rows before the list's own filters. */
  total: number;
  /** Rows after them. */
  shown: number;
  /** The list's filter text. */
  filter?: string;
  /** A status chip is pressed. */
  chips?: boolean;
};

function scope(input: ListInput): string {
  if (input.namespaced === false) return "in this cluster";
  return input.namespace === null ? "in any namespace" : `in ${input.namespace}`;
}

export function listState(input: ListInput): ListState {
  const plural = input.nouns[1];
  if (input.unavailable) return { kind: "unavailable" };
  if (input.error !== null) {
    return isForbiddenError(input.error)
      ? { kind: "forbidden", title: `You are not allowed to list ${plural} ${scope(input)}.` }
      : { kind: "error", title: `Could not load ${plural}`, message: input.error };
  }
  if (!input.loaded) return { kind: "loading" };
  if (input.total === 0) {
    const elsewhere = input.namespaced !== false && input.namespace !== null;
    return {
      kind: "empty",
      title: `No ${plural} ${scope(input)}`,
      hint: elsewhere
        ? "Other namespaces may have some: change the namespace in the top bar."
        : "They show up here as soon as one exists.",
    };
  }
  if (input.shown === 0) {
    const text = input.filter?.trim() ?? "";
    const match = text ? ` match "${text}"` : "";
    const status = input.chips ? " with the selected status" : "";
    return { kind: "filtered", title: `No ${plural}${match}${status}` };
  }
  return { kind: "ready" };
}
