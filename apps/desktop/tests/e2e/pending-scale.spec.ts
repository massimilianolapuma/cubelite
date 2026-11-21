import { type Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { tauriMockScript } from "./tauri-mock";

// A scale held in the stepper's debounce goes to the cluster it was made on;
// switching cluster within the debounce drops it (#682).

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
/** The mock's IPC, and every `scale_deployment` the app sent, in order. */
type Host = { __TAURI_INTERNALS__: { invoke: Invoke }; __scales?: Record<string, unknown>[] };

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
  // Record every scale_deployment the app sends, before the mock answers it.
  await page.addInitScript(() => {
    const host = window as unknown as Host;
    const invoke = host.__TAURI_INTERNALS__.invoke.bind(host.__TAURI_INTERNALS__);
    host.__TAURI_INTERNALS__.invoke = (cmd, args) => {
      if (cmd === "scale_deployment") host.__scales = [...(host.__scales ?? []), args ?? {}];
      return invoke(cmd, args);
    };
  });
  await page.addInitScript(() => {
    window.localStorage.setItem("cubelite.onboardingSeen", "true");
    window.localStorage.setItem("cubelite.theme", '"dark"');
  });
  await page.goto("/");
}

const scales = (page: Page) => page.evaluate(() => (window as unknown as Host).__scales ?? []);

test("a step left alone is sent to its cluster; a switch within the debounce sends nothing", async ({ page }) => {
  await boot(page);
  await page.getByRole("complementary").getByText("Deployments", { exact: true }).click();
  const row = page.getByRole("button", { name: /^api/ }).first();

  await row.getByRole("button", { name: "Scale up" }).click();
  await expect.poll(() => scales(page)).toEqual([
    expect.objectContaining({ namespace: "default", name: "api", replicas: 3, context: "prod-aks" }),
  ]);

  await row.getByRole("button", { name: "Scale up" }).click();
  await expect(row.locator("[data-pending='true']")).toHaveCount(1);
  await page.getByRole("navigation", { name: "Clusters" }).getByRole("button", { name: /^staging,/ }).click();
  await expect(page.locator("header").first().getByRole("button", { name: /^staging/ })).toBeVisible();
  await page.waitForTimeout(1_000);

  // Only the first scale: none to staging, none to prod-aks after the switch.
  expect(await scales(page)).toHaveLength(1);
});
