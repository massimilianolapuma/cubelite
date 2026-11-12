// Tonal phase 7 (#623): the logs surfaces on the rendered page. jsdom has no
// layout and no CSS, so colours, contrast, stacking and overflow are read here.
import { type Browser, type Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { tauriMockScript, emitPodLogLine, FIXTURES } from "./tauri-mock";

type Boot = {
  theme?: "dark" | "light";
  compact?: boolean;
  containers?: string[];
  /** Init containers after `containers`. */
  inits?: string[];
  /** Extra pods after the fixture's own. */
  pods?: string[];
  /** An Elasticsearch endpoint for prod-aks, so History is offered. */
  elastic?: boolean;
  /** Saved log panel height. */
  panelHeight?: number;
};

const container = (name: string, init = false) => ({ ...FIXTURES.podContainers[0], name, init, restarts: 0 });

const ELASTIC = {
  "prod-aks": {
    target: { kind: "in-cluster", namespace: "logging", service: "es", port: 9200, https: true },
    indexPattern: "logs-*",
    preset: "ecs",
    kibanaUrl: "https://kibana.example",
    skipTlsVerify: false,
  },
};

async function boot(page: Page, o: Boot = {}) {
  const overrides: Partial<typeof FIXTURES> = {};
  if (o.containers || o.inits)
    overrides.podContainers = [
      ...(o.containers ?? []).map((n) => container(n)),
      ...(o.inits ?? []).map((n) => container(n, true)),
    ];
  if (o.pods) overrides.pods = [...FIXTURES.pods, ...o.pods.map((name) => ({ ...FIXTURES.pods[0], name }))];
  await page.addInitScript(tauriMockScript(overrides));
  await page.addInitScript(
    ([theme, compact, elastic, height]) => {
      window.localStorage.setItem("cubelite.onboardingSeen", "true");
      window.localStorage.setItem("cubelite.theme", JSON.stringify(theme));
      if (compact) window.localStorage.setItem("cubelite.density", '"compact"');
      if (elastic) window.localStorage.setItem("cubelite.elastic.endpoints", elastic);
      if (height) window.localStorage.setItem("cubelite.logPanel.height", String(height));
    },
    [o.theme ?? "dark", !!o.compact, o.elastic ? JSON.stringify(ELASTIC) : "", o.panelHeight ?? 0] as const,
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

test("a merged stream colours its sources data-1 to data-5, and repeats them dashed, dotted, double", async ({
  page,
}) => {
  // Four rounds: plain, dashed, dotted, double.
  const names = Array.from({ length: 16 }, (_, i) => `c${String(i + 1).padStart(2, "0")}`);
  await boot(page, { containers: names });
  await openLogPanel(page);
  await page.getByRole("button", { name: "c01", exact: true }).click();
  await page.getByRole("button", { name: /all containers/ }).click();
  for (const name of names) await emitPodLogLine(page, name, `hello from ${name}`);
  const panel = page.getByLabel("Pod logs panel");
  await expect(panel.getByText("hello from c16")).toBeAttached();
  const ROUNDS = [
    ["none", "solid"],
    ["underline", "dashed"],
    ["underline", "dotted"],
    ["underline", "double"],
  ];

  for (const [i, name] of names.entries()) {
    const label = panel.locator(`[data-source="${i + 1}"]`);
    await expect(label).toHaveText(name);
    const style = await label.evaluate((el) => ({
      color: getComputedStyle(el).color,
      line: getComputedStyle(el).textDecorationLine,
      dash: getComputedStyle(el).textDecorationStyle,
    }));
    expect(style.color, name).toBe(await resolved(page, `var(--color-data-${(i % 5) + 1})`));
    expect([style.line, style.dash], name).toEqual(ROUNDS[Math.floor(i / 5)]);
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
  // Toolbar on the card, lines on surface-sunken (Tonal §8.5).
  expect(await panel.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
    await resolved(page, "var(--color-surface-container)"),
  );
  expect(await page.getByTestId("log-lines").evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
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

/** Rows the toolbar's controls occupy, and whether everything stays inside the panel card. */
async function toolbarLayout(page: Page) {
  return page.evaluate(() => {
    const card = document.querySelector<HTMLElement>('[aria-label="Pod logs panel"], [data-testid="logwindow"]')!;
    const bar = card.querySelector<HTMLElement>('[data-testid="log-toolbar"]')!;
    const lines = card.querySelector<HTMLElement>('[data-testid="log-lines"]')!;
    const box = card.getBoundingClientRect();
    const tops: number[] = [];
    const outside: string[] = [];
    for (const control of bar.querySelectorAll<HTMLElement>("button, input, select")) {
      const r = control.getBoundingClientRect();
      if (!r.width) continue;
      // A row is told by the controls' centre line (a text link is shorter than a chip).
      const middle = r.top + r.height / 2;
      if (!tops.some((t) => Math.abs(t - middle) < 6)) tops.push(middle);
      if (r.left < box.left - 0.5 || r.right > box.right + 0.5 || r.top < box.top - 0.5 || r.bottom > box.bottom + 0.5)
        outside.push(control.getAttribute("aria-label") ?? control.textContent?.trim() ?? "?");
    }
    const l = lines.getBoundingClientRect();
    if (l.bottom > box.bottom + 0.5) outside.push("lines");
    return {
      rows: tops.length,
      outside,
      lines: Math.round(l.height),
      sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });
}

type Size = { width: number; height: number; rows: number };
const SIZES: Size[] = [
  { width: 1360, height: 860, rows: 1 },
  { width: 1280, height: 800, rows: 1 },
  { width: 800, height: 600, rows: 2 },
];

for (const { width, height, rows } of SIZES) {
  for (const compact of [false, true]) {
    const density = compact ? "compact" : "default";
    test(`${width} x ${height}, ${density}: the panel toolbar takes at most ${rows} row(s), live and history, with the detail panel open`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      // Live without Elasticsearch shows the "Set up" link as well: the widest live toolbar.
      await boot(page, { compact });
      await openLogPanel(page);
      await page.getByPlaceholder("Search… (⌘F)").fill("needle");
      await expect(page.getByText("0 results")).toBeVisible();
      const layout = await toolbarLayout(page);
      expect(layout.outside).toEqual([]);
      expect(layout.rows).toBeLessThanOrEqual(rows);
      expect(layout.sideways).toBe(false);
    });

    test(`${width} x ${height}, ${density}: history toolbar takes at most ${rows} row(s)`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await boot(page, { compact, elastic: true });
      await openLogPanel(page);
      await page.getByTestId("logpanel-source").getByRole("radio", { name: "History" }).click();
      await expect(page.getByText("e2e-history-newest")).toBeVisible();
      await page.getByPlaceholder("Search… (⌘F)").fill("needle");
      await page.getByLabel("Elasticsearch query").fill("level:error");
      await expect(page.getByLabel("Pod logs panel").getByText(/^(\d+\/\d+|0 results)$/)).toBeVisible();
      const layout = await toolbarLayout(page);
      expect(layout.outside).toEqual([]);
      expect(layout.rows).toBeLessThanOrEqual(rows);
    });
  }
}

for (const compact of [false, true]) {
  test(`800 x 600, ${compact ? "compact" : "default"}: at the smallest panel height the body keeps four lines inside the card`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 800, height: 600 });
    await boot(page, { compact, panelHeight: 160 });
    await openLogPanel(page);
    await page.getByPlaceholder("Search… (⌘F)").fill("needle");
    // With the detail panel over the list, then without it.
    for (const step of ["overlay", "closed"]) {
      const layout = await toolbarLayout(page);
      expect(layout.outside, step).toEqual([]);
      expect(layout.lines, step).toBeGreaterThanOrEqual(72);
      if (step === "overlay") await page.getByRole("dialog", { name: "api-0" }).getByRole("button", { name: "Close" }).click();
    }
  });
}

test("800 x 600: the Logs view keeps a lines box with the log panel open", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await boot(page);
  await openLogPanel(page);
  await page.getByRole("list", { name: /^Pinned/ }).getByRole("button", { name: "Logs" }).click();
  await expect(page.getByRole("heading", { name: "Logs", level: 1 })).toBeVisible();
  const box = await page.getByTestId("logs-lines").boundingBox();
  expect(box?.height).toBeGreaterThanOrEqual(72);
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
            if (r.width && (r.right > box.right + 0.5 || r.left < box.left - 0.5 || r.bottom > box.bottom + 0.5))
              out.push(control.getAttribute("aria-label") ?? control.textContent ?? "?");
          }
        }
        return out;
      });

    await openLogPanel(page);
    await page.getByPlaceholder("Search… (⌘F)").fill("needle");
    await expect(page.getByTestId("log-toolbar")).toHaveCount(1);
    expect(await inside(), "panel with the detail panel").toEqual([]);
    await page.getByRole("dialog", { name: "api-0" }).getByRole("button", { name: "Close" }).click();
    expect(await inside(), "panel").toEqual([]);

    await page.getByRole("list", { name: /^Pinned/ }).getByRole("button", { name: "Logs" }).click();
    await expect(page.getByRole("heading", { name: "Logs", level: 1 })).toBeVisible();
    await expect(page.getByTestId("log-toolbar")).toHaveCount(2);
    expect(await inside(), "Logs view").toEqual([]);

    await openPopout(page, "prod-aks");
    expect(await inside(), "pop-out").toEqual([]);
    const layout = await toolbarLayout(page);
    expect(layout.outside).toEqual([]);
    expect(layout.lines).toBeGreaterThanOrEqual(72);
  });
}

