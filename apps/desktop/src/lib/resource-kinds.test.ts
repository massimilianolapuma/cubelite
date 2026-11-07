import { describe, it, expect } from "vitest";
import { GENERIC_KINDS, GENERIC_VIEWS, isGenericView, searchKeywords } from "#lib/resource-kinds.ts";
import { DEFAULT_SECTIONS } from "#lib/navigation.ts";

describe("resource kind registry", () => {
  it("lists the 18 types of spec §4", () => {
    expect(GENERIC_VIEWS).toHaveLength(18);
    expect(Object.keys(GENERIC_KINDS).sort()).toEqual([...GENERIC_VIEWS].sort());
  });

  it("uses the preferred versions and scopes of spec §5.4", () => {
    expect(GENERIC_KINDS.hpas).toMatchObject({ group: "autoscaling", version: "v2", label: "Autoscalers" });
    expect(GENERIC_KINDS.pdbs).toMatchObject({ group: "policy", version: "v1", label: "Disruption Budgets" });
    expect(GENERIC_KINDS.clusterroles.namespaced).toBe(false);
    expect(GENERIC_KINDS.roles.namespaced).toBe(true);
  });

  it("names rows in readable English", () => {
    expect(GENERIC_KINDS.networkpolicies.nouns).toEqual(["network policy", "network policies"]);
    expect(GENERIC_KINDS.ingressclasses.nouns).toEqual(["ingress class", "ingress classes"]);
    expect(GENERIC_KINDS.namespaces.nouns).toEqual(["namespace", "namespaces"]);
  });

  it("does not collide with the hand-written views", () => {
    for (const v of ["pods", "deployments", "pvcs", "nodes", "overview"]) expect(isGenericView(v)).toBe(false);
    expect(isGenericView("daemonsets")).toBe(true);
    expect(isGenericView(42)).toBe(false);
  });
});

describe("searchKeywords", () => {
  const items = DEFAULT_SECTIONS.flatMap((s) => s.items);

  it("every navigation view has keywords that include its label", () => {
    for (const { view, label } of items) {
      const words = searchKeywords(view, label);
      expect(words, view).toContain(label.toLowerCase());
      expect(new Set(words).size, view).toBe(words.length);
      expect(words.every((w) => w === w.toLowerCase()), view).toBe(true);
    }
  });

  it("finds the short names of spec §6", () => {
    const owner = (word: string) => items.filter((i) => searchKeywords(i.view, i.label).includes(word)).map((i) => i.view);
    expect(owner("deploy")).toEqual(["deployments"]);
    expect(owner("svc")).toEqual(["services"]);
    expect(owner("pvc")).toEqual(["pvcs"]);
    expect(owner("hpa")).toEqual(["hpas"]);
    expect(owner("netpol")).toEqual(["networkpolicies"]);
    expect(owner("sa")).toEqual(["serviceaccounts"]);
    expect(owner("crb")).toEqual(["clusterrolebindings"]);
    expect(owner("ns")).toEqual(["namespaces"]);
    expect(owner("horizontalpodautoscaler")).toEqual(["hpas"]);
  });
});
