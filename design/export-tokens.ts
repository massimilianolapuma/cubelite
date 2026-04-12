#!/usr/bin/env npx tsx
/**
 * design/export-tokens.ts
 *
 * Reads design/tokens.json and rewrites the generated regions inside
 * apps/desktop/src/app.css.
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

interface FontTokens {
  family: TokenGroup;
  size: TokenGroup;
  weight: TokenGroup;
  lineHeight: TokenGroup;
}

interface DesignTokens {
  semantic: { light: TokenGroup; dark: TokenGroup };
  spacing: TokenGroup;
  radius: TokenGroup;
  shadow: TokenGroup;
  font: FontTokens;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const val = (t: Token): string => t.$value;

function varBlock(
  group: TokenGroup,
  prefix: string,
  indent: string,
): string {
  return Object.entries(group)
    .map(([k, t]) => `${indent}--${prefix}${k}: ${val(t)};`)
    .join("\n");
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

const tk = JSON.parse(readFileSync(tokensFile, "utf-8")) as DesignTokens;

// ── Build @theme block ────────────────────────────────────────────────────────

const themeContent = [
  "@theme {",
  varBlock(
    { "font-sans": tk.font.family.sans, "font-mono": tk.font.family.mono },
    "",
    "  ",
  ),
  "",
  varBlock(tk.spacing, "spacing-", "  "),
  "",
  varBlock(tk.radius, "radius-", "  "),
  "",
  varBlock(tk.shadow, "shadow-", "  "),
  "}",
].join("\n");

// ── Build @layer base block ───────────────────────────────────────────────────

const layerContent = [
  "@layer base {",
  "  :root {",
  varBlock(tk.semantic.light, "", "    "),
  "  }",
  "  .dark {",
  varBlock(tk.semantic.dark, "", "    "),
  "  }",
  "}",
].join("\n");

// ── Inject and write ──────────────────────────────────────────────────────────

let css = readFileSync(cssFile, "utf-8");
css = injectRegion(css, "/* @generated:theme-start */", "/* @generated:theme-end */", themeContent);
css = injectRegion(css, "/* @generated:layer-start */", "/* @generated:layer-end */", layerContent);
writeFileSync(cssFile, css, "utf-8");

console.log("\u2713 Design tokens exported \u2192", cssFile);