/**
 * How far a control's fill stands out from what is under it: the contrast
 * between the surface below (composited) and that surface with the fill on top.
 */
async function shapeContrast(page: Page, selector: string): Promise<number> {
  return page.locator(selector).first().evaluate((el) => {
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
    const under: string[] = [];
    for (let e = el.parentElement; e; e = e.parentElement) {
      const bg = getComputedStyle(e).backgroundColor;
      if (paint([bg])[3] === 0) continue;
      under.unshift(bg);
      if (paint([bg])[3] === 255) break;
    }
    const lum = ([r, g, b]: number[]) => {
      const f = (v: number) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const [hi, lo] = [lum(paint(under)), lum(paint([...under, getComputedStyle(el).backgroundColor]))].sort(
      (a, b) => b - a,
    );
    return (hi + 0.05) / (lo + 0.05);
  });
}

for (const theme of ["dark", "light"] as const) {
  test(`${theme}: toolbar fields, chips and the active tab show their shape as well as the Logs view's`, async ({
    page,
  }) => {
    await boot(page, { theme });
    await page.getByRole("list", { name: /^Pinned/ }).getByRole("button", { name: "Logs" }).click();
    const baseline = await shapeContrast(page, '[placeholder="Filter…"]');
    expect(baseline).toBeGreaterThan(1.1);

    await openLogPanel(page);
    const panel = '[aria-label="Pod logs panel"]';
    const measured = {
      field: await shapeContrast(page, `${panel} [placeholder="Search… (⌘F)"]`),
      chip: await shapeContrast(page, `${panel} [data-testid="log-toolbar"] button[aria-expanded]`),
      tab: await shapeContrast(page, `${panel} [data-testid="log-tabs"] > :has([aria-current="true"])`),
    };
    for (const [what, ratio] of Object.entries(measured)) expect(ratio, what).toBeGreaterThanOrEqual(baseline - 0.005);

    await openPopout(page, "prod-aks");
    const popout = {
      field: await shapeContrast(page, '[placeholder="Search… (⌘F)"]'),
      chip: await shapeContrast(page, '[data-testid="log-toolbar"] button[aria-expanded]'),
    };
    for (const [what, ratio] of Object.entries(popout)) expect(ratio, `pop-out ${what}`).toBeGreaterThanOrEqual(baseline - 0.005);
  });

  test(`${theme}: a search match on a WARN row is marked by more than colour; the active one is stronger`, async ({
    page,
  }) => {
    await boot(page, { theme });
    await openLogPanel(page);
    await emitPodLogLine(page, "worker", "first needle", { level: "warn" });
    await emitPodLogLine(page, "worker", "second needle", { level: "warn" });
    await expect(page.getByText("second")).toBeVisible();
    await page.getByPlaceholder("Search… (⌘F)").fill("needle");
    await page.getByPlaceholder("Search… (⌘F)").press("Enter");
    await expect(page.locator('mark[data-active="true"]')).toHaveCount(1);
    const style = (sel: string) =>
      page.locator(sel).first().evaluate((el) => {
        const s = getComputedStyle(el);
        return {
          line: s.textDecorationLine,
          decoration: s.textDecorationColor,
          outline: `${s.outlineStyle} ${s.outlineWidth}`,
          weight: s.fontWeight,
        };
      });
    const rest = await style('mark[data-active="false"]');
    const active = await style('mark[data-active="true"]');
    expect(rest.line).toBe("underline");
    expect(rest.decoration).toBe(await resolved(page, "var(--color-warning)"));
    expect(active.outline).toBe("solid 2px");
    expect(Number(active.weight)).toBeGreaterThan(Number(rest.weight));
    // The underline reads on the mark's fill over the washed row (3:1, a graphic):
    // a child painted in the underline colour, measured against what is under it.
    await page.locator('mark[data-active="false"]').evaluate((el) => {
      const probe = document.createElement("span");
      probe.dataset.probe = "";
      probe.textContent = "x";
      probe.style.backgroundColor = getComputedStyle(el).textDecorationColor;
      el.append(probe);
    });
    expect(await shapeContrast(page, "[data-probe]")).toBeGreaterThanOrEqual(3);
  });
}

test("800 x 600: an overflowing tab strip does not widen the page", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  const pods = ["payments-api-7d9f8b6c5-x7k2p", "checkout-worker-5dd4ff54cf-9bq7n", "inventory-sync-6c8d9-zz1"];
  await boot(page, { pods });
  for (const pod of ["api-0", ...pods]) await openLogPanel(page, pod);
  const strip = await page
    .getByLabel("Pod logs panel")
    .locator("[data-testid=log-tabs]")
    .evaluate((el) => el.scrollWidth > el.clientWidth);
  expect(strip).toBe(true);
  // No box around the panel can be scrolled sideways (an overflow-hidden root
  // still scrolls when something is brought into view).
  const wider = await page.getByLabel("Pod logs panel").evaluate((panel) => {
    const out: string[] = [];
    for (let e: Element | null = panel; e; e = e.parentElement)
      if (e.scrollWidth > e.clientWidth) out.push(`${e.tagName} ${e.scrollWidth} > ${e.clientWidth}`);
    return out;
  });
  expect(wider).toEqual([]);
});

