/**
 * design/build-css.ts
 *
 * Pure builders that turn design/tokens.json (v3, Tonal) into the generated
 * regions of apps/desktop/src/app.css:
 *
 *   @generated:theme  — Tailwind v4 `@theme` vars: fonts, colour roles and the
 *                       v2 names kept as aliases, identity colours, shadows,
 *                       spacing, radius
 *   @generated:layer  — `@layer base` custom properties: the colour values per
 *                       theme, tint hue, alpha recipes, density, icons, motion
 *   @generated:type   — `@utility type-*` typography classes
 *
 * Tinted colours are `oklch(L C var(--cl-tint-h))`. They are declared on
 * `:root, [data-tint]` (and the `.dark` forms) so that an element carrying
 * `data-tint` and its own `--cl-tint-h` re-evaluates every role for its subtree.
 */

import { parseTypeStyle } from "./type-style.ts";

// ── Types ─────────────────────────────────────────────────────────────────────

export type Theme = "dark" | "light";

/** `[lightness, chroma, hue]`; a hue of `"tint"` follows the active cluster. */
export type ColorValue = [number, number, number | "tint"];

export interface ColorToken {
  $dark: ColorValue;
  $light: ColorValue;
  $description?: string;
}

export interface Token {
  $value: string;
  /** Light-theme counterpart; falls back to $value when omitted. */
  $light?: string;
  $type?: string;
  $description?: string;
  /** Typography only: CSS line-height (unitless). */
  $lineHeight?: string;
  /** Typography only: default text colour, a colour role. */
  $color?: string;
}

type Group<T> = Record<string, T>;
/** A group whose `$…` keys are metadata and whose other keys map to `T`. */
type Meta<T> = Record<string, T | string>;

