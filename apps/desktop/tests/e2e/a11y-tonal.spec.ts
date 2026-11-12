// Tonal phase 9 (#632): the accessibility pass on the rendered page (spec §9.1).
// Media features (more contrast, forced colours, reduced motion) and focus
// rings only exist in a real browser: jsdom can emulate none of them.
import { type Locator, type Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { tauriMockScript } from "./tauri-mock";

type Theme = "dark" | "light";
const THEMES: Theme[] = ["dark", "light"];

async function boot(page: Page, theme: Theme = "dark") {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(tauriMockScript());
  await page.addInitScript((t) => {
    window.localStorage.setItem("cubelite.onboardingSeen", "true");
    window.localStorage.setItem("cubelite.theme", JSON.stringify(t));
    // prod-aks teal, staging magenta: the rail shows two tints besides the window's.
    window.localStorage.setItem("cubelite.identityColors", JSON.stringify({ "prod-aks": "teal", staging: "magenta" }));
  }, theme);
  await page.goto("/");
}

/** The Pods list with api-0 selected: the content card, the panel and its tiles. */
async function podsWithPanel(page: Page) {
  await page.getByRole("complementary").getByText("Pods", { exact: true }).click();
  await page.getByText("api-0", { exact: true }).click();
  const panel = page.getByRole("dialog", { name: "api-0" });
  await expect(panel).toBeVisible();
  return panel;
}

/** The colour `value` resolves to inside `scope` (a tinted subtree resolves its own tint). */
async function resolvedIn(scope: Locator, value: string): Promise<string> {
  return scope.evaluate((el, v) => {
    const probe = document.createElement("span");
    probe.style.color = v;
    el.append(probe);
    const out = getComputedStyle(probe).color;
    probe.remove();
    return out;
  }, value);
}

async function edge(el: Locator) {
  return el.evaluate((node) => {
    const s = getComputedStyle(node);
    return { style: s.outlineStyle, width: s.outlineWidth, color: s.outlineColor };
  });
}

/**
 * Every card, tile and overlay of the main surfaces, opened one after another:
 * calls `check` with a name and the element while it is on screen.
 */
async function eachCard(page: Page, check: (name: string, el: Locator) => Promise<void>) {
  const panel = await podsWithPanel(page);
  await check("content card", page.locator("main"));
  await check("detail panel", panel);
  await check("tile", panel.locator("[data-tone]").first());
  await check("panel card", panel.locator("[data-container]").first());

  await page.getByRole("button", { name: /^prod-aks AKS/ }).click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await check("menu", menu);
  await menu.getByRole("menuitem", { name: "Copy server address" }).click();
  const toast = page.getByRole("status").locator("[data-tone]").first();
  await expect(toast).toBeVisible();
  await check("toast", toast);

  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /Search & switch/ }).click();
  const palette = page.getByTestId("command-palette");
  await expect(palette).toBeVisible();
  await check("palette", palette);
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();

  await page.getByLabel("Preferences").click();
  const prefs = page.getByRole("dialog", { name: "Preferences" });
  await expect(prefs).toBeVisible();
  await check("modal", prefs);
}

test.describe("more contrast (prefers-contrast: more)", () => {
  for (const theme of THEMES) {
    test(`${theme}: subtle text reads as muted text, on the window and in a tinted subtree`, async ({ page }) => {
      await page.emulateMedia({ contrast: "more" });
      await boot(page, theme);
      await podsWithPanel(page);
      const body = page.locator("body");
      // A rail avatar carries another cluster's tint.
      const tinted = page.locator('[data-tint][data-testid="identity-avatar"]').nth(1);
      for (const scope of [body, tinted]) {
        expect(await resolvedIn(scope, "var(--color-text-subtle)")).toBe(
          await resolvedIn(scope, "var(--color-text-muted)"),
        );
      }
      // Text written in the subtle role (the list's count) now paints in the muted one.
      const count = page.getByTestId("list-count");
      expect(await count.evaluate((el) => getComputedStyle(el).color)).toBe(
        await resolvedIn(body, "var(--color-text-muted)"),
      );
    });

    test(`${theme}: every card, tile and overlay gains an outline-strong edge`, async ({ page }) => {
      await page.emulateMedia({ contrast: "more" });
      await boot(page, theme);
      await eachCard(page, async (name, el) => {
        expect(await edge(el), name).toEqual({
          style: "solid",
          width: "1px",
          color: await resolvedIn(el, "var(--color-outline-strong)"),
        });
      });
    });
  }

  test("with no preference, subtle text and the cards are as before", async ({ page }) => {
    await page.emulateMedia({ contrast: "no-preference" });
    await boot(page, "dark");
    const body = page.locator("body");
    expect(await resolvedIn(body, "var(--color-text-subtle)")).not.toBe(
      await resolvedIn(body, "var(--color-text-muted)"),
    );
    await eachCard(page, async (name, el) => {
      expect((await edge(el)).style, name).toBe("none");
    });
  });
});

