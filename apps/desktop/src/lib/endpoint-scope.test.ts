import { describe, it, expect } from "vitest";
import {
  DEFAULT_MODE_SEGMENTS,
  canBeDefault,
  matchClusterLabel,
  resolveEndpoint,
  scopeView,
  usedByText,
  willUseDefaultText,
  type ScopedEndpoint,
} from "./endpoint-scope.ts";

type E = ScopedEndpoint & { cluster: string | null };

const ext = (url: string, cluster: string | null = null): E => ({ target: { kind: "external", url }, cluster });
const merge = (fallback: E, settings: { cluster: string }) => ({ ...fallback, cluster: settings.cluster });

describe("resolveEndpoint (#528)", () => {
  it("prefers the context's own endpoint, then the default unless off", () => {
    const own = ext("https://own");
    const fallback = ext("https://shared", "fallback");
    expect(resolveEndpoint({ own, fallback, disabled: true, settings: null, merge })).toBe(own);
    expect(resolveEndpoint({ own: null, fallback, disabled: false, settings: null, merge })).toEqual({
      ...fallback,
      shared: true,
    });
    expect(resolveEndpoint({ own: null, fallback, disabled: true, settings: null, merge })).toBeNull();
    expect(resolveEndpoint({ own: null, fallback: null, disabled: false, settings: null, merge })).toBeNull();
  });

  it("applies the context's settings to the default", () => {
    const resolved = resolveEndpoint({
      own: null,
      fallback: ext("https://shared", "fallback"),
      disabled: false,
      settings: { cluster: "aks-2" },
      merge,
    });
    expect(resolved).toEqual({ target: { kind: "external", url: "https://shared" }, cluster: "aks-2", shared: true });
  });

  it("never shares an in-cluster default", () => {
    const fallback: E = {
      target: { kind: "in-cluster", namespace: "m", service: "p", port: 9090, https: false },
      cluster: null,
    };
    expect(canBeDefault(fallback.target)).toBe(false);
    expect(resolveEndpoint({ own: null, fallback, disabled: false, settings: null, merge })).toBeNull();
    expect(DEFAULT_MODE_SEGMENTS.map((s) => s.value)).toEqual(["off", "external"]);
  });
});

describe("scopeView (#528)", () => {
  it("maps the scope and the context's use to a view", () => {
    expect(scopeView("default", "own", false)).toBe("default");
    expect(scopeView("context", "default", false)).toBe("inherited");
    expect(scopeView("context", "default", true)).toBe("own");
    expect(scopeView("context", "off", false)).toBe("off");
    expect(scopeView("context", "own", false)).toBe("own");
    expect(scopeView("context", "none", false)).toBe("own");
  });

  it("lists the contexts using the default", () => {
    expect(usedByText(["a", "b"])).toBe("Used by: a, b");
    expect(usedByText([])).toBe("No context uses the default endpoint yet.");
    expect(willUseDefaultText(["a", "b"])).toBe("Contexts without their own endpoint will use this default: a, b.");
    expect(willUseDefaultText([])).toBe("No context uses the default endpoint yet.");
  });
});

describe("matchClusterLabel (#528)", () => {
  const values = ["aks-prod", "aks-prod-weu", "aks-test", "dev"];

  it("prefers an equal value, case-insensitively", () => {
    expect(matchClusterLabel(values, "AKS-PROD")).toBe("aks-prod");
  });

  it("then the only value containing the name or contained in it", () => {
    expect(matchClusterLabel(["aks-prod-weu", "aks-test"], "aks-prod")).toBe("aks-prod-weu");
    expect(matchClusterLabel(values, "admin@aks-test")).toBe("aks-test");
  });

  it("preselects nothing when several values are near", () => {
    expect(matchClusterLabel(["preprod", "prod-eu"], "prod")).toBeNull();
    expect(matchClusterLabel(["aks-prod-weu-2", "aks-prod-weu"], "aks-prod")).toBeNull();
    expect(matchClusterLabel(["dev", "dev-eu"], "user@dev-eu-1")).toBeNull();
    expect(matchClusterLabel(["", "x"], "prod")).toBeNull();
  });

  it("returns null without a match", () => {
    expect(matchClusterLabel(values, "staging")).toBeNull();
    expect(matchClusterLabel([], "prod")).toBeNull();
  });
});
