import { type Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { FIXTURES, tauriMockScript } from "./tauri-mock";

// The Tonal shell (#611): top bar, rail, sidebar.
async function boot(page: Page, overrides: Parameters<typeof tauriMockScript>[0] = {}) {
  await page.addInitScript(tauriMockScript(overrides));
  await page.addInitScript(() => {
    window.localStorage.setItem("cubelite.onboardingSeen", "true");
    window.localStorage.setItem("cubelite.theme", '"dark"');
  });
  await page.goto("/");
}

const MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const aside = (page: Page) => page.locator("aside").first();

test("a long context name truncates instead of pushing the top bar out of the window", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  const long = "arn:aws:eks:eu-central-1:123456789012:cluster/payments-production-blue";
  await boot(page, {
    contexts: [{ ...FIXTURES.contexts[0], name: long }, ...FIXTURES.contexts.slice(1)],
  });
  const header = page.locator("header").first();
  await expect(header.getByText(long)).toBeVisible();
  expect(await header.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  // What sits after the name is still on screen.
  await expect(header.getByTestId("connection-state")).toBeInViewport();
});

test("the top bar stays on one row at the minimum window size", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await boot(page);
  const header = page.locator("header").first();
  await expect(header.getByTestId("connection-state")).toBeVisible();
  // One row: every control starts at the same height.
  const tops = await header.locator(":scope > button, :scope > div").evaluateAll((els) =>
    els.map((el) => Math.round(el.getBoundingClientRect().top)),
  );
  expect(new Set(tops).size).toBe(1);
  // Search collapses to its icon but keeps its name and still opens the palette.
  const search = header.getByRole("button", { name: /Search & switch/ });
  await expect(search).toBeVisible();
  expect((await search.boundingBox())!.width).toBeLessThan(60);
  await search.click();
  await expect(page.getByPlaceholder("Search clusters, resources, actions…")).toBeVisible();
});

test("the gutter above the top bar drags the window, as the title bar did", async ({ page }) => {
  await boot(page);
  await expect(page.locator("header").first()).toBeVisible();
  const drags = await page.evaluate(
    () => document.elementFromPoint(900, 3)?.closest("[data-tauri-drag-region]") !== null,
  );
  expect(drags).toBe(true);
});

test("keyboard focus shows a solid ring on the borderless shell controls", async ({ page }) => {
  await boot(page);
  await expect(page.getByLabel("All Clusters")).toBeVisible();
  await page.keyboard.press("Tab");
  const ring = await page.evaluate(() => {
    const style = getComputedStyle(document.activeElement!);
    return { label: document.activeElement!.getAttribute("aria-label"), style: style.outlineStyle, width: style.outlineWidth };
  });
  expect(ring).toEqual({ label: "All Clusters", style: "solid", width: "2px" });
});

test.describe("on macOS", () => {
  test.use({ userAgent: MAC_UA });

  test("the default profile still fits 1280×800 with the window controls strip", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await boot(page);
    await aside(page).getByRole("button", { name: /^Workloads/ }).click();
    await expect(aside(page).getByText("Helm Releases")).toBeVisible();
    expect(await aside(page).evaluate((el) => el.scrollHeight <= el.clientHeight)).toBe(true);
    const types = aside(page).getByRole("list", { name: "Workloads types" });
    expect(await types.evaluate((el) => el.scrollHeight <= el.clientHeight)).toBe(true);
  });

  test("nothing sits under the window controls, with or without the sidebar", async ({ page }) => {
    await boot(page);
    // The controls take the first 78 px of the top 36 px of the window.
    const clear = () =>
      page.evaluate(() =>
        [...document.querySelectorAll("button, input")].every((el) => {
          const box = el.getBoundingClientRect();
          return box.width === 0 || box.left >= 78 || box.top >= 36;
        }),
      );
    expect(await clear()).toBe(true);
    await page.getByLabel("All Clusters").click();
    await expect(page.getByText("All Clusters").first()).toBeVisible();
    expect(await clear()).toBe(true);
  });
});
