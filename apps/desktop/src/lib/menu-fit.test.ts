import { describe, expect, it } from "vitest";
import { menuFit } from "./menu-fit.ts";

const WINDOW = { width: 520, height: 320 };

describe("menuFit (#624)", () => {
  it("leaves a menu that fits where it is", () => {
    expect(menuFit({ left: 12, top: 100, width: 300 }, WINDOW, false)).toEqual({ shift: 0, maxHeight: null });
  });

  it("moves a menu that would leave the window on the right back in, keeping the margin", () => {
    expect(menuFit({ left: 300, top: 100, width: 300 }, WINDOW, false).shift).toBe(-88);
  });

  it("moves a menu that would leave the window on the left back in", () => {
    expect(menuFit({ left: -164, top: 100, width: 208 }, WINDOW, false).shift).toBe(172);
  });

  it("keeps the left edge of a menu wider than the window in view", () => {
    expect(menuFit({ left: 40, top: 100, width: 600 }, WINDOW, false).shift).toBe(-32);
  });

  it("gives a menu that opens downwards the room down to the window's bottom edge", () => {
    expect(menuFit({ left: 12, top: 100, width: 300 }, WINDOW, true).maxHeight).toBe(212);
    expect(menuFit({ left: 12, top: 400, width: 300 }, WINDOW, true).maxHeight).toBe(0);
  });
});
