import { describe, it, expect } from "vitest";
import {
  IDENTITY_COLORS,
  assignIdentityColors,
  initials,
  isIdentityColor,
} from "$lib/cluster-identity";

describe("assignIdentityColors", () => {
  it("assigns palette colors by first-appearance order", () => {
    const result = assignIdentityColors(["a", "b", "c"]);
    expect(result).toEqual({ a: "blue", b: "amber", c: "pink" });
  });

  it("cycles the palette when there are more contexts than colors", () => {
    const names = ["a", "b", "c", "d", "e", "f", "g"];
    const result = assignIdentityColors(names);
    expect(result.f).toBe(IDENTITY_COLORS[0]);
    expect(result.g).toBe(IDENTITY_COLORS[1]);
  });

  it("keeps saved assignments even when order changes", () => {
    const saved = assignIdentityColors(["a", "b", "c"]);
    const reordered = assignIdentityColors(["c", "a", "b"], saved);
    expect(reordered).toEqual(saved);
  });

  it("keeps saved colors when new contexts appear", () => {
    const saved = { prod: "teal" };
    const result = assignIdentityColors(["staging", "prod"], saved);
    expect(result.prod).toBe("teal");
    expect(result.staging).toBe("amber");
  });

  it("ignores invalid saved values", () => {
    const result = assignIdentityColors(["a"], { a: "magenta" });
    expect(result.a).toBe("blue");
  });
});

describe("initials", () => {
  it("uses first letters of the first two segments", () => {
    expect(initials("prod-eu-1")).toBe("PE");
    expect(initials("kind_local")).toBe("KL");
  });

  it("uses the first two characters of single-segment names", () => {
    expect(initials("minikube")).toBe("MI");
  });

  it("falls back for empty names", () => {
    expect(initials("")).toBe("?");
  });
});

describe("isIdentityColor", () => {
  it("accepts palette keys and rejects others", () => {
    expect(isIdentityColor("blue")).toBe(true);
    expect(isIdentityColor("magenta")).toBe(false);
    expect(isIdentityColor(3)).toBe(false);
  });
});
