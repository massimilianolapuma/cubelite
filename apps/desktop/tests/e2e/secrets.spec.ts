// Secret values stay in the backend until one is asked for (#661): the view
// reads one value per Reveal and drops it after the time set in Preferences.
import { type Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { SECRETS, SECRET_VALUES, tauriMockScript } from "./tauri-mock";

/** The Secrets list, in the sidebar's Config section. */
async function openSecrets(page: Page) {
  const aside = page.getByRole("complementary");
  const secrets = aside.getByText("Secrets", { exact: true });
  if (!(await secrets.isVisible())) await aside.getByRole("button", { name: /^Config \d+$/ }).click();
  await secrets.click();
}

async function boot(page: Page, hideAfter = 15) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.clock.install();
  await page.addInitScript(tauriMockScript({ secrets: SECRETS }));
  await page.addInitScript((seconds) => {
    window.localStorage.setItem("cubelite.onboardingSeen", "true");
    window.localStorage.setItem("cubelite.theme", '"dark"');
    window.localStorage.setItem("cubelite.secretHideAfter", JSON.stringify(seconds));
  }, hideAfter);
  await page.goto("/");
  await openSecrets(page);
  const keys = page.getByRole("group", { name: "Keys of api-credentials" });
  await expect(keys).toBeVisible();
  return keys;
}

const reveals = (page: Page) => page.evaluate(() => window.__secretReveals ?? []);

test("reveal one key: one read, for that key, and the value hides after the time", async ({ page }) => {
  const keys = await boot(page, 15);
  await expect(page.getByText("a value is read only when you reveal it")).toBeVisible();
  // Nothing was read to draw the list.
  expect(await reveals(page)).toEqual([]);
  for (const value of Object.values(SECRET_VALUES)) await expect(page.locator("body")).not.toContainText(value);

  await keys.getByRole("button", { name: "Reveal DB_PASSWORD" }).click();
  const password = SECRET_VALUES["default/api-credentials/DB_PASSWORD"];
  await expect(keys.getByText(password)).toBeVisible();
  expect(await reveals(page)).toEqual([
    { kubeconfigPath: expect.any(String), namespace: "default", name: "api-credentials", key: "DB_PASSWORD", context: "prod-aks" },
  ]);
  for (const [id, value] of Object.entries(SECRET_VALUES)) {
    if (!id.endsWith("/DB_PASSWORD")) await expect(page.locator("body")).not.toContainText(value);
  }
  await expect(page.getByTestId("secret-status")).toHaveText("DB_PASSWORD shown");

  await page.clock.runFor(14_000);
  await expect(keys.getByText(password)).toBeVisible();
  await page.clock.runFor(1_000);
  await expect(page.locator("body")).not.toContainText(password);
  await expect(keys.getByRole("button", { name: "Reveal DB_PASSWORD" })).toBeVisible();
  await expect(page.getByTestId("secret-status")).toHaveText("DB_PASSWORD hidden");
});

test("binary, Helm and every key's row read as the spec says", async ({ page }) => {
  const keys = await boot(page);
  const crt = keys.locator('[data-key-row="ca.crt"]');
  await expect(crt).toContainText("1.8 KiB");
  await expect(crt).toContainText("binary");
  await expect(crt.getByRole("button")).toHaveCount(0);
  const helm = page.getByRole("group", { name: "Keys of sh.helm.release.v1.api.v7" });
  await expect(helm).toHaveText("Helm release payload, shown in Helm");
  await expect(helm.getByRole("button")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Copy/ })).toHaveCount(0);
});

test("keyboard: Reveal buttons in key order, each with its ring; Enter keeps the focus on the button", async ({ page }) => {
  const keys = await boot(page);
  const first = keys.getByRole("button", { name: "Reveal API_KEY" });
  await page.keyboard.press("Shift");
  await first.focus();
  const order: string[] = [];
  for (let i = 0; i < 4; i++) {
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
  // The binary ca.crt has no action; the next Secret's key follows.
  expect(order).toEqual(["Reveal API_KEY", "Reveal DB_PASSWORD", "Reveal DB_USER", "Reveal .dockerconfigjson"]);

  const password = keys.getByRole("button", { name: "Reveal DB_PASSWORD" });
  await password.focus();
  await page.keyboard.press("Enter");
  const hide = keys.getByRole("button", { name: "Hide DB_PASSWORD" });
  await expect(hide).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(keys.getByRole("button", { name: "Reveal DB_PASSWORD" })).toBeFocused();
  await expect(page.locator("body")).not.toContainText(SECRET_VALUES["default/api-credentials/DB_PASSWORD"]);
});
