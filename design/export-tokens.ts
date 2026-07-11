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
  /** Light-theme counterpart; falls back to $value when omitted. */
  $light?: string;
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
function entries(group: TokenGroup, theme: "dark" | "light" = "dark"): [string, string][] {
  return Object.entries(group)
    .filter(([k]) => !k.startsWith("$"))
    .map(([k, t]) => [k, theme === "light" ? (t.$light ?? t.$value) : t.$value]);
}

/** `--prefix-key: var(--cl-prefix-key);` aliases for theme-switchable groups. */
function aliasLines(group: TokenGroup, prefix: string, indent: string): string {
  return entries(group)
    .map(([k]) => `${indent}--${prefix}${k}: var(--cl-${prefix}${k});`)
    .join("\n");
}

/** `--cl-prefix-key: <value>;` concrete values for one theme. */
function themedLines(
  group: TokenGroup,
  prefix: string,
  indent: string,
  theme: "dark" | "light",
): string {
  return entries(group, theme)
    .map(([k, v]) => `${indent}--cl-${prefix}${k}: ${v};`)
    .join("\n");
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
const swiftFile = resolve(
  root,
  "apps",
  "macos",
  "cubelite",
  "cubelite",
  "Helpers",
  "DesignTokens.swift",
);

// ── Parse tokens ─────────────────────────────────────────────────────────────

const tk = JSON.parse(readFileSync(tokensFile, "utf-8")) as DesignTokensV2;

const tval = (group: TokenGroup, key: string, theme: "dark" | "light" = "dark"): string => {
  const t = group[key];
  if (!t) throw new Error(`Missing token: ${key}`);
  return theme === "light" ? (t.$light ?? t.$value) : t.$value;
};

/** Color groups whose values switch between light and dark. */
const SWITCHABLE: [TokenGroup, string][] = [
  [tk.surface, "color-surface-"],
  [tk.border, "color-border-"],
  [tk.text, "color-text-"],
  [tk.status, "color-status-"],
  [tk["cluster-identity"], "color-cluster-"],
  [tk.shadow, "shadow-"],
];

// ── Build @theme block ────────────────────────────────────────────────────────

// accent.default → --color-accent; other accent keys keep their name suffix.
const accentAlias = (k: string): string =>
  k === "default" ? "color-accent" : `color-accent-${k}`;

// Colors and shadows are aliases into theme-switchable --cl-* custom
// properties defined per :root (light) / .dark below; everything that uses
// a utility or an inline var(--color-*) follows the active theme.
const themeContent = [
  "@theme {",
  `  --font-sans: ${tval(tk.font.family, "sans")};`,
  `  --font-mono: ${tval(tk.font.family, "mono")};`,
  "",
  ...SWITCHABLE.map(([group, prefix]) => aliasLines(group, prefix, "  ") + "\n"),
  entries(tk.accent)
    .map(([k]) => `  --${accentAlias(k)}: var(--cl-${accentAlias(k)});`)
    .join("\n"),
  "",
  lines(tk.spacing, "spacing-", "  "),
  "",
  lines(tk.radius, "radius-", "  "),
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

// shadcn-svelte compat bridge: HSL triples derived from the active palette.
// Existing/future shadcn-styled components read hsl(var(--background)) etc.
const bridgeFor = (theme: "dark" | "light"): [string, string][] => [
  ["background", tval(tk.surface, "window", theme)],
  ["foreground", tval(tk.text, "primary", theme)],
  ["card", tval(tk.surface, "surface", theme)],
  ["card-foreground", tval(tk.text, "primary", theme)],
  ["popover", tval(tk.surface, "overlay", theme)],
  ["popover-foreground", tval(tk.text, "primary", theme)],
  ["primary", tval(tk.accent, "default", theme)],
  ["primary-foreground", tval(tk.surface, "window", theme)],
  ["secondary", tval(tk.surface, "raised", theme)],
  ["secondary-foreground", tval(tk.text, "primary", theme)],
  ["muted", tval(tk.surface, "raised", theme)],
  ["muted-foreground", tval(tk.text, "secondary", theme)],
  ["accent", tval(tk.surface, "raised", theme)],
  ["accent-foreground", tval(tk.text, "primary", theme)],
  ["destructive", tval(tk.status, "err-solid", theme)],
  ["destructive-foreground", tval(tk.text, "primary", theme)],
  ["border", tval(tk.border, "default", theme)],
  ["input", tval(tk.border, "default", theme)],
  ["ring", tval(tk.accent, "default", theme)],
  ["sidebar-background", tval(tk.surface, "panel", theme)],
  ["sidebar-foreground", tval(tk.text, "secondary", theme)],
  ["sidebar-primary", tval(tk.accent, "default", theme)],
  ["sidebar-primary-foreground", tval(tk.surface, "window", theme)],
  ["sidebar-accent", tval(tk.surface, "raised", theme)],
  ["sidebar-accent-foreground", tval(tk.text, "primary", theme)],
  ["sidebar-border", tval(tk.border, "faint", theme)],
  ["sidebar-ring", tval(tk.accent, "default", theme)],
];

const bridgeLines = (indent: string, theme: "dark" | "light"): string =>
  bridgeFor(theme)
    .map(([k, v]) => `${indent}--${k}: ${hexToHslTriple(v)};`)
    .join("\n");

const themedBlock = (theme: "dark" | "light"): string =>
  [
    ...SWITCHABLE.map(([group, prefix]) => themedLines(group, prefix, "    ", theme)),
    entries(tk.accent, theme)
      .map(([k, v]) => `    --cl-${accentAlias(k)}: ${v};`)
      .join("\n"),
  ].join("\n");

const layerContent = [
  "@layer base {",
  "  :root {",
  themedBlock("light"),
  "",
  alphaLines,
  "",
  densityLines,
  "",
  motionLines,
  "",
  bridgeLines("    ", "light"),
  "  }",
  "  .dark {",
  themedBlock("dark"),
  "",
  bridgeLines("    ", "dark"),
  "  }",
  "}",
].join("\n");

// ── Inject and write ──────────────────────────────────────────────────────────

let css = readFileSync(cssFile, "utf-8");
css = injectRegion(css, "/* @generated:theme-start */", "/* @generated:theme-end */", themeContent);
css = injectRegion(css, "/* @generated:layer-start */", "/* @generated:layer-end */", layerContent);
writeFileSync(cssFile, css, "utf-8");

// ── Swift bridge (apps/macos) ────────────────────────────────────────────────

/** "row-hover" → "rowHover" */
function camel(name: string): string {
  return name.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

function swiftColorLines(group: TokenGroup, prefix: string): string {
  return entries(group)
    .map(([k]) => {
      const dark = tval(group, k, "dark");
      const light = tval(group, k, "light");
      return `    public static let ${prefix}${camel(k).replace(/^./, (c) => c.toUpperCase())} = dynamicColor(light: "${light}", dark: "${dark}")`;
    })
    .join("\n");
}

const swiftContent = `// Generated by \`pnpm design:tokens\` from design/tokens.json — do not edit.
//
// Unified Design System v1 bridge for SwiftUI (see #249). Colors are
// dynamic NSColors that follow the effective appearance (light/dark).

import SwiftUI

public enum DesignTokens {
    // MARK: - Surfaces
${swiftColorLines(tk.surface, "surface")}

    // MARK: - Borders
${swiftColorLines(tk.border, "border")}

    // MARK: - Text
${swiftColorLines(tk.text, "text")}

    // MARK: - Accent
${swiftColorLines(tk.accent, "accent")}

    // MARK: - Status
${swiftColorLines(tk.status, "status")}

    // MARK: - Cluster identity
${swiftColorLines(tk["cluster-identity"], "cluster")}

    // MARK: - Spacing (pt)
${entries(tk.spacing)
  .map(([k, v]) => `    public static let spacing${k}: CGFloat = ${Number.parseFloat(v)}`)
  .join("\n")}

    // MARK: - Radius (pt)
${entries(tk.radius)
  .map(
    ([k, v]) =>
      `    public static let radius${camel(k).replace(/^./, (c) => c.toUpperCase())}: CGFloat = ${Number.parseFloat(v) > 999 ? 999 : Number.parseFloat(v)}`,
  )
  .join("\n")}

    // MARK: - Density (pt)
${entries(tk.density)
  .map(
    ([k, v]) =>
      `    public static let ${camel(k)}: CGFloat = ${Number.parseFloat(v)}`,
  )
  .join("\n")}

    /// Appearance-aware color from light/dark hex pairs.
    private static func dynamicColor(light: String, dark: String) -> Color {
        Color(
            nsColor: NSColor(
                name: nil,
                dynamicProvider: { appearance in
                    let isDark =
                        appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
                    return NSColor(hex: isDark ? dark : light)
                }
            )
        )
    }
}

extension NSColor {
    /// \`#rrggbb\` hex parser used by the generated palette.
    convenience init(hex: String) {
        var value: UInt64 = 0
        Scanner(string: String(hex.dropFirst())).scanHexInt64(&value)
        self.init(
            srgbRed: CGFloat((value >> 16) & 0xff) / 255,
            green: CGFloat((value >> 8) & 0xff) / 255,
            blue: CGFloat(value & 0xff) / 255,
            alpha: 1
        )
    }
}
`;

writeFileSync(swiftFile, swiftContent, "utf-8");

console.log("✓ Design tokens exported →", cssFile);
console.log("✓ Swift bridge exported  →", swiftFile);
