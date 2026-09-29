import { describe, it, expect } from "vitest";
import { applyAccent, applyDensity } from "./appearance";

describe("applyDensity", () => {
  it("marks the root so the compact row padding token applies", () => {
    const root = document.createElement("html");
    applyDensity("compact", root);
    expect(root.dataset.density).toBe("compact");
    applyDensity("default", root);
    expect(root.dataset.density).toBe("default");
  });
});

describe("applyAccent", () => {
  it("overrides the accent token for alternates and clears it for the default", () => {
    const root = document.createElement("html");
    applyAccent("violet", root);
    expect(root.style.getPropertyValue("--cl-color-accent")).toBe("var(--cl-color-accent-alt-violet)");
    applyAccent("teal", root);
    expect(root.style.getPropertyValue("--cl-color-accent")).toBe("var(--cl-color-accent-alt-teal)");
    applyAccent("blue", root);
    expect(root.style.getPropertyValue("--cl-color-accent")).toBe("");
  });
});
