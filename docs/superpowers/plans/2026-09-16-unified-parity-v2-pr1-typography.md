# Unified Parity v2 — PR 1: Type Scale v1.1, Swift Typography Tokens, Geist Bundle

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Both apps read one typography scale (v1.1) from `design/tokens.json`, the desktop has zero hard-coded pixel font sizes, and the macOS app renders Geist / Geist Mono through a token-driven `typeStyle` modifier.

**Architecture:** `design/export-tokens.ts` gains a typography parser (`design/type-style.ts`) and emits (a) a new generated CSS region with the `@utility type-*` classes and (b) a `DesignTokens.Typography` namespace in Swift. The macOS app bundles six Geist OTF weights; `ScaledFontModifier` starts routing to them so every existing `scaledFont` call switches family at once, and a new `TypeStyleModifier` layers the token sizes on top for new/touched code. Desktop components migrate their `text-[Npx]` classes to the generated utilities. No layout or view-structure changes in this PR.

**Tech Stack:** TypeScript + tsx (generator, `node:test`), Tailwind v4 `@utility`, Svelte 5, vitest/jsdom; Swift 6 / SwiftUI, macOS 14.6 target, XCTest, xcodebuild.

**Spec:** `docs/superpowers/specs/2026-09-16-unified-parity-v2-design.md` (§1 items 4, §2, §6, §7 PR 1).

## Global Constraints

- Branch: `design/unified-parity-v2` (already contains the spec). PR target: `main`.
- Commit messages: Conventional Commits, no AI attribution footer (repo rule).
- Every commit must build and pass tests for the stack it touches (AGENTS.md). Commands:
  - desktop: `pnpm --filter desktop lint && pnpm --filter desktop typecheck && pnpm --filter desktop test`
  - macOS build: `xcodebuild build-for-testing -project apps/macos/cubelite/cubelite.xcodeproj -scheme cubelite -destination 'platform=macOS' -derivedDataPath /tmp/cubelite-build`
  - macOS tests: `xcodebuild test-without-building -project apps/macos/cubelite/cubelite.xcodeproj -scheme cubelite -destination 'platform=macOS' -derivedDataPath /tmp/cubelite-build -skip-testing cubeliteUITests`
  - `LoadClientIdentityTests.testLoadClientIdentity_validECCertAndKey` is a known keychain flake; rerun once before treating it as a failure.
- Type scale v1.1 (verbatim from spec §2.1): display 600 28px sans · title 600 16px sans · subtitle 600 13.5px sans · body 500 13px sans · caption 400 11.5px sans · section 600 10px sans uppercase ls .07em · colhead 600 11px sans uppercase · data 500 12.5px mono · data-sm 400 12px mono · log 400 11.5px mono · stat 600 22px mono (new) · micro 500 10.5px sans (new).
- No font size below 10px anywhere (Apple HIG minimum, spec §1.4).
- Generated files (`apps/desktop/src/app.css` regions, `apps/macos/cubelite/cubelite/Helpers/DesignTokens.swift`) are never edited by hand; run `pnpm design:tokens` and commit the result.
- Fonts: Geist v1.7.2, OFL 1.1, from `https://github.com/vercel/geist-font/releases/download/v1.7.2/geist-font-v1.7.2.zip`. Only the six static OTFs listed in Task 5 are bundled (~1 MB).
- Swift namespace is `DesignTokens.Typography` (not `Type`: `X.Type` is metatype syntax in Swift).

---

## File map

| File | Responsibility |
|---|---|
| `design/tokens.json` | v1.1 `font.style` values, plus `$lineHeight` / `$color` presentation hints |
| `design/type-style.ts` (new) | Pure parser `parseTypeStyle("600 10px sans · uppercase · ls .07em")` shared by CSS and Swift emitters |
| `design/type-style.test.ts` (new) | `node:test` coverage for the parser |
| `design/export-tokens.ts` | Emits `@generated:type` CSS region and `DesignTokens.Typography` Swift block |
| `design/README.md` | Documents typography tokens and the new region |
| `package.json` (root) | `design:test` script |
| `apps/desktop/src/app.css` | Hand-written `@utility type-*` block replaced by generated region |
| `apps/desktop/src/lib/components/**/*.svelte` (24 files) | `text-[Npx]` → `type-*` utilities |
| `apps/macos/cubelite/cubelite/Resources/Fonts/*.otf` (new, 6 files) + `OFL.txt` | Bundled Geist |
| `apps/macos/cubelite/cubelite/Info.plist` | `ATSApplicationFontsPath` |
| `apps/macos/cubelite/cubelite/Helpers/AppFont.swift` (new) | PostScript-name mapping, availability probe, `Font` factory with SF fallback |
| `apps/macos/cubelite/cubelite/Helpers/ScaledFont.swift` | Routes through `AppFont` (family switch for all existing callers) |
| `apps/macos/cubelite/cubelite/Helpers/TypeStyle.swift` (new) | `typeStyle(_:color:)` modifier on top of `DesignTokens.Typography` |
| `apps/macos/cubelite/cubeliteTests/AppFontTests.swift` (new) | Name mapping + bundle availability |
| `apps/macos/cubelite/cubeliteTests/TypographyTokensTests.swift` (new) | Generated token values, ≥10pt rule |
| `CHANGELOG.md` | Unreleased entry |

---

### Task 1: Typography parser (`design/type-style.ts`)

**Files:**
- Create: `design/type-style.ts`
- Create: `design/type-style.test.ts`
- Modify: `package.json` (root) — add `design:test` script

**Interfaces:**
- Produces: `parseTypeStyle(value: string): TypeStyleSpec` where
  `TypeStyleSpec = { size: number; weight: 400|500|600|700; family: "sans"|"mono"; uppercase: boolean; tracking: number }` (tracking in em, 0 when absent). Used by Task 2 and Task 3.

- [ ] **Step 1: Write the failing test**

`design/type-style.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTypeStyle } from "./type-style.ts";

test("parses weight, size and family", () => {
  assert.deepEqual(parseTypeStyle("500 13px sans"), {
    size: 13,
    weight: 500,
    family: "sans",
    uppercase: false,
    tracking: 0,
  });
});

test("parses fractional sizes and mono family", () => {
  assert.deepEqual(parseTypeStyle("400 11.5px mono"), {
    size: 11.5,
    weight: 400,
    family: "mono",
    uppercase: false,
    tracking: 0,
  });
});

test("parses uppercase and letter-spacing flags", () => {
  assert.deepEqual(parseTypeStyle("600 10px sans · uppercase · ls .07em"), {
    size: 10,
    weight: 600,
    family: "sans",
    uppercase: true,
    tracking: 0.07,
  });
});

test("rejects unknown flags", () => {
  assert.throws(() => parseTypeStyle("600 10px sans · italic"), /Unknown typography flag/);
});

test("rejects malformed core", () => {
  assert.throws(() => parseTypeStyle("bold 10px sans"), /Bad typography token/);
});
```

