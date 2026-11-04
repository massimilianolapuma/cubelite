import { describe, it, expect, beforeEach } from "vitest";
import { mergeClusterFilter, type ElasticContextSettings } from "#lib/elastic.ts";
import type { EsEndpoint, PromEndpoint } from "#lib/tauri.ts";
import { EndpointStore } from "./endpoints.svelte";

const KEY = "test.endpoints";
const STORAGE = `cubelite.${KEY}`;

const prom = (url: string, cluster: string | null = null): PromEndpoint => ({
  target: { kind: "external", url },
  cluster,
  grafanaUrl: null,
  grafanaDatasource: null,
  skipTlsVerify: false,
});

beforeEach(() => {
  for (const suffix of ["", ".default", ".off", ".contexts"]) window.localStorage.removeItem(STORAGE + suffix);
});

describe("EndpointStore (#528)", () => {
  it("loads settings saved before defaults existed", () => {
    window.localStorage.setItem(STORAGE, JSON.stringify({ prod: prom("https://p") }));
    const store = new EndpointStore<PromEndpoint>(KEY);
    expect(store.endpointFor("prod")).toEqual(prom("https://p"));
    expect(store.endpointFor("staging")).toBeNull();
    expect(store.defaultEndpoint).toBeNull();
    expect(store.useOf("prod")).toBe("own");
    expect(store.useOf("staging")).toBe("none");
  });

  it("ignores unreadable default, off and per-context entries", () => {
    window.localStorage.setItem(`${STORAGE}.default`, JSON.stringify("nope"));
    window.localStorage.setItem(`${STORAGE}.off`, JSON.stringify({ a: 1 }));
    window.localStorage.setItem(`${STORAGE}.contexts`, "not json");
    const store = new EndpointStore<PromEndpoint>(KEY);
    expect(store.defaultEndpoint).toBeNull();
    expect(store.isOff("prod")).toBe(false);
    expect(store.contextSettings("prod")).toBeNull();
  });

  it("resolves own ?? (off ? null : default), and persists all of it", () => {
    const store = new EndpointStore<PromEndpoint, { cluster: string | null }>(KEY, (d, s) => ({
      ...d,
      cluster: s.cluster || d.cluster,
    }));
    expect(store.setDefault(prom("https://shared", "fallback"))).toBe(true);
    store.setEndpoint("own", prom("https://own"));
    store.setContextSettings("aks-2", { cluster: "aks-2" });
    store.setOff("dev", true);

    expect(store.endpointFor("own")).toEqual(prom("https://own"));
    expect(store.endpointFor("aks-1")).toEqual({ ...prom("https://shared", "fallback"), shared: true });
    expect(store.endpointFor("aks-2")).toEqual({ ...prom("https://shared", "aks-2"), shared: true });
    expect(store.endpointFor("dev")).toBeNull();
    expect(store.usersOfDefault(["own", "aks-1", "aks-2", "dev"])).toEqual(["aks-1", "aks-2"]);

    const reloaded = new EndpointStore<PromEndpoint, { cluster: string | null }>(KEY);
    expect(reloaded.defaultEndpoint?.target).toEqual({ kind: "external", url: "https://shared" });
    expect(reloaded.defaultEndpoint?.shared).toBeUndefined();
    expect(reloaded.isOff("dev")).toBe(true);
    expect(reloaded.contextSettings("aks-2")).toEqual({ cluster: "aks-2" });
    expect(reloaded.useOf("dev")).toBe("off");
  });

  it("an own endpoint turns the default back on; removing the default removes it everywhere", () => {
    const store = new EndpointStore<PromEndpoint>(KEY);
    store.setDefault(prom("https://shared"));
    store.setOff("dev", true);
    store.setEndpoint("dev", prom("https://own"));
    expect(store.isOff("dev")).toBe(false);
    store.setEndpoint("dev", null);
    expect(store.useOf("dev")).toBe("default");
    store.setDefault(null);
    expect(store.endpointFor("dev")).toBeNull();
    expect(store.useOf("dev")).toBe("none");
  });

  it("refuses an in-cluster default", () => {
    const store = new EndpointStore<PromEndpoint>(KEY);
    const inCluster = {
      ...prom("x"),
      target: { kind: "in-cluster", namespace: "m", service: "p", port: 9090, https: false },
    } satisfies PromEndpoint;
    expect(store.setDefault(inCluster)).toBe(false);
    expect(store.defaultEndpoint).toBeNull();
  });

  it("defaultFor previews the default with a form's settings", () => {
    const store = new EndpointStore<PromEndpoint>(KEY);
    expect(store.defaultFor({ cluster: "x" })).toBeNull();
    store.setDefault(prom("https://shared"));
    expect(store.defaultFor({ cluster: "x" })).toEqual({ ...prom("https://shared", "x"), shared: true });
  });
});

describe("Elasticsearch cluster filter on the default (#528)", () => {
  const es = (clusterFilter: EsEndpoint["clusterFilter"]): EsEndpoint => ({
    target: { kind: "external", url: "https://es" },
    indexPattern: "logs-*",
    preset: "ecs",
    kibanaUrl: null,
    skipTlsVerify: false,
    clusterFilter,
  });

  it("takes the context's value and the default's field when blank", () => {
    const store = new EndpointStore<EsEndpoint, ElasticContextSettings>(KEY, mergeClusterFilter);
    store.setDefault(es({ field: "k8s.cluster", value: "" }));
    store.setContextSettings("aks-1", { clusterFilter: { field: "", value: "aks-1" } });
    store.setContextSettings("aks-2", { clusterFilter: { field: "cluster", value: "aks-2" } });
    expect(store.endpointFor("aks-1")?.clusterFilter).toEqual({ field: "k8s.cluster", value: "aks-1" });
    expect(store.endpointFor("aks-2")?.clusterFilter).toEqual({ field: "cluster", value: "aks-2" });
    expect(store.endpointFor("aks-3")?.clusterFilter).toEqual({ field: "k8s.cluster", value: "" });
  });
});
