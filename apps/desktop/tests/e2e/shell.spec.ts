import { type Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { FIXTURES, tauriMockScript } from "./tauri-mock";

// The Tonal shell (#611): top bar, rail, sidebar.
async function boot(page: Page, overrides: Parameters<typeof tauriMockScript>[0] = {}) {
  await page.addInitScript(tauriMockScript(overrides));
  await page.addInitScript(() => {
    window.localStorage.setItem("cubelite.onboardingSeen", "true");
    window.localStorage.setItem("cubelite.theme", '"dark"');
  });
  await page.goto("/");
}

const MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const aside = (page: Page) => page.locator("aside").first();

test("a long context name truncates instead of pushing the top bar out of the window", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  const long = "arn:aws:eks:eu-central-1:123456789012:cluster/payments-production-blue";
  await boot(page, {
    contexts: [{ ...FIXTURES.contexts[0], name: long }, ...FIXTURES.contexts.slice(1)],
  });
  const header = page.locator("header").first();
  await expect(header.getByText(long)).toBeVisible();
  expect(await header.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  // What sits after the name is still on screen.
  await expect(header.getByTestId("connection-state")).toBeInViewport();
});

test("the top bar stays on one row at the minimum window size", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await boot(page);
  const header = page.locator("header").first();
  await expect(header.getByTestId("connection-state")).toBeVisible();
  // One row: every control starts at the same height.
  const tops = await header.locator(":scope > button, :scope > div").evaluateAll((els) =>
    els.map((el) => Math.round(el.getBoundingClientRect().top)),
  );
  expect(new Set(tops).size).toBe(1);
  // Search collapses to its icon but keeps its name and still opens the palette.
  const search = header.getByRole("button", { name: /Search & switch/ });
  await expect(search).toBeVisible();
  expect((await search.boundingBox())!.width).toBeLessThan(60);
  await search.click();
  await expect(page.getByPlaceholder("Search clusters, resources, actions…")).toBeVisible();
});

// A long name in one chip must not squeeze the other chip's value away.
const LONG_CONTEXT = "arn:aws:eks:eu-west-1:123456789012:cluster/production-platform-main";
const LONG_NAMESPACE = "payments-gateway-canary-eu-central-1-blue-green-a";

/** The width of 14ch in the font of `el`. */
const fourteenCh = (el: import("@playwright/test").Locator) =>
  el.evaluate((n) => {
    const probe = document.createElement("span");
    probe.style.cssText = "position:absolute;visibility:hidden;width:14ch";
    n.append(probe);
    const w = probe.getBoundingClientRect().width;
    probe.remove();
    return w;
  });

for (const width of [800, 1000, 1100, 1280, 1440]) {
  test(`a long context name leaves the namespace readable at ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 700 });
    // First sight: "production" in the name makes it read-only (#662), so the
    // chip carries the environment tag and the access word too.
    await boot(page, {
      contexts: [{ ...FIXTURES.contexts[0], name: LONG_CONTEXT }, ...FIXTURES.contexts.slice(1)],
      clusterAccess: {},
    });
    const header = page.locator("header").first();
    await expect(header.getByTestId("access-state")).toHaveAttribute("data-access", "read_only");
    await header.getByRole("button", { name: /Namespace/ }).click();
    await page.getByRole("menuitemradio", { name: /kube-system/ }).click();
    const value = header.getByText("kube-system", { exact: true });
    await expect(value).toBeVisible();
    // Whole, not cut to an ellipsis.
    expect(await value.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    const name = header.getByText(LONG_CONTEXT);
    await expect(name).toHaveAttribute("title", LONG_CONTEXT);
    // The name wins: from 1100 px the extras give way before it goes under 14ch.
    const least = width >= 1100 ? (await fourteenCh(name)) - 1 : 40;
    expect((await name.boundingBox())!.width).toBeGreaterThan(least);
    // The environment tag stays, and the access keeps its state for every reader.
    await expect(header.getByTestId("environment-tag")).toBeVisible();
    await expect(header.getByTestId("access-state")).toBeVisible();
    await expect(header.getByTestId("access-state")).toHaveAttribute("title", "Read-only");
    await expect(header.locator("[data-cluster-chip]")).toHaveAccessibleName(/Read-only/);
    expect(await header.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  });

  test(`a long namespace leaves the context name readable at ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 700 });
    await boot(page, { namespaces: [...FIXTURES.namespaces, { name: LONG_NAMESPACE, phase: "Active" }] });
    const header = page.locator("header").first();
    await header.getByRole("button", { name: /Namespace/ }).click();
    await page.getByRole("menuitemradio", { name: new RegExp(LONG_NAMESPACE) }).click();
    const name = header.getByText(FIXTURES.contexts[0].name, { exact: true });
    expect(await name.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect((await header.getByText(LONG_NAMESPACE).boundingBox())!.width).toBeGreaterThan(40);
    expect(await header.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  });
}

