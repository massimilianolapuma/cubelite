import { describe, it, expect } from "vitest";
import { applyDensity, applyTint, tintFor, tintStyle } from "./appearance";

describe("applyDensity", () => {
  it("marks the root so the compact row padding token applies", () => {
    const root = document.createElement("html");
    applyDensity("compact", root);
    expect(root.dataset.density).toBe("compact");
    applyDensity("default", root);
    expect(root.dataset.density).toBe("default");
  });
});

describe("applyTint", () => {
  it("points the tint hue at the identity's hue and clears it for the default", () => {
    const root = document.createElement("html");
    applyTint("teal", root);
    expect(root.style.getPropertyValue("--cl-tint-h")).toBe("var(--cl-hue-teal)");
    applyTint("magenta", root);
    expect(root.style.getPropertyValue("--cl-tint-h")).toBe("var(--cl-hue-magenta)");
    applyTint(null, root);
    expect(root.style.getPropertyValue("--cl-tint-h")).toBe("");
  });
});

describe("tintFor", () => {
  const identityFor = (name: string) => (name === "prod" ? "violet" : "blue");

  it("is the active cluster's identity", () => {
    expect(tintFor(false, "prod", identityFor)).toBe("violet");
  });

  it("is the default on the All Clusters dashboard, which belongs to no cluster", () => {
    expect(tintFor(true, "prod", identityFor)).toBeNull();
  });

  it("is the default while no cluster is active", () => {
    expect(tintFor(false, null, identityFor)).toBeNull();
  });
});

describe("tintStyle", () => {
  it("is the inline declaration that tints a data-tint subtree", () => {
    expect(tintStyle("violet")).toBe("--cl-tint-h: var(--cl-hue-violet)");
  });
});
