import { describe, it, expect } from "vitest";
import { cellText, gridTemplate, planColumns } from "#lib/table-columns.ts";
import { formatAge } from "#lib/age.ts";

const col = (name: string, column_type = "string", format = "") => ({ name, column_type, format, description: "" });

describe("planColumns", () => {
  it("maps kubectl's DaemonSet columns", () => {
    const plan = planColumns([col("Name", "string", "name"), col("Desired", "integer"), col("Node Selector"), col("Age", "date")], true);
    expect(plan).toEqual([
      { kind: "name" },
      { kind: "namespace" },
      { kind: "cell", index: 1, label: "Desired", date: false },
      { kind: "cell", index: 2, label: "Node Selector", date: false },
      { kind: "age", label: "Age" },
    ]);
  });

  it("leaves out Namespace when asked", () => {
    expect(planColumns([col("Name", "string", "name"), col("Age", "date")], false)).toEqual([{ kind: "name" }, { kind: "age", label: "Age" }]);
  });

  it("treats RBAC's Created At as the Age column, keeping its label", () => {
    expect(planColumns([col("Name", "string", "name"), col("Created At", "date")], false)).toEqual([
      { kind: "name" },
      { kind: "age", label: "Created At" },
    ]);
  });

  it("adds no Age column when the server has none", () => {
    expect(planColumns([col("Name", "string", "name"), col("Ready")], false)).toEqual([
      { kind: "name" },
      { kind: "cell", index: 1, label: "Ready", date: false },
    ]);
  });

  it("takes a column named Name when none has the name format", () => {
    expect(planColumns([col("Name"), col("Status")], false)).toEqual([
      { kind: "name" },
      { kind: "cell", index: 1, label: "Status", date: false },
    ]);
  });

  it("puts name first when the server has no name column", () => {
    expect(planColumns([col("Status")], true)).toEqual([
      { kind: "name" },
      { kind: "namespace" },
      { kind: "cell", index: 0, label: "Status", date: false },
    ]);
  });

  it("marks other date columns", () => {
    expect(planColumns([col("Name", "string", "name"), col("Last Schedule", "date")], false)[1]).toEqual({
      kind: "cell",
      index: 1,
      label: "Last Schedule",
      date: true,
    });
  });
});

describe("cellText", () => {
  it("cellText renders every JSON type", () => {
    const now = new Date("2026-11-07T12:00:00Z");
    expect(cellText(null, false)).toBe("");
    expect(cellText(undefined, false)).toBe("");
    expect(cellText("<none>", false)).toBe("<none>");
    expect(cellText(3, false)).toBe("3");
    expect(cellText(true, false)).toBe("true");
    expect(cellText(["a", 1], false)).toBe("a, 1");
    expect(cellText({ a: 1 }, false)).toBe('{"a":1}');
    expect(cellText("2026-11-07T10:00:00Z", true, now)).toBe(formatAge("2026-11-07T10:00:00Z", now));
  });
});

describe("gridTemplate", () => {
  it("gives the name the room and Age a narrow column", () => {
    expect(gridTemplate([{ kind: "name" }, { kind: "namespace" }, { kind: "cell", index: 1, label: "X", date: false }, { kind: "age", label: "Age" }])).toBe(
      "grid-template-columns: minmax(0,3fr) minmax(0,1fr) minmax(0,1fr) 0.55fr;",
    );
  });
});
