/**
 * design/build-css.ts
 *
 * Pure builders that turn design/tokens.json (v3, Tonal) into the generated
 * regions of apps/desktop/src/app.css:
 *
 *   @generated:theme  — Tailwind v4 `@theme` vars: fonts, colour roles,
 *                       shadows, spacing, radius
 *   @generated:layer  — `@layer base` custom properties: the colour values per
 *                       theme, the tint hue and the identity hues, density,
 *                       icons, motion
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
    hues: Record<string, number>;
    default: string;
  };
  spacing: Group<Token>;
  radius: Meta<Token>;
  shadow: Group<Token>;
  font: { family: Group<Token>; style: Group<Token> };
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

const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** A colour value must be `[number, number, number | "tint"]`; anything else is a typo. */
function checkColor(name: string, key: string, value: unknown): ColorValue {
  const ok =
    Array.isArray(value) &&
    value.length === 3 &&
    isNumber(value[0]) &&
    isNumber(value[1]) &&
    (isNumber(value[2]) || value[2] === "tint");
  if (!ok) {
    throw new Error(
      `Bad colour "${name}" (${key}): expected [lightness, chroma, hue | "tint"], got ${JSON.stringify(value)}`,
    );
  }
  return value as ColorValue;
}

function identityHues(tk: Tokens): [string, number][] {
  return Object.entries(tk.identity.hues).map(([id, hue]) => {
    if (!isNumber(hue)) throw new Error(`Bad hue for identity "${id}": ${JSON.stringify(hue)}`);
    return [id, hue];
  });
}

/** Motion values may carry a transform note after "·" — keep only duration/ease. */
const motionValue = (v: string): string => v.split("·")[0].trim();

function plainLines(group: Meta<Token>, prefix: string, indent: string, map = (v: string) => v): string {
  return entries<Token>(group)
    .map(([k, t]) => `${indent}--${prefix}${k}: ${map(t.$value)};`)
    .join("\n");
}

// ── @theme ────────────────────────────────────────────────────────────────────

/**
 * `--color-*` → `--cl-color-*` for every role. Emitted in `@theme` (so
 * Tailwind builds the utilities) and again on `[data-tint]`: `@theme` lands on
 * `:root`, where `var(--cl-color-*)` is already resolved to the window's tint,
 * so a tinted subtree must re-declare them to get its own.
 */
function colorRoleLines(tk: Tokens, indent: string): string[] {
  return Object.keys(tk.color).map((r) => `${indent}--color-${r}: var(--cl-color-${r});`);
}

export function buildTheme(tk: Tokens): string {
  return [
    "@theme {",
    ...entries<Token>(tk.font.family).map(([k, t]) => `  --font-${k}: ${t.$value};`),
    "",
    ...colorRoleLines(tk, "  "),
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
  return Object.entries(tk.color)
    .map(([name, t]) => `    --cl-color-${name}: ${oklch(checkColor(name, key, t?.[key]))};`)
    .join("\n");
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
  return [
    "@layer base {",
    "  :root, [data-tint] {",
    colorBlock(tk, "light"),
    "  }",
    "  :root {",
    `    --cl-tint-h: ${defaultHue};`,
    ...identityHues(tk).map(([id, hue]) => `    --cl-hue-${id}: ${hue};`),
    "",
    shadowBlock(tk, "light"),
    "",
    plainLines(tk.density, "", "    "),
    "",
    plainLines(tk.icon, "icon-", "    "),
    "",
    plainLines(tk.motion, "motion-", "    ", motionValue),
    "  }",
    "  [data-tint] {",
    ...colorRoleLines(tk, "    "),
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
  if (meta.$color) decls.push(`  color: var(--color-${meta.$color});`);
  return decls;
}

export function buildType(tk: Tokens): string {
  return Object.keys(tk.font.style)
    .map((name) => `@utility type-${name} {\n${typeDecls(tk, name).join("\n")}\n}`)
    .join("\n");
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
