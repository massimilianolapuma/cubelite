import { describe, it, expect } from "vitest";
import { applyDensity, applyTint, tintFor, tintStyle, windowTint } from "./appearance";

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

describe("windowTint", () => {
  const identityFor = (name: string) => (name === "prod" ? "violet" : "teal");
  const base = { popout: false, neutralView: false, connecting: null, active: "prod" } as const;

  it("follows the active cluster", () => {
    expect(windowTint(base, identityFor)).toBe("violet");
  });

  it("is the default on a view that belongs to no cluster", () => {
    expect(windowTint({ ...base, neutralView: true }, identityFor)).toBeNull();
  });

  it("switches to the cluster being connected to as soon as connecting starts", () => {
    expect(windowTint({ ...base, connecting: "staging" }, identityFor)).toBe("teal");
  });

  it("takes the target's tint even from the All Clusters dashboard", () => {
    expect(windowTint({ ...base, neutralView: true, connecting: "staging" }, identityFor)).toBe("teal");
  });

  it("a pop-out log window keeps its cluster, whatever view state it carries", () => {
    expect(windowTint({ ...base, popout: true, neutralView: true }, identityFor)).toBe("violet");
  });
});
