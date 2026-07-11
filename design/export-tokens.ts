#!/usr/bin/env npx tsx
/**
 * design/export-tokens.ts
 *
 * Reads design/tokens.json (v2 schema — unified dark identity) and rewrites
 * the generated regions inside apps/desktop/src/app.css:
 *
 *   @generated:theme  — Tailwind v4 `@theme` vars (colors → utilities such as
 *                       bg-surface-panel / text-text-secondary / bg-cluster-blue,
 *                       fonts, spacing, radius, shadows)
 *   @generated:layer  — `@layer base` custom properties: alpha recipes
 *                       (color-mix), density, motion, and the shadcn-svelte
 *                       compat bridge (HSL triples derived from the dark
 *                       palette, written to both :root and .dark)
 *
 * Run:  pnpm design:tokens
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Token {
  $value: string;
  $type?: string;
  $description?: string;
}

type TokenGroup = Record<string, Token>;

interface DesignTokensV2 {
  surface: TokenGroup;
  border: TokenGroup;
  text: TokenGroup;
  accent: TokenGroup;
  status: TokenGroup;
  alpha: TokenGroup;
  "cluster-identity": TokenGroup;
  spacing: TokenGroup;
  radius: TokenGroup;
  shadow: TokenGroup;
  font: { family: TokenGroup; style: TokenGroup };
  density: TokenGroup;
  motion: TokenGroup;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Entries of a token group, skipping `$description` and other meta keys. */
function entries(group: TokenGroup): [string, string][] {
  return Object.entries(group)
    .filter(([k]) => !k.startsWith("$"))
    .map(([k, t]) => [k, t.$value]);
}

function lines(
  group: TokenGroup,
  prefix: string,
  indent: string,
  mapValue: (v: string) => string = (v) => v,
): string {
  return entries(group)
    .map(([k, v]) => `${indent}--${prefix}${k}: ${mapValue(v)};`)
    .join("\n");
}

/** `#rrggbb` → `H S% L%` (shadcn HSL triple). */
function hexToHslTriple(hex: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`Expected 6-digit hex color, got: ${hex}`);
  const int = Number.parseInt(m[1], 16);
  const r = ((int >> 16) & 255) / 255;
  const g = ((int >> 8) & 255) / 255;
  const b = (int & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  const round = (n: number) => Math.round(n * 10) / 10;
  return `${round(h)} ${round(s * 100)}% ${round(l * 100)}%`;
}

/** Motion values may carry a transform note after "·" — keep only duration/ease. */
function motionValue(v: string): string {
  return v.split("·")[0].trim();
}

function mix(colorVar: string, pct: string): string {
  return `color-mix(in srgb, var(${colorVar}) ${pct}, transparent)`;
}

function injectRegion(
  source: string,
  startTag: string,
  endTag: string,
  body: string,
): string {
  const si = source.indexOf(startTag);
  const ei = source.indexOf(endTag);
  if (si === -1 || ei === -1) {
    throw new Error(
      `Missing markers in app.css:\n  start: ${startTag}\n  end:   ${endTag}`,
    );
  }
  return (
    source.slice(0, si + startTag.length) +
    "\n" +
    body +
    "\n" +
    source.slice(ei)
  );
}

// ── Paths ─────────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = resolve(__dirname, "..");
const tokensFile = resolve(root, "design", "tokens.json");
const cssFile = resolve(root, "apps", "desktop", "src", "app.css");

// ── Parse tokens ─────────────────────────────────────────────────────────────

const tk = JSON.parse(readFileSync(tokensFile, "utf-8")) as DesignTokensV2;

const tval = (group: TokenGroup, key: string): string => {
  const t = group[key];
  if (!t) throw new Error(`Missing token: ${key}`);
  return t.$value;
};

// ── Build @theme block ────────────────────────────────────────────────────────

// accent.default → --color-accent; other accent keys keep their name suffix.
const accentLines = entries(tk.accent)
  .map(([k, v]) =>
    k === "default" ? `  --color-accent: ${v};` : `  --color-accent-${k}: ${v};`,
  )
  .join("\n");

