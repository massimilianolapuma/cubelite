import { type Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { tauriMockScript } from "./tauri-mock";

// A cluster switch closes the Delete pod dialog of the cluster being left
// (#685): nothing is deleted, on either cluster. A delete already confirmed
// goes to the cluster it was opened on (stores and PodsView unit tests).

async function boot(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  // staging answers the probe, so the switch lands connected as a real one would.
  await page.addInitScript(
    tauriMockScript({
      probes: {
        staging: { reachable: true, version: "v1.30.2", node_count: 1, pod_count: 4, issue_pod_count: 0, capacity: null, error: null },
      },
    }),
  );
  await page.addInitScript(() => {
    window.localStorage.setItem("cubelite.onboardingSeen", "true");
    window.localStorage.setItem("cubelite.theme", '"dark"');
  });
  await page.goto("/");
}

const deletes = (page: Page) => page.evaluate(() => window.__podDeletes ?? []);

test("a switch by shortcut closes the Delete pod dialog and deletes nothing", async ({ page }) => {
  await boot(page);
  await page.getByRole("complementary").getByText("Pods", { exact: true }).click();
  await page.getByText("api-0", { exact: true }).click();
  await page.getByRole("dialog", { name: "api-0" }).getByRole("button", { name: "Delete" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete Pod" });
  await expect(dialog.getByRole("list", { name: "Pod to delete" })).toContainText("prod-aks");

  // The shortcut for the second cluster of the rail (the e2e user agent is Windows).
  await page.keyboard.press("Control+Digit2");
  await expect(page.locator("header").first().getByRole("button", { name: /^staging/ })).toBeVisible();

  await expect(dialog).toHaveCount(0);
  // Long enough for a delete to have been sent, had the dialog sent one.
  await page.waitForTimeout(500);
  expect(await deletes(page)).toEqual([]);
});
