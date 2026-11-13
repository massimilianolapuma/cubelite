import { type Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { FIXTURES, tauriMockScript } from "./tauri-mock";

// The shared list card at the minimum window (Tonal §8.1, §9.1).
const [api] = FIXTURES.pods;
const pods = [
  api,
  { ...api, name: "payments-gateway-6f7c9d8b5-crash", namespace: "team-a", phase: "CrashLoopBackOff", ready: false },
  { ...api, name: "web-0", namespace: "team-a" },
];

async function boot(page: Page) {
  await page.setViewportSize({ width: 800, height: 600 });
  await page.addInitScript(tauriMockScript({ pods }));
  await page.addInitScript(() => {
    window.localStorage.setItem("cubelite.onboardingSeen", "true");
    window.localStorage.setItem("cubelite.theme", '"dark"');
  });
  await page.goto("/");
}

const open = (page: Page, name: string) => page.getByRole("complementary").getByText(name, { exact: true }).click();

test("a list title stays on one line; the tools wrap under it", async ({ page }) => {
  await boot(page);
  for (const [nav, title] of [
    ["Deployments", "Deployments"],
    ["Pods", "Pods"],
  ]) {
    await open(page, nav);
    const heading = page.getByRole("heading", { level: 1, name: title });
    await expect(heading).toBeVisible();
    const box = (await heading.boundingBox())!;
    // One line of the display style, and wide enough to read the word.
    expect(box.height).toBeLessThan(60);
    expect(await heading.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
});

test("sideways scroll keeps the name column and the namespace group in view", async ({ page }) => {
  await boot(page);
  await open(page, "Pods");
  await expect(page.getByText("api-0")).toBeVisible();
  await page.getByRole("button", { name: "Group by namespace" }).click();
  const scroller = page.getByTestId("list-scroller");
  expect(await scroller.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  await scroller.evaluate((el) => (el.scrollLeft = el.scrollWidth));
  await expect(page.locator('[data-group="team-a"]').getByText("team-a")).toBeInViewport();
  await expect(page.getByText("web-0")).toBeInViewport();
  await expect(page.getByRole("button", { name: "Sort by Name" })).toBeInViewport();
});

test("with the log panel open the list still shows rows", async ({ page }) => {
  await boot(page);
  await open(page, "Pods");
  const row = page.getByText("api-0");
  await row.click();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Pod logs panel")).toBeVisible();
  await page.keyboard.press("Escape");
  // At least three rows' worth of list, whatever the panel takes.
  const height = await page.getByTestId("list-scroller").evaluate((el) => el.clientHeight);
  expect(height).toBeGreaterThanOrEqual(3 * 38);
});