- [ ] **Step 2: Add the script and run the test to verify it fails**

In root `package.json` `"scripts"`, add after `"design:tokens"`:

```json
"design:test": "tsx --test design/*.test.ts"
```

Run: `pnpm design:test`
Expected: FAIL — `Cannot find module './type-style.ts'`.

- [ ] **Step 3: Write the parser**

`design/type-style.ts`:

```ts
/**
 * design/type-style.ts
 *
 * Parses the compact typography token syntax used in design/tokens.json:
 *
 *   "<weight> <size>px <sans|mono>[ · uppercase][ · ls <em>em]"
 *
 * Shared by the CSS and Swift emitters in export-tokens.ts.
 */

export type TypeFamily = "sans" | "mono";
export type TypeWeight = 400 | 500 | 600 | 700;

export interface TypeStyleSpec {
  size: number;
  weight: TypeWeight;
  family: TypeFamily;
  uppercase: boolean;
  /** Letter spacing as a fraction of the font size (em). 0 when unset. */
  tracking: number;
}

const CORE = /^([4-7]00)\s+([\d.]+)px\s+(sans|mono)$/;
const LS = /^ls\s+([\d.]+)em$/;

export function parseTypeStyle(value: string): TypeStyleSpec {
  const [core = "", ...flags] = value.split("·").map((s) => s.trim());
  const m = CORE.exec(core);
  if (!m) throw new Error(`Bad typography token: ${value}`);
  let uppercase = false;
  let tracking = 0;
  for (const flag of flags) {
    const ls = LS.exec(flag);
    if (flag === "uppercase") uppercase = true;
    else if (ls) tracking = Number.parseFloat(ls[1]);
    else throw new Error(`Unknown typography flag "${flag}" in: ${value}`);
  }
  return {
    size: Number.parseFloat(m[2]),
    weight: Number(m[1]) as TypeWeight,
    family: m[3] as TypeFamily,
    uppercase,
    tracking,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm design:test`
Expected: `# pass 5`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add design/type-style.ts design/type-style.test.ts package.json
git commit -m "design(tokens): add typography token parser with node:test coverage"
```

---

### Task 2: Type scale v1.1 in tokens and generated CSS utilities

**Files:**
- Modify: `design/tokens.json` (`font.style` group)
- Modify: `design/export-tokens.ts` (Token interface, new region emitter)
- Modify: `apps/desktop/src/app.css` (replace hand-written `@utility type-*` block, lines ≈ 248–312, with region markers)
- Modify: `design/README.md` (Typography section)

**Interfaces:**
- Consumes: `parseTypeStyle` from Task 1.
- Produces: CSS utilities `type-display`, `type-title`, `type-subtitle`, `type-body`, `type-caption`, `type-section`, `type-colhead`, `type-data`, `type-data-sm`, `type-log`, `type-stat`, `type-micro` (used by Task 4). Token fields `$lineHeight?: string`, `$color?: string` (read by Task 3 only for validation of the schema, not emitted to Swift).

- [ ] **Step 1: Update `font.style` in `design/tokens.json`**

Replace the whole `"style"` object under `"font"` with:

```json
"style": {
  "display": {
    "$value": "600 28px sans",
    "$type": "typography",
    "$lineHeight": "1.25",
    "$color": "primary",
    "$description": "Onboarding hero only"
  },
  "title": {
    "$value": "600 16px sans",
    "$type": "typography",
    "$lineHeight": "1.3",
    "$color": "primary",
    "$description": "View titles"
  },
  "subtitle": {
    "$value": "600 13.5px sans",
    "$type": "typography",
    "$lineHeight": "1.3",
    "$color": "primary",
    "$description": "Modal titles, titlebar cluster name, card titles"
  },
  "body": {
    "$value": "500 13px sans",
    "$type": "typography",
    "$lineHeight": "1.4",
    "$description": "Nav, buttons, rows"
  },
  "caption": {
    "$value": "400 11.5px sans",
    "$type": "typography",
    "$lineHeight": "1.45",
    "$description": "Descriptions, meta, filter inputs"
  },
  "section": {
    "$value": "600 10px sans · uppercase · ls .07em",
    "$type": "typography",
    "$description": "Sidebar / palette section headers"
  },
  "colhead": {
    "$value": "600 11px sans · uppercase · ls .05em",
    "$type": "typography",
    "$color": "tertiary",
    "$description": "Table column headers, card labels"
  },
  "data": {
    "$value": "500 12.5px mono",
    "$type": "typography",
    "$description": "Resource names"
  },
  "data-sm": {
    "$value": "400 12px mono",
    "$type": "typography",
    "$description": "Cells, metrics"
  },
  "log": {
    "$value": "400 11.5px mono",
    "$type": "typography",
    "$description": "Log lines"
  },
  "stat": {
    "$value": "600 22px mono",
    "$type": "typography",
    "$color": "data-bright",
    "$description": "Stat card values"
  },
  "micro": {
    "$value": "500 10.5px sans",
    "$type": "typography",
    "$description": "Kbd chips, pills, counters, log meta — smallest allowed size"
  }
}
```

- [ ] **Step 2: Replace the hand-written utilities in `app.css` with region markers**

Delete everything from the comment `/* Typography styles from the design spec (sans for UI, mono strictly for data) */` through the closing `}` of `@utility type-log { … }` and put in its place exactly:

```css
/* @generated:type-start */
/* @generated:type-end */
```

Keep the `/* Motion (spec: keep ≤200ms, ease) */` block that follows untouched.

- [ ] **Step 3: Extend the generator**

In `design/export-tokens.ts`:

1. Add the import at the top (after the `node:url` import):

```ts
import { parseTypeStyle } from "./type-style.ts";
```

2. Extend the `Token` interface:

```ts
interface Token {
  $value: string;
  /** Light-theme counterpart; falls back to $value when omitted. */
  $light?: string;
  $type?: string;
  $description?: string;
  /** Typography only: CSS line-height (unitless). */
  $lineHeight?: string;
  /** Typography only: default text color, a key of the `text` group. */
  $color?: string;
}
```

3. After the `layerContent` definition and before `// ── Inject and write`, add:

```ts
// ── Build @generated:type block (Tailwind v4 @utility classes) ───────────────

const typeContent = entries(tk.font.style)
  .map(([name, value]) => {
    const meta = tk.font.style[name];
    const s = parseTypeStyle(value);
    if (s.size < 10) throw new Error(`Typography token "${name}" is below the 10px minimum`);
    if (meta.$color && !tk.text[meta.$color]) {
      throw new Error(`Typography token "${name}" references unknown text color "${meta.$color}"`);
    }
    const decls = [
      `  font-family: var(--font-${s.family});`,
      `  font-size: ${s.size}px;`,
      `  font-weight: ${s.weight};`,
    ];
    if (meta.$lineHeight) decls.push(`  line-height: ${meta.$lineHeight};`);
    if (s.tracking) decls.push(`  letter-spacing: ${s.tracking}em;`);
    if (s.uppercase) decls.push(`  text-transform: uppercase;`);
    if (meta.$color) decls.push(`  color: var(--color-text-${meta.$color});`);
    return `@utility type-${name} {\n${decls.join("\n")}\n}`;
  })
  .join("\n");
```

4. In the inject section, add a third `injectRegion` call after the `layer` one:

```ts
css = injectRegion(css, "/* @generated:type-start */", "/* @generated:type-end */", typeContent);
```

5. Update the header doc comment list with a third bullet:

```
 *   @generated:type   — `@utility type-*` typography classes (family, size,
 *                       weight, line-height, tracking, case, default color)
```

- [ ] **Step 4: Run the generator and inspect the output**

Run: `pnpm design:tokens && git diff --stat`
Expected: `app.css` and `DesignTokens.swift` listed (Swift only if whitespace changed; content is unchanged in this task). Then:

Run: `sed -n '/@generated:type-start/,/@generated:type-end/p' apps/desktop/src/app.css`
Expected: twelve `@utility type-…` blocks; `type-body` has `font-size: 13px;`, `type-section` has `font-size: 10px;` + `letter-spacing: 0.07em;` + `text-transform: uppercase;`, `type-colhead` ends with `color: var(--color-text-tertiary);`, `type-stat` is `var(--font-mono)` 22px 600 with `color: var(--color-text-data-bright);`, `type-micro` is 10.5px 500.

- [ ] **Step 5: Verify the desktop still builds and tests pass**

Run: `pnpm --filter desktop lint && pnpm --filter desktop typecheck && pnpm --filter desktop test`
Expected: all green (no component uses the new utilities yet; existing ones keep their names).

- [ ] **Step 6: Document in `design/README.md`**

Replace the `### 6. Typography` section with:

```markdown
### 6. Typography

`--font-sans` = Geist (UI), `--font-mono` = Geist Mono (data only: names, metrics, IPs, logs).

`font.style.*` tokens use the compact syntax `"<weight> <size>px <sans|mono>[ · uppercase][ · ls <em>em]"`
plus optional `$lineHeight` and `$color` (a key of the `text` group). The generator emits one
Tailwind `@utility type-<name>` per token inside the `@generated:type` region of `app.css`, and a
`DesignTokens.Typography.<name>` style for SwiftUI. Sizes below 10px are rejected (Apple HIG floor).

| Token | Value | Use |
|---|---|---|
| display | 600 28px sans | onboarding hero |
| title | 600 16px sans | view titles |
| subtitle | 600 13.5px sans | modal/card titles, titlebar cluster name |
| body | 500 13px sans | nav, buttons, rows |
| caption | 400 11.5px sans | descriptions, meta, filter inputs |
| section | 600 10px sans · uppercase · ls .07em | section headers |
| colhead | 600 11px sans · uppercase · ls .05em | column headers, card labels |
| data | 500 12.5px mono | resource names |
| data-sm | 400 12px mono | cells, metrics |
| log | 400 11.5px mono | log lines |
| stat | 600 22px mono | stat card values |
| micro | 500 10.5px sans | kbd, pills, counters, log meta |

Components must use these utilities (optionally combined with `font-mono`, `font-normal`,
`font-semibold`, `uppercase`); hard-coded `text-[Npx]` classes are not allowed.
```

Also update the "Updating tokens" list: step 3 becomes `Commit tokens.json, apps/desktop/src/app.css and apps/macos/cubelite/cubelite/Helpers/DesignTokens.swift`.

- [ ] **Step 7: Commit**

```bash
git add design/tokens.json design/export-tokens.ts design/README.md apps/desktop/src/app.css apps/macos/cubelite/cubelite/Helpers/DesignTokens.swift
git commit -m "design(tokens): type scale v1.1 and generated type-* utilities"
```

---

### Task 3: Swift `DesignTokens.Typography` emission

**Files:**
- Modify: `design/export-tokens.ts` (Swift template)
- Generated: `apps/macos/cubelite/cubelite/Helpers/DesignTokens.swift`
- Create: `apps/macos/cubelite/cubeliteTests/TypographyTokensTests.swift`

**Interfaces:**
- Consumes: `parseTypeStyle` (Task 1).
- Produces (Swift, public in module `cubelite`):

```swift
extension DesignTokens {
    public enum Typography {
        public struct Style: Sendable, Equatable {
            public let size: CGFloat
            public let weight: Font.Weight
            public let mono: Bool
            public let uppercase: Bool
            public let tracking: CGFloat   // em
        }
        public static let display: Style … public static let micro: Style
        public static let all: [(name: String, style: Style)]
    }
}
```
Used by Task 6 (`typeStyle`) and by PR 2/3.

- [ ] **Step 1: Write the failing test**

`apps/macos/cubelite/cubeliteTests/TypographyTokensTests.swift`:

```swift
import SwiftUI
import XCTest

@testable import cubelite

/// Guards the generated `DesignTokens.Typography` block against drift from
/// design/tokens.json (type scale v1.1).
final class TypographyTokensTests: XCTestCase {

    func testBody_isGeistMedium13() {
        let s = DesignTokens.Typography.body
        XCTAssertEqual(s.size, 13)
        XCTAssertEqual(s.weight, .medium)
        XCTAssertFalse(s.mono)
        XCTAssertFalse(s.uppercase)
        XCTAssertEqual(s.tracking, 0)
    }

    func testSection_isUppercaseTracked10() {
        let s = DesignTokens.Typography.section
        XCTAssertEqual(s.size, 10)
        XCTAssertEqual(s.weight, .semibold)
        XCTAssertTrue(s.uppercase)
        XCTAssertEqual(s.tracking, 0.07, accuracy: 0.0001)
    }

    func testStat_isMono22Semibold() {
        let s = DesignTokens.Typography.stat
        XCTAssertEqual(s.size, 22)
        XCTAssertEqual(s.weight, .semibold)
        XCTAssertTrue(s.mono)
    }

    func testAll_containsTwelveStylesNoneBelowTenPoints() {
        let all = DesignTokens.Typography.all
        XCTAssertEqual(all.count, 12)
        for entry in all {
            XCTAssertGreaterThanOrEqual(entry.style.size, 10, "\(entry.name) is below the HIG minimum")
        }
        XCTAssertEqual(all.map(\.name), [
            "display", "title", "subtitle", "body", "caption", "section",
            "colhead", "data", "dataSm", "log", "stat", "micro",
        ])
    }
}
```