export interface Tokens {
  color: Group<ColorToken>;
  identity: {
    $dark: [number, number];
    $light: [number, number];
    hues: Record<string, number>;
    default: string;
  };
  alias: Meta<string>;
  spacing: Group<Token>;
  radius: Meta<Token>;
  shadow: Group<Token>;
  font: { family: Group<Token>; style: Group<Token>; alias: Meta<string> };
  density: Group<Token>;
  icon: Group<Token>;
  motion: Group<Token>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Entries of a group, skipping `$description` and other meta keys. */
function entries<T>(group: Record<string, T | string>): [string, T][] {
  return Object.entries(group).filter(([k]) => !k.startsWith("$")) as [string, T][];
}

const themed = (t: Token, theme: Theme): string =>
  theme === "light" ? (t.$light ?? t.$value) : t.$value;

function oklch([l, c, h]: ColorValue): string {
  return `oklch(${l} ${c} ${h === "tint" ? "var(--cl-tint-h)" : h})`;
}

/** Motion values may carry a transform note after "·" — keep only duration/ease. */
const motionValue = (v: string): string => v.split("·")[0].trim();

const mix = (colorVar: string, pct: string): string =>
  `color-mix(in srgb, var(${colorVar}) ${pct}, transparent)`;

function plainLines(group: Meta<Token>, prefix: string, indent: string, map = (v: string) => v): string {
  return entries<Token>(group)
    .map(([k, t]) => `${indent}--${prefix}${k}: ${map(t.$value)};`)
    .join("\n");
}

/** Old name → role, validated: the role exists and the name is not itself a role. */
function aliases(tk: Tokens): [string, string][] {
  return entries<string>(tk.alias).map(([name, role]) => {
    if (!tk.color[role]) throw new Error(`Alias "${name}" points at unknown colour role "${role}"`);
    if (tk.color[name]) throw new Error(`"${name}" is both a colour role and an alias`);
    return [name, role];
  });
}

// ── @theme ────────────────────────────────────────────────────────────────────

export function buildTheme(tk: Tokens): string {
  const roles = Object.keys(tk.color);
  return [
    "@theme {",
    ...entries<Token>(tk.font.family).map(([k, t]) => `  --font-${k}: ${t.$value};`),
    "",
    ...roles.map((r) => `  --color-${r}: var(--cl-color-${r});`),
    "",
    ...aliases(tk).map(([name, role]) => `  --color-${name}: var(--cl-color-${role});`),
    "",
    ...Object.keys(tk.identity.hues).map(
      (id) => `  --color-cluster-${id}: var(--cl-color-cluster-${id});`,
    ),
    "",
    ...entries<Token>(tk.shadow).map(([k]) => `  --shadow-${k}: var(--cl-shadow-${k});`),
    "",
    plainLines(tk.spacing, "spacing-", "  "),
    "",
    plainLines(tk.radius, "radius-", "  "),
    "}",
  ].join("\n");
}

// ── @layer base ───────────────────────────────────────────────────────────────

function colorBlock(tk: Tokens, theme: Theme): string {
  const key = theme === "dark" ? "$dark" : "$light";
  const [l, c] = tk.identity[key];
  return [
    ...Object.entries(tk.color).map(([name, t]) => `    --cl-color-${name}: ${oklch(t[key])};`),
    ...Object.entries(tk.identity.hues).map(
      ([id, hue]) => `    --cl-color-cluster-${id}: ${oklch([l, c, hue])};`,
    ),
  ].join("\n");
}

const shadowBlock = (tk: Tokens, theme: Theme): string =>
  entries<Token>(tk.shadow)
    .map(([k, t]) => `    --cl-shadow-${k}: ${themed(t, theme)};`)
    .join("\n");

export function buildLayer(tk: Tokens): string {
  const defaultHue = tk.identity.hues[tk.identity.default];
  if (defaultHue === undefined) {
    throw new Error(`Default identity "${tk.identity.default}" has no hue`);
  }
  // Alpha recipes still read the v2 names; they follow the aliases above.
  const alpha = [
    `    --alpha-selection-bg: ${mix("--color-accent", "10%")};`,
    `    --alpha-active-nav-bg: ${mix("--color-accent", "14%")};`,
    `    --alpha-pill-ok: ${mix("--color-status-ok", "10%")};`,
    `    --alpha-pill-warn: ${mix("--color-status-warn", "10%")};`,
    `    --alpha-pill-err: ${mix("--color-status-err", "10%")};`,
    `    --alpha-log-error-row: ${mix("--color-status-err", "7%")};`,
    `    --alpha-log-warn-row: ${mix("--color-status-warn", "4.5%")};`,
    `    --focus-ring: 0 0 0 3px ${mix("--color-accent", "15%")};`,
  ].join("\n");

  return [
    "@layer base {",
    "  :root, [data-tint] {",
    colorBlock(tk, "light"),
    "  }",
    "  :root {",
    `    --cl-tint-h: ${defaultHue};`,
    ...Object.entries(tk.identity.hues).map(([id, hue]) => `    --cl-hue-${id}: ${hue};`),
    "",
    shadowBlock(tk, "light"),
    "",
    alpha,
    "",
    plainLines(tk.density, "", "    "),
    "",
    plainLines(tk.icon, "icon-", "    "),
    "",
    plainLines(tk.motion, "motion-", "    ", motionValue),
    "  }",
    "  .dark, .dark [data-tint] {",
    colorBlock(tk, "dark"),
    "  }",
    "  .dark {",
    shadowBlock(tk, "dark"),
    "  }",
    "}",
  ].join("\n");
}

// ── @utility type-* ───────────────────────────────────────────────────────────

function typeDecls(tk: Tokens, name: string): string[] {
  const meta = tk.font.style[name];
  if (!meta) throw new Error(`Unknown typography style "${name}"`);
  const s = parseTypeStyle(meta.$value);
  if (s.size < 10) throw new Error(`Typography token "${name}" is below the 10px minimum`);
  if (meta.$color && !tk.color[meta.$color]) {
    throw new Error(`Typography token "${name}" references unknown colour role "${meta.$color}"`);
  }
  const decls = [
    `  font-family: var(--font-${s.family});`,
    `  font-size: ${s.size}px;`,
    `  font-weight: ${s.weight};`,
  ];
  if (meta.$lineHeight) decls.push(`  line-height: ${meta.$lineHeight};`);
  if (s.tracking) decls.push(`  letter-spacing: ${s.tracking}em;`);
  if (s.uppercase) decls.push(`  text-transform: uppercase;`);
  if (meta.$color) decls.push(`  color: var(--color-${meta.$color});`);
  return decls;
}

export function buildType(tk: Tokens): string {
  const utility = (name: string, style: string): string =>
    `@utility type-${name} {\n${typeDecls(tk, style).join("\n")}\n}`;
  return [
    ...Object.keys(tk.font.style).map((name) => utility(name, name)),
    ...entries<string>(tk.font.alias).map(([name, style]) => {
      if (tk.font.style[name]) throw new Error(`"${name}" is both a type style and an alias`);
      return utility(name, style);
    }),
  ].join("\n");
}

// ── Assemble ──────────────────────────────────────────────────────────────────

function injectRegion(source: string, name: string, body: string): string {
  const startTag = `/* @generated:${name}-start */`;
  const endTag = `/* @generated:${name}-end */`;
  const si = source.indexOf(startTag);
  const ei = source.indexOf(endTag);
  if (si === -1 || ei === -1) {
    throw new Error(`Missing markers in app.css:\n  start: ${startTag}\n  end:   ${endTag}`);
  }
  return source.slice(0, si + startTag.length) + "\n" + body + "\n" + source.slice(ei);
}

/** Rewrite the three generated regions of `css` from `tk`; the rest is kept. */
export function buildCss(css: string, tk: Tokens): string {
  let out = injectRegion(css, "theme", buildTheme(tk));
  out = injectRegion(out, "layer", buildLayer(tk));
  out = injectRegion(out, "type", buildType(tk));
  return out;
}
