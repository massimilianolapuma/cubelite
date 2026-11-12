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
