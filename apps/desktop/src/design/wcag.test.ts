import { describe, expect, it } from "vitest";
import { contrastRatio, contrastRatioOklch, oklchLuminance } from "./wcag";

describe("contrastRatio", () => {
  it("black on white is 21:1", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 1);
  });
  it("same color is 1:1", () => {
    expect(contrastRatio("#808080", "#808080")).toBeCloseTo(1, 5);
  });
  it("is symmetric", () => {
    expect(contrastRatio("#123456", "#fedcba")).toBeCloseTo(
      contrastRatio("#fedcba", "#123456"), 6);
  });
  it("matches a known reference pair", () => {
    // #767676 on #ffffff is the canonical 4.54:1 AA-passing gray
    expect(contrastRatio("#767676", "#ffffff")).toBeGreaterThan(4.5);
    expect(contrastRatio("#777777", "#ffffff")).toBeCloseTo(4.48, 1);
  });
});

describe("OKLCH contrast", () => {
  it("maps white and black to luminance 1 and 0", () => {
    expect(oklchLuminance(1, 0, 0)).toBeCloseTo(1, 3);
    expect(oklchLuminance(0, 0, 0)).toBeCloseTo(0, 5);
  });

  it("matches the sRGB luminance of pure red", () => {
    // oklch(0.627955 0.257683 29.2339) is #ff0000.
    expect(oklchLuminance(0.627955, 0.257683, 29.2339)).toBeCloseTo(0.2126, 2);
  });

  it("clips a colour outside sRGB instead of exceeding the range", () => {
    // Far outside the gamut towards green: red and blue clip to 0, green to 1,
    // so the result is exactly the green coefficient. Unclipped it would be 0.83.
    expect(oklchLuminance(0.9, 0.4, 145)).toBeCloseTo(0.7152, 3);
  });

  it("gives 21:1 for white on black, in either order", () => {
    expect(contrastRatioOklch([1, 0, 0], [0, 0, 0])).toBeCloseTo(21, 1);
    expect(contrastRatioOklch([0, 0, 0], [1, 0, 0])).toBeCloseTo(21, 1);
  });
});