test("800 x 600: the YAML editor fits its modal, with and without an apply error", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await boot(page);
  await page.getByRole("complementary").getByText("Pods", { exact: true }).click();
  await page.getByText("api-0", { exact: true }).click();
  await page.getByRole("button", { name: "YAML" }).click();
  const fits = (area: string) =>
    page.evaluate((sel) => {
      const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]')!;
      const body = dialog.querySelector<HTMLElement>("header + div")!;
      const el = dialog.querySelector<HTMLElement>(sel)!;
      const d = dialog.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return {
        nested: body.scrollHeight > body.clientHeight + 1,
        inside: r.top >= d.top && r.bottom <= d.bottom,
        height: r.height,
      };
    }, area);
  await expect(page.getByText("kind: Pod")).toBeVisible();
  expect(await fits("pre")).toMatchObject({ nested: false, inside: true });

  await page.getByRole("button", { name: "Edit" }).click();
  expect(await fits("textarea")).toMatchObject({ nested: false, inside: true });

  // The apply fails: the error line takes room from the editor, not from the modal.
  await page.evaluate(() => {
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a: unknown) => unknown } })
      .__TAURI_INTERNALS__;
    const invoke = internals.invoke.bind(internals);
    internals.invoke = async (cmd: string, args: unknown) => {
      if (cmd === "apply_resource_yaml") throw "admission webhook denied the request: replicas must be at least 1";
      return invoke(cmd, args);
    };
  });
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByRole("alert")).toContainText("admission webhook");
  const withError = await fits("textarea");
  expect(withError).toMatchObject({ nested: false, inside: true });
  expect(withError.height).toBeGreaterThan(120);
});

