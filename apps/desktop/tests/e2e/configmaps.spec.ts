// A ConfigMap's values, read one at a time (#668): its keys are listed under
// it with their sizes; Show reads one value from the backend and Hide drops
// it; Copy goes through the backend and never puts the value in the page. No
// timer, nothing masked.
import { type Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { CONFIGMAPS, CONFIGMAP_VALUES, FIXTURES, tauriMockScript } from "./tauri-mock";

/** The ConfigMaps list, in the sidebar's Config section. */
async function openConfigMaps(page: Page) {
  const aside = page.getByRole("complementary");
  const nav = aside.getByText("ConfigMaps", { exact: true });
  if (!(await nav.isVisible())) await aside.getByRole("button", { name: /^Config \d+$/ }).click();
  await nav.click();
}

async function boot(page: Page, overrides: Partial<typeof FIXTURES> = {}) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.clock.install();
  await page.addInitScript(tauriMockScript({ configmaps: CONFIGMAPS, ...overrides }));
  await page.addInitScript(() => {
    window.localStorage.setItem("cubelite.onboardingSeen", "true");
    window.localStorage.setItem("cubelite.theme", '"dark"');
  });
  await page.goto("/");
  await openConfigMaps(page);
  const keys = page.getByRole("group", { name: "Keys of app-config" });
  await expect(keys).toBeVisible();
  return keys;
}

const reads = (page: Page) => page.evaluate(() => window.__configMapReads ?? []);
const copies = (page: Page) => page.evaluate(() => window.__configMapCopies ?? []);
const yaml = CONFIGMAP_VALUES["default/app-config/application.yaml"];

test("show one key: one read, for that key, its lines kept; Hide drops it; no timer", async ({ page }) => {
  const keys = await boot(page);
  // Nothing was read to draw the list, and nothing is masked.
  expect(await reads(page)).toEqual([]);
  await expect(page.locator("body")).not.toContainText("server:");
  await expect(keys).not.toContainText("••••••••");
  await expect(keys.locator('[data-key-row="LOG_LEVEL"]')).toContainText("4 B");

  await keys.getByRole("button", { name: "Show application.yaml" }).click();
  const shown = keys.locator('[data-key-row="application.yaml"] [data-key-shown]');
  await expect(shown).toBeVisible();
  expect(await shown.textContent()).toBe(yaml);
  expect(await reads(page)).toEqual([
    { kubeconfigPath: expect.any(String), namespace: "default", name: "app-config", key: "application.yaml", context: "prod-aks" },
  ]);
  await expect(page.getByTestId("configmap-status")).toHaveText("application.yaml shown");
  // Eleven lines: past eight it scrolls inside the row.
  const fits = await shown.evaluate((el) => el.scrollHeight > el.clientHeight + 1);
  expect(fits, "a value over 8 lines scrolls").toBe(true);

  // An hour later it is still there: there is no timer.
  await page.clock.runFor(60 * 60 * 1000);
  await expect(shown).toBeVisible();

  await keys.getByRole("button", { name: "Hide application.yaml" }).click();
  await expect(page.locator("body")).not.toContainText("server:");
  await expect(keys.getByRole("button", { name: "Show application.yaml" })).toBeVisible();
  await expect(page.getByTestId("configmap-status")).toHaveText("application.yaml hidden");
});

test("copy: one call, for that key; Copied for 2 s; no value reaches the page", async ({ page }) => {
  const keys = await boot(page);
  const showAt = async () => (await keys.getByRole("button", { name: "Show application.yaml" }).boundingBox())!.x;
  const before = await showAt();
  await keys.getByRole("button", { name: "Copy application.yaml" }).click();
  await expect(keys.getByRole("button", { name: "Copied application.yaml" })).toHaveText("Copied");
  // "Copied" takes no more room than "Copy": Show does not move.
  expect(await showAt()).toBe(before);
  expect(await copies(page)).toEqual([
    { kubeconfigPath: expect.any(String), namespace: "default", name: "app-config", key: "application.yaml", context: "prod-aks" },
  ]);
  await expect(page.getByTestId("configmap-status")).toHaveText("application.yaml copied");
  expect(await reads(page)).toEqual([]);
  await expect(page.locator("body")).not.toContainText("server:");
  await page.clock.runFor(2_000);
  await expect(keys.getByRole("button", { name: "Copy application.yaml" })).toHaveText("Copy");
});

test("a binary key offers Copy base64 only; an empty key no action", async ({ page }) => {
  const keys = await boot(page);
  const logo = keys.locator('[data-key-row="logo.png"]');
  await expect(logo).toContainText("14 KiB");
  await expect(logo).toContainText("binary");
  await expect(logo.getByRole("button")).toHaveCount(1);
  await expect(logo.getByRole("button", { name: "Copy logo.png as base64" })).toHaveText("Copy base64");
  await logo.getByRole("button", { name: "Copy logo.png as base64" }).click();
  await expect(logo.getByRole("button", { name: "Copied logo.png as base64" })).toBeVisible();
  expect((await copies(page)).map((c) => c.key)).toEqual(["logo.png"]);
  expect(await reads(page)).toEqual([]);

  const unused = keys.locator('[data-key-row="unused"]');
  await expect(unused).toContainText("empty");
  await expect(unused.getByRole("button")).toHaveCount(0);
});

test("keyboard: per key Show then Copy, each with its ring; Enter keeps the focus on the button", async ({ page }) => {
  const keys = await boot(page);
  const first = keys.getByRole("button", { name: "Show LOG_LEVEL" });
  await page.keyboard.press("Shift");
  await first.focus();
  const order: string[] = [];
  for (let i = 0; i < 7; i++) {
    const focused = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement;
      const s = getComputedStyle(el);
      return {
        name: el.getAttribute("aria-label") ?? "",
        ring: s.outlineStyle !== "none" && parseFloat(s.outlineWidth) >= 2 && el.matches(":focus-visible"),
      };
    });
    expect(focused.ring, focused.name).toBe(true);
    order.push(focused.name);
    await page.keyboard.press("Tab");
  }
  // logo.png has Copy only, unused nothing; then the next ConfigMap's key.
  expect(order).toEqual([
    "Show LOG_LEVEL",
    "Copy LOG_LEVEL",
    "Show application.yaml",
    "Copy application.yaml",
    "Copy logo.png as base64",
    "Show ca.crt",
    "Copy ca.crt",
  ]);

  await first.focus();
  await page.keyboard.press("Enter");
  const hide = keys.getByRole("button", { name: "Hide LOG_LEVEL" });
  await expect(hide).toBeFocused();
  await expect(keys.locator('[data-key-row="LOG_LEVEL"] [data-key-shown]')).toHaveText("info");
  await page.keyboard.press("Enter");
  await expect(keys.getByRole("button", { name: "Show LOG_LEVEL" })).toBeFocused();

  await keys.getByRole("button", { name: "Copy LOG_LEVEL" }).focus();
  await page.keyboard.press("Enter");
  await expect(keys.getByRole("button", { name: "Copied LOG_LEVEL" })).toBeFocused();
  await page.clock.runFor(2_000);
  await expect(keys.getByRole("button", { name: "Copy LOG_LEVEL" })).toBeFocused();
});

test("a vanished key says so in its row", async ({ page }) => {
  const keys = await boot(page, { configMapValues: {} });
  await keys.getByRole("button", { name: "Show LOG_LEVEL" }).click();
  await expect(keys.locator('[data-key-row="LOG_LEVEL"]')).toContainText("No longer exists");
  await expect(keys.locator('[data-key-row="LOG_LEVEL"] [data-glyph="err"]')).toBeVisible();
});