/** Whether `el` takes room on screen (not hidden, not visually hidden). */
const shown = (el: import("@playwright/test").Locator) =>
  el.evaluate((n) => n.getBoundingClientRect().width > 1 && getComputedStyle(n).position !== "absolute");

// The namespace chip (#683): its "Namespace" label gives way before the value is cut.
const SIXTEEN = "payments-gateway";
for (const compact of [false, true]) {
  const density = compact ? "compact" : "default";
  test(`1100 px, ${density}: a 16-character namespace is shown whole, the label giving way first`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1100, height: 700 });
    if (compact) await page.addInitScript(() => window.localStorage.setItem("cubelite.density", '"compact"'));
    await boot(page, {
      contexts: [{ ...FIXTURES.contexts[0], name: LONG_CONTEXT }, ...FIXTURES.contexts.slice(1)],
      namespaces: [...FIXTURES.namespaces, { name: SIXTEEN, phase: "Active" }],
      clusterAccess: {},
    });
    const header = page.locator("header").first();
    const chip = header.getByRole("button", { name: /Namespace/ });
    await chip.click();
    await page.getByRole("menuitemradio", { name: new RegExp(SIXTEEN) }).click();
    const value = header.getByText(SIXTEEN, { exact: true });
    await expect(value).toBeVisible();
    expect(await value.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    // The label is gone from view, still in the chip's name.
    expect(await shown(chip.getByText("Namespace", { exact: true }))).toBe(false);
    await expect(chip).toHaveAccessibleName(/Namespace/);
    // The cluster's name keeps its minimum.
    const name = header.getByText(LONG_CONTEXT);
    expect((await name.boundingBox())!.width).toBeGreaterThan((await fourteenCh(name)) - 1);
    expect(await header.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  });
}

test("with room for it, the namespace chip keeps its label", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 700 });
  await boot(page);
  const header = page.locator("header").first();
  const chip = header.getByRole("button", { name: /Namespace/ });
  await chip.click();
  await page.getByRole("menuitemradio", { name: /kube-system/ }).click();
  await expect(header.getByText("kube-system", { exact: true })).toBeVisible();
  expect(await shown(chip.getByText("Namespace", { exact: true }))).toBe(true);
});

test("a namespace too long for the chip drops the label, then truncates", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 700 });
  await boot(page, { namespaces: [...FIXTURES.namespaces, { name: LONG_NAMESPACE, phase: "Active" }] });
  const header = page.locator("header").first();
  const chip = header.getByRole("button", { name: /Namespace/ });
  await chip.click();
  await page.getByRole("menuitemradio", { name: new RegExp(LONG_NAMESPACE) }).click();
  const value = header.getByText(LONG_NAMESPACE, { exact: true });
  await expect(value).toBeVisible();
  expect(await shown(chip.getByText("Namespace", { exact: true }))).toBe(false);
  expect(await value.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  // Back to a short one: the label comes back.
  await chip.click();
  await page.getByRole("menuitemradio", { name: /kube-system/ }).click();
  await expect(header.getByText("kube-system", { exact: true })).toBeVisible();
  await expect.poll(() => shown(chip.getByText("Namespace", { exact: true }))).toBe(true);
});

test("beside a long context name the connection word goes first, then the version", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 700 });
  await boot(page, {
    contexts: [{ ...FIXTURES.contexts[0], name: LONG_CONTEXT }, ...FIXTURES.contexts.slice(1)],
    clusterAccess: {},
  });
  const header = page.locator("header").first();
  const chip = header.locator("[data-cluster-chip]");
  await header.getByRole("button", { name: /Namespace/ }).click();
  await page.getByRole("menuitemradio", { name: /kube-system/ }).click();
  await expect(header.getByText("kube-system", { exact: true })).toBeVisible();
  // Gone from view, still read out: the connection keeps its glyph and title.
  expect(await shown(header.getByTestId("connection-state").getByText("Connected"))).toBe(false);
  await expect(header.getByTestId("connection-state")).toHaveAttribute("title", "Connected");
  await expect(header.getByText("v1.30.2")).toBeHidden();
  await expect(chip).toHaveAccessibleName(/Connected/);
  // What gives way later is still there.
  expect(await shown(header.getByTestId("access-state").getByText("Read-only"))).toBe(true);
  await expect(header.getByText("AKS", { exact: true })).toBeVisible();
  await expect(header.getByTestId("environment-tag")).toBeVisible();
});

