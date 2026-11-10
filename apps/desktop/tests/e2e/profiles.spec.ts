import { type Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { tauriMockScript } from "./tauri-mock";

// Sidebar C, profiles and pins (resource-kinds phase 3, #580).
async function boot(page: Page) {
  await page.addInitScript(tauriMockScript());
  await page.addInitScript(() => {
    // Only on the first load of a test: reloads must keep what the test saved.
    if (window.sessionStorage.getItem("booted")) return;
    window.sessionStorage.setItem("booted", "1");
    window.localStorage.setItem("cubelite.onboardingSeen", "true");
    window.localStorage.setItem("cubelite.theme", '"dark"');
  });
  await page.goto("/");
}

const aside = (page: Page) => page.locator("aside").first();
const pinned = (page: Page, profile: string) => aside(page).getByRole("list", { name: `Pinned · ${profile}` });
const section = (page: Page, label: string) =>
  aside(page).getByRole("button", { name: new RegExp(`^${label}( pods need attention)? \\d+$`) });

async function profileShortcut(page: Page, digit: number) {
  const mac = await page.evaluate(() => navigator.userAgent.includes("Mac"));
  await page.keyboard.press(`${mac ? "Meta" : "Control"}+Alt+Digit${digit}`);
}

test("the sidebar does not scroll at 800 px", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await boot(page);
  await section(page, "Workloads").click();
  await expect(aside(page).getByText("Helm Releases")).toBeVisible();
  const fits = await aside(page).evaluate((el) => el.scrollHeight <= el.clientHeight);
  expect(fits).toBe(true);
  // With the default profile even the open section's types fit without their own scroll.
  const types = aside(page).getByRole("list", { name: "Workloads types" });
  expect(await types.evaluate((el) => el.scrollHeight <= el.clientHeight)).toBe(true);
});

test("a full profile with Workloads open still does not scroll at 800 px", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await boot(page);
  // On-call (7 pins) + Services + Ingresses = the 9-pin cap.
  await section(page, "Network").click();
  for (const label of ["Services", "Ingresses"]) {
    await aside(page).getByText(label, { exact: true }).first().click();
    await page.getByRole("button", { name: "Pin to On-call" }).click();
  }
  await expect(pinned(page, "On-call").getByRole("listitem")).toHaveCount(9);
  await section(page, "Workloads").click();
  await expect(aside(page).getByText("Helm Releases")).toBeVisible();
  expect(await aside(page).evaluate((el) => el.scrollHeight <= el.clientHeight)).toBe(true);
  // The pins and the section rows stay in view; only the open section's types may scroll.
  await expect(pinned(page, "On-call").getByText("Logs", { exact: true })).toBeInViewport();
  await expect(section(page, "Observe")).toBeInViewport();
});

test("switch profile from the menu and the keyboard, pin from a list header, survives reload", async ({ page }) => {
  await boot(page);
  await expect(pinned(page, "On-call")).toBeVisible();

  await aside(page).getByRole("button", { name: /Profile: On-call/ }).click();
  await page.getByRole("menuitemradio", { name: /Developer/ }).click();
  await expect(pinned(page, "Developer").getByText("Ingresses", { exact: true })).toBeVisible();

  await profileShortcut(page, 3);
  await expect(pinned(page, "Security").getByText("Network Policies", { exact: true })).toBeVisible();

  await section(page, "Config").click();
  await aside(page).getByText("Resource Quotas", { exact: true }).click();
  const toggle = page.getByRole("button", { name: "Pin to Security" });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(pinned(page, "Security").getByText("Resource Quotas", { exact: true })).toBeVisible();

  await page.reload();
  await expect(aside(page).getByRole("button", { name: /Profile: Security/ })).toBeVisible();
  await expect(pinned(page, "Security").getByText("Resource Quotas", { exact: true })).toBeVisible();
});

test("a 10th pin is refused with a toast", async ({ page }) => {
  await boot(page);
  await section(page, "Network").click();
  for (const label of ["Services", "Ingresses"]) {
    await aside(page).getByText(label, { exact: true }).first().click();
    await page.getByRole("button", { name: "Pin to On-call" }).click();
  }
  await expect(pinned(page, "On-call").getByRole("listitem")).toHaveCount(9);
  await section(page, "Config").click();
  await aside(page).getByText("Secrets", { exact: true }).click();
  await page.getByRole("button", { name: "Pin to On-call" }).click();
  await expect(page.getByText("A profile holds up to 9 pins")).toBeVisible();
  await expect(pinned(page, "On-call").getByRole("listitem")).toHaveCount(9);
});

test("create, rename and delete a profile in Preferences", async ({ page }) => {
  await boot(page);
  await aside(page).getByRole("button", { name: /Profile: On-call/ }).click();
  await page.getByRole("menuitem", { name: "Manage profiles…" }).click();

  const prefs = page.getByTestId("profiles-prefs");
  await prefs.getByLabel("Profile name").fill("Team A");
  await prefs.getByRole("radio", { name: "Copy On-call" }).click();
  await prefs.getByRole("button", { name: "Create" }).click();
  await expect(prefs.getByRole("button", { name: "Show pins of Team A" })).toBeVisible();

  await prefs.getByRole("button", { name: "Rename Team A" }).click();
  await prefs.getByLabel("New name for Team A").fill("Team B");
  await prefs.getByLabel("New name for Team A").press("Enter");
  await page.keyboard.press("Escape");
  await expect(aside(page).getByRole("button", { name: /Profile: Team B/ })).toBeVisible();
  await expect(pinned(page, "Team B").getByRole("listitem")).toHaveCount(7);

  await page.getByLabel("Preferences").click();
  await page.getByTestId("profiles-prefs").getByRole("button", { name: "Delete Team B" }).click();
  await page.keyboard.press("Escape");
  await expect(aside(page).getByRole("button", { name: /Profile: On-call/ })).toBeVisible();
});
