import { test, expect, type Page } from "@playwright/test";
import { tauriMockScript } from "./tauri-mock";

/** ECK and kube-prometheus-stack, as `integrations_detect` reports them (#527). */
const DETECTED = {
  elasticsearch: { kind: "elasticsearch", namespace: "logging", name: "quickstart-es-http", port: 9200, https: true },
  kibana: { kind: "kibana", namespace: "logging", name: "quickstart-kb-http", port: 5601, https: true },
  prometheus: { kind: "prometheus", namespace: "monitoring", name: "prometheus-operated", port: 9090, https: false },
  grafana: { kind: "grafana", namespace: "monitoring", name: "kps-grafana", port: 80, https: false },
};

async function boot(page: Page) {
  await page.addInitScript(tauriMockScript());
  await page.addInitScript((detected) => {
    window.localStorage.setItem("cubelite.onboardingSeen", "true");
    window.localStorage.setItem("cubelite.theme", '"dark"');
    window.__detectedIntegrations = detected;
  }, DETECTED);
  await page.goto("/");
}

test("the banner offers the detected integrations and Enable saves them (#527)", async ({ page }) => {
  await boot(page);
  const banner = page.getByTestId("integrations-banner");
  await expect(banner).toHaveText(/Elasticsearch and Prometheus found in this cluster/);
  // Nothing reached Elasticsearch or Prometheus before the click.
  expect(await page.evaluate(() => window.__integrationCalls ?? [])).toEqual([]);

  await banner.getByRole("button", { name: "Enable" }).click();
  await expect(page.getByText("Elasticsearch enabled for prod-aks")).toBeVisible();
  await expect(page.getByText("Prometheus enabled for prod-aks")).toBeVisible();
  await expect(banner).toBeHidden();

  const calls = await page.evaluate(() => (window.__integrationCalls ?? []).map((c) => c.cmd));
  expect(calls).toEqual(["elastic_test", "elastic_use_eck_credentials", "prometheus_test", "prometheus_save_auth"]);
  const saved = await page.evaluate(() => ({
    elastic: JSON.parse(window.localStorage.getItem("cubelite.elastic.endpoints") ?? "{}"),
    prometheus: JSON.parse(window.localStorage.getItem("cubelite.prometheus.endpoints") ?? "{}"),
  }));
  expect(saved.elastic["prod-aks"]).toMatchObject({
    target: { kind: "in-cluster", namespace: "logging", service: "quickstart-es-http", port: 9200, https: true },
    kibanaService: { namespace: "logging", service: "quickstart-kb-http", port: 5601, https: true },
    preset: "ecs",
  });
  expect(saved.prometheus["prod-aks"]).toMatchObject({
    target: { kind: "in-cluster", namespace: "monitoring", service: "prometheus-operated", port: 9090, https: false },
    grafanaService: { namespace: "monitoring", service: "kps-grafana", port: 80, https: false },
  });
});

test("Review opens Preferences pre-filled and ✕ hides the banner for good (#527)", async ({ page }) => {
  await boot(page);
  const banner = page.getByTestId("integrations-banner");
  await banner.getByRole("button", { name: "Review" }).click();
  const prefs = page.getByTestId("elastic-prefs");
  await expect(prefs.getByLabel("Service")).toHaveValue("quickstart-es-http");
  await expect(prefs.getByLabel("Authentication")).toHaveValue("eck-user");
  await page.keyboard.press("Escape");

  await banner.getByRole("button", { name: "Dismiss" }).click();
  await expect(banner).toBeHidden();
  await page.reload();
  await expect(page.getByText("prod-aks").first()).toBeVisible();
  await expect(page.getByTestId("integrations-banner")).toBeHidden();

  // Preferences brings it back.
  await page.getByLabel("Preferences").click();
  await page.getByRole("button", { name: "Suggest detected integrations again" }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("integrations-banner")).toBeVisible();
});
