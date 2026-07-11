import { describe, it, expect } from "vitest";
import { matchShortcut, type KeyLike } from "$lib/keyboard";

function key(overrides: Partial<KeyLike>): KeyLike {
  return { key: "", metaKey: false, ctrlKey: false, altKey: false, ...overrides };
}

describe("matchShortcut", () => {
  it("maps mod+K to the palette on both platforms", () => {
    expect(matchShortcut(key({ key: "k", metaKey: true }), true)).toEqual({ type: "palette" });
    expect(matchShortcut(key({ key: "K", ctrlKey: true }), false)).toEqual({ type: "palette" });
  });

  it("uses the platform-correct modifier", () => {
    expect(matchShortcut(key({ key: "k", ctrlKey: true }), true)).toBeNull();
    expect(matchShortcut(key({ key: "k", metaKey: true }), false)).toBeNull();
  });

  it("maps mod+1..5 to cluster indices", () => {
    expect(matchShortcut(key({ key: "1", metaKey: true }), true)).toEqual({
      type: "switch-cluster",
      index: 0,
    });
    expect(matchShortcut(key({ key: "5", ctrlKey: true }), false)).toEqual({
      type: "switch-cluster",
      index: 4,
    });
    expect(matchShortcut(key({ key: "6", metaKey: true }), true)).toBeNull();
    expect(matchShortcut(key({ key: "0", metaKey: true }), true)).toBeNull();
  });

  it("maps mod+, to preferences", () => {
    expect(matchShortcut(key({ key: ",", metaKey: true }), true)).toEqual({
      type: "preferences",
    });
  });

  it("ignores alt combos and plain keys", () => {
    expect(matchShortcut(key({ key: "k", metaKey: true, altKey: true }), true)).toBeNull();
    expect(matchShortcut(key({ key: "k" }), true)).toBeNull();
  });
});