const themeContent = [
  "@theme {",
  `  --font-sans: ${tval(tk.font.family, "sans")};`,
  `  --font-mono: ${tval(tk.font.family, "mono")};`,
  "",
  lines(tk.surface, "color-surface-", "  "),
  "",
  lines(tk.border, "color-border-", "  "),
  "",
  lines(tk.text, "color-text-", "  "),
  "",
  accentLines,
  "",
  lines(tk.status, "color-status-", "  "),
  "",
  lines(tk["cluster-identity"], "color-cluster-", "  "),
  "",
  lines(tk.spacing, "spacing-", "  "),
  "",
  lines(tk.radius, "radius-", "  "),
  "",
  lines(tk.shadow, "shadow-", "  "),
  "}",
].join("\n");

// ── Build @layer base block ───────────────────────────────────────────────────

// Alpha recipes from the spec (identity- and per-status tints that depend on a
// runtime color are computed in components with color-mix instead).
const alphaLines = [
  `    --alpha-selection-bg: ${mix("--color-accent", "10%")};`,
  `    --alpha-active-nav-bg: ${mix("--color-accent", "14%")};`,
  `    --alpha-pill-ok: ${mix("--color-status-ok", "10%")};`,
  `    --alpha-pill-warn: ${mix("--color-status-warn", "10%")};`,
  `    --alpha-pill-err: ${mix("--color-status-err", "10%")};`,
  `    --alpha-log-error-row: ${mix("--color-status-err", "7%")};`,
  `    --alpha-log-warn-row: ${mix("--color-status-warn", "4.5%")};`,
  `    --focus-ring: 0 0 0 3px ${mix("--color-accent", "15%")};`,
].join("\n");

const densityLines = lines(tk.density, "", "    ");
const motionLines = lines(tk.motion, "motion-", "    ", motionValue);

// shadcn-svelte compat bridge: HSL triples derived from the v2 dark palette.
// Existing/future shadcn-styled components read hsl(var(--background)) etc.
// The app is dark-only in v1, so :root and .dark get identical values.
const bridge: [string, string][] = [
  ["background", tval(tk.surface, "window")],
  ["foreground", tval(tk.text, "primary")],
  ["card", tval(tk.surface, "surface")],
  ["card-foreground", tval(tk.text, "primary")],
  ["popover", tval(tk.surface, "overlay")],
  ["popover-foreground", tval(tk.text, "primary")],
  ["primary", tval(tk.accent, "default")],
  ["primary-foreground", tval(tk.surface, "window")],
  ["secondary", tval(tk.surface, "raised")],
  ["secondary-foreground", tval(tk.text, "primary")],
  ["muted", tval(tk.surface, "raised")],
  ["muted-foreground", tval(tk.text, "secondary")],
  ["accent", tval(tk.surface, "raised")],
  ["accent-foreground", tval(tk.text, "primary")],
  ["destructive", tval(tk.status, "err-solid")],
  ["destructive-foreground", tval(tk.text, "primary")],
  ["border", tval(tk.border, "default")],
  ["input", tval(tk.border, "default")],
  ["ring", tval(tk.accent, "default")],
  ["sidebar-background", tval(tk.surface, "panel")],
  ["sidebar-foreground", tval(tk.text, "secondary")],
  ["sidebar-primary", tval(tk.accent, "default")],
  ["sidebar-primary-foreground", tval(tk.surface, "window")],
  ["sidebar-accent", tval(tk.surface, "raised")],
  ["sidebar-accent-foreground", tval(tk.text, "primary")],
  ["sidebar-border", tval(tk.border, "faint")],
  ["sidebar-ring", tval(tk.accent, "default")],
];

const bridgeLines = (indent: string): string =>
  bridge.map(([k, v]) => `${indent}--${k}: ${hexToHslTriple(v)};`).join("\n");

const layerContent = [
  "@layer base {",
  "  :root {",
  alphaLines,
  "",
  densityLines,
  "",
  motionLines,
  "",
  bridgeLines("    "),
  "  }",
  "  .dark {",
  bridgeLines("    "),
  "  }",
  "}",
].join("\n");

// ── Inject and write ──────────────────────────────────────────────────────────

let css = readFileSync(cssFile, "utf-8");
css = injectRegion(css, "/* @generated:theme-start */", "/* @generated:theme-end */", themeContent);
css = injectRegion(css, "/* @generated:layer-start */", "/* @generated:layer-end */", layerContent);
writeFileSync(cssFile, css, "utf-8");

console.log("✓ Design tokens exported →", cssFile);
