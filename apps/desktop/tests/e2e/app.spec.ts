import { test, expect, type Page } from "@playwright/test";
import { tauriMockScript } from "./tauri-mock";

async function boot(page: Page, opts: { onboardingSeen?: boolean } = {}) {
  await page.addInitScript(tauriMockScript());
  const seen = opts.onboardingSeen ?? true;
  await page.addInitScript(
    ([seenValue]) => {
      window.localStorage.setItem("cubelite.onboardingSeen", seenValue);
      window.localStorage.setItem("cubelite.theme", '"dark"');
    },
    [String(seen)],
  );
  await page.goto("/");
}

test("shell renders titlebar, rail, sidebar and status bar", async ({ page }) => {
  await boot(page);
  await expect(page.getByText("prod-aks").first()).toBeVisible();
  await expect(page.getByText("AKS", { exact: true })).toBeVisible();
  await expect(page.getByLabel("All Clusters")).toBeVisible();
  await expect(page.getByText("Workloads")).toBeVisible();
  await expect(page.getByText("https://prod.azmk8s.io:443")).toBeVisible();
});

test("first launch shows onboarding and completes", async ({ page }) => {
  await boot(page, { onboardingSeen: false });
  await expect(page.getByText("Welcome to CubeLite")).toBeVisible();
  await expect(page.getByText("2 contexts found")).toBeVisible();
  await page.getByText("Continue").click();
  await page.getByText("Continue").click();
  await page.getByText("Start using CubeLite").click();
  await expect(page.getByText("Welcome to CubeLite")).not.toBeVisible();
  // The init script would reset the flag on reload; assert persistence directly.
  const seen = await page.evaluate(() => window.localStorage.getItem("cubelite.onboardingSeen"));
  expect(seen).toBe("true");
});

test("pods view lists fixtures and opens the detail drawer, Esc closes", async ({ page }) => {
  await boot(page);
  await page.getByText("Pods", { exact: true }).click();
  await expect(page.getByText("api-0")).toBeVisible();
  await expect(page.getByText("Pending", { exact: true })).toBeVisible();
  await page.getByText("api-0").click();
  await expect(page.getByRole("dialog", { name: "api-0" })).toBeVisible();
  await expect(page.getByText("Burstable")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "api-0" })).not.toBeVisible();
});

test("command palette navigates views", async ({ page }) => {
  await boot(page);
  await page.getByText("Search & switch…").click();
  await expect(page.getByPlaceholder("Search clusters, views, actions…")).toBeVisible();
  await page.getByText("Go to Deployments").click();
  await expect(page.getByText("Replicas · Actions")).toBeVisible();
});

test("cluster switch from the rail lands on the new cluster", async ({ page }) => {
  await boot(page);
  await page.getByTitle("staging").click();
  await expect(page.getByText("staging").first()).toBeVisible();
  await expect(page.getByLabel("All Clusters")).toBeVisible();
});

test("preferences persist the refresh interval across reloads", async ({ page }) => {
  await boot(page);
  await page.getByLabel("Preferences").click();
  await page.getByRole("radio", { name: "1m" }).click();
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(page.getByText("refresh 1m")).toBeVisible();
});
