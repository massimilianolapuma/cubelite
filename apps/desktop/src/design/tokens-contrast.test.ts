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
  { text: ["cluster-identity", "pink"], min: 4.5, surfaces: [["surface","sunken"]] },
  { text: ["cluster-identity", "violet"], min: 4.5, surfaces: [["surface","sunken"]] },
  // status.err-solid is a FILL token (destructive-button background), not a text
  // color — but contrast is symmetric, so it's audited here against the text
  // token actually overlaid on it. DeletePodDialog.svelte renders its confirm
  // button as `style="background: var(--color-status-err-solid)"` with class
  // `text-text-primary`, i.e. the real foreground is text.primary (not
  // surface.window, which is the convention used by other solid-fill buttons
  // elsewhere in the app but not this one) — paired against its own theme's
  // text.primary value.
  { text: ["status", "err-solid"], min: 4.5, surfaces: [["text","primary"]] },
];

/** "<textGroup>.<name>/<surface>/<theme>" → recorded ratio + reason. */
const EXCEPTIONS: Record<string, { ratio: number; reason: string }> = {
  // filled by the fix pass (Task 2) — goal: zero or near-zero entries
};

/**
 * "<group>.<name>" → reason, for color tokens in the coverage-guard groups
 * below that are intentionally not in MATRIX (i.e. not audited against AA).
 * Keep this empty wherever possible — prefer adding a MATRIX row instead.
 */
const AUDIT_EXEMPT: Record<string, string> = {
  "text.disabled": "AA-exempt, floor-asserted separately",
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

  for (const sName of ["window", "panel", "surface"] as const) {
    for (const theme of ["dark", "light"] as const) {
      it(`text.disabled floor on ${sName} (${theme})`, () => {
        const ratio = contrastRatio(
          hex("text", "disabled", theme), hex("surface", sName, theme));
        expect(ratio).toBeGreaterThanOrEqual(2.5); // AA-exempt, floor only
      });
    }
  }

  // Coverage guard: every color token in these groups must be either
  // matrix-audited (a MATRIX row) or explicitly exempt (AUDIT_EXEMPT, with a
  // reason). Prevents a newly added text/status/cluster-identity token from
  // silently skipping the contrast audit.
  it("every text/status/cluster-identity color token is audited or exempt", () => {
    const auditedKeys = new Set(MATRIX.map((row) => `${row.text[0]}.${row.text[1]}`));
    const missing: string[] = [];
    for (const group of ["text", "status", "cluster-identity"] as const) {
      for (const name of Object.keys(tokens[group] ?? {})) {
        if (name.startsWith("$")) continue;
        const key = `${group}.${name}`;
        if (!auditedKeys.has(key) && !(key in AUDIT_EXEMPT)) {
          missing.push(key);
        }
      }
    }
    expect(missing, `token(s) missing a MATRIX row or AUDIT_EXEMPT entry: ${missing.join(", ")}`)
      .toEqual([]);
  });
});