/**
 * Every row of the open toolbar menu (the panel after the expanded toggle):
 * the menu stays inside the window, and each row is inside it and is the
 * element under its own centre. A menu taller than its room is scrolled, and
 * only the menu: no box around it may scroll to bring a row into view.
 */
async function menuReach(page: Page, toggle: ReturnType<Page["locator"]>) {
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const menu = toggle.locator("xpath=following-sibling::div[1]");
  await menu.evaluate((m) => Promise.all(m.getAnimations().map((a) => a.finished)).then(() => null));
  const t = (await toggle.boundingBox())!;
  const reach = await menu.evaluate((m) => {
    const problems: string[] = [];
    const [w, h] = [window.innerWidth, window.innerHeight];
    const out = (r: DOMRect) => r.left < -0.5 || r.top < -0.5 || r.right > w + 0.5 || r.bottom > h + 0.5;
    const box = m.getBoundingClientRect();
    const where = (r: DOMRect) => `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`;
    if (out(box)) problems.push(`menu leaves the ${w} x ${h} window at ${where(box)}`);
    const items = [...m.querySelectorAll<HTMLElement>("button")];
    for (const item of items) {
      if (m.scrollHeight > m.clientHeight) m.scrollTop = item.offsetTop - (m.clientHeight - item.offsetHeight) / 2;
      const r = item.getBoundingClientRect();
      const name = item.textContent?.replace(/\s+/g, " ").trim() ?? "?";
      if (out(r)) problems.push(`${name}: outside the window at ${where(r)}`);
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (!hit || !item.contains(hit)) problems.push(`${name}: under its centre is ${hit?.tagName ?? "nothing"}`);
    }
    for (let e = m.parentElement; e; e = e.parentElement)
      if (e.scrollTop || e.scrollLeft) problems.push(`${e.tagName} scrolled to reach the menu`);
    const after = m.getBoundingClientRect();
    return { items: items.length, problems, top: after.top, bottom: after.bottom };
  });
  return { ...reach, below: reach.top >= t.y + t.height - 0.5, above: reach.bottom <= t.y + 0.5 };
}

