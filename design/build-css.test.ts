import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildCss, buildLayer, buildTheme, buildType, type Tokens } from "./build-css.ts";

const tokens = JSON.parse(
  readFileSync(new URL("./tokens.json", import.meta.url), "utf8"),
) as Tokens;
const appCss = readFileSync(new URL("../apps/desktop/src/app.css", import.meta.url), "utf8");

/** Body of the rule that starts with `selector {` inside the generated layer. */
function rule(css: string, selector: string): string {
  const start = css.indexOf(`  ${selector} {\n`);
  assert.notEqual(start, -1, `no rule for "${selector}"`);
  return css.slice(start, css.indexOf("\n  }", start));
}

test("tinted roles follow --cl-tint-h in both themes", () => {
  const layer = buildLayer(tokens);
  assert.ok(
    rule(layer, ":root, [data-tint]").includes(
      "--cl-color-surface-window: oklch(0.955 0.02 var(--cl-tint-h));",
    ),
  );
  assert.ok(
    rule(layer, ".dark, .dark [data-tint]").includes(
      "--cl-color-surface-window: oklch(0.165 0.03 var(--cl-tint-h));",
    ),
  );
});

test("fixed-hue roles keep their own hue", () => {
  const layer = buildLayer(tokens);
  assert.ok(rule(layer, ".dark, .dark [data-tint]").includes("--cl-color-error: oklch(0.78 0.13 24);"));
  assert.ok(rule(layer, ":root, [data-tint]").includes("--cl-color-error: oklch(0.52 0.19 27);"));
});

test("the default tint and every identity hue are declared on :root", () => {
  const root = rule(buildLayer(tokens), ":root");
  assert.ok(root.includes("--cl-tint-h: 240;"));
  assert.ok(root.includes("--cl-hue-teal: 190;"));
  assert.ok(root.includes("--cl-hue-magenta: 345;"));
});

test("identity colours take the primary lightness and chroma at their own hue", () => {
  const layer = buildLayer(tokens);
  assert.ok(
    rule(layer, ".dark, .dark [data-tint]").includes("--cl-color-cluster-magenta: oklch(0.84 0.09 345);"),
  );
  assert.ok(
    rule(layer, ":root, [data-tint]").includes("--cl-color-cluster-teal: oklch(0.45 0.14 190);"),
  );
});

test("v2 names alias the new roles", () => {
  const theme = buildTheme(tokens);
  for (const line of [
    "--color-surface-container: var(--cl-color-surface-container);",
    "--color-surface-panel: var(--cl-color-surface-container);",
    "--color-border-default: var(--cl-color-outline);",
    "--color-text-secondary: var(--cl-color-text-muted);",
    "--color-accent: var(--cl-color-primary);",
    "--color-status-err: var(--cl-color-error);",
    "--color-cluster-amber: var(--cl-color-data-4);",
    "--color-cluster-indigo: var(--cl-color-cluster-indigo);",
    "--font-display:",
  ]) {
    assert.ok(theme.includes(line), `missing "${line}"`);
  }
});

test("an alias of a role that does not exist is rejected", () => {
  assert.throws(
    () => buildTheme({ ...tokens, alias: { ...tokens.alias, "surface-panel": "surface-nope" } }),
    /unknown colour role "surface-nope"/,
  );
});

test("a role and an alias cannot share a name", () => {
  assert.throws(
    () => buildTheme({ ...tokens, alias: { ...tokens.alias, text: "text-muted" } }),
    /"text" is both a colour role and an alias/,
  );
});

test("type styles use their family, tracking and colour", () => {
  const type = buildType(tokens);
  assert.ok(
    type.includes(
      [
        "@utility type-display {",
        "  font-family: var(--font-display);",
        "  font-size: 34px;",
        "  font-weight: 600;",
        "  line-height: 1;",
        "  letter-spacing: -0.02em;",
        "  color: var(--color-text);",
        "}",
      ].join("\n"),
    ),
  );
});

test("retired type names reuse the new style", () => {
  const type = buildType(tokens);
  const body = (name: string) => {
    const start = type.indexOf(`@utility type-${name} {`);
    assert.notEqual(start, -1, `no type-${name}`);
    return type.slice(type.indexOf("{", start), type.indexOf("}", start));
  };
  assert.equal(body("caption"), body("body-sm"));
  assert.equal(body("colhead"), body("label"));
  assert.equal(body("subtitle"), body("title"));
  assert.ok(!body("section").includes("uppercase"));
});

test("no shadcn bridge is emitted", () => {
  assert.doesNotMatch(buildLayer(tokens), /--sidebar-background|--popover:|--muted-foreground/);
});

test("app.css is in sync with tokens.json (run pnpm design:tokens)", () => {
  assert.equal(buildCss(appCss, tokens), appCss);
});