- [ ] **Step 2: Build for testing to verify it fails**

Run: `xcodebuild build-for-testing -project apps/macos/cubelite/cubelite.xcodeproj -scheme cubelite -destination 'platform=macOS' -derivedDataPath /tmp/cubelite-build 2>&1 | grep -E 'error:|BUILD' | head`
Expected: `error: type 'DesignTokens' has no member 'Typography'` … `** TEST BUILD FAILED **`.

- [ ] **Step 3: Extend the Swift template in the generator**

In `design/export-tokens.ts`, before `const swiftContent = …`, add:

```ts
const SWIFT_WEIGHT: Record<number, string> = {
  400: ".regular",
  500: ".medium",
  600: ".semibold",
  700: ".bold",
};

const swiftTypographyLines = entries(tk.font.style)
  .map(([name, value]) => {
    const s = parseTypeStyle(value);
    return `        public static let ${camel(name)} = Style(size: ${s.size}, weight: ${SWIFT_WEIGHT[s.weight]}, mono: ${s.family === "mono"}, uppercase: ${s.uppercase}, tracking: ${s.tracking})`;
  })
  .join("\n");

const swiftTypographyAll = entries(tk.font.style)
  .map(([name]) => `            (name: "${camel(name)}", style: ${camel(name)}),`)
  .join("\n");
```

(`camel` is already defined further down in the file — move the `function camel` declaration above this block.)

Then, inside the `swiftContent` template, after the `// MARK: - Density (pt)` block and before the `/// Appearance-aware color…` doc comment, insert:

```ts
    // MARK: - Typography (type scale v1.1)
    public enum Typography {
        /// One design-system text style. \`tracking\` is a fraction of the font
        /// size (em). Apply with \`View.typeStyle(_:color:)\`.
        public struct Style: Sendable, Equatable {
            public let size: CGFloat
            public let weight: Font.Weight
            public let mono: Bool
            public let uppercase: Bool
            public let tracking: CGFloat
        }

${swiftTypographyLines}

        /// Every style, in token order — for lint-style tests.
        public static let all: [(name: String, style: Style)] = [
${swiftTypographyAll}
        ]
    }
```

Also update the generated-file header comment from `Unified Design System v1 bridge` to `Unified Design System v1.1 bridge`.

- [ ] **Step 4: Regenerate and run the macOS tests**

Run: `pnpm design:tokens && grep -n 'public static let body\|public static let dataSm\|enum Typography' apps/macos/cubelite/cubelite/Helpers/DesignTokens.swift`
Expected: three matching lines; `body = Style(size: 13, weight: .medium, mono: false, uppercase: false, tracking: 0)`.

Run: build-for-testing (Global Constraints), then
`xcodebuild test-without-building … -only-testing:cubeliteTests/TypographyTokensTests 2>&1 | grep -E 'Test Case.*(passed|failed)|TEST'`
Expected: 4 passed, `** TEST SUCCEEDED **`.

- [ ] **Step 5: Commit**

```bash
git add design/export-tokens.ts apps/macos/cubelite/cubelite/Helpers/DesignTokens.swift apps/macos/cubelite/cubeliteTests/TypographyTokensTests.swift
git commit -m "design(tokens): emit DesignTokens.Typography for SwiftUI"
```

---

### Task 4: Desktop — replace every `text-[Npx]` with a `type-*` utility

**Files:**
- Modify (24 files, 38 occurrences): listed in the mapping table below.

**Interfaces:**
- Consumes: utilities from Task 2.
- Produces: nothing new; the invariant "zero `text-[Npx]` under `apps/desktop/src`" that PR 4's lint will enforce.

Mapping rules (apply exactly; keep every other class on the element):

| Old class(es) | New class(es) | Why |
|---|---|---|
| `font-mono text-[22px] font-semibold` | `type-stat` | stat values |
| `text-[13.5px]` (palette input) | `type-subtitle font-normal` | spec §2.4 |
| `font-mono text-[12px] font-medium` | `type-data` | mini-stat values |
| `font-mono text-[11.5px]` | `type-data-sm` | mono cells / namespace values |
| `text-[11.5px]` on table status cells | `type-data-sm` | table cells are data |
| `text-[11.5px]` on inputs / prose | `type-caption` | sans 11.5 |
| `text-[11px]` | `type-caption` | sans meta |
| `font-mono text-[10.5px]` / `font-mono text-[10px]` / `font-mono text-[9.5px]` | `type-micro font-mono` (+ keep `font-semibold` / `uppercase` if present) | mono meta ≥ 10.5px |
| `text-[10.5px] font-medium` / `text-[10px]` (sans) | `type-micro` | pills, kbd-less chips, toast close |

- [ ] **Step 1: Apply the per-file edits**