/** The two toolbar menus: the container picker and "More log options". */
function toolbarMenus(page: Page) {
  const bar = page.getByTestId("log-toolbar");
  return [
    { name: "container picker", toggle: bar.locator("button[aria-expanded]").first(), items: 8 },
    { name: "More log options", toggle: bar.getByRole("button", { name: "More log options" }), items: 6 },
  ];
}

const MANY = { containers: ["worker", "envoy", "istio-proxy", "log-shipper", "metrics-exporter"], inits: ["init-migrate", "init-config"] };

for (const { width, height } of [
  { width: 900, height: 500 },
  { width: 520, height: 320 },
]) {
  test(`pop-out at ${width} x ${height}: both toolbar menus open downwards with every row inside the window (#624)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await boot(page, { ...MANY, elastic: true });
    await openPopout(page, "prod-aks");
    for (const { name, toggle, items } of toolbarMenus(page)) {
      await toggle.click();
      const reach = await menuReach(page, toggle);
      expect(reach.problems, name).toEqual([]);
      expect(reach.items, name).toBe(items);
      expect(reach.below, `${name} opens below its toggle`).toBe(true);
      await toggle.click();
    }
  });
}

for (const { width, height, mode } of [
  { width: 800, height: 600, mode: "overlay" },
  { width: 1440, height: 900, mode: "docked" },
]) {
  test(`log panel at ${width} x ${height}, detail panel ${mode}: both toolbar menus open upwards with every row reachable (#624)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await boot(page, { ...MANY, elastic: true });
    await openLogPanel(page);
    await expect(page.getByRole("dialog", { name: "api-0" })).toHaveAttribute("data-mode", mode);
    for (const { name, toggle, items } of toolbarMenus(page)) {
      await toggle.click();
      const reach = await menuReach(page, toggle);
      expect(reach.problems, name).toEqual([]);
      expect(reach.items, name).toBe(items);
      expect(reach.above, `${name} opens above its toggle`).toBe(true);
      await toggle.click();
    }
  });
}
