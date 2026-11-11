/**
 * Grouping of the resource lists by namespace (#547, spec §4): one group per
 * namespace with its row count and problem marker, plus the collapse rules.
 * Pure helpers; the preference and the session collapse state live in
 * `stores/lists.svelte.ts`.
 */
import { compareText, sortRows, TONE_RANK, type SortAccessors, type SortSpec } from "#lib/list-sort.ts";
import type { StatusTone } from "#lib/status.ts";

/** Accessors of a list that has a Namespace column. */
export type GroupAccessors<T> = SortAccessors<T> & { namespace: (row: T) => string };

export type NamespaceGroup<T> = {
  namespace: string;
  /** Rows in the current sort. */
  rows: T[];
  count: number;
  /** Worst status among the rows; null when the list has no status. */
  worst: StatusTone | null;
  /** Rows whose status is not `ok`; 0 when the list has no status. */
  problems: number;
};

/** Namespace → collapsed. Only `true` entries count (a namespace may be named "constructor"). */
export type CollapseState = Readonly<Record<string, boolean>>;

/**
 * Splits `rows` into one group per namespace. Groups are ordered A→Z, or
 * Z→A when the sort is Namespace descending. Rows keep the current sort
 * inside each group; a Namespace sort sorts them by name instead, and API
 * order keeps API order. Namespaces without rows have no group.
 */
export function groupByNamespace<T>(
  rows: readonly T[],
  spec: SortSpec,
  acc: GroupAccessors<T>,
): NamespaceGroup<T>[] {
  const inner: SortSpec = spec.field === "namespace" ? { field: "name", dir: "asc" } : spec;
  const byNamespace = new Map<string, T[]>();
  for (const row of sortRows(rows, inner, acc)) {
    const ns = acc.namespace(row);
    const bucket = byNamespace.get(ns);
    if (bucket) bucket.push(row);
    else byNamespace.set(ns, [row]);
  }
  const sign = spec.field === "namespace" && spec.dir === "desc" ? -1 : 1;
  return [...byNamespace.keys()]
    .sort((a, b) => sign * compareText(a, b))
    .map((namespace) => summarize(namespace, byNamespace.get(namespace) ?? [], acc.status));
}

function summarize<T>(
  namespace: string,
  rows: T[],
  status: ((row: T) => StatusTone) | undefined,
): NamespaceGroup<T> {
  let worst: StatusTone | null = null;
  let problems = 0;
  if (status) {
    worst = "ok";
    for (const row of rows) {
      const tone = status(row);
      if (tone !== "ok") problems++;
      if (TONE_RANK[tone] < TONE_RANK[worst]) worst = tone;
    }
  }
  return { namespace, rows, count: rows.length, worst, problems };
}

export function isCollapsed(state: CollapseState, namespace: string): boolean {
  return Object.hasOwn(state, namespace) && state[namespace] === true;
}

/**
 * Header click: flips `namespace`. With `all` (Option/Alt-click) every
 * namespace in `all` takes the clicked group's new state.
 */
export function toggleCollapse(
  state: CollapseState,
  namespace: string,
  all: readonly string[] | null = null,
): Record<string, boolean> {
  const collapse = !isCollapsed(state, namespace);
  const next: Record<string, boolean> = { ...state };
  for (const ns of all ?? [namespace]) {
    if (collapse) next[ns] = true;
    else delete next[ns];
  }
  return next;
}

/**
 * Collapse state a filter shows: while the filter is not empty every group
 * starts expanded (a match must never sit in a collapsed group) and header
 * clicks only change `transient`, which belongs to that exact filter text
 * (GroupedRows starts it over on every filter change); an empty filter shows
 * the stored session state.
 */
export function shownCollapse(
  filter: string,
  stored: CollapseState,
  transient: { filter: string; state: CollapseState },
): CollapseState {
  if (!filter) return stored;
  return transient.filter === filter ? transient.state : {};
}

/** Accessible name of a header: "team-a, 12 pods, 2 with problems, expanded". */
export function groupLabel<T>(
  group: NamespaceGroup<T>,
  nouns: readonly [singular: string, plural: string],
  expanded: boolean,
): string {
  const parts = [group.namespace, `${group.count} ${group.count === 1 ? nouns[0] : nouns[1]}`];
  if (group.problems > 0) parts.push(`${group.problems} with problems`);
  parts.push(expanded ? "expanded" : "collapsed");
  return parts.join(", ");
}

/**
 * Grid tracks of a list whose second column is Namespace: the column is
 * dropped while grouped (the group header already names it).
 */
export function shownColumns(columns: readonly string[], grouped: boolean): string[] {
  return grouped ? columns.filter((_, i) => i !== 1) : [...columns];
}
