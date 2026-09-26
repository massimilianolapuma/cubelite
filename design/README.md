# Design Tokens — CubeLite

Single source of truth for all visual design primitives and semantic aliases used across the
CubeLite desktop application.

---

## Structure

```
design/
├── tokens.json          ← All tokens (primitives + semantics + spacing + typography)
├── export-tokens.ts     ← Generator script — run to sync tokens → CSS
└── README.md            ← This file
```

---

## Token Layers

### 1. Primitive colours

Raw zinc palette (`zinc-50` → `zinc-950`).
These are reference-only — **do not use primitive tokens directly in components**; use semantic aliases.

### 2. Semantic aliases (light + dark)

All values are **HSL channel triples** consumed with `hsl(var(--token))` in shadcn-svelte components.

| Token | Light | Dark | Notes |
|---|---|---|---|
| `--background` | `0 0% 100%` | `240 10% 3.9%` | Page / window background |
| `--foreground` | `240 10% 3.9%` | `0 0% 98%` | Default text |
| `--card` / `--card-foreground` | white / 3.9% | 3.9% / 98% | Card surfaces |
| `--muted` / `--muted-foreground` | 95.9% / 46.1% | 15.9% / 64.9% | Disabled / secondary text |
| `--border` | `240 5.9% 90%` | `240 3.7% 15.9%` | Dividers and outlines |
| `--ring` | `240 5.9% 10%` | `240 4.9% 83.9%` | Focus rings |
| `--primary` / `--primary-foreground` | 10% / 98% | 98% / 10% | Buttons, active states |
| `--destructive` | `0 84.2% 60.2%` | `0 62.8% 30.6%` | Error / delete actions |
| `--sidebar-background` | `240 5.9% 95%` | `240 5.9% 10%` | Sidebar panel |

### 3. Spacing

`--spacing-{0‥24}` — matches Tailwind's default 4 px base scale (values in `rem`).

### 4. Border radius

`--radius-{none,sm,md,lg,xl,2xl,full}` — consumed by shadcn-svelte components.

### 5. Shadows

`--shadow-{sm,md,lg,xl}` — standard elevation scale.

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

---

## Accessibility

All semantic aliases satisfy **WCAG 2.1 AA** contrast requirements:

| Pairing | Contrast ratio | Requirement |
|---|---|---|
| `--foreground` on `--background` (light) | ≥ 16:1 | ≥ 4.5:1 (text) ✅ |
| `--foreground` on `--background` (dark) | ≥ 16:1 | ≥ 4.5:1 (text) ✅ |
| `--muted-foreground` on `--background` (light) | ≥ 4.6:1 | ≥ 4.5:1 (text) ✅ |
| `--muted-foreground` on `--background` (dark) | ≥ 4.6:1 | ≥ 4.5:1 (text) ✅ |
| `--primary-foreground` on `--primary` | ≥ 12:1 | ≥ 4.5:1 (text) ✅ |
| `--destructive` on `--background` (non-text) | ≥ 3.1:1 | ≥ 3:1 (non-text) ✅ |

---

## Updating tokens

1. Edit `design/tokens.json`
2. Run `pnpm design:tokens` (executes `tsx design/export-tokens.ts`)
3. Commit `tokens.json`, `apps/desktop/src/app.css` and `apps/macos/cubelite/cubelite/Helpers/DesignTokens.swift`

> The generator rewrites **only** the content between `/* @generated:*-start */` and
> `/* @generated:*-end */` markers — manual CSS outside those blocks is preserved.
