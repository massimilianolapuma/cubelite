import { describe, it, expect } from "vitest";
import {
  DEFAULT_NAV,
  canHide,
  moveItem,
  moveSection,
  normalize,
  setHidden,
  visibleSections,
} from "#lib/navigation.ts";

const ids = (prefs = DEFAULT_NAV) => visibleSections(prefs).map((s) => [s.id, s.items.map((i) => i.view)]);

describe("normalize", () => {
  it("returns the defaults for missing or broken storage", () => {
    expect(normalize(undefined)).toEqual(DEFAULT_NAV);
    expect(normalize({ sections: 3, order: "x", hidden: null })).toEqual(DEFAULT_NAV);
  });
  it("drops unknown ids and inserts new ones after their default predecessor", () => {
    const prefs = normalize({
      sections: ["observe", "gone", "workloads"],
      order: ["deployments", "pods", "nope", "logs", "events"],
      hidden: ["nope", "helm"],
    });
    expect(prefs.sections).toEqual(["cluster", "observe", "workloads", "network", "config"]);
    const workloads = visibleSections(prefs).find((s) => s.id === "workloads")!;
    expect(workloads.items.map((i) => i.view)).toEqual(["deployments", "statefulsets", "jobs", "cronjobs", "pods"]);
    expect(prefs.hidden).toEqual(["helm"]);
    expect(visibleSections(prefs).find((s) => s.id === "observe")!.items.map((i) => i.view)).toEqual(["logs", "events"]);
  });
  it("keeps Cluster first and Overview first and visible", () => {
    const prefs = normalize({ sections: ["observe", "cluster"], order: ["nodes", "overview"], hidden: ["overview"] });
    expect(prefs.sections[0]).toBe("cluster");
    expect(ids(prefs)[0]).toEqual(["cluster", ["overview", "nodes"]]);
    expect(prefs.hidden).not.toContain("overview");
  });
  it("never hides every type besides Overview", () => {
    const all = DEFAULT_NAV.order.filter((v) => v !== "overview");
    const prefs = normalize({ hidden: all });
    expect(prefs.hidden).toHaveLength(all.length - 1);
  });
});

describe("moves and visibility", () => {
  it("moves items within their section only", () => {
    let prefs = moveItem(DEFAULT_NAV, "deployments", -1);
    expect(ids(prefs)[1]).toEqual(["workloads", ["deployments", "pods", "statefulsets", "jobs", "cronjobs", "helm"]]);
    prefs = moveItem(prefs, "deployments", -1); // already first
    expect(prefs).toBe(prefs);
    expect(moveItem(DEFAULT_NAV, "nodes", -1)).toBe(DEFAULT_NAV); // cannot pass Overview
    expect(moveItem(DEFAULT_NAV, "overview", 1)).toBe(DEFAULT_NAV);
  });
  it("moves sections but never above or the Cluster section itself", () => {
    expect(moveSection(DEFAULT_NAV, "observe", -1).sections).toEqual(["cluster", "workloads", "network", "observe", "config"]);
    expect(moveSection(DEFAULT_NAV, "workloads", -1)).toBe(DEFAULT_NAV);
    expect(moveSection(DEFAULT_NAV, "cluster", 1)).toBe(DEFAULT_NAV);
    expect(moveSection(DEFAULT_NAV, "observe", 1)).toBe(DEFAULT_NAV);
  });
  it("hides items, drops empty sections and refuses Overview", () => {
    let prefs = setHidden(DEFAULT_NAV, "services", true);
    prefs = setHidden(prefs, "ingresses", true);
    expect(ids(prefs).map(([id]) => id)).not.toContain("network");
    expect(setHidden(prefs, "overview", true)).toBe(prefs);
    expect(canHide(prefs, "overview")).toBe(false);
    expect(ids(setHidden(prefs, "services", false)).map(([id]) => id)).toContain("network");
  });
});
