import { test, expect, type Page } from "@playwright/test";
import { FIXTURES, tauriMockScript } from "./tauri-mock";

// Custom Resources (resource-kinds phase 5, #586).
async function boot(page: Page, overrides: Partial<typeof FIXTURES> = {}) {
  await page.addInitScript(tauriMockScript(overrides));
  await page.addInitScript(() => {
    window.localStorage.setItem("cubelite.onboardingSeen", "true");
    window.localStorage.setItem("cubelite.theme", '"dark"');
  });
  await page.goto("/");
}

const aside = (page: Page) => page.locator("aside").first();
const custom = (page: Page) => aside(page).getByRole("button", { name: /^Custom Resources \d+$/ });

test("open a custom kind from its group, pin it, see it in Pinned", async ({ page }) => {
  await boot(page);
  await custom(page).click();
  await aside(page).getByRole("button", { name: /^monitoring\.coreos\.com \d+$/ }).click();
  await aside(page).getByText("ServiceMonitor", { exact: true }).click();
  await expect(page.getByRole("heading", { name: "ServiceMonitor" })).toBeVisible();
  await expect(page.getByText("monitoring.coreos.com").first()).toBeVisible();
  await page.getByRole("button", { name: "Pin to On-call" }).click();
  await expect(
    aside(page).getByRole("list", { name: "Pinned · On-call" }).getByText("ServiceMonitor", { exact: true }),
  ).toBeVisible();
});

test("60 groups stay in an 8-row area", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const groups = Array.from({ length: 60 }, (_, i) => ({
    group: `group${String(i).padStart(2, "0")}.example.com`,
    version: "v1",
    kind: `Widget${i}`,
    plural: `widget${i}s`,
    namespaced: true,
    short_names: [],
  }));
  await boot(page, { resourceKinds: [...FIXTURES.resourceKinds, ...groups] });
  await expect(custom(page)).toHaveText(/62/);
  await custom(page).click();
  const area = aside(page).getByTestId("custom-groups");
  await expect(area).toBeVisible();
  const box = await area.evaluate((el) => ({ client: el.clientHeight, scroll: el.scrollHeight }));
  expect(box.client).toBeLessThanOrEqual(8 * 26);
  expect(box.scroll).toBeGreaterThan(box.client);
  expect(await aside(page).evaluate((el) => el.scrollHeight <= el.clientHeight)).toBe(true);
});

test("opening a kind far down a long group list scrolls its row into view", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const groups = Array.from({ length: 60 }, (_, i) => ({
    group: `group${String(i).padStart(2, "0")}.example.com`,
    version: "v1",
    kind: `Widget${i}`,
    plural: `widget${i}s`,
    namespaced: true,
    short_names: [],
  }));
  await boot(page, { resourceKinds: [...FIXTURES.resourceKinds, ...groups] });
  await expect(custom(page)).toHaveText(/62/);
  const mac = await page.evaluate(() => navigator.userAgent.includes("Mac"));
  await page.keyboard.press(`${mac ? "Meta" : "Control"}+KeyK`);
  await page.getByPlaceholder("Search clusters, resources, actions…").fill("widget55");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Widget55" })).toBeVisible();
  const row = aside(page).getByTestId("custom-groups").locator('[aria-current="page"]');
  await expect(row).toHaveText(/Widget55/);
  await expect(row).toBeInViewport();
});