| File:line | Replace | With |
|---|---|---|
| `components/DeploymentTable.svelte:63` | `text-[11.5px]` | `type-data-sm` |
| `components/PodTable.svelte:61` | `text-[11.5px]` | `type-data-sm` |
| `components/OnboardingModal.svelte:43` | `text-[11px] text-text-secondary` | `type-caption text-text-secondary` |
| `components/OnboardingModal.svelte:47` | `text-[11px] text-status-ok` | `type-caption text-status-ok` |
| `components/PreferencesModal.svelte:86` | `text-[11px] text-text-secondary` | `type-caption text-text-secondary` |
| `components/ui/Kbd.svelte:6` | `font-mono text-[10px] font-medium text-text-disabled` | `type-micro font-mono text-text-disabled` |
| `components/CommandPalette.svelte:88` | `text-[13.5px] text-text-primary` | `type-subtitle font-normal text-text-primary` |
| `components/CommandPalette.svelte:115` | `font-mono text-[10px] font-medium` | `type-micro font-mono` |
| `components/ui/StatusPill.svelte:15` | `text-[10.5px] font-medium` | `type-micro` |
| `components/ui/MeterBar.svelte:27` | `font-mono text-[10.5px] text-text-tertiary` | `type-micro font-mono text-text-tertiary` |
| `components/ui/Toaster.svelte:20` | `text-[10px] text-text-tertiary` | `type-micro text-text-tertiary` |
| `components/ui/NamespaceDropdown.svelte:19` | `font-mono text-[11.5px] text-text-primary` | `type-data-sm text-text-primary` |
| `components/ui/NamespaceDropdown.svelte:41` | `font-mono text-[11.5px]` | `type-data-sm` |
| `components/ui/StatCard.svelte:20` | `font-mono text-[22px] font-semibold` | `type-stat` |
| `components/shell/StatusBar.svelte:23` | `font-mono text-[10.5px] text-text-tertiary` | `type-micro font-mono text-text-tertiary` |
| `components/shell/Sidebar.svelte:92,95` | `font-mono text-[10.5px] text-status-err` | `type-micro font-mono text-status-err` |
| `components/shell/Sidebar.svelte:98` | `font-mono text-[10.5px] text-text-tertiary` | `type-micro font-mono text-text-tertiary` |
| `components/shell/Titlebar.svelte:55` | `font-mono text-[10px] font-medium` | `type-micro font-mono` |
| `components/logpanel/LogLineRow.svelte:61` | `font-mono text-[10.5px] text-text-disabled` | `type-micro font-mono text-text-disabled` |
| `components/logpanel/LogLineRow.svelte:65` | `font-mono text-[9.5px] font-semibold` | `type-micro font-mono font-semibold` |
| `components/logpanel/LogLineRow.svelte:70` | `font-mono text-[10px] font-semibold uppercase` | `type-micro font-mono font-semibold uppercase` |
| `components/logpanel/LogToolbar.svelte:169` | `text-[11.5px] text-text-primary` | `type-caption text-text-primary` |
| `components/pods/PodDrawer.svelte:145,153,173` | `text-[11px]` | `type-caption` |
| `components/views/PodsView.svelte:38` | `text-[11.5px] text-text-primary` | `type-caption text-text-primary` |
| `components/views/DeploymentsView.svelte:23` | `text-[11.5px] text-text-primary` | `type-caption text-text-primary` |
| `components/views/EventsView.svelte:33` | `text-[10.5px] font-medium` | `type-micro` |
| `components/views/SecretsView.svelte:32` | `text-[10.5px] font-medium` | `type-micro` |
| `components/views/UnreachableView.svelte:21` | `text-[11.5px] text-text-tertiary` | `type-caption text-text-tertiary` |
| `components/views/LogsView.svelte:92,117` | `text-[11px]` / `text-[11.5px]` (+`text-text-primary`) | `type-caption text-text-primary` |
| `components/views/LogsView.svelte:160` | `font-mono text-[10.5px] text-text-disabled` | `type-micro font-mono text-text-disabled` |
| `components/views/LogsView.svelte:162` | `font-mono text-[10px] font-semibold uppercase` | `type-micro font-mono font-semibold uppercase` |
| `components/views/LogsView.svelte:167` | `font-mono text-[10.5px] text-text-secondary` | `type-micro font-mono text-text-secondary` |
| `components/views/AllClustersView.svelte:90` | `font-mono text-[10.5px] text-text-tertiary` | `type-micro font-mono text-text-tertiary` |
| `components/views/AllClustersView.svelte:103` | `font-mono text-[12px] font-medium` | `type-data` |

(Paths relative to `apps/desktop/src/lib/`.) Line numbers are from the branch base; confirm each with `grep -n 'text-\[' <file>` before editing. Where the original had `font-mono` before the size class, the mono override must stay **after** the `type-*` class as written above.

- [ ] **Step 2: Verify the invariant**

Run: `grep -rnE 'text-\[[0-9.]+px\]' apps/desktop/src --include='*.svelte' | wc -l`
Expected: `0`.

- [ ] **Step 3: Verify utility override order in the built CSS**

Tailwind v4 orders utilities so that single-declaration utilities (`font-mono`, `font-normal`, `font-semibold`, `uppercase`) are emitted after multi-declaration custom utilities. Confirm on the real build:

Run: `pnpm --filter desktop build >/dev/null && f=$(ls apps/desktop/build/_app/immutable/assets/*.css | head -1) && python3 -c "import sys;c=open('$f').read();a=c.find('.type-micro{');b=c.find('.font-mono{');print('ok' if 0<=a<b else f'BAD a={a} b={b}')"`
Expected: `ok`. If `BAD`, add `@layer utilities` ordering is not the fix — instead swap to the explicit form on the affected elements: keep `type-micro` and add `[font-family:var(--font-mono)]` in place of `font-mono` (arbitrary property utilities always win). Record any such element in the PR description.

- [ ] **Step 4: Run desktop lint, typecheck and tests**

Run: `pnpm --filter desktop lint && pnpm --filter desktop typecheck && pnpm --filter desktop test`
Expected: all green.

- [ ] **Step 5: Visual check**

Run: `pnpm --filter desktop tauri:dev` (background), open Overview, Pods, Logs, ⌘K. Confirm: stat values still 22px mono; kbd chips and pills readable at 10.5px; nothing wraps in the sidebar counts or status bar. Take one screenshot of Overview for the PR.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/lib/components
git commit -m "style(desktop): migrate hard-coded px font sizes to type-* utilities"
```

---

### Task 5: Bundle Geist and Geist Mono in the macOS app

**Files:**
- Create: `apps/macos/cubelite/cubelite/Resources/Fonts/Geist-Regular.otf`, `Geist-Medium.otf`, `Geist-SemiBold.otf`, `GeistMono-Regular.otf`, `GeistMono-Medium.otf`, `GeistMono-SemiBold.otf`, `OFL.txt`
- Modify: `apps/macos/cubelite/cubelite/Info.plist`
- Create: `apps/macos/cubelite/cubelite/Helpers/AppFont.swift`
- Create: `apps/macos/cubelite/cubeliteTests/AppFontTests.swift`

**Interfaces:**
- Produces:

```swift
enum AppFont {
    /// PostScript name of the bundled weight closest to `weight`.
    static func postScriptName(mono: Bool, weight: Font.Weight) -> String
    /// True when CoreText resolved the bundled family (false in previews / missing resource).
    static let isAvailable: Bool
    /// Geist / Geist Mono at `size`, or the SF equivalent when unavailable.
    static func font(mono: Bool, weight: Font.Weight, size: CGFloat) -> Font
}
```
Used by Task 6.

- [ ] **Step 1: Write the failing test**

`apps/macos/cubelite/cubeliteTests/AppFontTests.swift`:

```swift
import AppKit
import SwiftUI
import XCTest

