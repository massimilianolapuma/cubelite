import { type Page } from "@playwright/test";
import { test, expect } from "./fixtures";
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
  // Kinds show right away under their vendor (#589).
  await expect(aside(page).getByText("coreos.com", { exact: true })).toBeVisible();
  await aside(page).getByText("ServiceMonitor", { exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "ServiceMonitor" })).toBeVisible();
  await expect(page.getByText("monitoring.coreos.com").first()).toBeVisible();
  await page.getByRole("button", { name: "Pin to On-call" }).click();
  await expect(
    aside(page).getByRole("list", { name: "Pinned · On-call" }).getByText("ServiceMonitor", { exact: true }),
  ).toBeVisible();
});

test("60 groups: only the section's list scrolls, the sidebar does not", async ({ page }) => {
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
  await expect(custom(page)).toHaveText(/64/);
  await custom(page).click();
  const types = aside(page).getByRole("list", { name: "Custom Resources types" });
  await expect(types).toBeVisible();
  const box = await types.evaluate((el) => ({ client: el.clientHeight, scroll: el.scrollHeight }));
  expect(box.scroll).toBeGreaterThan(box.client);
  expect(await aside(page).evaluate((el) => el.scrollHeight <= el.clientHeight)).toBe(true);
  await expect(aside(page).getByRole("button", { name: /^Observe \d+$/ })).toBeInViewport();
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
  await expect(custom(page)).toHaveText(/64/);
  const mac = await page.evaluate(() => navigator.userAgent.includes("Mac"));
  await page.keyboard.press(`${mac ? "Meta" : "Control"}+KeyK`);
  await page.getByPlaceholder("Search clusters, resources, actions…").fill("widget55");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "Widget55" })).toBeVisible();
  const row = aside(page).getByRole("list", { name: "Custom Resources types" }).locator('[aria-current="page"]');
  await expect(row).toHaveText(/Widget55/);
  await expect(row).toBeInViewport();
});
