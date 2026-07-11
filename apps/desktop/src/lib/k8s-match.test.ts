import { describe, it, expect } from "vitest";
import { matchesSelector } from "$lib/k8s-match";

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
