import { describe, it, expect } from "vitest";
import {
  GENERIC_KINDS,
  GENERIC_VIEWS,
  customView,
  isCustomKind,
  isCustomView,
  isGenericView,
  isKindView,
  parseCustomView,
  vendorOf,
  searchKeywords,
} from "#lib/resource-kinds.ts";
import { isView } from "#lib/stores/app.svelte.ts";
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

describe("custom view ids", () => {
  it("builds and parses custom ids", () => {
    const v = customView("monitoring.coreos.com", "servicemonitors");
    expect(v).toBe("crd:monitoring.coreos.com/servicemonitors");
    expect(parseCustomView(v)).toEqual({ group: "monitoring.coreos.com", plural: "servicemonitors" });
    expect(isCustomView(v)).toBe(true);
    expect(isKindView(v)).toBe(true);
    expect(isKindView("roles")).toBe(true);
    expect(isKindView("pods")).toBe(false);
  });

  it("rejects malformed custom ids", () => {
    for (const bad of ["crd:", "crd:x", "crd:a/b/c", "crd:Monitoring.coreos.com/x", "crd:a/", "crd:/x", "crd:-a/x", "pods", 3]) {
      expect(isCustomView(bad), String(bad)).toBe(false);
      expect(parseCustomView(String(bad)), String(bad)).toBeNull();
    }
  });

  it("isView accepts custom ids", () => {
    expect(isView("crd:cert-manager.io/certificates")).toBe(true);
    expect(isView("crd:x")).toBe(false);
    expect(isView("pods")).toBe(true);
  });

  it("built-in groups are not custom", () => {
    for (const group of ["", "apps", "batch", "metrics.k8s.io", "rbac.authorization.k8s.io", "apiextensions.k8s.io"]) {
      expect(isCustomKind({ group }), group).toBe(false);
    }
    for (const group of ["gateway.networking.k8s.io", "snapshot.storage.k8s.io", "cert-manager.io", "monitoring.coreos.com"]) {
      expect(isCustomKind({ group }), group).toBe(true);
    }
  });
});

describe("searchKeywords for custom kinds", () => {
  it("uses kind, plural, short names and group", () => {
    const words = searchKeywords("crd:monitoring.coreos.com/servicemonitors", "ServiceMonitor", {
      kind: "ServiceMonitor",
      plural: "servicemonitors",
      shortNames: ["smon"],
    });
    expect(words).toEqual(expect.arrayContaining(["servicemonitor", "servicemonitors", "smon", "monitoring.coreos.com"]));
  });

  it("falls back to the id", () => {
    expect(searchKeywords("crd:example.com/widgets", "widgets")).toEqual(expect.arrayContaining(["widgets", "example.com"]));
  });
});

describe("real-world CRD names", () => {
  it("accepts hyphenated plurals (Multus network-attachment-definitions)", () => {
    const v = customView("k8s.cni.cncf.io", "network-attachment-definitions");
    expect(isCustomView(v)).toBe(true);
    expect(parseCustomView(v)).toEqual({ group: "k8s.cni.cncf.io", plural: "network-attachment-definitions" });
    expect(isCustomView("crd:x.io/-bad")).toBe(false);
    expect(isCustomView("crd:x.io/bad-")).toBe(false);
  });

  it("rejects ids in built-in groups (those kinds have their own views)", () => {
    for (const v of ["crd:apps/deployments", "crd:rbac.authorization.k8s.io/roles", "crd:metrics.k8s.io/pods"]) {
      expect(isCustomView(v), v).toBe(false);
      expect(parseCustomView(v), v).toBeNull();
    }
  });
});

describe("vendorOf", () => {
  it("is the registrable domain of an API group", () => {
    expect(vendorOf("agent.k8s.elastic.co")).toBe("elastic.co");
    expect(vendorOf("elasticsearch.k8s.elastic.co")).toBe("elastic.co");
    expect(vendorOf("monitoring.coreos.com")).toBe("coreos.com");
    expect(vendorOf("cert-manager.io")).toBe("cert-manager.io");
    expect(vendorOf("acme.cert-manager.io")).toBe("cert-manager.io");
    expect(vendorOf("gateway.networking.k8s.io")).toBe("k8s.io");
    expect(vendorOf("localhost")).toBe("localhost");
  });
});
