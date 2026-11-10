import { type Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { tauriMockScript } from "./tauri-mock";

// Resource kinds phase 2 (#578): the generic list and the YAML drawer.
async function boot(page: Page) {
  await page.addInitScript(tauriMockScript());
  await page.addInitScript(() => {
    window.localStorage.setItem("cubelite.onboardingSeen", "true");
    window.localStorage.setItem("cubelite.theme", '"dark"');
  });
  await page.goto("/");
}

test("a new kind opens as kubectl's columns with a read-only YAML drawer", async ({ page }) => {
  await boot(page);
  const sidebar = page.locator("aside").first();
  await sidebar.getByRole("button", { name: /^Workloads/ }).click();
  await sidebar.getByText("DaemonSets").click();
  await expect(page.getByRole("heading", { name: "DaemonSets" })).toBeVisible();
  for (const h of ["Desired", "Node Selector"]) await expect(page.getByText(h, { exact: true })).toBeVisible();
  await expect(page.getByText("kubernetes.io/os=linux")).toBeVisible();
  await expect(sidebar.getByText("DaemonSets").locator("..").getByTestId("nav-count")).toHaveText("1");

  await page.getByRole("button", { name: /fluent-bit/ }).click();
  const drawer = page.getByRole("dialog", { name: "fluent-bit" });
  await expect(drawer).toContainText("kind: DaemonSet");
  await expect(page.getByRole("button", { name: "Edit" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
});

test("a kind the cluster does not serve says so", async ({ page }) => {
  await boot(page);
  const sidebar = page.locator("aside").first();
  await sidebar.getByRole("button", { name: /^Storage \d+$/ }).click();
  const row = sidebar.getByText("Storage Classes");
  await expect(row.locator("..")).toHaveAttribute("title", "Not available on this cluster");
  await row.click();
  await expect(page.getByText("Not available on this cluster", { exact: true })).toBeVisible();
});

test("a cluster-scoped kind says so and has no Namespace column", async ({ page }) => {
  await boot(page);
  await page.locator("aside").first().getByRole("button", { name: /^Access Control \d+$/ }).click();
  await page.locator("aside").first().getByText("Cluster Roles").click();
  await expect(page.getByText("cluster-scoped")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sort by Namespace" })).toHaveCount(0);
  await expect(page.getByText("No cluster roles found.")).toBeVisible();
});
