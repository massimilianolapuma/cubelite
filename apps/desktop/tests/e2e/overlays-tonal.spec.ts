// Tonal phase 8 (#627): the palette, Preferences, onboarding and the delete
// dialog on the rendered page. jsdom has no layout and no CSS, so sizes,
// overflow, tints and contrast are read here.
import { type Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { tauriMockScript, FIXTURES } from "./tauri-mock";

const LONG_POD = "payments-settlement-reconciliation-worker-7f9c8d6b5-x2kqz-with-a-very-long-suffix";

type Boot = { theme?: "dark" | "light"; compact?: boolean; onboarding?: boolean };

async function boot(page: Page, o: Boot = {}) {
  await page.addInitScript(tauriMockScript({ pods: [...FIXTURES.pods, { ...FIXTURES.pods[0], name: LONG_POD }] }));
  await page.addInitScript(
    ([theme, compact, onboarding]) => {
      if (!onboarding) window.localStorage.setItem("cubelite.onboardingSeen", "true");
      window.localStorage.setItem("cubelite.theme", JSON.stringify(theme));
      if (compact) window.localStorage.setItem("cubelite.density", '"compact"');
      // Two clusters of different colours, neither of them the default.
      window.localStorage.setItem("cubelite.identityColors", JSON.stringify({ "prod-aks": "teal", staging: "magenta" }));
    },
    [o.theme ?? "dark", !!o.compact, !!o.onboarding] as const,
  );
  await page.goto("/");
}

async function openPalette(page: Page) {
  const mac = await page.evaluate(() => navigator.userAgent.includes("Mac"));
  await page.keyboard.press(`${mac ? "Meta" : "Control"}+KeyK`);
  await expect(page.getByPlaceholder("Search clusters, resources, actions…")).toBeVisible();
  return page.getByTestId("command-palette");
}

/** The colour a CSS value resolves to inside `scope` (so a `data-tint` subtree resolves its own tint). */
async function resolvedIn(page: Page, scope: string, value: string): Promise<string> {
  return page.evaluate(
    ([sel, v]) => {
      const probe = document.createElement("span");
      probe.style.color = v;
      document.querySelector(sel)!.append(probe);
      const out = getComputedStyle(probe).color;
      probe.remove();
      return out;
    },
    [scope, value] as const,
  );
}

/** Whether a dialog, its title row and its actions lie inside the window. */
async function inWindow(page: Page, dialog: string) {
  return page.evaluate((sel) => {
    const d = document.querySelector<HTMLElement>(sel)!;
    const r = d.getBoundingClientRect();
    const inside = (b: DOMRect) => b.left >= -0.5 && b.top >= -0.5 && b.right <= innerWidth + 0.5 && b.bottom <= innerHeight + 0.5;
    const outside = [...d.querySelectorAll<HTMLElement>("button")]
      .filter((b) => b.closest("footer, header, [data-actions]"))
      .filter((b) => !inside(b.getBoundingClientRect()))
      .map((b) => b.getAttribute("aria-label") ?? b.textContent?.trim());
    return { box: inside(r), outside, sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth };
  }, dialog);
}

/**
 * Contrast against what is painted under an element (WCAG ratio), of its
 * `prop` colour. The browser converts the colours by painting them on a canvas.
 */
async function edges(page: Page, root: string, selector: string, prop: "borderTopColor" | "backgroundColor" | "color") {
  return page.evaluate(
    ([rootSel, sel, p]) => {
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
      const under = (start: Element | null) => {
        const layers: string[] = [];
        for (let e = start; e; e = e.parentElement) {
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
      return [...document.querySelector(rootSel)!.querySelectorAll<HTMLElement>(sel)].map((el) => {
        const layers = under(el.parentElement);
        const colour = getComputedStyle(el)[p as "color"];
        const [hi, lo] = [lum(paint(layers)), lum(paint([...layers, colour]))].sort((a, b) => b - a);
        return { name: el.getAttribute("aria-label") ?? el.tagName, ratio: (hi + 0.05) / (lo + 0.05) };
      });
    },
    [root, selector, prop] as const,
  );
}

for (const compact of [false, true]) {
  const density = compact ? "compact" : "default";

  test(`${density}: the palette is 580 px wide with a 48 px input and rounded xl`, async ({ page }) => {
    await boot(page, { compact });
    const palette = await openPalette(page);
    // Layout sizes: the pop-in animation scales the box for a moment.
    expect(await palette.evaluate((el) => (el as HTMLElement).offsetWidth)).toBe(580);
    expect(
      await page.getByPlaceholder("Search clusters, resources, actions…").evaluate((el) => (el as HTMLElement).offsetHeight),
    ).toBe(48);
    expect(await palette.evaluate((el) => getComputedStyle(el).borderRadius)).toBe("28px");
    expect(await palette.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
      await resolvedIn(page, "body", "var(--color-surface-overlay)"),
    );
  });

  test(`800 x 600, ${density}: every dialog fits the window and keeps its actions reachable`, async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 600 });
    await boot(page, { compact });

    // The palette stays inside the window, results or none.
    const palette = await openPalette(page);
    const pbox = (await palette.boundingBox())!;
    expect(pbox.x).toBeGreaterThanOrEqual(0);
    expect(pbox.y + pbox.height).toBeLessThanOrEqual(600);
    await page.keyboard.press("Escape");

    // Preferences is far taller than the window: its body scrolls, its title and close stay.
    await page.getByLabel("Preferences").click();
    const prefs = '[role="dialog"][aria-label="Preferences"]';
    await expect(page.locator(prefs)).toBeVisible();
    expect(await inWindow(page, prefs)).toEqual({ box: true, outside: [], sideways: false });
    await page.locator(prefs).getByRole("heading", { name: "Updates" }).scrollIntoViewIfNeeded();
    await expect(page.locator(prefs).getByRole("button", { name: "Show first-launch onboarding again" })).toBeInViewport();
    expect(await inWindow(page, prefs)).toEqual({ box: true, outside: [], sideways: false });
    await page.getByRole("button", { name: "Close" }).click();

    // A very long pod name wraps inside the delete dialog; Cancel and Delete stay in view.
    await page.getByRole("complementary").getByText("Pods", { exact: true }).click();
    await page.getByText(LONG_POD, { exact: true }).click();
    await page.getByRole("dialog", { name: LONG_POD }).getByRole("button", { name: "Delete" }).click();
    const del = '[role="dialog"][aria-label="Delete Pod"]';
    await expect(page.locator(del)).toBeVisible();
    expect(await inWindow(page, del)).toEqual({ box: true, outside: [], sideways: false });
    await expect(page.locator(del).getByRole("button", { name: "Delete Pod" })).toBeInViewport({ ratio: 1 });
    await expect(page.locator(del).getByRole("button", { name: "Cancel" })).toBeInViewport({ ratio: 1 });
  });

  test(`800 x 600, ${density}: onboarding keeps its progress and actions in the window on every step`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 800, height: 600 });
    await boot(page, { compact, onboarding: true });
    const dialog = page.getByRole("dialog", { name: "Welcome to CubeLite" });
    for (const step of [1, 2, 3]) {
      await expect(dialog.getByText(`Step ${step} of 3`)).toBeInViewport({ ratio: 1 });
      const action = dialog.getByRole("button", { name: step < 3 ? "Continue" : "Start using CubeLite" });
      await expect(action).toBeInViewport({ ratio: 1 });
      if (step < 3) await action.click();
    }
  });
}

