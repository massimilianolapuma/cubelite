import { describe, it, expect } from "vitest";
import { matchesSelector, parseLabelSelector } from "$lib/k8s-match";

describe("matchesSelector", () => {
  it("matches when all selector entries are present", () => {
    expect(matchesSelector({ app: "api", tier: "web", extra: "x" }, { app: "api", tier: "web" })).toBe(true);
  });

  it("rejects on any mismatch or missing key", () => {
    expect(matchesSelector({ app: "api" }, { app: "worker" })).toBe(false);
    expect(matchesSelector({ tier: "web" }, { app: "api" })).toBe(false);
  });

  it("never matches an empty selector (would select everything)", () => {
    expect(matchesSelector({ app: "api" }, {})).toBe(false);
  });
});

describe("parseLabelSelector", () => {
  it("parses an equality list with whitespace", () => {
    expect(parseLabelSelector(" app=api, tier = web ")).toEqual({ app: "api", tier: "web" });
  });

  it("splits on the first equals sign only", () => {
    expect(parseLabelSelector("cfg=a=b")).toEqual({ cfg: "a=b" });
  });

  it("ignores malformed tokens", () => {
    expect(parseLabelSelector("app=api, nonsense, =v, k=")).toEqual({ app: "api" });
  });

  it("empty input parses to an empty selector", () => {
    expect(parseLabelSelector("")).toEqual({});
    expect(parseLabelSelector("   ")).toEqual({});
  });
});
