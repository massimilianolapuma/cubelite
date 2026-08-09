import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { contrastRatio } from "./wcag";

type Token = { $value: string; $light?: string };
type Tokens = Record<string, Record<string, Token>>;

const tokens: Tokens = JSON.parse(
  readFileSync(resolve(__dirname, "../../../../design/tokens.json"), "utf8"),
);

function hex(group: string, name: string, theme: "dark" | "light"): string {
  const t = tokens[group]?.[name];
  if (!t) throw new Error(`missing token ${group}.${name}`);
  return theme === "dark" ? t.$value : (t.$light ?? t.$value);
}

/** text token → surfaces it sits on (spec §Pairing matrix). */
const MATRIX: { text: [string, string]; surfaces: [string, string][]; min: number }[] = [
  { text: ["text", "primary"], min: 4.5,
    surfaces: [["surface","window"],["surface","panel"],["surface","surface"],["surface","raised"],["surface","overlay"],["surface","sunken"],["surface","row-hover"]] },
  { text: ["text", "secondary"], min: 4.5,
    surfaces: [["surface","window"],["surface","panel"],["surface","surface"],["surface","overlay"]] },
  { text: ["text", "tertiary"], min: 4.5,
    surfaces: [["surface","window"],["surface","panel"],["surface","surface"]] },
  { text: ["text", "log"], min: 4.5, surfaces: [["surface","sunken"]] },
  { text: ["text", "data-bright"], min: 4.5, surfaces: [["surface","panel"],["surface","surface"]] },
  { text: ["status", "ok"], min: 4.5,
    surfaces: [["surface","window"],["surface","panel"],["surface","surface"],["surface","sunken"]] },
  { text: ["status", "warn"], min: 4.5,
    surfaces: [["surface","window"],["surface","panel"],["surface","surface"],["surface","sunken"]] },
  { text: ["status", "err"], min: 4.5,
    surfaces: [["surface","window"],["surface","panel"],["surface","surface"],["surface","sunken"]] },
  { text: ["status", "info"], min: 4.5,
    surfaces: [["surface","window"],["surface","panel"],["surface","surface"],["surface","sunken"]] },
  { text: ["accent", "default"], min: 4.5,
    surfaces: [["surface","window"],["surface","panel"],["surface","surface"]] },
  { text: ["cluster-identity", "blue"], min: 4.5, surfaces: [["surface","sunken"]] },
  { text: ["cluster-identity", "teal"], min: 4.5, surfaces: [["surface","sunken"]] },
  { text: ["cluster-identity", "amber"], min: 4.5, surfaces: [["surface","sunken"]] },
];

/** "<textGroup>.<name>/<surface>/<theme>" → recorded ratio + reason. */
const EXCEPTIONS: Record<string, { ratio: number; reason: string }> = {
  // filled by the fix pass (Task 2) — goal: zero or near-zero entries
};

describe("token contrast (WCAG AA)", () => {
  for (const row of MATRIX) {
    for (const [sGroup, sName] of row.surfaces) {
      for (const theme of ["dark", "light"] as const) {
        const key = `${row.text[0]}.${row.text[1]}/${sName}/${theme}`;
        it(key, () => {
          const ratio = contrastRatio(
            hex(row.text[0], row.text[1], theme), hex(sGroup, sName, theme));
          const exception = EXCEPTIONS[key];
          if (exception) {
            expect(ratio, `documented exception drifted: ${exception.reason}`)
              .toBeCloseTo(exception.ratio, 2);
            expect(ratio).toBeGreaterThanOrEqual(3);
          } else {
            expect(ratio, `${key} below AA`).toBeGreaterThanOrEqual(row.min);
          }
        });
      }
    }
  }

  for (const theme of ["dark", "light"] as const) {
    it(`text.disabled floor on window (${theme})`, () => {
      const ratio = contrastRatio(
        hex("text", "disabled", theme), hex("surface", "window", theme));
      expect(ratio).toBeGreaterThanOrEqual(2.5); // AA-exempt, floor only
    });
  }
});
