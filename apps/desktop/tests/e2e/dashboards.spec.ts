import { type Locator, type Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { FIXTURES, tauriMockScript } from "./tauri-mock";

// Long text on the dashboards stays in its box (Tonal §8.4, §9.2 "Long names").

/** A reason as the backend reports it: one URL of more than 80 characters, no space. */
const EKS_URL =
  "https://4F1C9A27D3B85E60AB12CD34EF567890.gr7.eu-west-1.eks.amazonaws.com:443/api/v1/namespaces/kube-system/pods?limit=500";
const LONG_REASON = `Get "${EKS_URL}": dial tcp 10.0.12.7:443: i/o timeout`;
/** A private API server's host: dots only, so nothing in it is a place to break the line. */
const LONG_HOST = "4f1c9a27d3b85e60ab12cd34ef567890.privatelink.westeurope.azmk8s.io";
const HOST_REASON = `Get "https://${LONG_HOST}:443/version": dial tcp: lookup ${LONG_HOST}: no such host`;

async function boot(page: Page, overrides: Partial<typeof FIXTURES> = {}) {
  await page.addInitScript(tauriMockScript(overrides));
  await page.addInitScript(() => {
    window.localStorage.setItem("cubelite.onboardingSeen", "true");
    window.localStorage.setItem("cubelite.theme", '"dark"');
  });
  await page.goto("/");
}

/** The content scroller: nothing in a view may make it scroll sideways. */
const scroller = (page: Page) => page.locator("main > div").first();

async function fitsSideways(el: Locator): Promise<boolean> {
  return el.evaluate((node) => node.scrollWidth <= node.clientWidth);
}

/** `inner` lies inside `outer`, give or take a pixel of rounding. */
async function expectInside(inner: Locator, outer: Locator) {
  const a = (await inner.boundingBox())!;
  const b = (await outer.boundingBox())!;
  expect(a.x).toBeGreaterThanOrEqual(b.x - 1);
  expect(a.x + a.width).toBeLessThanOrEqual(b.x + b.width + 1);
}

test("a long warning message on the Overview does not widen the page", async ({ page }) => {
  await page.setViewportSize({ width: 1270, height: 800 });
  await boot(page, {
    events: [
      {
        event_type: "Warning",
        reason: "FailedScheduling",
        object: "pod/worker-0",
        message:
          "0/3 nodes are available: 1 node(s) had untolerated taint {node.kubernetes.io/not-ready: }, 2 Insufficient memory. preemption: 0/3 nodes are available.",
        namespace: "default",
        count: 4,
        last_timestamp: "2026-11-12T08:00:00Z",
      },
    ],
  });
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  await expect(page.getByText("pod/worker-0")).toBeVisible();
  expect(await fitsSideways(scroller(page))).toBe(true);
});

test("an unreachable cluster's long reason stays inside its card on All Clusters", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await boot(page, {
    probes: {
      staging: { reachable: false, version: null, node_count: null, pod_count: null, issue_pod_count: null, capacity: null, error: LONG_REASON },
    },
  });
  await page.getByLabel("All Clusters").click();
  await expect(page.getByRole("heading", { level: 1, name: "All Clusters" })).toBeVisible();
  const card = page.locator('[data-tint][data-state="unreachable"]');
  const detail = card.getByTestId("unreachable-detail");
  await expect(detail).toContainText(EKS_URL);
  expect(await fitsSideways(scroller(page))).toBe(true);
  expect(await fitsSideways(detail)).toBe(true);
  await expectInside(detail, card);
});

test("the Unreachable view keeps a long host inside its hero", async ({ page }) => {
  await boot(page, {
    probes: {
      staging: { reachable: false, version: null, node_count: null, pod_count: null, issue_pod_count: null, capacity: null, error: HOST_REASON },
    },
  });
  await page.getByTitle("staging").click();
  await expect(page.getByRole("heading", { level: 1, name: "Cluster unreachable" })).toBeVisible();
  const hero = page.locator('[data-hero="error"]');
  const reason = hero.getByText("no such host", { exact: false });
  await expect(reason).toBeVisible();
  expect(await fitsSideways(reason)).toBe(true);
  await expectInside(reason, hero);
  expect(await fitsSideways(scroller(page))).toBe(true);
});
