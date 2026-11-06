import { describe, it, expect } from "vitest";
import {
  gridColumns,
  groupByNamespace,
  groupLabel,
  isCollapsed,
  shownCollapse,
  toggleCollapse,
  type GroupAccessors,
} from "#lib/list-group.ts";
import type { StatusTone } from "#lib/status.ts";

type Row = { name: string; ns: string; tone: StatusTone; restarts: number };
const r = (name: string, ns: string, tone: StatusTone = "ok", restarts = 0): Row => ({ name, ns, tone, restarts });
const rows: Row[] = [
  r("web-2", "team-b"),
  r("api-10", "team-a", "warn", 4),
  r("kube-dns", "kube-system"),
  r("api-2", "team-a", "err", 1),
  r("worker", "team-a"),
];
const withStatus: GroupAccessors<Row> = {
  name: (x) => x.name,
  namespace: (x) => x.ns,
  status: (x) => x.tone,
  restarts: (x) => x.restarts,
};
const noStatus: GroupAccessors<Row> = { name: (x) => x.name, namespace: (x) => x.ns };
const shape = (groups: ReturnType<typeof groupByNamespace<Row>>) =>
  groups.map((g) => [g.namespace, g.rows.map((x) => x.name)]);

describe("groupByNamespace (#547)", () => {
  it("orders groups A→Z and keeps API order inside each group", () => {
    expect(shape(groupByNamespace(rows, { field: "api", dir: "asc" }, withStatus))).toEqual([
      ["kube-system", ["kube-dns"]],
      ["team-a", ["api-10", "api-2", "worker"]],
      ["team-b", ["web-2"]],
    ]);
  });

  it("rows inside a group follow the current sort", () => {
    const byRestarts = groupByNamespace(rows, { field: "restarts", dir: "desc" }, withStatus);
    expect(byRestarts[1].rows.map((x) => x.name)).toEqual(["api-10", "api-2", "worker"]);
    const byName = groupByNamespace(rows, { field: "name", dir: "desc" }, withStatus);
    expect(shape(byName).map(([ns]) => ns)).toEqual(["kube-system", "team-a", "team-b"]);
    expect(byName[1].rows.map((x) => x.name)).toEqual(["worker", "api-10", "api-2"]);
  });

  it("a Namespace sort orders the groups and sorts rows by name", () => {
    expect(shape(groupByNamespace(rows, { field: "namespace", dir: "asc" }, withStatus))).toEqual([
      ["kube-system", ["kube-dns"]],
      ["team-a", ["api-2", "api-10", "worker"]],
      ["team-b", ["web-2"]],
    ]);
    expect(shape(groupByNamespace(rows, { field: "namespace", dir: "desc" }, withStatus))).toEqual([
      ["team-b", ["web-2"]],
      ["team-a", ["api-2", "api-10", "worker"]],
      ["kube-system", ["kube-dns"]],
    ]);
  });

  it("counts rows and marks the worst tone and the rows not ok", () => {
    const [system, teamA] = groupByNamespace(rows, { field: "api", dir: "asc" }, withStatus);
    expect(system).toMatchObject({ count: 1, worst: "ok", problems: 0 });
    expect(teamA).toMatchObject({ count: 3, worst: "err", problems: 2 });
    const neutral = groupByNamespace([r("a", "x", "neutral"), r("b", "x", "ok")], { field: "api", dir: "asc" }, withStatus);
    expect(neutral[0]).toMatchObject({ worst: "neutral", problems: 1 });
  });

  it("lists without a status have no problem marker", () => {
    for (const g of groupByNamespace(rows, { field: "api", dir: "asc" }, noStatus)) {
      expect(g.worst).toBeNull();
      expect(g.problems).toBe(0);
    }
  });

  it("has no group for namespaces without rows", () => {
    expect(groupByNamespace([], { field: "name", dir: "asc" }, withStatus)).toEqual([]);
  });

  it("handles namespace names that are Object.prototype keys", () => {
    const groups = groupByNamespace([r("a", "constructor"), r("b", "toString")], { field: "api", dir: "asc" }, noStatus);
    expect(shape(groups)).toEqual([
      ["constructor", ["a"]],
      ["toString", ["b"]],
    ]);
    expect(isCollapsed({}, "constructor")).toBe(false);
  });
});

describe("collapse state (#547)", () => {
  it("a click flips one group", () => {
    const once = toggleCollapse({}, "team-a");
    expect(isCollapsed(once, "team-a")).toBe(true);
    expect(isCollapsed(once, "team-b")).toBe(false);
    expect(toggleCollapse(once, "team-a")).toEqual({});
  });

  it("Option-click gives every group the clicked group's new state", () => {
    const all = ["kube-system", "team-a", "team-b"];
    const collapsedAll = toggleCollapse({ "team-b": true }, "team-a", all);
    expect(all.every((ns) => isCollapsed(collapsedAll, ns))).toBe(true);
    const expandedAll = toggleCollapse(collapsedAll, "kube-system", all);
    expect(all.some((ns) => isCollapsed(expandedAll, ns))).toBe(false);
  });

  it("does not change the state it is given", () => {
    const state = { "team-a": true };
    toggleCollapse(state, "team-a");
    expect(state).toEqual({ "team-a": true });
  });

  it("a filter shows every group expanded, its own clicks stay with that filter", () => {
    const stored = { "team-a": true };
    const none = { filter: "", state: {} };
    expect(shownCollapse("", stored, none)).toBe(stored);
    expect(shownCollapse("api", stored, none)).toEqual({});
    const transient = { filter: "api", state: { "team-b": true } };
    expect(shownCollapse("api", stored, transient)).toEqual({ "team-b": true });
    expect(shownCollapse("ap", stored, transient)).toEqual({});
    expect(shownCollapse("", stored, transient)).toBe(stored);
  });
});

describe("groupLabel / gridColumns (#547)", () => {
  const [, teamA, teamB] = groupByNamespace(rows, { field: "api", dir: "asc" }, withStatus);

  it("names the group, its rows, its problems and its state", () => {
    expect(groupLabel(teamA, ["pod", "pods"], true)).toBe("team-a, 3 pods, 2 with problems, expanded");
    expect(groupLabel(teamB, ["pod", "pods"], false)).toBe("team-b, 1 pod, collapsed");
  });

  it("drops the Namespace column while grouped", () => {
    expect(gridColumns(["2fr", "1fr", "0.5fr"], false)).toBe("grid-template-columns: 2fr 1fr 0.5fr;");
    expect(gridColumns(["2fr", "1fr", "0.5fr"], true)).toBe("grid-template-columns: 2fr 0.5fr;");
  });
});
