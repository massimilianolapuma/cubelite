import { type Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { tauriMockScript } from "./tauri-mock";

// An action goes to the cluster it was started on (#685): a Delete pod dialog
// left open through a cluster switch deletes the pod it was opened on, on its
// cluster, never the pod of the same name on the cluster switched to.

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

test("Delete confirmed after a switch by shortcut goes to the cluster the dialog was opened on", async ({ page }) => {
  await boot(page);
  await page.getByRole("complementary").getByText("Pods", { exact: true }).click();
  await page.getByText("api-0", { exact: true }).click();
  await page.getByRole("dialog", { name: "api-0" }).getByRole("button", { name: "Delete" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete Pod" });
  const cluster = dialog.getByRole("list", { name: "Pod to delete" }).getByRole("listitem").filter({ hasText: "Cluster" });
  await expect(cluster).toContainText("prod-aks");

  // The shortcut for the second cluster of the rail (the e2e user agent is Windows).
  await page.keyboard.press("Control+Digit2");
  await expect(page.locator("header").first().getByRole("button", { name: /^staging/ })).toBeVisible();

  // The dialog is still the one it was: prod-aks's pod.
  await expect(dialog).toBeVisible();
  await expect(cluster).toContainText("prod-aks");
  await dialog.getByRole("button", { name: "Delete Pod" }).click();

  await expect.poll(() => deletes(page)).toEqual([
    expect.objectContaining({ namespace: "default", name: "api-0", context: "prod-aks" }),
  ]);
  await expect(page.getByText("Pod api-0 deleted on prod-aks")).toBeVisible();
  await expect(dialog).toBeHidden();
});
