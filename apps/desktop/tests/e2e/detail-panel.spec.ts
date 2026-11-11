import { type Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { tauriMockScript } from "./tauri-mock";

// The detail panel: docked beside the list from 1000 px of content, over it below (Tonal §5, §8.3).
async function boot(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await page.addInitScript(tauriMockScript());
  await page.addInitScript(() => {
    window.localStorage.setItem("cubelite.onboardingSeen", "true");
    window.localStorage.setItem("cubelite.theme", '"dark"');
  });
  await page.goto("/");
}

const open = (page: Page, name: string) => page.getByRole("complementary").getByText(name, { exact: true }).click();
const header = (page: Page, name: string) => page.locator(".list-head").getByText(name, { exact: true });

test("at 1440 × 900 the panel docks beside the list, which keeps five columns", async ({ page }) => {
  await boot(page, 1440, 900);
  await open(page, "Pods");
  await expect(header(page, "CPU")).toBeVisible();

  await page.getByText("api-0").click();
  const panel = page.getByRole("dialog", { name: "api-0" });
  await expect(panel).toHaveAttribute("data-mode", "docked");
  // Side by side: the list card ends before the panel starts.
  const list = (await page.locator("main").boundingBox())!;
  const box = (await panel.boundingBox())!;
  expect(list.x + list.width).toBeLessThanOrEqual(box.x);
  expect(Math.round(box.width)).toBe(360);
  // Name, namespace, status and two more; the rest is in the panel.
  await expect(page.locator(".list-head > *")).toHaveCount(5);
  await expect(header(page, "CPU")).toHaveCount(0);
  // Nothing is cut: the narrowed list does not scroll sideways.
  expect(await page.getByTestId("list-scroller").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);

  await panel.getByRole("button", { name: "Close" }).click();
  await expect(panel).toHaveCount(0);
  await expect(header(page, "CPU")).toBeVisible();
});

test("at 1280 × 800 the panel lies over the list, which keeps every column", async ({ page }) => {
  await boot(page, 1280, 800);
  await open(page, "Pods");
  await page.getByText("api-0").click();
  const panel = page.getByRole("dialog", { name: "api-0" });
  await expect(panel).toHaveAttribute("data-mode", "overlay");
  const list = (await page.locator("main").boundingBox())!;
  const box = (await panel.boundingBox())!;
  expect(box.x).toBeLessThan(list.x + list.width);
  await expect(page.locator(".list-head > *")).toHaveCount(8);
});

test("opening moves focus to the panel's heading; Esc gives it back to the row", async ({ page }) => {
  await boot(page, 1440, 900);
  await open(page, "Pods");
  const row = page.getByRole("button", { name: /^api-0/ });
  await row.focus();
  await page.keyboard.press("Enter");
  const panel = page.getByRole("dialog", { name: "api-0" });
  await expect(panel.getByRole("heading", { name: "api-0" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(row).toBeFocused();
});

test("Enter on a row and Enter again opens its logs", async ({ page }) => {
  await boot(page, 1440, 900);
  await open(page, "Pods");
  await page.getByRole("button", { name: /^api-0/ }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "api-0" })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Pod logs panel")).toBeVisible();
});

test("a docked deployment panel takes over scale and restart from the row", async ({ page }) => {
  await boot(page, 1440, 900);
  await open(page, "Deployments");
  const row = page.getByRole("button", { name: /^api/ }).first();
  await expect(row.getByRole("button", { name: "Scale up" })).toBeVisible();
  await page.getByText("api", { exact: true }).click();
  const panel = page.getByRole("dialog", { name: "api" });
  await expect(panel).toHaveAttribute("data-mode", "docked");
  await expect(panel.getByRole("button", { name: "Scale up" })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Rollout Restart" })).toBeVisible();
  await expect(page.locator("main").getByRole("button", { name: "Scale up" })).toHaveCount(0);
});

test("in a short panel the actions scroll with the content instead of squeezing it", async ({ page }) => {
  await boot(page, 800, 600);
  await open(page, "Pods");
  await page.getByText("api-0").click();
  const panel = page.getByRole("dialog", { name: "api-0" });
  await expect(panel.locator("footer")).toHaveAttribute("data-pinned", "true");
  await panel.getByRole("button", { name: "Open logs" }).click();
  await expect(page.getByLabel("Pod logs panel")).toBeVisible();
  // The log panel took most of the height: the footer joins the scrolling body.
  await expect(panel.locator("footer")).toHaveAttribute("data-pinned", "false");
  const body = (await panel.locator("[data-panel-body]").boundingBox())!;
  const whole = (await panel.boundingBox())!;
  expect(body.height).toBeGreaterThan(whole.height * 0.6);
  await expect(panel.getByRole("button", { name: "Delete" })).toBeAttached();
});

test("clicking another row and closing gives focus back to that row", async ({ page }) => {
  await boot(page, 1440, 900);
  await open(page, "Pods");
  await page.getByText("api-0").click();
  await page.getByText("worker-0").click();
  const panel = page.getByRole("dialog", { name: "worker-0" });
  await panel.getByRole("button", { name: "Close" }).click();
  await expect(panel).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^worker-0/ })).toBeFocused();
});