test("then the access word goes, its icon keeping the state and the warning look", async ({ page }) => {
  // A long namespace and a timed unlock leave the name the least room.
  await page.setViewportSize({ width: 1024, height: 700 });
  await boot(page, {
    contexts: [{ ...FIXTURES.contexts[0], name: LONG_CONTEXT }, ...FIXTURES.contexts.slice(1)],
    namespaces: [...FIXTURES.namespaces, { name: LONG_NAMESPACE, phase: "Active" }],
    clusterAccess: {},
  });
  const header = page.locator("header").first();
  const chip = header.locator("[data-cluster-chip]");
  await header.getByRole("button", { name: /Namespace/ }).click();
  await page.getByRole("menuitemradio", { name: new RegExp(LONG_NAMESPACE) }).click();
  await chip.click();
  await page.getByRole("menuitem", { name: "Make writable for" }).click();
  await page.getByRole("menuitem", { name: "15 minutes", exact: true }).click();
  await page.getByRole("button", { name: "Make writable" }).click();
  const state = header.getByTestId("access-state");
  await expect(state).toHaveAttribute("data-access", "timed");
  await expect(state).toBeVisible();
  // The words go, the timer stays.
  expect(await shown(state.locator(":scope > span"))).toBe(false);
  expect((await state.boundingBox())!.width).toBeLessThan(32);
  await expect(state).toHaveAttribute("title", /^Writable · 1[45] min$/);
  await expect(chip).toHaveAccessibleName(/Writable · 1[45] min/);
  await expect(state).toHaveClass(/bg-warning-container/);
  // The provider tag is the last to go: still there, as the environment tag.
  await expect(header.getByText("AKS", { exact: true })).toBeVisible();
  await expect(header.getByTestId("environment-tag")).toBeVisible();
  const name = header.getByText(LONG_CONTEXT);
  expect((await name.boundingBox())!.width).toBeGreaterThan((await fourteenCh(name)) - 1);
});

test("a short context name with room for it all keeps every extra", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 700 });
  await boot(page, {
    contexts: [{ ...FIXTURES.contexts[0], name: "aks-prod-01-emm" }, ...FIXTURES.contexts.slice(1)],
    clusterAccess: {},
  });
  const header = page.locator("header").first();
  await expect(header.getByTestId("access-state")).toHaveText("Read-only");
  const name = header.getByText("aks-prod-01-emm", { exact: true });
  // Whole: nothing cut.
  expect(await name.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  expect(await shown(header.getByTestId("connection-state").getByText("Connected"))).toBe(true);
  expect(await shown(header.getByText("v1.30.2"))).toBe(true);
});

test("the gutter above the top bar drags the window, as the title bar did", async ({ page }) => {
  await boot(page);
  await expect(page.locator("header").first()).toBeVisible();
  const drags = await page.evaluate(
    () => document.elementFromPoint(900, 3)?.closest("[data-tauri-drag-region]") !== null,
  );
  expect(drags).toBe(true);
});

test("keyboard focus shows a solid ring on the borderless shell controls", async ({ page }) => {
  await boot(page);
  await expect(page.getByLabel("All Clusters")).toBeVisible();
  await page.keyboard.press("Tab");
  const ring = await page.evaluate(() => {
    const style = getComputedStyle(document.activeElement!);
    return { label: document.activeElement!.getAttribute("aria-label"), style: style.outlineStyle, width: style.outlineWidth };
  });
  expect(ring).toEqual({ label: "All Clusters", style: "solid", width: "2px" });
});

test.describe("on macOS", () => {
  test.use({ userAgent: MAC_UA });

  test("the default profile still fits 1280×800 with the window controls strip", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await boot(page);
    await aside(page).getByRole("button", { name: /^Workloads/ }).click();
    await expect(aside(page).getByText("Helm Releases")).toBeVisible();
    expect(await aside(page).evaluate((el) => el.scrollHeight <= el.clientHeight)).toBe(true);
    const types = aside(page).getByRole("list", { name: "Workloads types" });
    expect(await types.evaluate((el) => el.scrollHeight <= el.clientHeight)).toBe(true);
  });

  test("nothing sits under the window controls, with or without the sidebar", async ({ page }) => {
    await boot(page);
    // The controls take the first 78 px of the top 36 px of the window.
    const clear = () =>
      page.evaluate(() =>
        [...document.querySelectorAll("button, input")].every((el) => {
          const box = el.getBoundingClientRect();
          return box.width === 0 || box.left >= 78 || box.top >= 36;
        }),
      );
    expect(await clear()).toBe(true);
    await page.getByLabel("All Clusters").click();
    await expect(page.getByText("All Clusters").first()).toBeVisible();
    expect(await clear()).toBe(true);
  });
});
