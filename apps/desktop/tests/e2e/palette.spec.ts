import { test, expect, type Page } from "@playwright/test";
import { tauriMockScript } from "./tauri-mock";

// Go to any resource from ⌘K (resource-kinds phase 4, #583).
async function boot(page: Page) {
  await page.addInitScript(tauriMockScript());
  await page.addInitScript(() => {
    window.localStorage.setItem("cubelite.onboardingSeen", "true");
    window.localStorage.setItem("cubelite.theme", '"dark"');
  });
  await page.goto("/");
}

async function palette(page: Page, query: string) {
  const mac = await page.evaluate(() => navigator.userAgent.includes("Mac"));
  await page.keyboard.press(`${mac ? "Meta" : "Control"}+KeyK`);
  const input = page.getByPlaceholder("Search clusters, resources, actions…");
  await expect(input).toBeVisible();
  await input.fill(query);
  return mac;
}

test("↵ on a short name opens the type", async ({ page }) => {
  await boot(page);
  await expect(page.getByRole("list", { name: "Pinned · On-call" })).toBeVisible();
  await palette(page, "hpa");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Autoscalers" })).toBeVisible();
});

test("⌘↵ opens the type and pins it to the active profile", async ({ page }) => {
  await boot(page);
  await expect(page.getByRole("list", { name: "Pinned · On-call" })).toBeVisible();
  const mac = await palette(page, "sa");
  await page.keyboard.press(`${mac ? "Meta" : "Control"}+Enter`);
  await expect(page.getByRole("heading", { name: "Service Accounts" })).toBeVisible();
  await expect(
    page.getByRole("list", { name: "Pinned · On-call" }).getByText("Service Accounts", { exact: true }),
  ).toBeVisible();
});

test("a custom kind is reachable by short name (phase 5)", async ({ page }) => {
  await boot(page);
  await expect(page.getByRole("list", { name: "Pinned · On-call" })).toBeVisible();
  await palette(page, "smon");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "ServiceMonitor" })).toBeVisible();
});
