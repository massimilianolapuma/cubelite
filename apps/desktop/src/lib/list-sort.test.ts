import { describe, it, expect } from "vitest";
import { firstDir, isSortSpec, sortRows, supports, type SortAccessors } from "#lib/list-sort.ts";
import type { StatusTone } from "#lib/status.ts";

type Row = { name: string; ns: string; created: string | null; tone: StatusTone; restarts: number };
const r = (name: string, ns: string, created: string | null, tone: StatusTone, restarts = 0): Row => ({
  name,
  ns,
  created,
  tone,
  restarts,
});
const rows: Row[] = [
  r("pod-10", "b", "2026-11-01T00:00:00Z", "ok", 1),
  r("pod-2", "a", "2026-11-03T00:00:00Z", "err", 5),
  r("Pod-1", "b", null, "warn", 0),
  r("pod-3", "a", "2026-11-02T00:00:00Z", "ok", 5),
];
const full: SortAccessors<Row> = {
  name: (x) => x.name,
  namespace: (x) => x.ns,
  created: (x) => x.created,
  status: (x) => x.tone,
  restarts: (x) => x.restarts,
};
const names = (xs: Row[]) => xs.map((x) => x.name);

describe("sortRows", () => {
  it("keeps API order for api", () => {
    expect(names(sortRows(rows, { field: "api", dir: "desc" }, full))).toEqual(names(rows));
  });
  it("sorts names naturally and case-insensitively, both directions", () => {
    expect(names(sortRows(rows, { field: "name", dir: "asc" }, full))).toEqual(["Pod-1", "pod-2", "pod-3", "pod-10"]);
    expect(names(sortRows(rows, { field: "name", dir: "desc" }, full))).toEqual(["pod-10", "pod-3", "pod-2", "Pod-1"]);
  });
  it("sorts by namespace then name", () => {
    expect(names(sortRows(rows, { field: "namespace", dir: "asc" }, full))).toEqual(["pod-2", "pod-3", "Pod-1", "pod-10"]);
  });
  it("sorts age newest first ascending, missing timestamps last", () => {
    expect(names(sortRows(rows, { field: "age", dir: "asc" }, full))).toEqual(["pod-2", "pod-3", "pod-10", "Pod-1"]);
  });
  it("puts problems first for status, then name", () => {
    expect(names(sortRows(rows, { field: "status", dir: "asc" }, full))).toEqual(["pod-2", "Pod-1", "pod-3", "pod-10"]);
  });
  it("sorts restarts with name as tie-break", () => {
    expect(names(sortRows(rows, { field: "restarts", dir: "desc" }, full))).toEqual(["pod-3", "pod-2", "pod-10", "Pod-1"]);
  });
  it("falls back to name when the list lacks the field", () => {
    const nameOnly: SortAccessors<Row> = { name: (x) => x.name };
    expect(supports(nameOnly, "restarts")).toBe(false);
    expect(names(sortRows(rows, { field: "restarts", dir: "asc" }, nameOnly))).toEqual(["Pod-1", "pod-2", "pod-3", "pod-10"]);
  });
  it("is stable: equal keys keep API order", () => {
    const same = [r("x", "a", null, "ok"), r("x", "a", null, "ok")];
    const out = sortRows(same, { field: "name", dir: "desc" }, full);
    expect(out[0]).toBe(same[0]);
    expect(out[1]).toBe(same[1]);
  });
  it("does not mutate the input", () => {
    const copy = [...rows];
    sortRows(rows, { field: "name", dir: "asc" }, full);
    expect(rows).toEqual(copy);
  });
});

describe("helpers", () => {
  it("validates stored specs", () => {
    expect(isSortSpec({ field: "age", dir: "desc" })).toBe(true);
    expect(isSortSpec({ field: "size", dir: "asc" })).toBe(false);
    expect(isSortSpec({ field: "age" })).toBe(false);
    expect(isSortSpec(null)).toBe(false);
  });
  it("starts restarts descending, everything else ascending", () => {
    expect(firstDir("restarts")).toBe("desc");
    expect(firstDir("age")).toBe("asc");
  });
});