/** The colour a system colour keyword (Highlight, CanvasText…) resolves to on this page. */
const sys = (page: Page, keyword: string) => resolvedIn(page.locator("body"), keyword);

const bg = (el: Locator) => el.evaluate((n) => getComputedStyle(n).backgroundColor);
/**
 * A filled item must opt out of the forcing: otherwise the browser paints a
 * Canvas backplate behind each run of its text, and HighlightText (or
 * ButtonFace) on that backplate cannot be read.
 */
const unforced = async (el: Locator) =>
  expect(await el.evaluate((n) => getComputedStyle(n).forcedColorAdjust)).toBe("none");
const fg = (el: Locator) => el.evaluate((n) => getComputedStyle(n).color);
async function border(el: Locator) {
  return el.evaluate((n) => {
    const s = getComputedStyle(n);
    return { style: s.borderTopStyle, width: parseFloat(s.borderTopWidth) };
  });
}

test.describe("forced colours (forced-colors: active)", () => {
  // The window's theme and the system's palette are independent: check both pairs that differ.
  for (const [theme, scheme] of [
    ["dark", "light"],
    ["light", "dark"],
  ] as const) {
    test(`${theme} app on a ${scheme} system palette: selection, current items and pressed controls are system colours`, async ({
      page,
    }) => {
      await page.emulateMedia({ forcedColors: "active", colorScheme: scheme });
      await boot(page, theme);
      const panel = await podsWithPanel(page);
      const [highlight, highlightText, canvasText] = [
        await sys(page, "Highlight"),
        await sys(page, "HighlightText"),
        await sys(page, "CanvasText"),
      ];

      // Selected list row: the row and every cell in it.
      const row = page.locator('.list-row[data-selected="true"]');
      expect(await bg(row)).toBe(highlight);
      await unforced(row);
      expect(await fg(row.getByText("api-0", { exact: true }))).toBe(highlightText);
      expect(await fg(row.getByText("Running"))).toBe(highlightText);
      // A glyph follows its text instead of keeping its state's colour.
      expect(await fg(row.locator("[data-glyph]").first())).toBe(highlightText);
      // An unselected row's badge keeps a shape: its fill is gone, its edge is not.
      const pending = page.locator('.list-row:not([data-selected="true"]) [data-state="warn"]');
      expect(await border(pending)).toEqual({ style: "solid", width: 1 });
      expect(await fg(pending.locator("[data-glyph]"))).toBe(canvasText);

      // Current nav row and the active rail avatar.
      const nav = page.locator('[data-nav][data-active="true"]');
      expect(await bg(nav)).toBe(highlight);
      expect(await fg(nav.getByText("Pods", { exact: true }))).toBe(highlightText);
      await unforced(nav);
      const avatars = page.getByTestId("identity-avatar");
      const active = avatars.and(page.locator('[data-active="true"]'));
      expect(await bg(active)).toBe(highlight);
      expect(await fg(active)).toBe(highlightText);
      await unforced(active);
      expect(await border(avatars.and(page.locator('[data-active="false"]')).first())).toEqual({
        style: "solid",
        width: 1,
      });

      // Pressed chip.
      const chips = page.getByRole("group", { name: "Filter by status" });
      await chips.getByRole("button", { name: /Running/ }).click();
      expect(await bg(chips.getByRole("button", { pressed: true }))).toBe(highlight);
      await unforced(chips.getByRole("button", { pressed: true }));
      expect(await border(chips.getByRole("button", { pressed: false }).first())).toEqual({ style: "solid", width: 1 });

      // Primary and tonal buttons differ by more than a fill: primary is inverted, tonal outlined.
      const openLogs = panel.getByRole("button", { name: "Open logs" });
      expect(await bg(openLogs)).toBe(await sys(page, "ButtonText"));
      expect(await fg(openLogs)).toBe(await sys(page, "ButtonFace"));
      await unforced(openLogs);
      expect(await border(panel.getByRole("button", { name: "Restart" }))).toEqual({ style: "solid", width: 1 });

      // Fields keep their edge.
      expect(await border(page.getByPlaceholder("Filter pods…"))).toEqual({ style: "solid", width: 1 });
    });

    test(`${theme} app on a ${scheme} system palette: Preferences, menus, palette and meters`, async ({ page }) => {
      await page.emulateMedia({ forcedColors: "active", colorScheme: scheme });
      await boot(page, theme);
      const highlight = await sys(page, "Highlight");

      // Meters on All Clusters: the track has an edge, the fill a system colour.
      await page.getByRole("button", { name: "All Clusters" }).click();
      const meter = page.locator("[data-level]").first();
      await expect(meter).toBeVisible();
      expect(await border(meter.locator("[data-meter-track]"))).toEqual({ style: "solid", width: 1 });
      expect(await bg(meter.getByTestId("meter-fill"))).toBe(await sys(page, "CanvasText"));

      // The highlighted menu item.
      await page.getByRole("button", { name: /^prod-aks AKS/ }).click();
      const item = page.getByRole("menuitem", { name: "Reconnect" });
      await item.hover();
      expect(await bg(item)).toBe(highlight);
      await page.keyboard.press("Escape");

      // The palette's highlighted row.
      await page.getByRole("button", { name: /Search & switch/ }).click();
      const selected = page.getByTestId("command-palette").locator("[data-selected]").first();
      await expect(selected).toBeVisible();
      expect(await bg(selected)).toBe(highlight);
      await page.keyboard.press("Escape");

      // Preferences: selected segment, switch on and off, a swatch, a disabled segment.
      await page.getByLabel("Preferences").click();
      const prefs = page.getByRole("dialog", { name: "Preferences" });
      const theme_ = prefs.getByRole("radiogroup", { name: "Theme" });
      expect(await bg(theme_.getByRole("radio", { checked: true }))).toBe(highlight);
      await unforced(theme_.getByRole("radio", { checked: true }));
      const tls = prefs.getByRole("switch", { name: "Skip TLS verification" });
      const hints = prefs.getByRole("switch", { name: "Show integration hints in panels" });
      for (const sw of [tls, hints]) {
        const on = (await sw.getAttribute("aria-checked")) === "true";
        const knob = sw.locator("[data-knob]");
        expect(await border(sw)).toEqual({ style: "solid", width: 1 });
        expect(await bg(knob)).toBe(await sys(page, on ? "HighlightText" : "ButtonText"));
        if (on) expect(await bg(sw)).toBe(highlight);
      }
      const swatches = prefs.getByRole("radiogroup", { name: "Color for prod-aks" });
      expect(await border(swatches.getByRole("radio", { checked: false }).first())).toEqual({
        style: "solid",
        width: 1,
      });
      expect(await bg(swatches.getByRole("radio", { checked: true }))).toBe(highlight);

      // A disabled control is grey text, whatever its role colour was. The browser
      // does this for a native disabled control; this checks no rule above undoes it.
      expect(await fg(prefs.getByRole("button", { name: "Move On-call up" }))).toBe(await sys(page, "GrayText"));
    });

    test(`${theme} app on a ${scheme} system palette: cards keep an edge`, async ({ page }) => {
      await page.emulateMedia({ forcedColors: "active", colorScheme: scheme });
      await boot(page, theme);
      await eachCard(page, async (name, el) => {
        expect((await edge(el)).style, name).toBe("solid");
      });
    });
  }
});
