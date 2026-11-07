import { describe, it, expect } from "vitest";
import { paletteFilter } from "#lib/palette-filter.ts";
import { searchKeywords } from "#lib/resource-kinds.ts";
import { DEFAULT_SECTIONS } from "#lib/navigation.ts";

const items = DEFAULT_SECTIONS.flatMap((s) => s.items);
const matches = (search: string) =>
  items.filter((i) => paletteFilter(`Go to ${i.label}`, search, searchKeywords(i.view, i.label)) > 0).map((i) => i.view);

describe("paletteFilter", () => {
  it("drops scattered fuzzy matches", () => {
    expect(matches("netpol")).toEqual(["networkpolicies"]);
    expect(matches("hpa")).toEqual(["hpas"]);
  });

  it("keeps real fuzzy matches and abbreviations", () => {
    expect(matches("cfgmap")).toContain("configmaps");
    expect(paletteFilter("staging", "stg")).toBeGreaterThan(0);
    expect(matches("ing").slice(0, 2)).toEqual(["ingresses", "ingressclasses"]);
  });
});
