import { test, expect, type Page } from "@playwright/test";
import { tauriMockScript } from "./tauri-mock";

async function boot(page: Page) {
  await page.addInitScript(tauriMockScript());
  await page.addInitScript(() => {
    window.localStorage.setItem("cubelite.onboardingSeen", "true");
    window.localStorage.setItem("cubelite.theme", '"dark"');
  });
  await page.goto("/");
}

test("open logs from pod drawer, panel persists across navigation", async ({ page }) => {
  await boot(page);
  await page.getByText("Pods", { exact: true }).click();
  await page.getByText("api-0").click();
  await expect(page.getByRole("dialog", { name: "api-0" })).toBeVisible();
  await page.getByRole("button", { name: "Log panel" }).click();
  await expect(page.getByLabel("Pod logs panel")).toBeVisible();

  // stream a line through the mock and see it render
  await page.evaluate(() =>
    window.__emitTauriEvent?.("pod-log-line:1", {
      pod: "api-0",
      namespace: "default",
      time: "2026-08-04T10:00:00Z",
      level: "info",
      message: "e2e-hello",
    }),
  );
  await expect(page.getByText("e2e-hello")).toBeVisible();

  // navigate elsewhere: panel stays
  await page.getByText("Services", { exact: true }).click();
  await expect(page.getByLabel("Pod logs panel")).toBeVisible();
  await expect(page.getByText("e2e-hello")).toBeVisible();
});
