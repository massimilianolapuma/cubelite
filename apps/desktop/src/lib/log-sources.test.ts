import { describe, it, expect } from "vitest";
import { sourceClass, sourceIndex } from "./log-sources";
import type { ContainerDetail } from "#lib/tauri.ts";

const cs = [
  { name: "init-migrate", init: true },
  { name: "worker", init: false },
  { name: "envoy", init: false },
  { name: "a", init: false },
  { name: "b", init: false },
  { name: "c", init: false },
] as ContainerDetail[];

describe("sourceIndex", () => {
  it("numbers regular containers in pod-spec order, then init containers", () => {
    expect(["worker", "envoy", "a", "b", "c", "init-migrate"].map((n) => sourceIndex(cs, n))).toEqual([
      0, 1, 2, 3, 4, 5,
    ]);
  });

  it("an unknown container takes the first source", () => {
    expect(sourceIndex(cs, "ghost")).toBe(0);
  });
});

describe("sourceClass", () => {
  it("names the five data colours in full, so Tailwind emits them", () => {
    expect([0, 1, 2, 3, 4].map(sourceClass)).toEqual([
      "text-data-1",
      "text-data-2",
      "text-data-3",
      "text-data-4",
      "text-data-5",
    ]);
  });

  it("past five the colours repeat with a different underline each round", () => {
    const sixth = sourceClass(5);
    expect(sixth).toContain("text-data-1");
    expect(sixth).toContain("decoration-dashed");
    expect(sourceClass(10)).toContain("decoration-dotted");
    expect(sourceClass(15)).toContain("decoration-double");
    // No two of the first twenty sources look the same.
    expect(new Set(Array.from({ length: 20 }, (_, i) => sourceClass(i))).size).toBe(20);
  });
});
