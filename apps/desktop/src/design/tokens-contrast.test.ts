import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { contrastRatioOklch, type Oklch } from "./wcag";

type ColorValue = [number, number, number | "tint"];
type ColorToken = { $dark: ColorValue; $light: ColorValue };

const tokens: {
  color: Record<string, ColorToken>;
  identity: { hues: Record<string, number> };
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
  // Graphics: the healthy glyph on a selected row. Control edges are in CONTROLS.
  { fg: "success", on: ["primary-container"], min: 3 },
];

/**
 * The edge, indicator or glyph that identifies each control, on what it sits on
 * (WCAG 1.4.11, 3:1). A control named by its own text (a chip's label, a toolbar
 * field's text) is identified by that text, held to 4.5:1 in MATRIX; its fill
 * is not a boundary. Pairs MATRIX already holds to 4.5:1 are listed here too, so
 * each control's requirement reads in one place.
 */
const CONTROLS: { control: string; fg: string; on: string[] }[] = [
  // Form fields, outlined segmented controls, the switch when off (track and
  // knob), the scrollbar thumb: one outline-strong edge, on any surface.
  { control: "field, outlined group, switch off, scrollbar thumb", fg: "outline-strong", on: SURFACES },
  // Switch on: the primary track on its surface, the knob on the track.
  { control: "switch on: track", fg: "primary", on: SURFACES },
  { control: "switch on: knob", fg: "on-primary", on: ["primary"] },
  // Checked checkbox: the primary fill on the dialog (its unchecked box is the
  // browser's own, checked by pixels in overlays-tonal.spec.ts).
  { control: "checkbox checked", fg: "primary", on: ["surface-overlay", "surface-container"] },
  // Selected segment: a primary ring inside the tonal fill, on the group's track.
  { control: "selected segment: ring on its fill", fg: "primary", on: ["primary-container"] },
  { control: "selected segment: ring on the track", fg: "primary", on: ["surface-container-high", "surface-overlay"] },
  // Pressed status chip: a ring of its state's colour inside the state's container, on the card.
  { control: "pressed chip: ring on its fill", fg: "primary", on: ["primary-container"] },
  { control: "pressed chip: ring on its fill", fg: "warning", on: ["warning-container"] },
  { control: "pressed chip: ring on its fill", fg: "error", on: ["error-container"] },
  { control: "pressed chip: ring on the card", fg: "primary", on: ["surface-container", "surface-overlay"] },
  { control: "pressed chip: ring on the card", fg: "warning", on: ["surface-container", "surface-overlay"] },
  { control: "pressed chip: ring on the card", fg: "error", on: ["surface-container", "surface-overlay"] },
  // Icon buttons are identified by their glyph: on a resting disc, a pressed
  // (primary) disc, a tonal disc, or no disc at all.
  { control: "icon button glyph", fg: "text-muted", on: [...SURFACES, "surface-container-high"] },
  { control: "icon button glyph, pressed", fg: "on-primary", on: ["primary"] },
  { control: "icon button glyph, tonal", fg: "on-primary-container", on: ["primary-container"] },
  { control: "icon toggle pressed: disc", fg: "primary", on: ["surface-container", "surface-overlay"] },
  // Meter: the track's outline-strong edge on the card or tile under it, the fill on the track.
  { control: "meter track edge", fg: "outline-strong", on: ["surface-container-high", "surface-container-top"] },
  { control: "meter fill", fg: "primary", on: ["outline"] },
  { control: "meter fill, high", fg: "warning", on: ["outline"] },
  { control: "meter fill, critical", fg: "error", on: ["outline"] },
  // Focus ring: outside a control it sits on the surface; inside a row it sits
  // on the row: hovered, selected (tonal), or a current nav row.
  { control: "focus ring", fg: "primary", on: [...SURFACES, "surface-container-high", "primary-container"] },
];

describe("control contrast (WCAG 1.4.11) on every cluster tint", () => {
  for (const [identity, hue] of Object.entries(tokens.identity.hues)) {
    for (const theme of THEMES) {
      for (const { control, fg, on } of CONTROLS) {
        for (const bg of on) {
          it(`${control}: ${fg} on ${bg} · ${theme} · ${identity}`, () => {
            const ratio = contrastRatioOklch(color(fg, theme, hue), color(bg, theme, hue));
            expect(ratio, `${fg} on ${bg} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
          });
        }
      }
    }
  }
});

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

  it("every colour role is audited or exempt with a reason", () => {
    // `outline` is audited only as the meter track: as a hairline it is
    // decorative and never the only boundary of a control.
    const audited = new Set([...MATRIX, ...CONTROLS].flatMap((row) => [row.fg, ...row.on]));
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
