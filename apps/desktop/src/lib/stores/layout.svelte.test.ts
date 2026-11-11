import { beforeEach, describe, expect, it } from "vitest";
import { DOCK_MIN_WIDTH, layout } from "./layout.svelte";

beforeEach(() => (layout.contentWidth = 0));

describe("layout", () => {
  it("docks the detail panel from 1000 px of content width", () => {
    expect(DOCK_MIN_WIDTH).toBe(1000);
    layout.contentWidth = 999;
    expect(layout.docked).toBe(false);
    layout.contentWidth = 1000;
    expect(layout.docked).toBe(true);
  });

  it("overlays before the content column has been measured", () => {
    expect(layout.docked).toBe(false);
  });
});
