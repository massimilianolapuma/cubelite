// Tonal phase 7 (#623): the logs surfaces on the rendered page. jsdom has no
// layout and no CSS, so colours, contrast, stacking and overflow are read here.
import { type Browser, type Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { tauriMockScript, emitPodLogLine, FIXTURES } from "./tauri-mock";

type Boot = { theme?: "dark" | "light"; compact?: boolean; containers?: string[] };

const container = (name: string, init = false) => ({ ...FIXTURES.podContainers[0], name, init, restarts: 0 });

async function boot(page: Page, o: Boot = {}) {
  const overrides = o.containers ? { podContainers: o.containers.map((n) => container(n)) } : {};
  await page.addInitScript(tauriMockScript(overrides));
  await page.addInitScript(
    ([theme, compact]) => {
      window.localStorage.setItem("cubelite.onboardingSeen", "true");
      window.localStorage.setItem("cubelite.theme", JSON.stringify(theme));
      if (compact) window.localStorage.setItem("cubelite.density", '"compact"');
    },
    [o.theme ?? "dark", !!o.compact] as const,
  );
  await page.goto("/");
}

async function openLogPanel(page: Page, pod = "api-0") {
  await page.getByRole("complementary").getByText("Pods", { exact: true }).click();
  await page.getByText(pod, { exact: true }).click();
  await expect(page.getByRole("dialog", { name: pod })).toBeVisible();
  await page.getByRole("button", { name: "Open logs" }).click();
  await expect(page.getByLabel("Pod logs panel")).toBeVisible();
}

/** The colour a CSS value resolves to on this page, e.g. `var(--color-data-2)`. */
async function resolved(page: Page, value: string): Promise<string> {
  return page.evaluate((v) => {
    const probe = document.createElement("span");
    probe.style.color = v;
    document.body.append(probe);
    const out = getComputedStyle(probe).color;
    probe.remove();
    return out;
  }, value);
}

/**
 * Contrast of each text element matched by `selector` against everything
 * painted under it (a translucent wash is composited over the opaque surface
 * below it), as WCAG ratios. The browser converts the colours (oklch, color-mix)
 * by painting them on a canvas.
 */
async function contrasts(page: Page, selector: string): Promise<{ text: string; ratio: number }[]> {
  return page.evaluate((sel) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    const paint = (layers: string[]) => {
      ctx.clearRect(0, 0, 1, 1);
      for (const layer of layers) {
        ctx.fillStyle = layer;
        ctx.fillRect(0, 0, 1, 1);
      }
      return [...ctx.getImageData(0, 0, 1, 1).data];
    };
    const under = (el: Element) => {
      const layers: string[] = [];
      for (let e: Element | null = el; e; e = e.parentElement) {
        const bg = getComputedStyle(e).backgroundColor;
        if (paint([bg])[3] === 0) continue;
        layers.unshift(bg);
        if (paint([bg])[3] === 255) break;
      }
      return layers;
    };
    const lum = ([r, g, b]: number[]) => {
      const f = (v: number) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    return [...document.querySelectorAll(sel)].map((el) => {
      const layers = under(el);
      const [hi, lo] = [lum(paint(layers)), lum(paint([...layers, getComputedStyle(el).color]))].sort((a, b) => b - a);
      return { text: (el.textContent ?? "").trim(), ratio: (hi + 0.05) / (lo + 0.05) };
    });
  }, selector);
}

for (const theme of ["dark", "light"] as const) {
  test(`${theme}: log text keeps 4.5:1 on WARN and ERROR washes, search marks and the follow chip`, async ({
    page,
  }) => {
    await boot(page, { theme });
    await openLogPanel(page);
    await emitPodLogLine(page, "worker", "slow query took 2.4s needle", { level: "warn" });
    await emitPodLogLine(page, "worker", "connection refused needle", { level: "error" });
    await emitPodLogLine(page, "worker", "all good needle", { level: "info" });
    await expect(page.getByText("all good")).toBeVisible();
    await page.getByPlaceholder("Search… (⌘F)").fill("needle");
    await expect(page.locator("mark")).toHaveCount(3);
    await page.getByPlaceholder("Search… (⌘F)").press("Enter");
    await expect(page.locator('mark[data-active="true"]')).toHaveCount(1);

    const warn = page.locator('[data-level="warn"]');
    const error = page.locator('[data-level="error"]');
    // The rows carry a wash; INFO stays on the bare surface, and no row has a coloured edge.
    expect(await warn.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
    expect(await error.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
    const info = page.locator('[data-level="info"]').filter({ hasText: "all good" });
    expect(await info.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
    for (const row of [warn, error, info]) {
      expect(await row.evaluate((el) => getComputedStyle(el.firstElementChild!).borderLeftWidth)).toBe("0px");
    }
    // Level words in their colour.
    expect(await warn.locator("[data-level-word]").evaluate((el) => getComputedStyle(el).color)).toBe(
      await resolved(page, "var(--color-warning)"),
    );
    expect(await error.locator("[data-level-word]").evaluate((el) => getComputedStyle(el).color)).toBe(
      await resolved(page, "var(--color-error)"),
    );
    expect(await info.locator("[data-level-word]").evaluate((el) => getComputedStyle(el).color)).toBe(
      await resolved(page, "var(--color-text-muted)"),
    );

    const pairs = await contrasts(
      page,
      '[data-level="warn"] span, [data-level="error"] span, mark, [data-state="paused"]',
    );
    expect(pairs.length).toBeGreaterThan(8);
    for (const pair of pairs) expect(pair.ratio, pair.text).toBeGreaterThanOrEqual(4.5);
  });
}

test("a merged stream colours its sources data-1 to data-5, and repeats them underlined past five", async ({
  page,
}) => {
  const names = ["worker", "envoy", "proxy", "metrics", "fluent", "cache"];
  await boot(page, { containers: names });
  await openLogPanel(page);
  await page.getByRole("button", { name: "worker", exact: true }).click();
  await page.getByRole("button", { name: /all containers/ }).click();
  for (const name of names) await emitPodLogLine(page, name, `hello from ${name}`);
  const panel = page.getByLabel("Pod logs panel");
  await expect(panel.getByText("hello from cache")).toBeVisible();

  for (const [i, name] of names.entries()) {
    const label = panel.locator(`[data-source="${i + 1}"]`);
    await expect(label).toHaveText(name);
    const style = await label.evaluate((el) => ({
      color: getComputedStyle(el).color,
      line: getComputedStyle(el).textDecorationLine,
      dash: getComputedStyle(el).textDecorationStyle,
    }));
    expect(style.color, name).toBe(await resolved(page, `var(--color-data-${(i % 5) + 1})`));
    if (i < 5) expect(style.line, name).toBe("none");
    else expect([style.line, style.dash], name).toEqual(["underline", "dashed"]);
  }
  // Two sources with the same colour still differ.
  expect(await resolved(page, "var(--color-data-1)")).not.toBe(await resolved(page, "var(--color-data-2)"));
});

test("JSON values: keys muted, strings in the text colour, numbers data-2, booleans and null data-3", async ({
  page,
}) => {
  await boot(page);
  await openLogPanel(page);
  await emitPodLogLine(page, "worker", '{"msg":"paid","orderId":"A-1","amount":42,"retry":true,"user":null}');
  await page.getByTestId("logpanel-view-mode").getByRole("radio", { name: "JSON" }).click();
  await page.getByTestId("json-row").click();
  const tree = page.getByTestId("json-tree");
  const colour = (selector: string) => tree.locator(selector).first().evaluate((el) => getComputedStyle(el).color);
  expect(await colour('[data-json="string"]')).toBe(await resolved(page, "var(--color-text)"));
  expect(await colour('[data-json="number"]')).toBe(await resolved(page, "var(--color-data-2)"));
  expect(await colour('[data-json="boolean"]')).toBe(await resolved(page, "var(--color-data-3)"));
  expect(await colour('[data-json="null"]')).toBe(await resolved(page, "var(--color-data-3)"));
  expect(await tree.getByText("orderId", { exact: true }).evaluate((el) => getComputedStyle(el).color)).toBe(
    await resolved(page, "var(--color-text-muted)"),
  );

  await page.getByTestId("logpanel-view-mode").getByRole("radio", { name: "ECS" }).click();
  // The line stays expanded across modes.
  const table = page.getByTestId("ecs-table");
  await expect(table).toBeVisible();
  expect(await table.locator('[data-json="number"]').first().evaluate((el) => getComputedStyle(el).color)).toBe(
    await resolved(page, "var(--color-data-2)"),
  );
});

test("the log panel lies above the detail panel only while that panel overlays the list", async ({ page }) => {
  // 1280 x 800: the content column is under 1000 px, so the detail panel overlays.
  await boot(page);
  await openLogPanel(page);
  const panel = page.getByLabel("Pod logs panel");
  await expect(page.getByRole("dialog", { name: "api-0" })).toHaveAttribute("data-mode", "overlay");
  expect(await panel.evaluate((el) => getComputedStyle(el).zIndex)).toBe("35");

  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole("dialog", { name: "api-0" })).toHaveAttribute("data-mode", "docked");
  expect(await panel.evaluate((el) => getComputedStyle(el).zIndex)).toBe("auto");
  // A surface-sunken card.
  expect(await panel.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
    await resolved(page, "var(--color-surface-sunken)"),
  );
});

test("the Logs view keeps a wide pod column", async ({ page }) => {
  await boot(page);
  await page.getByRole("list", { name: /^Pinned/ }).getByRole("button", { name: "Logs" }).click();
  await expect(page.getByRole("heading", { name: "Logs", level: 1 })).toBeVisible();
  const pod = page.getByText("simulator-bff-5dd4ff54cf-9bq7n");
  await expect
    .poll(async () => {
      await page.evaluate(() =>
        window.__emitTauriEvent?.("log-line", {
          pod: "simulator-bff-5dd4ff54cf-9bq7n",
          namespace: "default",
          time: null,
          level: "info",
          message: "hello",
        }),
      );
      return pod.count();
    })
    .toBeGreaterThan(0);
  expect((await pod.first().boundingBox())?.width).toBe(144);
});

/** Opens a pop-out log window for api-0 of `cluster`, as logWindows does. */
async function openPopout(page: Page, cluster: string) {
  await page.goto("/?logWindow=default%2Fapi-0");
  const seed = {
    key: "default/api-0",
    namespace: "default",
    pod: "api-0",
    container: "worker",
    previous: false,
    tailLines: 500,
    following: true,
    lines: [{ id: 0, pod: "api-0", namespace: "default", time: null, level: "warn", message: "seeded line" }],
    kubeconfigPath: "/home/test/.kube/config",
    activeCluster: cluster,
  };
  // The window listens once it has mounted; send the seed until it has arrived.
  await expect
    .poll(async () => {
      await page.evaluate((s) => window.__emitTauriEvent?.("log-window-seed:default/api-0", s), seed);
      return page.getByTestId("logwindow-state").count();
    })
    .toBe(1);
}

const tintOf = (page: Page) =>
  page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--cl-tint-h"));

async function newApp(browser: Browser) {
  const context = await browser.newContext();
  await context.addInitScript(tauriMockScript());
  await context.addInitScript(() => {
    if (window.localStorage.getItem("cubelite.onboardingSeen")) return;
    window.localStorage.setItem("cubelite.onboardingSeen", "true");
    window.localStorage.setItem("cubelite.theme", '"dark"');
    window.localStorage.setItem("cubelite.identityColors", JSON.stringify({ "prod-aks": "teal", staging: "violet" }));
  });
  return context;
}

test("the pop-out takes its pod's cluster tint and follows a colour change made in the main window", async ({
  browser,
}) => {
  const context = await newApp(browser);
  const main = await context.newPage();
  await main.goto("/");
  await main.locator("html[data-app-ready]").waitFor({ state: "attached" });
  // The main window is on prod-aks (teal); the pod belongs to staging (violet).
  await expect.poll(() => tintOf(main)).toBe("190");

  const popout = await context.newPage();
  await openPopout(popout, "staging");
  await expect.poll(() => tintOf(popout)).toBe("310");
  await expect(popout.getByText("seeded line")).toBeVisible();

  // Preferences in the main window: staging becomes magenta.
  await main.getByLabel("Preferences").click();
  await main.getByRole("radiogroup", { name: "Color for staging" }).getByRole("radio", { name: "magenta" }).click();
  await expect.poll(() => tintOf(popout)).toBe("345");
  // The main window stays on its own cluster's tint.
  await expect.poll(() => tintOf(main)).toBe("190");
  await context.close();
});

for (const theme of ["dark", "light"] as const) {
  test(`${theme}: at 800 x 600 in compact density every log toolbar stays inside its card`, async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 600 });
    await boot(page, { theme, compact: true });
    const inside = () =>
      page.evaluate(() => {
        const out: string[] = [];
        if (document.documentElement.scrollWidth > window.innerWidth) out.push("page scrolls sideways");
        for (const bar of document.querySelectorAll<HTMLElement>('[data-testid="log-toolbar"]')) {
          if (bar.scrollWidth > bar.clientWidth) out.push("toolbar scrolls");
          const box = bar.getBoundingClientRect();
          for (const control of bar.querySelectorAll<HTMLElement>("button, input, select")) {
            const r = control.getBoundingClientRect();
            if (r.width && (r.right > box.right + 0.5 || r.left < box.left - 0.5))
              out.push(control.getAttribute("aria-label") ?? control.textContent ?? "?");
          }
        }
        return out;
      });

    await openLogPanel(page);
    await page.getByRole("dialog", { name: "api-0" }).getByRole("button", { name: "Close" }).click();
    await page.getByPlaceholder("Search… (⌘F)").fill("needle");
    await expect(page.getByTestId("log-toolbar")).toHaveCount(1);
    expect(await inside()).toEqual([]);

    await page.getByRole("list", { name: /^Pinned/ }).getByRole("button", { name: "Logs" }).click();
    await expect(page.getByRole("heading", { name: "Logs", level: 1 })).toBeVisible();
    await expect(page.getByTestId("log-toolbar")).toHaveCount(2);
    expect(await inside()).toEqual([]);

    await openPopout(page, "prod-aks");
    expect(await inside()).toEqual([]);
  });
}