test("a cluster row in the palette carries its own cluster's tint, not the active one's", async ({ page }) => {
  await boot(page);
  await openPalette(page);
  const mark = (name: string) =>
    page.locator(`[data-cluster-row="${name}"] [data-testid="identity-mark"]`).evaluate((el) => getComputedStyle(el).backgroundColor);
  const prod = await mark("prod-aks");
  const staging = await mark("staging");
  expect(prod).not.toBe(staging);
  // Each is the primary of its own hue; the window is on prod-aks (teal).
  expect(staging).toBe(await resolvedIn(page, '[data-cluster-row="staging"]', "var(--color-primary)"));
  expect(staging).not.toBe(await resolvedIn(page, "body", "var(--color-primary)"));
  // Health is a shape and a word.
  await expect(page.locator('[data-cluster-row="prod-aks"]')).toContainText("Connected");
  await expect(page.locator('[data-cluster-row="prod-aks"] [data-glyph="ok"]')).toBeVisible();
});

test("the delete dialog names the pod, its namespace and the cluster, and confirms in error-solid", async ({ page }) => {
  await boot(page);
  await page.getByRole("complementary").getByText("Pods", { exact: true }).click();
  await page.getByText("api-0", { exact: true }).click();
  await page.getByRole("dialog", { name: "api-0" }).getByRole("button", { name: "Delete" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete Pod" });
  const facts = dialog.getByRole("list", { name: "Pod to delete" });
  await expect(facts.getByRole("listitem")).toHaveText([/Pod\s*api-0/, /Namespace\s*default/, /Cluster\s*prod-aks/]);
  const confirm = dialog.getByRole("button", { name: "Delete Pod" });
  expect(await confirm.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
    await resolvedIn(page, "body", "var(--color-error-solid)"),
  );
  expect(await confirm.evaluate((el) => getComputedStyle(el).color)).toBe(
    await resolvedIn(page, "body", "var(--color-on-error-solid)"),
  );
  // Cancel deletes nothing: the dialog goes, the pod's panel stays.
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("dialog", { name: "api-0" })).toBeVisible();
});

for (const theme of ["dark", "light"] as const) {
  test(`${theme}: Preferences controls keep a 3:1 edge against the dialog, and the chosen swatch its mark`, async ({
    page,
  }) => {
    await boot(page, { theme });
    await page.getByLabel("Preferences").click();
    const root = '[role="dialog"][aria-label="Preferences"]';
    const es = page.locator(root).getByTestId("elastic-prefs");
    await es.getByRole("radio", { name: "In cluster" }).click();
    await expect(es.getByLabel("Namespace")).toBeVisible();

    const measured = [
      ...(await edges(page, root, "input:not([type=checkbox]), select", "borderTopColor")),
      ...(await edges(page, root, '[role="switch"][aria-checked="false"]', "borderTopColor")),
      ...(await edges(page, root, '[role="switch"][aria-checked="true"]', "backgroundColor")),
      ...(await edges(page, root, '[role="radiogroup"][data-outlined="true"]', "borderTopColor")),
      ...(await edges(page, root, '[role="radio"][data-tint]', "backgroundColor")),
      ...(await edges(page, root, "[data-swatch-mark]", "color")),
    ];
    // Fields, both switch states, every segmented group, ten swatches and two marks.
    expect(measured.length).toBeGreaterThan(20);
    for (const m of measured) expect(m.ratio, m.name).toBeGreaterThanOrEqual(3);
    // One mark per cluster, on the chosen swatch only.
    await expect(page.locator(root).locator('[role="radio"][aria-checked="true"] [data-swatch-mark]')).toHaveCount(2);
    await expect(page.locator(root).locator('[role="radio"][aria-checked="false"] [data-swatch-mark]')).toHaveCount(0);
  });
}
