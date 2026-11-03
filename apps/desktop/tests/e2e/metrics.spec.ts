import { test, expect } from "@playwright/test";
import { tauriMockScript } from "./tauri-mock";

test("Prometheus metrics in the pod drawer, sparklines and Grafana (#510)", async ({ page }) => {
  await page.addInitScript(tauriMockScript());
  await page.addInitScript(() => {
    window.localStorage.setItem("cubelite.onboardingSeen", "true");
    window.localStorage.setItem("cubelite.theme", '"dark"');
    window.localStorage.setItem(
      "cubelite.prometheus.endpoints",
      JSON.stringify({
        "prod-aks": {
          target: { kind: "in-cluster", namespace: "monitoring", service: "prometheus-operated", port: 9090, https: false },
          cluster: null,
          grafanaUrl: "https://grafana.example",
          grafanaDatasource: "prom",
          skipTlsVerify: false,
        },
      }),
    );
  });
  await page.goto("/");
  await page.getByRole("complementary").getByText("Pods", { exact: true }).click();
  await expect(page.getByRole("img", { name: "CPU, last hour" }).first()).toBeVisible();

  await page.getByText("api-0", { exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "api-0" });
  const section = drawer.getByTestId("metrics-section");
  await section.scrollIntoViewIfNeeded();
  await expect(section.getByTestId("metrics-chart")).toHaveCount(4);
  await expect(section.getByText("250m / req 500m / lim 1")).toBeVisible();
  await expect(section.getByText("1 in range")).toBeVisible();
  const request = await page.evaluate(() => window.__lastPromMetrics);
  expect(request).toMatchObject({
    context: "prod-aks",
    request: { namespace: "default", workload: { kind: "pod", name: "api-0" }, range: "1h", perContainer: true },
  });

  await section.getByRole("radio", { name: "6h" }).click();
  await expect.poll(() => page.evaluate(() => (window.__lastPromMetrics?.request as { range: string }).range)).toBe("6h");

  await section.getByRole("button", { name: "Open CPU in Grafana" }).click();
  const opened = await page.evaluate(() => window.__grafanaOpened);
  expect(opened).toMatchObject({
    grafanaUrl: "https://grafana.example",
    datasource: "prom",
    queries: ["e2e-cpu", "e2e-cpu-request", "e2e-cpu-limit"],
    range: "6h",
  });
});
