import { type Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { tauriMockScript } from "./tauri-mock";

async function boot(page: Page, storage: Record<string, string> = {}) {
  await page.addInitScript(tauriMockScript());
  await page.addInitScript(
    ([entries]) => {
      const all = { "cubelite.onboardingSeen": "true", "cubelite.theme": '"dark"', ...entries };
      for (const [key, value] of Object.entries(all)) window.localStorage.setItem(key, value);
    },
    [storage],
  );
  await page.goto("/");
}

/** The tint hue the window is showing, once its cross-fade has finished. */
const tintOf = (page: Page) =>
  page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--cl-tint-h"));

test("the window takes the tint of the cluster it is on", async ({ page }) => {
  await boot(page, {
    "cubelite.identityColors": JSON.stringify({ "prod-aks": "teal", staging: "violet" }),
  });
  await expect(page.getByText("prod-aks").first()).toBeVisible();
  await expect.poll(() => tintOf(page)).toBe("190");

  await page.getByTitle("staging").click();
  await expect.poll(() => tintOf(page)).toBe("310");

  // The All Clusters dashboard belongs to no cluster.
  await page.getByLabel("All Clusters").click();
  await expect.poll(() => tintOf(page)).toBe("240");
});

test("a saved colour that left the palette moves to its successor", async ({ page }) => {
  await boot(page, { "cubelite.identityColors": JSON.stringify({ "prod-aks": "amber" }) });
  await expect.poll(() => tintOf(page)).toBe("275");
  const saved = await page.evaluate(() => window.localStorage.getItem("cubelite.identityColors"));
  expect(JSON.parse(saved ?? "{}")["prod-aks"]).toBe("indigo");
});

test("onboarding shows the default tint, then the cluster's", async ({ page }) => {
  await boot(page, {
    "cubelite.onboardingSeen": "false",
    "cubelite.identityColors": JSON.stringify({ "prod-aks": "teal" }),
  });
  await expect(page.getByText("Welcome to CubeLite")).toBeVisible();
  await expect.poll(() => tintOf(page)).toBe("240");
  await page.getByText("Continue").click();
  await page.getByText("Continue").click();
  await page.getByText("Start using CubeLite").click();
  await expect.poll(() => tintOf(page)).toBe("190");
});

test("a subtree marked data-tint paints utilities in its own tint", async ({ page }) => {
  await boot(page);
  await expect(page.getByText("prod-aks").first()).toBeVisible();
  const colours = await page.evaluate(() => {
    const make = (tinted: boolean) => {
      const el = document.createElement("div");
      // Classes the app already uses, so Tailwind has emitted them.
      el.className = "bg-surface-window text-text-primary";
      if (tinted) {
        el.dataset.tint = "";
        el.style.setProperty("--cl-tint-h", "var(--cl-hue-magenta)");
      }
      document.body.append(el);
      const style = getComputedStyle(el);
      const out = { bg: style.backgroundColor, fg: style.color };
      el.remove();
      return out;
    };
    return { plain: make(false), tinted: make(true) };
  });
  expect(colours.tinted.bg).not.toBe(colours.plain.bg);
  expect(colours.tinted.fg).not.toBe(colours.plain.fg);
});
