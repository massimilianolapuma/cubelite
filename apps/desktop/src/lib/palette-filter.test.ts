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

describe("paletteFilter ranking and scope", () => {
  const ranked = (search: string) =>
    items
      .map((i) => ({ view: i.view, score: paletteFilter(`Go to ${i.label}`, search, searchKeywords(i.view, i.label)) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((r) => r.view);

  it("an exact short name ranks its own type strictly first", () => {
    for (const [search, view] of [["ing", "ingresses"], ["po", "pods"], ["cr", "clusterroles"], ["rb", "rolebindings"], ["sa", "serviceaccounts"]]) {
      const [first, second] = ranked(search);
      expect(first, search).toBe(view);
      const score = (v: string) => {
        const i = items.find((x) => x.view === v)!;
        return paletteFilter(`Go to ${i.label}`, search, searchKeywords(i.view, i.label));
      };
      if (second) expect(score(first), search).toBeGreaterThan(score(second));
    }
    // An action with no keywords ("Open pod logs") does not tie with Pods.
    expect(paletteFilter("Open pod logs", "po")).toBeLessThan(paletteFilter("Go to Pods", "po", searchKeywords("pods", "Pods")));
  });

  it("the floor applies to resource rows only: long context names keep fuzzy matches", () => {
    expect(paletteFilter("gke_my-project_europe-west1_production-cluster", "prdclstr")).toBeGreaterThan(0);
  });
});
