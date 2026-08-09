# A11y Contrast Audit (#120 stage 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permanent WCAG AA contrast audit over `design/tokens.json` (both themes) as a vitest suite, plus the token fix pass that makes it green, per spec `docs/superpowers/specs/2026-08-09-a11y-contrast-audit-design.md`.

**Architecture:** One test file under `apps/desktop/src` (inside the existing vitest include glob — zero config changes) reads `design/tokens.json` from the repo root, computes WCAG 2.1 ratios for a declared pairing matrix in dark + light, and fails below threshold unless a documented exception records the exact ratio. Token fixes go in `tokens.json`; `pnpm design:tokens` regenerates `apps/desktop/src/app.css` AND `apps/macos/.../DesignTokens.swift` together.

**Tech Stack:** vitest, TypeScript, no new dependencies.

## Global Constraints

- Single PR, branch `feat/120-a11y-contrast` (spec + this plan already on it).
- NEVER hand-edit generated files (`app.css` generated regions, `DesignTokens.swift`) — only `design/tokens.json` + `pnpm design:tokens`.
- Token fixes: MINIMAL delta, preserve hue, prefer text tokens over surface tokens.
- Thresholds: 4.5:1 text; `text.disabled` exempt from AA but floor-asserted ≥ 2.5:1; `cluster.*` on sunken targets 4.5:1 with documented 3:1-floor exceptions allowed only if the fix would break identity hue.
- Exceptions map entries: `{ ratio, reason }`, ratio re-asserted exactly (rot-proof).
- Gates with explicit exit codes (`; echo "X=$?"`): desktop `cd apps/desktop && pnpm vitest run; pnpm typecheck; pnpm lint`; macOS build-for-testing + test-without-building (`-derivedDataPath /tmp/cubelite-build`, `-skip-testing cubeliteUITests`, `; echo "X=${PIPESTATUS[0]}"`). Known macOS flaky: LoadClientIdentityTests, AppSettingsContextNamespacesTests (rerun isolated if sole failures).
- Conventional Commits, NO Claude attribution, no session links.

---

### Task 1: WCAG math + audit suite (expected to expose failures)

**Files:**
- Create: `apps/desktop/src/design/wcag.ts`
- Create: `apps/desktop/src/design/wcag.test.ts`
- Create: `apps/desktop/src/design/tokens-contrast.test.ts`

**Interfaces:**
- Produces: `contrastRatio(hexA: string, hexB: string): number` (WCAG 2.1: relative luminance with sRGB linearization; ratio (L1+0.05)/(L2+0.05) ≥ 1); pairing matrix + `exceptions` map exported from `tokens-contrast.test.ts` for Task 2 to edit.

- [ ] **Step 1: Failing unit tests for the math**

`apps/desktop/src/design/wcag.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { contrastRatio } from "./wcag";

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
```

Run: `cd apps/desktop && pnpm vitest run src/design/wcag.test.ts; echo "X=$?"` → FAIL (module missing).

- [ ] **Step 2: Implement `wcag.ts`**

```ts
/** WCAG 2.1 contrast math over hex colors — no dependencies. */

function channel(v: number): number {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`not a 6-digit hex color: ${hex}`);
  const n = parseInt(m[1], 16);
  return (
    0.2126 * channel((n >> 16) & 0xff) +
    0.7152 * channel((n >> 8) & 0xff) +
    0.0722 * channel(n & 0xff)
  );
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}
```

Run wcag.test.ts → PASS.

- [ ] **Step 3: The audit suite**

`apps/desktop/src/design/tokens-contrast.test.ts` — reads the token source from the repo root:

```ts
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
```

Adapt group/name lookups to the REAL `tokens.json` structure (verify `accent.accent`, `cluster.blue` etc. exist under those exact keys — check the file; e.g. accent group may name its main token differently). If a matrix pairing references a token that does not exist, fix the matrix row, do not invent tokens.

- [ ] **Step 4: Run the audit — record the failures (do NOT fix yet)**

Run: `cd apps/desktop && pnpm vitest run src/design/tokens-contrast.test.ts 2>&1 | tail -40; echo "X=$?"`
Expected: some failures. Copy the full list of failing pairings + actual ratios into the task report — Task 2 consumes it verbatim.

- [ ] **Step 5: Commit (audit suite, red allowed on the new file ONLY at this commit)**

```bash
git add apps/desktop/src/design/
git commit -m "test(design): WCAG AA contrast audit over design tokens"
```

---

### Task 2: Token fix pass + regeneration + audit report

**Files:**
- Modify: `design/tokens.json`
- Regenerate: `apps/desktop/src/app.css`, `apps/macos/cubelite/cubelite/Helpers/DesignTokens.swift` (via `pnpm design:tokens` ONLY)
- Modify: `apps/desktop/src/design/tokens-contrast.test.ts` (EXCEPTIONS entries only, if any irreducible)
- Create: `docs/a11y/contrast-audit.md`

**Interfaces:**
- Consumes: Task 1's failure list (pairing, theme, actual ratio).

- [ ] **Step 1: For each failing pairing, compute the minimal token nudge**

Method per failure: keep hue/saturation, adjust lightness of the TEXT token until ratio ≥ threshold against its worst surface in that theme (a scratch Node script with `contrastRatio` is fine — put it nowhere, run inline). Prefer nudging the text token; only touch a surface token if several text tokens fail on the same surface and one surface nudge fixes them all. Record before → after hex + before → after ratio for every change.

- [ ] **Step 2: Apply to `design/tokens.json` and regenerate**

Run: `pnpm design:tokens; echo "X=$?"` from repo root. Verify with `git diff --stat` that ONLY tokens.json + the two generated files changed.

- [ ] **Step 3: Audit suite green**

Run: `cd apps/desktop && pnpm vitest run src/design/tokens-contrast.test.ts; echo "X=$?"` → PASS. Any pairing that cannot clear threshold without breaking identity hue gets an EXCEPTIONS entry with the exact ratio and a reason; goal ≤ 3 entries total.

- [ ] **Step 4: Both apps' full gates**

- `cd apps/desktop && pnpm vitest run; echo "X=$?"` and `pnpm typecheck; echo "X=$?"` and `pnpm lint; echo "X=$?"`
- macOS: build-for-testing + test-without-building (Global Constraints commands). Token-only changes must not break tests; if a macOS test asserts an exact hex (grep `#` literals in cubeliteTests referencing changed values), update that assertion and note it.

- [ ] **Step 5: Write `docs/a11y/contrast-audit.md`**

Contents: date, method (WCAG 2.1, thresholds), full matrix table with ratios per theme AFTER the fix, table of changed tokens (token, theme, before hex/ratio → after hex/ratio), exception list with reasons, out-of-scope notes (alpha overlays, non-text contrast) — mirror the spec's Out of scope section.

- [ ] **Step 6: Commit**

```bash
git add design/tokens.json apps/desktop/src/app.css apps/macos/cubelite/cubelite/Helpers/DesignTokens.swift apps/desktop/src/design/tokens-contrast.test.ts docs/a11y/contrast-audit.md
git commit -m "fix(design): WCAG AA contrast token pass, both themes"
```

---

## Delivery

- Single PR: `feat/120-a11y-contrast` → main. Titolo: `feat(design): WCAG AA contrast audit + token fixes (#120)`. PR body: per-token before/after hex + ratio table (from the audit report) so the user can eyeball the visual deltas.
- Push con `massilp`; merge dell'utente.
