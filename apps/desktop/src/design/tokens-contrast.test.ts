import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { contrastRatioOklch, type Oklch } from "./wcag";

type ColorValue = [number, number, number | "tint"];
type ColorToken = { $dark: ColorValue; $light: ColorValue };

const tokens: {
  color: Record<string, ColorToken>;
  identity: { $dark: [number, number]; $light: [number, number]; hues: Record<string, number> };
} = JSON.parse(readFileSync(resolve(__dirname, "../../../../design/tokens.json"), "utf8"));

const THEMES = ["dark", "light"] as const;
type Theme = (typeof THEMES)[number];

/** A role's colour in one theme, with the tint resolved to a cluster hue. */
function color(role: string, theme: Theme, tintHue: number): Oklch {
  const token = tokens.color[role];
  if (!token) throw new Error(`missing colour role ${role}`);
  const [l, c, h] = theme === "dark" ? token.$dark : token.$light;
  return [l, c, h === "tint" ? tintHue : h];
}

const SURFACES = [
  "surface-window",
  "surface-sunken",
  "surface-container",
  "surface-container-high",
  "surface-container-top",
  "surface-overlay",
];
const without = (...names: string[]) => SURFACES.filter((s) => !names.includes(s));

/** Foreground role → the grounds it is used on (spec §4.6). */
const MATRIX: { fg: string; on: string[]; min: number }[] = [
  { fg: "text", on: SURFACES, min: 4.5 },
  { fg: "text-muted", on: SURFACES, min: 4.5 },
  { fg: "text-subtle", on: SURFACES, min: 4.5 },
  { fg: "primary", on: SURFACES, min: 4.5 },
  { fg: "success", on: SURFACES, min: 4.5 },
  { fg: "warning", on: SURFACES, min: 4.5 },
  { fg: "error", on: SURFACES, min: 4.5 },
  // Text on its own fill.
  { fg: "on-primary", on: ["primary"], min: 4.5 },
  { fg: "on-primary-container", on: ["primary-container"], min: 4.5 },
  { fg: "on-success-container", on: ["success-container"], min: 4.5 },
  { fg: "on-warning-container", on: ["warning-container"], min: 4.5 },
  { fg: "on-error-container", on: ["error-container"], min: 4.5 },
  { fg: "on-error-solid", on: ["error-solid"], min: 4.5 },
  // Chart series double as log-source labels, so they are held to text contrast.
  ...["data-1", "data-2", "data-3", "data-4", "data-5"].map((fg) => ({
    fg,
    on: without("surface-window", "surface-overlay"),
    min: 4.5,
  })),
  // Graphics: control borders, and the healthy glyph on a selected row.
  { fg: "outline-strong", on: SURFACES, min: 3 },
  { fg: "success", on: ["primary-container"], min: 3 },
  // Meter fills on their track.
  { fg: "primary", on: ["outline"], min: 3 },
  { fg: "warning", on: ["outline"], min: 3 },
  { fg: "error", on: ["outline"], min: 3 },
];

/** Roles that are deliberately not held to a contrast floor. */
const AUDIT_EXEMPT: Record<string, string> = {};

describe("token contrast (WCAG AA) on every cluster tint", () => {
  for (const [identity, hue] of Object.entries(tokens.identity.hues)) {
    for (const theme of THEMES) {
      for (const { fg, on, min } of MATRIX) {
        for (const bg of on) {
          it(`${fg} on ${bg} · ${theme} · ${identity}`, () => {
            const ratio = contrastRatioOklch(color(fg, theme, hue), color(bg, theme, hue));
            expect(ratio, `${fg} on ${bg} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(min);
          });
        }
      }
    }
  }

  it("identity colours read as text on the wells that show them", () => {
    for (const hue of Object.values(tokens.identity.hues)) {
      for (const theme of THEMES) {
        const [l, c] = theme === "dark" ? tokens.identity.$dark : tokens.identity.$light;
        for (const bg of ["surface-sunken", "surface-window", "surface-container"]) {
          // An identity colour is always shown inside its own tint.
          expect(contrastRatioOklch([l, c, hue], color(bg, theme, hue))).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it("every colour role is audited or exempt with a reason", () => {
    const audited = new Set(MATRIX.flatMap((row) => [row.fg, ...row.on]));
    const missing = Object.keys(tokens.color).filter(
      (role) => !audited.has(role) && !(role in AUDIT_EXEMPT),
    );
    expect(missing, `role(s) with no MATRIX row or AUDIT_EXEMPT entry`).toEqual([]);
  });

  it("identities stay out of the hues that mean a state", () => {
    // Warm half of the wheel (red, amber, green) is reserved for status.
    for (const [identity, hue] of Object.entries(tokens.identity.hues)) {
      expect(hue, identity).toBeGreaterThanOrEqual(185);
      expect(hue, identity).toBeLessThanOrEqual(345);
    }
  });
});
