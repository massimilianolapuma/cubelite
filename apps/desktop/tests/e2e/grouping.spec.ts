import { type Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { FIXTURES, tauriMockScript } from "./tauri-mock";

// Group the resource lists by namespace (#547).
const [api, worker] = FIXTURES.pods;
const pods = [
  api,
  worker,
  { ...api, name: "coredns-0", namespace: "kube-system", labels: { app: "coredns" } },
  { ...api, name: "web-0", namespace: "team-a", labels: { app: "web" } },
];

async function boot(page: Page) {
  await page.addInitScript(tauriMockScript({ pods }));
  await page.addInitScript(() => {
    window.localStorage.setItem("cubelite.onboardingSeen", "true");
    window.localStorage.setItem("cubelite.theme", '"dark"');
  });
  await page.goto("/");
  await page.getByRole("complementary").getByText("Pods", { exact: true }).click();
  await expect(page.getByText("api-0")).toBeVisible();
}

const group = (page: Page, ns: string) => page.locator(`[data-group="${ns}"]`);

test("toggle groups pods by namespace, headers collapse, Option-click all, filter expands", async ({ page }) => {
  await boot(page);
  const toggle = page.getByRole("button", { name: "Group by namespace" });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("button", { name: "Sort by Namespace" })).toBeVisible();

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("[data-group]")).toHaveCount(3);
  expect(await page.locator("[data-group]").evaluateAll((els) => els.map((e) => e.getAttribute("data-group")))).toEqual([
    "default",
    "kube-system",
    "team-a",
  ]);
  await expect(group(page, "default")).toHaveAccessibleName("default, 2 pods, 1 with problems, expanded");
  await expect(page.getByRole("button", { name: "Sort by Namespace" })).toHaveCount(0);

  await group(page, "default").click();
  await expect(group(page, "default")).toHaveAttribute("data-expanded", "false");
  await expect(page.getByText("api-0")).toHaveCount(0);
  await expect(page.getByText("web-0")).toBeVisible();

  await group(page, "kube-system").click({ modifiers: ["Alt"] });
  await expect(page.locator('[data-expanded="true"]')).toHaveCount(0);
  await expect(page.getByText("web-0")).toHaveCount(0);

  const filter = page.getByPlaceholder("Filter pods…");
  await filter.fill("api");
  await expect(page.locator("[data-group]")).toHaveCount(1);
  await expect(group(page, "default")).toHaveAttribute("data-expanded", "true");
  await expect(page.getByText("api-0")).toBeVisible();
  await expect(page.getByText("worker-0")).toHaveCount(0);

  await filter.fill("");
  await expect(page.locator("[data-group]")).toHaveCount(3);
  await expect(page.locator('[data-expanded="true"]')).toHaveCount(0);

  // Option-click again expands every group.
  await group(page, "team-a").click({ modifiers: ["Alt"] });
  await expect(page.locator('[data-expanded="false"]')).toHaveCount(0);
  await expect(page.getByText("coredns-0")).toBeVisible();
});

test("the preference persists and lives in Preferences → Navigation; collapse does not", async ({ page }) => {
  await boot(page);
  await page.getByLabel("Preferences").click();
  const sw = page.getByRole("switch", { name: "Group by namespace" });
  await expect(sw).toHaveAttribute("aria-checked", "false");
  await sw.click();
  await expect(sw).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");

  await group(page, "team-a").click();
  await expect(page.getByText("web-0")).toHaveCount(0);

  await page.reload();
  await page.getByRole("complementary").getByText("Pods", { exact: true }).click();
  await expect(page.getByRole("button", { name: "Group by namespace" })).toHaveAttribute("aria-pressed", "true");
  await expect(group(page, "team-a")).toHaveAttribute("data-expanded", "true");
  await expect(page.getByText("web-0")).toBeVisible();
});