@testable import cubelite

final class AppFontTests: XCTestCase {

    // MARK: PostScript name mapping (three bundled weights per family)

    func testPostScriptName_sansRegular() {
        XCTAssertEqual(AppFont.postScriptName(mono: false, weight: .regular), "Geist-Regular")
    }

    func testPostScriptName_sansMedium() {
        XCTAssertEqual(AppFont.postScriptName(mono: false, weight: .medium), "Geist-Medium")
    }

    func testPostScriptName_sansSemibold() {
        XCTAssertEqual(AppFont.postScriptName(mono: false, weight: .semibold), "Geist-SemiBold")
    }

    func testPostScriptName_boldClampsToSemibold() {
        XCTAssertEqual(AppFont.postScriptName(mono: false, weight: .bold), "Geist-SemiBold")
        XCTAssertEqual(AppFont.postScriptName(mono: true, weight: .heavy), "GeistMono-SemiBold")
    }

    func testPostScriptName_lightClampsToRegular() {
        XCTAssertEqual(AppFont.postScriptName(mono: false, weight: .light), "Geist-Regular")
        XCTAssertEqual(AppFont.postScriptName(mono: true, weight: .thin), "GeistMono-Regular")
    }

    func testPostScriptName_mono() {
        XCTAssertEqual(AppFont.postScriptName(mono: true, weight: .medium), "GeistMono-Medium")
    }

    // MARK: Bundle registration (ATSApplicationFontsPath)

    func testBundledFonts_resolveThroughCoreText() {
        for name in [
            "Geist-Regular", "Geist-Medium", "Geist-SemiBold",
            "GeistMono-Regular", "GeistMono-Medium", "GeistMono-SemiBold",
        ] {
            XCTAssertNotNil(NSFont(name: name, size: 13), "\(name) is not registered — check Resources/Fonts and ATSApplicationFontsPath")
        }
        XCTAssertTrue(AppFont.isAvailable)
    }
}
```

- [ ] **Step 2: Build for testing to verify it fails**

Run: build-for-testing (Global Constraints) `| grep -E 'error:' | head -3`
Expected: `cannot find 'AppFont' in scope`.

- [ ] **Step 3: Add the font files and licence**

```bash
S=/tmp/geist-src && mkdir -p "$S" && cd "$S" \
 && curl -sL -o geist.zip https://github.com/vercel/geist-font/releases/download/v1.7.2/geist-font-v1.7.2.zip \
 && unzip -qo geist.zip
D=apps/macos/cubelite/cubelite/Resources/Fonts
cd /Users/massimilianolapuma/projects/personal/cubelite && mkdir -p "$D"
cp "$S"/geist-font/Geist/otf/Geist-{Regular,Medium,SemiBold}.otf "$D"/
cp "$S"/geist-font/GeistMono/otf/GeistMono-{Regular,Medium,SemiBold}.otf "$D"/
cp "$S"/geist-font/OFL.txt "$D"/OFL.txt
ls -la "$D"
```

Expected: six `.otf` files (each 155–180 KB) plus `OFL.txt`. The `cubelite` folder is a `PBXFileSystemSynchronizedRootGroup`, so Xcode picks the new files up without editing `project.pbxproj`.

- [ ] **Step 4: Register the fonts directory in `Info.plist`**

Inside the top-level `<dict>` of `apps/macos/cubelite/cubelite/Info.plist`, after the `NSAppTransportSecurity` entry, add:

```xml
	<!-- Bundled Geist / Geist Mono (OFL 1.1, Resources/Fonts/OFL.txt). -->
	<key>ATSApplicationFontsPath</key>
	<string>Fonts</string>
```

Then build once and check where Xcode copied the files:

Run: build-for-testing, then `find /tmp/cubelite-build/Build/Products/Debug/cubelite.app/Contents/Resources -name 'Geist*.otf' | head -2`
- If the paths contain `/Resources/Fonts/`: keep `<string>Fonts</string>`.
- If the files sit directly in `/Resources/`: change the value to `<string>.</string>` (CoreText accepts `.` for the Resources root).

- [ ] **Step 5: Write `AppFont.swift`**

`apps/macos/cubelite/cubelite/Helpers/AppFont.swift`:

```swift
import AppKit
import SwiftUI

// MARK: - Bundled Geist families

/// Access to the Geist / Geist Mono weights shipped in `Resources/Fonts`
/// (registered by `ATSApplicationFontsPath`). The design system uses only
/// 400 / 500 / 600; other weights clamp to the nearest bundled file.
///
/// Falls back to the SF system font when the bundle is unavailable (Xcode
/// previews, missing resource), so text never disappears.
enum AppFont {

    /// PostScript name of the bundled weight closest to `weight`.
    nonisolated static func postScriptName(mono: Bool, weight: Font.Weight) -> String {
        let family = mono ? "GeistMono" : "Geist"
        switch weight {
        case .ultraLight, .thin, .light, .regular:
            return "\(family)-Regular"
        case .medium:
            return "\(family)-Medium"
        default:  // .semibold, .bold, .heavy, .black
            return "\(family)-SemiBold"
        }
    }

    /// True once CoreText can resolve the bundled regular weight.
    static let isAvailable: Bool = NSFont(name: "Geist-Regular", size: 13) != nil

