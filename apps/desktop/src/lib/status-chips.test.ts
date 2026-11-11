import { describe, expect, it } from "vitest";
import { applyChips, chipViews, toggleChip, type ChipDef } from "./status-chips";

const defs: ChipDef[] = [
  { key: "err", label: "Failing", state: "err" },
  { key: "warn", label: "Pending", state: "warn" },
  { key: "ok", label: "Running", state: "ok" },
  { key: "done", label: "Completed", state: "done" },
];
const rows = ["ok", "ok", "err", "ok"];
const keyOf = (r: string) => r;

describe("chipViews", () => {
  it("counts rows per chip, in the order of the definitions (worst first)", () => {
    expect(chipViews(defs, rows, keyOf, [])).toEqual([
      { key: "err", label: "Failing", state: "err", count: 1, pressed: false },
      { key: "ok", label: "Running", state: "ok", count: 3, pressed: false },
    ]);
  });

  it("hides a chip with no rows", () => {
    expect(chipViews(defs, rows, keyOf, []).map((c) => c.key)).not.toContain("warn");
  });

  it("keeps a pressed chip visible at zero, so it can be released", () => {
    const warn = chipViews(defs, rows, keyOf, ["warn"]).find((c) => c.key === "warn");
    expect(warn).toMatchObject({ count: 0, pressed: true });
  });

  it("shows no chips for an empty list with nothing pressed", () => {
    expect(chipViews(defs, [], keyOf, [])).toEqual([]);
  });
});

describe("applyChips", () => {
  it("keeps every row when no chip is pressed", () => {
    expect(applyChips(rows, keyOf, [])).toEqual(rows);
  });

  it("keeps the rows of any pressed chip", () => {
    expect(applyChips(["ok", "err", "warn", "done"], keyOf, ["err", "warn"])).toEqual(["err", "warn"]);
  });
});

describe("toggleChip", () => {
  it("presses and releases one key, leaving the others", () => {
    expect(toggleChip([], "err")).toEqual(["err"]);
    expect(toggleChip(["err", "warn"], "err")).toEqual(["warn"]);
  });
});
