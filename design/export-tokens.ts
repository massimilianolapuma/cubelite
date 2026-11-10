#!/usr/bin/env npx tsx
/**
 * design/export-tokens.ts
 *
 * Reads design/tokens.json and rewrites the generated regions of
 * apps/desktop/src/app.css. The CSS itself is built in build-css.ts.
 *
 * Run:  pnpm design:tokens
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCss, type Tokens } from "./build-css.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tokensFile = resolve(root, "design", "tokens.json");
const cssFile = resolve(root, "apps", "desktop", "src", "app.css");

const tokens = JSON.parse(readFileSync(tokensFile, "utf-8")) as Tokens;
writeFileSync(cssFile, buildCss(readFileSync(cssFile, "utf-8"), tokens), "utf-8");

console.log("✓ Design tokens exported →", cssFile);
