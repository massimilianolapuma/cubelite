import { type Locator, type Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { FIXTURES, tauriMockScript } from "./tauri-mock";

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

// #648: the version of an image is what the reader looks for. In the narrowest
// panel (360 px) a long reference truncates its repository, never its tag.
const LONG_IMAGE = "registry.example.internal:5000/platform/team/backend-services/orders-api:2.14.3-rc.1";
const LONG_TAG = "2.14.3-rc.1-build.20261113.sha.4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d";

async function bootWithImages(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  const [api, worker] = FIXTURES.pods;
  await page.addInitScript(
    tauriMockScript({
      pods: [
        {
          ...api,
          containers: [
            { name: "orders", image: LONG_IMAGE, ready: true },
            { name: "builder", image: `ghcr.io/x/builder:${LONG_TAG}`, ready: true },
          ],
        },
        worker,
      ],
      deployments: [{ ...FIXTURES.deployments[0], images: [LONG_IMAGE, "ghcr.io/x/envoy:1.29"] }],
    }),
  );
  await page.addInitScript(() => {
    window.localStorage.setItem("cubelite.onboardingSeen", "true");
    window.localStorage.setItem("cubelite.theme", '"dark"');
  });
  await page.goto("/");
}

/** The tag is drawn whole inside the panel and inside its own row. */
async function expectTagWhole(panel: Locator, ref: Locator, tag: string) {
  const tagEl = ref.locator("[data-image-tag]");
  await expect(tagEl).toHaveText(tag);
  const box = (await panel.boundingBox())!;
  const own = (await ref.boundingBox())!;
  const rects = await tagEl.evaluate((el) => [...el.getClientRects()].map((r) => ({ left: r.left, right: r.right })));
  for (const r of rects) {
    expect(r.left).toBeGreaterThanOrEqual(Math.floor(own.x));
    expect(r.right).toBeLessThanOrEqual(Math.ceil(own.x + own.width));
    expect(r.right).toBeLessThanOrEqual(box.x + box.width);
  }
  // Nothing of the tag is hidden: neither the reference nor the tag's own box scrolls.
  expect(await ref.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  expect(await tagEl.evaluate((el) => el.parentElement!.scrollWidth <= el.parentElement!.clientWidth)).toBe(true);
}

test("in the narrowest panel a long image keeps its whole tag on one line; the repository truncates", async ({ page }) => {
  await bootWithImages(page);
  await open(page, "Pods");
  await page.getByText("api-0").click();
  const panel = page.getByRole("dialog", { name: "api-0" });
  await expect(panel).toHaveAttribute("data-mode", "docked");
  expect(Math.round((await panel.boundingBox())!.width)).toBe(360);

  const ref = panel.locator('[data-container="orders"] [data-image]');
  await expect(ref).toHaveAttribute("title", LONG_IMAGE);
  await expectTagWhole(panel, ref, "2.14.3-rc.1");
  // The repository gave way (the case under test is real), and the tag is one line.
  expect(await ref.locator("[data-image-repository]").evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  expect(await ref.locator("[data-image-tag]").evaluate((el) => el.getClientRects().length)).toBe(1);

  // A tag longer than the row goes under the repository, which keeps its line, and wraps there.
  const long = panel.locator('[data-container="builder"] [data-image]');
  await expectTagWhole(panel, long, LONG_TAG);
  const repo = (await long.locator("[data-image-repository]").boundingBox())!;
  const tag = (await long.locator("[data-image-tag]").boundingBox())!;
  expect(repo.width).toBeGreaterThan(100);
  expect(tag.y).toBeGreaterThanOrEqual(repo.y + repo.height - 1);
});

test("a deployment panel shows each long image on its own line with its whole tag", async ({ page }) => {
  await bootWithImages(page);
  await open(page, "Deployments");
  await page.getByText("api", { exact: true }).click();
  const panel = page.getByRole("dialog", { name: "api" });
  await expect(panel).toHaveAttribute("data-mode", "docked");
  const refs = panel.locator("dd [data-image]");
  await expect(refs).toHaveCount(2);
  await expectTagWhole(panel, refs.nth(0), "2.14.3-rc.1");
  await expectTagWhole(panel, refs.nth(1), "1.29");
  const [a, b] = [(await refs.nth(0).boundingBox())!, (await refs.nth(1).boundingBox())!];
  expect(b.y).toBeGreaterThanOrEqual(a.y + a.height - 1);
});
