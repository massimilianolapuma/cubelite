import { type Locator, type Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { API_0_METRICS, FIXTURES, tauriMockScript } from "./tauri-mock";

// The detail panel: docked beside the list from 1000 px of content, over it below (Tonal §5, §8.3).
async function boot(page: Page, width: number, height: number, overrides: Parameters<typeof tauriMockScript>[0] = {}) {
  await page.setViewportSize({ width, height });
  await page.addInitScript(tauriMockScript(overrides));
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

/**
 * A part of the reference (`tag` or `name`) is drawn whole: every line of it
 * inside the reference and the panel, and nothing of it scrolled away.
 */
async function expectWhole(panel: Locator, ref: Locator, part: "tag" | "name", text: string) {
  const el = ref.locator(`[data-image-${part}]`);
  await expect(el).toHaveText(text);
  const box = (await panel.boundingBox())!;
  const own = (await ref.boundingBox())!;
  const rects = await el.evaluate((e) => [...e.getClientRects()].map((r) => ({ left: r.left, right: r.right })));
  expect(rects.length).toBeGreaterThan(0);
  for (const r of rects) {
    expect(r.left).toBeGreaterThanOrEqual(Math.floor(own.x));
    expect(r.right).toBeLessThanOrEqual(Math.ceil(own.x + own.width));
    expect(r.left).toBeGreaterThanOrEqual(box.x);
    expect(r.right).toBeLessThanOrEqual(box.x + box.width);
  }
  // Neither the reference nor the part's own box (the tag's is its wrapper, with the separator) scrolls.
  expect(await ref.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
  expect(
    await el.evaluate((e, isTag) => {
      const own = isTag ? e.parentElement! : e;
      return own.scrollWidth <= own.clientWidth;
    }, part === "tag"),
  ).toBe(true);
}

const lines = (el: Locator) => el.evaluate((e) => e.getClientRects().length);
const truncated = (el: Locator) => el.evaluate((e) => e.scrollWidth > e.clientWidth);

test("in the narrowest panel a long image keeps its name and tag whole on one line; the prefix truncates", async ({ page }) => {
  await bootWithImages(page);
  await open(page, "Pods");
  await page.getByText("api-0").click();
  const panel = page.getByRole("dialog", { name: "api-0" });
  await expect(panel).toHaveAttribute("data-mode", "docked");
  expect(Math.round((await panel.boundingBox())!.width)).toBe(360);

  const ref = panel.locator('[data-container="orders"] [data-image]');
  await expect(ref).toHaveAttribute("title", LONG_IMAGE);
  await expectWhole(panel, ref, "tag", "2.14.3-rc.1");
  await expectWhole(panel, ref, "name", "orders-api");
  // The registry and path gave way (the case under test is real); name and tag share one line.
  expect(await truncated(ref.locator("[data-image-prefix]"))).toBe(true);
  expect(await lines(ref.locator("[data-image-tag]"))).toBe(1);
  expect(await lines(ref.locator("[data-image-name]"))).toBe(1);
  const [prefix, name, tag] = [
    (await ref.locator("[data-image-prefix]").boundingBox())!,
    (await ref.locator("[data-image-name]").boundingBox())!,
    (await ref.locator("[data-image-tag]").boundingBox())!,
  ];
  // One line: the prefix gave way in place rather than pushing the name down.
  expect(Math.abs(name.y - prefix.y)).toBeLessThan(2);
  expect(Math.abs(tag.y - name.y)).toBeLessThan(2);

  // A tag longer than the row goes under the name, which keeps its line, and wraps there.
  const long = panel.locator('[data-container="builder"] [data-image]');
  await expectWhole(panel, long, "tag", LONG_TAG);
  await expectWhole(panel, long, "name", "builder");
  const builder = (await long.locator("[data-image-name]").boundingBox())!;
  const longTag = (await long.locator("[data-image-tag]").boundingBox())!;
  expect(longTag.y).toBeGreaterThanOrEqual(builder.y + builder.height - 1);
});

test("a deployment panel shows each long image on its own line with its whole name and tag", async ({ page }) => {
  await bootWithImages(page);
  await open(page, "Deployments");
  await page.getByText("api", { exact: true }).click();
  const panel = page.getByRole("dialog", { name: "api" });
  await expect(panel).toHaveAttribute("data-mode", "docked");
  const refs = panel.locator("dd [data-image]");
  await expect(refs).toHaveCount(2);
  await expectWhole(panel, refs.nth(0), "tag", "2.14.3-rc.1");
  await expectWhole(panel, refs.nth(0), "name", "orders-api");
  expect(await truncated(refs.nth(0).locator("[data-image-prefix]"))).toBe(true);
  await expectWhole(panel, refs.nth(1), "tag", "1.29");
  await expectWhole(panel, refs.nth(1), "name", "envoy");
  const [a, b] = [(await refs.nth(0).boundingBox())!, (await refs.nth(1).boundingBox())!];
  expect(b.y).toBeGreaterThanOrEqual(a.y + a.height - 1);
});

// #652: requests, limits and usage per container, in the narrowest (docked, 360 px) panel.
const UNAVAILABLE = "Usage unavailable: metrics-server did not answer.";

/** Nothing in `el` scrolls sideways: no text is cut. */
const fits = (el: Locator) => el.evaluate((e) => e.scrollWidth <= e.clientWidth);

/** Every line of every row of `card` lies inside the card and the panel. */
async function expectRowsInside(panel: Locator, card: Locator) {
  const box = (await panel.boundingBox())!;
  const own = (await card.boundingBox())!;
  const rows = card.locator("[data-resource-row]");
  await expect(rows).toHaveCount(2);
  for (const row of await rows.all()) {
    const rects = await row.evaluate((e) =>
      [...e.querySelectorAll("span")].flatMap((s) => [...s.getClientRects()].map((r) => ({ left: r.left, right: r.right }))),
    );
    for (const r of rects) {
      expect(r.left).toBeGreaterThanOrEqual(Math.floor(own.x));
      expect(r.right).toBeLessThanOrEqual(Math.ceil(own.x + own.width));
      expect(r.right).toBeLessThanOrEqual(box.x + box.width);
    }
  }
}

async function openDeployment(page: Page) {
  await open(page, "Deployments");
  await page.getByText("api", { exact: true }).click();
  const panel = page.getByRole("dialog", { name: "api" });
  await expect(panel).toHaveAttribute("data-mode", "docked");
  expect(Math.round((await panel.boundingBox())!.width)).toBe(360);
  return panel;
}

test("a deployment panel shows each container's requests, limits and usage inside its 360 px", async ({ page }) => {
  await boot(page, 1440, 900, { podMetrics: [API_0_METRICS] });
  const panel = await openDeployment(page);
  const section = panel.locator('[data-section="resources"]');
  await expect(section).toBeVisible();
  await expect(section.getByText("Resources", { exact: true })).toBeVisible();

  const worker = section.locator('[data-container="worker"]');
  await expect(worker.locator('[data-resource-row="memory"]')).toContainText("498Mi of 512Mi · request 256Mi");
  await expect(worker.locator('[data-resource-row="cpu"]')).toContainText("260m of 500m · request 250m");
  const envoy = section.locator('[data-container="envoy"]');
  await expect(envoy).toContainText("sidecar");
  await expect(envoy.locator('[data-resource-row="cpu"]')).toContainText("38m used · request 100m · no limit");
  await expect(panel.getByText(UNAVAILABLE)).toHaveCount(0);

  expect(await fits(section)).toBe(true);
  for (const card of await section.locator("[data-container]").all()) {
    expect(await fits(card)).toBe(true);
    await expectRowsInside(panel, card);
  }

  // A row without a limit keeps the meter rows' columns: its label where theirs is,
  // its sentence where their sentence starts.
  const label = (row: Locator) => row.locator(".type-label").first().boundingBox();
  const [meterLabel, lineLabel] = [
    (await label(worker.locator('[data-resource-row="cpu"]')))!,
    (await label(envoy.locator('[data-resource-row="cpu"]')))!,
  ];
  expect(Math.abs(meterLabel.x - lineLabel.x)).toBeLessThan(1);
  expect(Math.abs(meterLabel.width - lineLabel.width)).toBeLessThan(1);
  // Where the text itself starts (the meter's sentence is a padded box).
  const textLeft = (el: Locator) =>
    el.evaluate((e) => {
      const range = document.createRange();
      range.selectNodeContents(e);
      return range.getClientRects()[0].left;
    });
  const meterDetail = await textLeft(worker.locator('[data-resource-row="cpu"]').getByText("260m of 500m", { exact: false }));
  const lineDetail = await textLeft(envoy.locator('[data-resource-row="cpu"] .type-data-sm'));
  expect(Math.abs(meterDetail - lineDetail)).toBeLessThan(1);
});

test("a deployment panel says once that usage is unavailable when metrics-server does not answer", async ({ page }) => {
  await boot(page, 1440, 900, { podMetrics: null });
  const panel = await openDeployment(page);
  const section = panel.locator('[data-section="resources"]');
  await expect(section.getByText(UNAVAILABLE)).toBeVisible();
  await expect(panel.getByText(UNAVAILABLE)).toHaveCount(1);
  await expect(section.locator('[data-container="worker"] [data-resource-row="cpu"]')).toContainText("limit 500m · request 250m");
  expect(await fits(section)).toBe(true);
});

test("a pod panel shows the resource rows in its container card, inside the panel's width", async ({ page }) => {
  await boot(page, 1440, 900, { podMetrics: [API_0_METRICS] });
  await open(page, "Pods");
  await page.getByText("api-0").click();
  const panel = page.getByRole("dialog", { name: "api-0" });
  await expect(panel).toHaveAttribute("data-mode", "docked");
  const worker = panel.locator('[data-container="worker"]');
  await expect(worker.locator('[data-resource-row="cpu"]')).toContainText("260m of 500m · request 250m");
  await expect(worker.locator('[data-resource-row="memory"]')).toContainText("498Mi of 512Mi · request 256Mi");
  expect(await fits(worker)).toBe(true);
  await expectRowsInside(panel, worker);
  // A container without requests or limits in the payload has no rows.
  await expect(panel.locator('[data-container="init-migrate"] [data-resource-row]')).toHaveCount(0);
});

test("a long container name and long sentences wrap inside the panel instead of being cut", async ({ page }) => {
  const Gi = 1024 ** 3;
  const q = (text: string, amount: number) => ({ text, amount });
  const name = "opentelemetry-collector-contrib-agent";
  await boot(page, 1440, 900, {
    deployments: [
      {
        ...FIXTURES.deployments[0],
        containers: [
          {
            name,
            image: "ghcr.io/x/otel:0.98",
            sidecar: true,
            resources: { cpu: { request: q("1500m", 1500), limit: null }, memory: { request: q("1536Mi", 1.5 * Gi), limit: null } },
          },
          {
            name: "worker",
            image: "ghcr.io/x/worker:2.1",
            sidecar: false,
            resources: {
              cpu: { request: q("1500m", 1500), limit: q("2500m", 2500) },
              memory: { request: q("1536Mi", 1.5 * Gi), limit: q("3584Mi", 3.5 * Gi) },
            },
          },
        ],
      },
    ],
    podMetrics: [
      {
        ...API_0_METRICS,
        containers: [
          { name, cpu_millis: 1234, memory_bytes: 1.25 * Gi },
          { name: "worker", cpu_millis: 2345, memory_bytes: 3.4 * Gi },
        ],
      },
    ],
  });
  const panel = await openDeployment(page);
  const section = panel.locator('[data-section="resources"]');
  const otel = section.locator(`[data-container="${name}"]`);
  await expect(otel.locator('[data-resource-row="memory"]')).toContainText("1.3Gi used · request 1536Mi · no limit");
  await expect(otel).toContainText("sidecar");
  expect(await fits(section)).toBe(true);
  for (const card of await section.locator("[data-container]").all()) {
    await expectRowsInside(panel, card);
  }
});