    /// Geist / Geist Mono at `size`, or the SF equivalent when unavailable.
    static func font(mono: Bool, weight: Font.Weight, size: CGFloat) -> Font {
        guard isAvailable else {
            return .system(size: size, weight: weight, design: mono ? .monospaced : .default)
        }
        return .custom(postScriptName(mono: mono, weight: weight), size: size)
    }
}
```

- [ ] **Step 6: Build and run the new tests**

Run: build-for-testing, then `xcodebuild test-without-building … -only-testing:cubeliteTests/AppFontTests 2>&1 | grep -E 'Test Case.*(passed|failed)|TEST'`
Expected: 7 passed, `** TEST SUCCEEDED **`. If `testBundledFonts_resolveThroughCoreText` fails, revisit Step 4 (path value) — nothing else can cause it.

- [ ] **Step 7: Commit**

```bash
git add apps/macos/cubelite/cubelite/Resources/Fonts apps/macos/cubelite/cubelite/Info.plist apps/macos/cubelite/cubelite/Helpers/AppFont.swift apps/macos/cubelite/cubeliteTests/AppFontTests.swift
git commit -m "feat(macos): bundle Geist and Geist Mono (OFL) with AppFont resolver"
```

---

### Task 6: `typeStyle` modifier and Geist routing for `scaledFont`

**Files:**
- Modify: `apps/macos/cubelite/cubelite/Helpers/ScaledFont.swift` (`ScaledFontModifier.body`)
- Create: `apps/macos/cubelite/cubelite/Helpers/TypeStyle.swift`
- Create: `apps/macos/cubelite/cubeliteTests/TypeStyleTests.swift`

**Interfaces:**
- Consumes: `AppFont` (Task 5), `DesignTokens.Typography.Style` (Task 3), `ScaledFontModifier.anchor(for:)` (existing).
- Produces:

```swift
extension View {
    /// Design-system text style (Geist / Geist Mono, Dynamic Type scaled).
    /// `color` is applied only when given, so callers can keep inherited colors.
    func typeStyle(_ style: DesignTokens.Typography.Style, color: Color? = nil) -> some View
}
struct TypeStyleModifier: ViewModifier { init(style: DesignTokens.Typography.Style) }
```
Used by PR 2 and PR 3 for every new or touched label.

- [ ] **Step 1: Write the failing test**

`apps/macos/cubelite/cubeliteTests/TypeStyleTests.swift`:

```swift
import SwiftUI
import XCTest

@testable import cubelite

@MainActor
final class TypeStyleTests: XCTestCase {

    func testModifier_usesAnchorBucketOfTheStyleSize() {
        // body (13) → .title3 bucket, micro (10.5) → .body, section (10) → .caption
        XCTAssertEqual(TypeStyleModifier(style: DesignTokens.Typography.body).anchor, .title3)
        XCTAssertEqual(TypeStyleModifier(style: DesignTokens.Typography.micro).anchor, .body)
        XCTAssertEqual(TypeStyleModifier(style: DesignTokens.Typography.section).anchor, .caption)
    }

    func testModifier_keepsTokenSizeAtDefaultTextSize() {
        XCTAssertEqual(TypeStyleModifier(style: DesignTokens.Typography.stat).size, 22)
    }

    func testTrackingPoints_isEmTimesSize() {
        let m = TypeStyleModifier(style: DesignTokens.Typography.section)
        XCTAssertEqual(m.trackingPoints, 0.07 * 10, accuracy: 0.0001)
        XCTAssertEqual(TypeStyleModifier(style: DesignTokens.Typography.body).trackingPoints, 0)
    }

    func testTextCase_onlyForUppercaseStyles() {
        XCTAssertEqual(TypeStyleModifier(style: DesignTokens.Typography.colhead).textCase, .uppercase)
        XCTAssertNil(TypeStyleModifier(style: DesignTokens.Typography.body).textCase)
    }

    func testView_typeStyle_compiles() {
        _ = Text("x").typeStyle(DesignTokens.Typography.body)
        _ = Text("x").typeStyle(DesignTokens.Typography.stat, color: DesignTokens.textDataBright)
    }
}
```

- [ ] **Step 2: Build for testing to verify it fails**

Run: build-for-testing `| grep -E 'error:' | head -3`
Expected: `cannot find 'TypeStyleModifier' in scope`.

- [ ] **Step 3: Write `TypeStyle.swift`**

`apps/macos/cubelite/cubelite/Helpers/TypeStyle.swift`:

```swift
import SwiftUI

// MARK: - Design-system text styles

/// Applies a `DesignTokens.Typography.Style`: bundled Geist / Geist Mono via
/// `AppFont`, size scaled with `@ScaledMetric` along the same anchor buckets
/// as `scaledFont`, plus tracking and uppercase when the token asks for them.
struct TypeStyleModifier: ViewModifier {
    @ScaledMetric var size: CGFloat
    let style: DesignTokens.Typography.Style
    let anchor: Font.TextStyle

    init(style: DesignTokens.Typography.Style) {
        let anchor = ScaledFontModifier.anchor(for: style.size)
        _size = ScaledMetric(wrappedValue: style.size, relativeTo: anchor)
        self.style = style
        self.anchor = anchor
    }

    /// Letter spacing in points at the current (scaled) size.
    var trackingPoints: CGFloat { style.tracking * size }

    /// `.uppercase` for section/colhead styles, nil otherwise (inherit).
    var textCase: Text.Case? { style.uppercase ? .uppercase : nil }

    func body(content: Content) -> some View {
        content
            .font(AppFont.font(mono: style.mono, weight: style.weight, size: size))
            .tracking(trackingPoints)
            .textCase(textCase)
    }
}

/// Applies `color` only when provided, so `typeStyle` never clobbers an
/// inherited foreground style.
private struct OptionalForeground: ViewModifier {
    let color: Color?

    @ViewBuilder
    func body(content: Content) -> some View {
        if let color {
            content.foregroundStyle(color)
        } else {
            content
        }
    }
}

extension View {
    /// Design-system text style (Geist / Geist Mono, Dynamic Type scaled).
    ///
    ///     Text("Pods").typeStyle(DesignTokens.Typography.subtitle)
    ///     Text("107").typeStyle(DesignTokens.Typography.stat, color: DesignTokens.textDataBright)
    func typeStyle(_ style: DesignTokens.Typography.Style, color: Color? = nil) -> some View {
        modifier(TypeStyleModifier(style: style)).modifier(OptionalForeground(color: color))
    }
}
```

- [ ] **Step 4: Route `scaledFont` through the bundled family**

In `apps/macos/cubelite/cubelite/Helpers/ScaledFont.swift`, replace the `body(content:)` of `ScaledFontModifier`:

```swift
    func body(content: Content) -> some View {
        // Family switch for the whole app: every existing scaledFont call now
        // renders Geist / Geist Mono (SF fallback inside AppFont). Sizes and
        // Dynamic Type scaling are unchanged.
        content.font(AppFont.font(mono: design == .monospaced, weight: weight, size: size))
    }
```

and update the type's doc comment first line to: `/// Wraps a Geist / Geist Mono font (via AppFont) in @ScaledMetric so primary`.

- [ ] **Step 5: Build, run the full macOS suite**

Run: build-for-testing, then the full `test-without-building` command from Global Constraints `2>&1 | grep -E 'Test Suite .*(passed|failed)|Executed|TEST'`
Expected: `** TEST SUCCEEDED **`; `TypeStyleTests` 5 passed; `ScaledFontTests` unchanged and green.

- [ ] **Step 6: Visual check**

