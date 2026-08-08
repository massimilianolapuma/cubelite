import { test, expect, type Page } from "@playwright/test";
import { tauriMockScript, emitPodLogLine } from "./tauri-mock";

async function boot(page: Page) {
  await page.addInitScript(tauriMockScript());
  await page.addInitScript(() => {
    window.localStorage.setItem("cubelite.onboardingSeen", "true");
    window.localStorage.setItem("cubelite.theme", '"dark"');
  });
  await page.goto("/");
}

/** Opens the pod drawer for `pod` and then its log panel. */
async function openLogPanel(page: Page, pod: string) {
  await page.getByText("Pods", { exact: true }).click();
  await page.getByText(pod, { exact: true }).click();
  await expect(page.getByRole("dialog", { name: pod })).toBeVisible();
  await page.getByRole("button", { name: "Log panel" }).click();
  await expect(page.getByLabel("Pod logs panel")).toBeVisible();
}

test("open logs from pod drawer, panel persists across navigation", async ({ page }) => {
  await boot(page);
  await openLogPanel(page, "api-0");

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

test("merged all-containers view interleaves color-tagged lines", async ({ page }) => {
  await boot(page);
  await openLogPanel(page, "api-0");

  // default container on open is the first non-init one from the fixture;
  // it has restarts, so the previous-instance chip is showing
  await expect(page.getByRole("button", { name: "worker", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "prev" })).toBeVisible();

  // open the container picker and switch to the merged "all containers" mode
  await page.getByRole("button", { name: "worker", exact: true }).click();
  await page.getByRole("button", { name: /all containers/ }).click();
  await expect(page.getByRole("button", { name: "all containers" })).toBeVisible();

  // stream a line per regular container through their own sub-stream
  await emitPodLogLine(page, "worker", "hello from worker");
  await emitPodLogLine(page, "envoy", "hello from envoy");

  // lines from both regular containers are visible
  await expect(page.getByText("hello from worker")).toBeVisible();
  await expect(page.getByText("hello from envoy")).toBeVisible();

  // source column shows the container names (scoped to the log panel: the
  // pod drawer's own Containers list now also lists "worker/envoy" since
  // its fixture was aligned with get_pod_containers, see #297 finding 3)
  const logPanel = page.getByLabel("Pod logs panel");
  await expect(logPanel.getByText("worker", { exact: true })).toBeVisible();
  await expect(logPanel.getByText("envoy", { exact: true })).toBeVisible();

  // previous-instance chip is gone in merged mode
  await expect(page.getByRole("button", { name: "prev" })).toHaveCount(0);
});
