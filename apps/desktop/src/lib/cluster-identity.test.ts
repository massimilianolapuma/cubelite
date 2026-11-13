import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import {
  IDENTITY_COLORS,
  assignIdentityColors,
  identityHue,
  initials,
  isIdentityColor,
} from "#lib/cluster-identity.ts";

describe("assignIdentityColors", () => {
  it("assigns palette colors by first-appearance order", () => {
    const result = assignIdentityColors(["a", "b", "c"]);
    expect(result).toEqual({ a: "blue", b: "magenta", c: "teal" });
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
    expect(result.staging).toBe("magenta");
  });

  it("ignores invalid saved values", () => {
    const result = assignIdentityColors(["a"], { a: "chartreuse" });
    expect(result.a).toBe("blue");
  });

  it("moves the retired warm colours to their cool successors", () => {
    // amber and pink tinted the window like a warning or an error (spec §3 #4).
    const result = assignIdentityColors(["a", "b", "c"], { a: "amber", b: "pink", c: "teal" });
    expect(result).toEqual({ a: "indigo", b: "magenta", c: "teal" });
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
    expect(isIdentityColor("magenta")).toBe(true);
    expect(isIdentityColor("amber")).toBe(false);
    expect(isIdentityColor(3)).toBe(false);
  });
});

describe("identityHue", () => {
  it("points at the hue variable the generator emits", () => {
    expect(identityHue("teal")).toBe("var(--cl-hue-teal)");
  });

  it("has a hue in the design tokens for every palette colour, in the same order", () => {
    const tokens: { identity: { hues: Record<string, number> } } = JSON.parse(
      readFileSync(resolve(__dirname, "../../../../design/tokens.json"), "utf8"),
    );
    expect(Object.keys(tokens.identity.hues)).toEqual([...IDENTITY_COLORS]);
  });
});
