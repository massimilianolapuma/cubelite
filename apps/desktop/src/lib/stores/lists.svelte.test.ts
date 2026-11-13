import { beforeEach, describe, expect, it } from "vitest";
import { lists } from "./lists.svelte";

beforeEach(() => lists.resetSession());

describe("status chips of a list", () => {
  it("starts with nothing pressed", () => {
    expect(lists.pressed("pods")).toEqual([]);
  });

  it("toggles one chip of one list", () => {
    lists.toggleStatus("pods", "err");
    lists.toggleStatus("pods", "warn");
    expect(lists.pressed("pods")).toEqual(["err", "warn"]);
    expect(lists.pressed("events")).toEqual([]);
    lists.toggleStatus("pods", "err");
    expect(lists.pressed("pods")).toEqual(["warn"]);
  });

  it("sets and clears the chips of a list at once", () => {
    lists.setStatus("pods", ["err", "warn"]);
    expect(lists.pressed("pods")).toEqual(["err", "warn"]);
    lists.setStatus("pods", []);
    expect(lists.pressed("pods")).toEqual([]);
  });

  it("a list named like an Object.prototype key has nothing pressed", () => {
    expect(lists.pressed("constructor")).toEqual([]);
  });

  it("forgets the chips with the session", () => {
    lists.setStatus("pods", ["err"]);
    lists.resetSession();
    expect(lists.pressed("pods")).toEqual([]);
  });
});
