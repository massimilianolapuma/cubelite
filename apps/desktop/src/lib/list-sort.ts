import type { StatusTone } from "#lib/status.ts";

/** Sort fields of the resource lists (#496, spec §4.1). `api` keeps API order. */
export type SortField = "api" | "name" | "namespace" | "age" | "status" | "restarts";
export type SortDir = "asc" | "desc";
export type SortSpec = { field: SortField; dir: SortDir };

export const SORT_FIELDS: { value: SortField; label: string }[] = [
  { value: "api", label: "API order" },
  { value: "name", label: "Name" },
  { value: "namespace", label: "Namespace" },
  { value: "age", label: "Age" },
  { value: "status", label: "Status" },
  { value: "restarts", label: "Restarts" },
];

export const DEFAULT_SORT: SortSpec = { field: "api", dir: "asc" };

export function isSortSpec(v: unknown): v is SortSpec {
  if (typeof v !== "object" || v === null) return false;
  const { field, dir } = v as Record<string, unknown>;
  return SORT_FIELDS.some((f) => f.value === field) && (dir === "asc" || dir === "desc");
}

/**
 * Direction a header click starts with: ascending is the natural reading
 * order (A→Z, newest first, problems first) except restarts (most first).
 */
export function firstDir(field: SortField): SortDir {
  return field === "restarts" ? "desc" : "asc";
}

/** How a list exposes each field; missing accessors mean the list lacks the field. */
export type SortAccessors<T> = {
  name: (row: T) => string;
  namespace?: (row: T) => string;
  /** ISO creation timestamp. */
  created?: (row: T) => string | null;
  status?: (row: T) => StatusTone;
  restarts?: (row: T) => number;
};

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Natural, case-insensitive text order used by every list sort ("pod-2" < "pod-10"). */
export function compareText(a: string, b: string): number {
  return collator.compare(a, b);
}

/** Problems first: err, warn, neutral (pending/unknown), ok. */
export const TONE_RANK: Record<StatusTone, number> = { err: 0, warn: 1, neutral: 2, ok: 3 };

function time(iso: string | null | undefined): number {
  const t = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
}

/** Whether `field` applies to a list with these accessors (`api` and `name` always do). */
export function supports<T>(acc: SortAccessors<T>, field: SortField): boolean {
  switch (field) {
    case "api":
    case "name":
      return true;
    case "namespace":
      return acc.namespace !== undefined;
    case "age":
      return acc.created !== undefined;
    case "status":
      return acc.status !== undefined;
    case "restarts":
      return acc.restarts !== undefined;
  }
}

/**
 * Sorts `rows` by `spec` (stable: ties keep API order). A field the list
 * lacks falls back to Name; `api` returns the rows as given.
 */
export function sortRows<T>(rows: readonly T[], spec: SortSpec, acc: SortAccessors<T>): T[] {
  if (spec.field === "api") return [...rows];
  const field = supports(acc, spec.field) ? spec.field : "name";
  const byName = (a: T, b: T) => collator.compare(acc.name(a), acc.name(b));
  let cmp: (a: T, b: T) => number;
  switch (field) {
    case "namespace": {
      const ns = acc.namespace!;
      cmp = (a, b) => collator.compare(ns(a), ns(b)) || byName(a, b);
      break;
    }
    case "age": {
      // Ascending age = youngest first = latest creation first.
      const created = acc.created!;
      cmp = (a, b) => time(created(b)) - time(created(a)) || 0;
      break;
    }
    case "status": {
      const status = acc.status!;
      cmp = (a, b) => TONE_RANK[status(a)] - TONE_RANK[status(b)] || byName(a, b);
      break;
    }
    case "restarts": {
      const restarts = acc.restarts!;
      cmp = (a, b) => restarts(a) - restarts(b) || byName(a, b);
      break;
    }
    default:
      cmp = byName;
  }
  const sign = spec.dir === "asc" ? 1 : -1;
  return rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => sign * cmp(a.row, b.row) || a.i - b.i)
    .map((x) => x.row);
}
