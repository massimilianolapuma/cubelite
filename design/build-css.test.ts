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

test("a tinted subtree re-declares what utilities and recipes read", () => {
  // @theme puts --color-* on :root, where var(--cl-color-*) is already resolved;
  // without these, bg-*/text-* inside [data-tint] would keep the window's tint.
  const sub = rule(buildLayer(tokens), "[data-tint]");
  for (const line of [
    "--color-surface-window: var(--cl-color-surface-window);",
    "--color-text: var(--cl-color-text);",
    "--color-primary: var(--cl-color-primary);",
    "--color-data-1: var(--cl-color-data-1);",
  ]) {
    assert.ok(sub.includes(line), `missing "${line}"`);
  }
});

test("malformed colour values are rejected instead of emitted", () => {
  const withText = (value: unknown) =>
    ({ ...tokens, color: { ...tokens.color, text: { ...tokens.color.text, $dark: value } } }) as Tokens;
  assert.throws(() => buildLayer(withText([0.9, 0.01, "Tint"])), /colour "text" \(\$dark\)/);
  assert.throws(() => buildLayer(withText([0.9, 0.01])), /colour "text" \(\$dark\)/);
  assert.throws(() => buildLayer(withText(null)), /colour "text" \(\$dark\)/);
  assert.throws(
    () =>
      buildLayer({
        ...tokens,
        identity: { ...tokens.identity, hues: { ...tokens.identity.hues, teal: "190" as never } },
      }),
    /identity "teal"/,
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

test("every colour role is a theme colour, under its own name", () => {
  const theme = buildTheme(tokens);
  for (const role of Object.keys(tokens.color)) {
    assert.ok(theme.includes(`--color-${role}: var(--cl-color-${role});`), `missing role "${role}"`);
  }
  assert.ok(theme.includes("--font-display:"));
});

// The names the Tonal restyle retired (spec §4.5), as they would appear in CSS.
const RETIRED = [
  /--color-(surface-(panel|surface|raised|row-hover)|border-(default|strong|faint))\b/,
  /--color-text-(primary|secondary|tertiary|disabled|data-bright|log)\b/,
  /--color-(accent|status-[a-z-]+)\b/,
  /color-cluster-[a-z]+/,
  /--alpha-/,
  /type-(caption|colhead|section|subtitle)\b/,
  /--radius-2xl\b/,
];

test("the generated CSS has no v2 name", () => {
  const css = [buildTheme(tokens), buildLayer(tokens), buildType(tokens)].join("\n");
  for (const name of RETIRED) assert.doesNotMatch(css, name);
});

test("tokens.json has no alias group left", () => {
  assert.ok(!("alias" in tokens), "color alias group");
  assert.ok(!("alias" in tokens.font), "type alias group");
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

test("there is one type utility per style", () => {
  const names = [...buildType(tokens).matchAll(/@utility type-([a-z-]+) \{/g)].map((m) => m[1]);
  assert.deepEqual(names, Object.keys(tokens.font.style));
});

test("no shadcn bridge is emitted", () => {
  assert.doesNotMatch(buildLayer(tokens), /--sidebar-background|--popover:|--muted-foreground/);
});

test("app.css is in sync with tokens.json (run pnpm design:tokens)", () => {
  assert.equal(buildCss(appCss, tokens), appCss);
});
