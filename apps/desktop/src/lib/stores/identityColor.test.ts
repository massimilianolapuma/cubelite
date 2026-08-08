import { describe, it, expect } from "vitest";
import { identityColorFor } from "./identityColor";
import type { ContainerDetail } from "$lib/tauri";

const cs = [
  { name: "worker", init: false },
  { name: "envoy", init: false },
  { name: "extra", init: false },
  { name: "init-migrate", init: true },
] as ContainerDetail[];

describe("identityColorFor", () => {
  it("init containers are always amber", () => {
    expect(identityColorFor(cs, "init-migrate")).toBe("var(--color-cluster-amber)");
  });

  it("regular containers cycle blue → teal by spec order", () => {
    expect(identityColorFor(cs, "worker")).toBe("var(--color-cluster-blue)");
    expect(identityColorFor(cs, "envoy")).toBe("var(--color-cluster-teal)");
    expect(identityColorFor(cs, "extra")).toBe("var(--color-cluster-blue)"); // cycles
  });

  it("unknown container falls back to blue", () => {
    expect(identityColorFor(cs, "ghost")).toBe("var(--color-cluster-blue)");
  });
});