Run: `xcodebuild build -project apps/macos/cubelite/cubelite.xcodeproj -scheme cubelite -configuration Debug -destination 'platform=macOS' -derivedDataPath /tmp/cubelite-build -quiet && open /tmp/cubelite-build/Build/Products/Debug/cubelite.app`
Confirm the sidebar, header and status bar now render in Geist (compare letterforms "g", "a" against the desktop app). Titles inside `OverviewView` still use `.font(.system…)` and stay SF — expected, they are PR 3 scope. Screenshot the Overview for the PR.

- [ ] **Step 7: Commit**

```bash
git add apps/macos/cubelite/cubelite/Helpers/ScaledFont.swift apps/macos/cubelite/cubelite/Helpers/TypeStyle.swift apps/macos/cubelite/cubeliteTests/TypeStyleTests.swift
git commit -m "feat(macos): typeStyle modifier and Geist routing for scaledFont"
```

---

### Task 7: Changelog, issue and pull request

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Changelog entry**

Under `## [Unreleased]` add:

```markdown
### Changed

- **Type scale v1.1** (both apps): body 13px, caption 11.5px, section 10px,
  column headers 11px, data 12.5px; new `stat` and `micro` styles. The scale is
  generated from `design/tokens.json` into Tailwind `type-*` utilities and
  `DesignTokens.Typography` for SwiftUI; no size falls below the 10pt HIG floor.
- **macOS**: Geist and Geist Mono (OFL 1.1) are bundled and used by every
  `scaledFont` call and the new `typeStyle` modifier — same families as the
  desktop app.
```

- [ ] **Step 2: Full verification on both stacks**

Run: `pnpm design:test && pnpm design:tokens && git diff --exit-code --stat -- apps/desktop/src/app.css apps/macos/cubelite/cubelite/Helpers/DesignTokens.swift && pnpm --filter desktop lint && pnpm --filter desktop typecheck && pnpm --filter desktop test`
Expected: generator produces no diff (committed output is current); all desktop checks green.

Run: macOS build-for-testing + test-without-building (Global Constraints).
Expected: `** TEST SUCCEEDED **`.

- [ ] **Step 3: Commit and push**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): type scale v1.1 and bundled Geist"
git push -u origin design/unified-parity-v2
```

(Push uses the personal `massilp` GitHub account — switch with `gh auth switch --user massilp` if the active account is the work one.)

- [ ] **Step 4: Issue and PR**

```bash
gh issue create \
  --title "design: type scale v1.1, Swift typography tokens, bundled Geist (unified parity v2 — PR 1/4)" \
  --label "area:design,area:desktop,area:macos,type:feat" \
  --body "$(cat <<'EOF'
Part 1 of 4 of the unified parity effort — spec: docs/superpowers/specs/2026-09-16-unified-parity-v2-design.md (§2).

- Type scale v1.1 in design/tokens.json, generated `type-*` utilities and `DesignTokens.Typography`
- Desktop: zero hard-coded `text-[Npx]`
- macOS: Geist + Geist Mono bundled, `typeStyle` modifier, `scaledFont` routed to Geist
EOF
)"
```

Take the issue number `N` from the output, then:

```bash
gh pr create --base main --head design/unified-parity-v2 \
  --title "design(tokens): type scale v1.1, Swift typography tokens, bundled Geist" \
  --label "area:design,area:desktop,area:macos,type:feat,status:review" \
  --body "$(cat <<'EOF'
Closes #N

## What
- `design/tokens.json` type scale v1.1 (body 13 / caption 11.5 / section 10 / colhead 11 / data 12.5 / data-sm 12 / log 11.5, new `stat` 22 mono and `micro` 10.5) with a shared parser (`design/type-style.ts`, node:test).
- Generator emits the `@generated:type` CSS region (`type-*` utilities) and `DesignTokens.Typography` for SwiftUI; sizes < 10px are rejected.
- Desktop: all 38 `text-[Npx]` classes migrated to `type-*` utilities.
- macOS: Geist / Geist Mono OTF (OFL 1.1) bundled via `ATSApplicationFontsPath`; `AppFont` resolver with SF fallback; `scaledFont` now renders Geist app-wide; new `typeStyle(_:color:)` modifier for token-driven labels.

## Spec
docs/superpowers/specs/2026-09-16-unified-parity-v2-design.md — §2, §6, §7 (PR 1/4). No layout changes; PR 2 (native shell + Events), PR 3 (overview parity) and PR 4 (design lint + audit) follow on top.

## Verification
- `pnpm design:test`, `pnpm design:tokens` (no diff), desktop lint/typecheck/test
- macOS `xcodebuild` build + unit tests (TypographyTokensTests, AppFontTests, TypeStyleTests)
- Screenshots: desktop Overview and macOS Overview attached (dark, default text size)
EOF
)"
```

Attach the two screenshots from Task 4 Step 5 and Task 6 Step 6 as a PR comment (`gh pr comment <num> --body-file` with the images uploaded through the web UI if `gh` cannot attach binaries).

- [ ] **Step 5: Watch CI**

Run: `gh pr checks --watch`
Expected: `ci` (desktop lint / check / test, Rust) and `ci-macos` green. On a macOS failure that names `LoadClientIdentityTests.testLoadClientIdentity_validECCertAndKey` only, re-run the job once before investigating.

---

## Self-review

- **Spec coverage (PR 1 scope):** §2.1 scale → Task 2; §2.2 generator CSS + Swift → Tasks 2–3; §2.3 bundle + `typeStyle` + `scaledFont` compatibility → Tasks 5–6 (`LogBodyView` keeps its own path; it already reads sizes through `scaledFont`, so it inherits Geist Mono without edits — the token read-through mentioned in the spec lands in PR 3 with the other native re-skins); §2.4 desktop px migration → Task 4; §6 tests → Tasks 1, 3, 5, 6; §7 PR 1 delivery → Task 7. `LogBodyView` divergence noted above is the only deferral.
- **Placeholders:** none; every step has concrete code or an exact command with expected output. The only conditional (Info.plist path value in Task 5 Step 4) has both branches spelled out.
- **Type consistency:** `parseTypeStyle`/`TypeStyleSpec` (Task 1) used by Tasks 2–3; `DesignTokens.Typography.Style` field names (`size`, `weight`, `mono`, `uppercase`, `tracking`) identical in Tasks 3 and 6; `AppFont.postScriptName(mono:weight:)`, `AppFont.isAvailable`, `AppFont.font(mono:weight:size:)` identical in Tasks 5–6; `all` entries use `(name:style:)` in both the generator and the test; `camel("data-sm")` = `dataSm` matches the test list.
