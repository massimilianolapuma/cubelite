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

`--font-sans` / `--font-mono` — Geist Mono for both; CubeLite uses a monospace-first aesthetic.

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
3. Commit both `tokens.json` and the updated `apps/desktop/src/app.css`

> The generator rewrites **only** the content between `/* @generated:*-start */` and
> `/* @generated:*-end */` markers — manual CSS outside those blocks is preserved.
