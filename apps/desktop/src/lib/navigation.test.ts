import { describe, it, expect } from "vitest";
import {
  DEFAULT_NAV,
  arrange,
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
    expect(prefs.sections).toEqual(["cluster", "observe", "workloads", "network", "storage", "config", "access"]);
    const workloads = visibleSections(prefs).find((s) => s.id === "workloads")!;
    expect(workloads.items.map((i) => i.view)).toEqual([
      "deployments",
      "statefulsets",
      "daemonsets",
      "replicasets",
      "jobs",
      "cronjobs",
      "hpas",
      "pods",
    ]);
    expect(prefs.hidden).toEqual(["helm"]);
    expect(visibleSections(prefs).find((s) => s.id === "observe")!.items.map((i) => i.view)).toEqual(["logs", "events"]);
  });
  it("keeps Cluster first and Overview first and visible", () => {
    const prefs = normalize({ sections: ["observe", "cluster"], order: ["nodes", "overview"], hidden: ["overview"] });
    expect(prefs.sections[0]).toBe("cluster");
    expect(ids(prefs)[0]).toEqual(["cluster", ["overview", "nodes", "namespaces"]]);
    expect(prefs.hidden).not.toContain("overview");
  });
  it("never hides every type besides Overview", () => {
    const all = DEFAULT_NAV.order.filter((v) => v !== "overview");
    const prefs = normalize({ hidden: all });
    expect(prefs.hidden).toHaveLength(all.length - 1);
  });
});

describe("resource kinds phase 2 sections", () => {
  it("lays out the sections of spec §4", () => {
    expect(ids()).toEqual([
      ["cluster", ["overview", "nodes", "namespaces"]],
      ["workloads", ["pods", "deployments", "statefulsets", "daemonsets", "replicasets", "jobs", "cronjobs", "hpas", "helm"]],
      ["network", ["services", "ingresses", "ingressclasses", "endpointslices", "networkpolicies"]],
      ["storage", ["pvcs", "pvs", "storageclasses"]],
      ["config", ["configmaps", "secrets", "resourcequotas", "limitranges", "pdbs", "priorityclasses"]],
      ["access", ["serviceaccounts", "roles", "rolebindings", "clusterroles", "clusterrolebindings"]],
      ["observe", ["events", "logs"]],
    ]);
    const labels = arrange(DEFAULT_NAV).map((s) => s.label);
    expect(labels).toEqual(["Cluster", "Workloads", "Network", "Storage", "Config", "Access Control", "Observe"]);
    const access = arrange(DEFAULT_NAV).find((s) => s.id === "access")!;
    expect(access.items.map((i) => i.label)).toEqual(["Service Accounts", "Roles", "Role Bindings", "Cluster Roles", "Cluster Role Bindings"]);
  });

  it("migrates preferences stored before Storage and Access Control existed", () => {
    const prefs = normalize({
      sections: ["cluster", "workloads", "config", "network", "observe"],
      order: ["overview", "nodes", "pods", "deployments", "statefulsets", "jobs", "cronjobs", "helm", "services", "ingresses", "pvcs", "secrets", "configmaps", "events", "logs"],
      hidden: ["pvcs"],
    });
    // New sections land after their default predecessor (Access after Config, Storage after Network).
    expect(prefs.sections).toEqual(["cluster", "workloads", "config", "access", "network", "storage", "observe"]);
    const storage = arrange(prefs).find((s) => s.id === "storage")!;
    expect(storage.items.map((i) => i.view)).toEqual(["pvcs", "pvs", "storageclasses"]);
    expect(prefs.hidden).toEqual(["pvcs"]);
    const config = arrange(prefs).find((s) => s.id === "config")!.items.map((i) => i.view);
    expect(config).not.toContain("pvcs");
    expect(config.indexOf("secrets")).toBeLessThan(config.indexOf("configmaps"));
  });
});

describe("moves and visibility", () => {
  it("moves items within their section only", () => {
    let prefs = moveItem(DEFAULT_NAV, "deployments", -1);
    expect(ids(prefs)[1]).toEqual([
      "workloads",
      ["deployments", "pods", "statefulsets", "daemonsets", "replicasets", "jobs", "cronjobs", "hpas", "helm"],
    ]);
    prefs = moveItem(prefs, "deployments", -1); // already first
    expect(prefs).toBe(prefs);
    expect(moveItem(DEFAULT_NAV, "nodes", -1)).toBe(DEFAULT_NAV); // cannot pass Overview
    expect(moveItem(DEFAULT_NAV, "overview", 1)).toBe(DEFAULT_NAV);
  });
  it("moves sections but never above or the Cluster section itself", () => {
    expect(moveSection(DEFAULT_NAV, "observe", -1).sections).toEqual([
      "cluster",
      "workloads",
      "network",
      "storage",
      "config",
      "observe",
      "access",
    ]);
    expect(moveSection(DEFAULT_NAV, "workloads", -1)).toBe(DEFAULT_NAV);
    expect(moveSection(DEFAULT_NAV, "cluster", 1)).toBe(DEFAULT_NAV);
    expect(moveSection(DEFAULT_NAV, "observe", 1)).toBe(DEFAULT_NAV);
  });
  it("hides items, drops empty sections and refuses Overview", () => {
    let prefs = DEFAULT_NAV;
    for (const v of ["services", "ingresses", "ingressclasses", "endpointslices", "networkpolicies"] as const) {
      prefs = setHidden(prefs, v, true);
    }
    expect(ids(prefs).map(([id]) => id)).not.toContain("network");
    expect(setHidden(prefs, "overview", true)).toBe(prefs);
    expect(canHide(prefs, "overview")).toBe(false);
    expect(ids(setHidden(prefs, "services", false)).map(([id]) => id)).toContain("network");
  });
});
