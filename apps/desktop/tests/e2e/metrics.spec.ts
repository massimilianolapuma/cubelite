import { test, expect, type Page } from "@playwright/test";
import { tauriMockScript } from "./tauri-mock";

const GRAFANA_SERVICE = { namespace: "monitoring", service: "kps-grafana", port: 80, https: false };

/** Boots with a Prometheus endpoint for prod-aks and opens api-0's Metrics section. */
async function openMetrics(page: Page, grafana: { grafanaUrl: string | null; grafanaService?: typeof GRAFANA_SERVICE }) {
  await page.addInitScript(tauriMockScript());
  await page.addInitScript((g) => {
    window.localStorage.setItem("cubelite.onboardingSeen", "true");
    window.localStorage.setItem("cubelite.theme", '"dark"');
    window.localStorage.setItem(
      "cubelite.prometheus.endpoints",
      JSON.stringify({
        "prod-aks": {
          target: { kind: "in-cluster", namespace: "monitoring", service: "prometheus-operated", port: 9090, https: false },
          cluster: null,
          grafanaDatasource: "prom",
          skipTlsVerify: false,
          ...g,
        },
      }),
    );
  }, grafana);
  await page.goto("/");
  await page.getByRole("complementary").getByText("Pods", { exact: true }).click();
  await expect(page.getByRole("img", { name: "CPU, last hour" }).first()).toBeVisible();

  await page.getByText("api-0", { exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "api-0" });
  const section = drawer.getByTestId("metrics-section");
  await section.scrollIntoViewIfNeeded();
  await expect(section.getByTestId("metrics-chart")).toHaveCount(4);
  return section;
}

test("Prometheus metrics in the pod drawer, sparklines and Grafana (#510)", async ({ page }) => {
  const section = await openMetrics(page, { grafanaUrl: "https://grafana.example" });
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

test("Overview cluster history and alerts, and a node's metrics (#530)", async ({ page }) => {
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
  const history = page.getByTestId("cluster-history");
  await expect(history.getByTestId("metrics-chart")).toHaveCount(2);
  await expect(history.getByText("1.50 / alloc 4")).toBeVisible();
  // Watchdog (severity none) is listed but not counted.
  const badge = page.getByTestId("overview-alerts-badge");
  await expect(badge).toHaveText("1 alert firing");
  await expect(badge).toHaveAccessibleName("1 alert firing: 1 critical. Show the alerts.");
  await badge.click();
  await expect(page.getByTestId("alerts-card")).toBeFocused();
  await expect(page.getByTestId("alerts-card")).toBeInViewport();
  await expect(page.getByTestId("alerts-informational")).toHaveText("1 informational");
  const alerts = page.getByTestId("alerts-card");
  await expect(alerts.getByTestId("alert-row")).toHaveCount(2);
  await expect(alerts.getByText("Node is not ready.")).toBeVisible();

  await alerts.getByRole("button", { name: "Open Watchdog in Grafana" }).click();
  await expect.poll(() => page.evaluate(() => window.__grafanaOpened)).toMatchObject({
    grafanaUrl: "https://grafana.example",
    queries: ["vector(1)"],
    range: "1h",
  });

  await alerts.getByRole("button", { name: "node-1" }).click();
  const drawer = page.getByRole("dialog", { name: "node-1" });
  const section = drawer.getByTestId("node-metrics-section");
  await section.scrollIntoViewIfNeeded();
  await expect(section.getByTestId("metrics-chart")).toHaveCount(5);
  await expect(section.getByText("not available — needs node-exporter or cAdvisor metrics for this node")).toBeVisible();
});

test("Open in Grafana forwards to an in-cluster Grafana without a URL (#525)", async ({ page }) => {
  const section = await openMetrics(page, { grafanaUrl: null, grafanaService: GRAFANA_SERVICE });
  for (let i = 0; i < 2; i++) await section.getByRole("button", { name: "Grafana", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__grafanaOpened)).toMatchObject({
    grafanaUrl: "http://127.0.0.1:43000",
    datasource: "prom",
    range: "1h",
  });
  // The backend owns the forward and reuses it; each open asks for its port.
  const forwards = await page.evaluate(() => window.__grafanaForwards);
  expect(forwards).toHaveLength(2);
  expect(forwards?.[0]).toMatchObject({ context: "prod-aks", service: GRAFANA_SERVICE });
});
