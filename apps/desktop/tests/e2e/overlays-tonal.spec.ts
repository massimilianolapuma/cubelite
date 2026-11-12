// Tonal phase 8 (#627): the palette, Preferences, onboarding and the delete
// dialog on the rendered page. jsdom has no layout and no CSS, so sizes,
// overflow, tints and contrast are read here.
import { type Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { tauriMockScript, FIXTURES } from "./tauri-mock";

const LONG_POD = "payments-settlement-reconciliation-worker-7f9c8d6b5-x2kqz-with-a-very-long-suffix";

// Two EKS contexts whose names differ only at the end (§9.2 long names).
const ARN_PROD = "arn:aws:eks:eu-west-1:123456789012:cluster/payments-prod";
const ARN_STAGING = "arn:aws:eks:eu-west-1:123456789012:cluster/payments-staging";
const arnContext = (name: string) => ({ ...FIXTURES.contexts[1], name, cluster_server: "https://eks.amazonaws.com" });

type Boot = {
  theme?: "dark" | "light";
  compact?: boolean;
  onboarding?: boolean;
  contexts?: (typeof FIXTURES)["contexts"];
  /** Cluster colours; by default prod-aks is teal and staging magenta. */
  colors?: Record<string, string>;
  /** Runs after the Tauri mock is installed, before the app starts. */
  init?: () => void;
};

async function boot(page: Page, o: Boot = {}) {
  await page.addInitScript(
    tauriMockScript({
      pods: [...FIXTURES.pods, { ...FIXTURES.pods[0], name: LONG_POD }],
      ...(o.contexts ? { contexts: o.contexts } : {}),
    }),
  );
  if (o.init) await page.addInitScript(o.init);
  await page.addInitScript(
    ([theme, compact, onboarding, colors]) => {
      if (!onboarding) window.localStorage.setItem("cubelite.onboardingSeen", "true");
      window.localStorage.setItem("cubelite.theme", JSON.stringify(theme));
      if (compact) window.localStorage.setItem("cubelite.density", '"compact"');
      window.localStorage.setItem("cubelite.identityColors", JSON.stringify(colors));
    },
    // Two clusters of different colours, neither of them the default.
    [o.theme ?? "dark", !!o.compact, !!o.onboarding, o.colors ?? { "prod-aks": "teal", staging: "magenta" }] as const,
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

/**
 * Whether a dialog lies inside the window, none of its scrolling parts scrolls
 * sideways, and every control lies inside the dialog's box: across, all of them;
 * down, those outside a scroller (title row, actions), which never scroll away.
 */
async function fits(page: Page, dialog: string) {
  return page.evaluate((sel) => {
    const d = document.querySelector<HTMLElement>(sel)!;
    const box = d.getBoundingClientRect();
    const name = (e: Element) => e.getAttribute("aria-label") ?? e.textContent?.trim() ?? e.tagName;
    const scrollers = [d, ...d.querySelectorAll<HTMLElement>("*")].filter((e) =>
      /auto|scroll/.test(getComputedStyle(e).overflowY),
    );
    const sideways = scrollers.filter((e) => e.scrollWidth > e.clientWidth).map((e) => e.className);
    const outside = [
      ...d.querySelectorAll<HTMLElement>('button, input, select, textarea, [role="switch"], [role="radio"]'),
    ]
      .filter((c) => c.getClientRects().length > 0)
      .filter((c) => {
        const r = c.getBoundingClientRect();
        const across = r.left < box.left - 0.5 || r.right > box.right + 0.5;
        const scrolls = scrollers.some((e) => e !== d && e.contains(c));
        const down = !scrolls && (r.top < box.top - 0.5 || r.bottom > box.bottom + 0.5);
        return across || down;
      })
      .map(name);
    const window =
      box.left >= -0.5 && box.top >= -0.5 && box.right <= innerWidth + 0.5 && box.bottom <= innerHeight + 0.5;
    return { window, sideways, outside };
  }, dialog);
}

/**
 * Contrast against what is painted under an element (WCAG ratio), of its
 * `prop` colour. The browser converts the colours by painting them on a canvas.
 */
async function edges(
  page: Page,
  root: string,
  selector: string,
  prop: "borderTopColor" | "backgroundColor" | "color" | "ring",
) {
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
      // `ring`: the colour of the element's inset box-shadow ring (the one with a spread).
      const ring = (el: Element) => {
        const shadows = getComputedStyle(el).boxShadow.split(/,(?![^(]*\))/);
        const drawn = shadows.find((sh) => /inset/.test(sh) && /\s0px\s0px\s0px\s[1-9][\d.]*px/.test(sh));
        return drawn?.match(/^\s*(\w+\([^)]*\)|#\w+|\w+)/)?.[1] ?? "transparent";
      };
      return [...document.querySelector(rootSel)!.querySelectorAll<HTMLElement>(sel)].map((el) => {
        const layers = under(el.parentElement);
        const colour = p === "ring" ? ring(el) : getComputedStyle(el)[p as "color"];
        const [hi, lo] = [lum(paint(layers)), lum(paint([...layers, colour]))].sort((a, b) => b - a);
        const name = el.getAttribute("aria-label") ?? (el.textContent?.trim() || el.tagName);
        return { name, ratio: (hi + 0.05) / (lo + 0.05) };
      });
    },
    [root, selector, prop] as const,
  );
}

/**
 * Contrast of each native checkbox against the dialog, read from the pixels the
 * browser painted (its box has no CSS colour to read). Unchecked: the pixel of
 * the box that differs most from the surface, which is its outline. Checked: the
 * box's commonest colour, which is its fill (the tick covers less).
 */
async function checkboxEdges(page: Page, root: string) {
  const boxes = page.locator(`${root} input[type="checkbox"]`);
  const out: { name: string; ratio: number }[] = [];
  for (let i = 0; i < (await boxes.count()); i++) {
    const box = boxes.nth(i);
    await box.scrollIntoViewIfNeeded();
    const r = (await box.boundingBox())!;
    const m = 4;
    const png = await page.screenshot({
      clip: { x: r.x - m, y: r.y - m, width: r.width + 2 * m, height: r.height + 2 * m },
      animations: "disabled",
    });
    const checked = await box.isChecked();
    const ratio = await page.evaluate(
      async ([data, margin, on]) => {
        const img = new Image();
        img.src = `data:image/png;base64,${data}`;
        await img.decode();
        const canvas = document.createElement("canvas");
        [canvas.width, canvas.height] = [img.width, img.height];
        const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
        ctx.drawImage(img, 0, 0);
        const px = (x: number, y: number) => [...ctx.getImageData(x, y, 1, 1).data];
        const lum = ([r, g, b]: number[]) => {
          const f = (v: number) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
          return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
        };
        const contrast = (a: number[], b: number[]) => {
          const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
          return (hi + 0.05) / (lo + 0.05);
        };
        const surface = px(1, 1);
        const inside: number[][] = [];
        for (let y = margin; y < img.height - margin; y++)
          for (let x = margin; x < img.width - margin; x++) inside.push(px(x, y));
        if (!on) return Math.max(...inside.map((p) => contrast(p, surface)));
        const counts = new Map<string, number>();
        for (const p of inside) counts.set(p.join(), (counts.get(p.join()) ?? 0) + 1);
        const fill = [...counts].sort((a, b) => b[1] - a[1])[0][0].split(",").map(Number);
        return contrast(fill, surface);
      },
      [png.toString("base64"), m, checked] as const,
    );
    out.push({ name: `checkbox ${i} ${checked ? "on" : "off"}`, ratio });
  }
  return out;
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
    expect(pbox.x + pbox.width).toBeLessThanOrEqual(800);
    expect(pbox.y + pbox.height).toBeLessThanOrEqual(600);
    await page.keyboard.press("Escape");

    // Preferences is far taller than the window: its body scrolls, its title and close stay.
    await page.getByLabel("Preferences").click();
    const prefs = '[role="dialog"][aria-label="Preferences"]';
    await expect(page.locator(prefs)).toBeVisible();
    const fitted = { window: true, sideways: [], outside: [] };
    expect(await fits(page, prefs)).toEqual(fitted);
    // The last control scrolls into view whole.
    const last = page.locator(prefs).getByRole("button", { name: "Show first-launch onboarding again" });
    await last.scrollIntoViewIfNeeded();
    await expect(last).toBeInViewport({ ratio: 1 });
    expect(await fits(page, prefs)).toEqual(fitted);
    await page.getByRole("button", { name: "Close" }).click();

    // A very long pod name wraps inside the delete dialog; Cancel and Delete stay in view.
    await page.getByRole("complementary").getByText("Pods", { exact: true }).click();
    await page.getByText(LONG_POD, { exact: true }).click();
    await page.getByRole("dialog", { name: LONG_POD }).getByRole("button", { name: "Delete" }).click();
    const del = '[role="dialog"][aria-label="Delete Pod"]';
    await expect(page.locator(del)).toBeVisible();
    expect(await fits(page, del)).toEqual(fitted);
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
      expect(await fits(page, '[data-testid="onboarding"]')).toEqual({ window: true, sideways: [], outside: [] });
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

for (const [width, height] of [
  [1360, 860],
  [800, 600],
] as const) {
  test(`${width} x ${height}: two long cluster names that differ at the end read differently in the palette`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await boot(page, { contexts: [FIXTURES.contexts[0], arnContext(ARN_PROD), arnContext(ARN_STAGING)] });
    await openPalette(page);
    for (const name of [ARN_PROD, ARN_STAGING]) {
      const label = page.locator(`[data-cluster-row="${name}"]`).getByText(name, { exact: true });
      // The full name is always one hover away (§9.2).
      await expect(label).toHaveAttribute("title", name);
      // Two lines are enough for these: nothing of the name is cut, so its end shows.
      const box = await label.evaluate((el) => ({
        sw: el.scrollWidth,
        cw: el.clientWidth,
        sh: el.scrollHeight,
        ch: el.clientHeight,
      }));
      expect(box.sw, `${name} is cut sideways`).toBeLessThanOrEqual(box.cw);
      expect(box.sh, `${name} is cut below`).toBeLessThanOrEqual(box.ch);
    }
  });
}

test("Install update keeps its label and its width while the update downloads", async ({ page }) => {
  // An update is there; its download never ends.
  const init = () => {
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, ...a: unknown[]) => unknown } })
      .__TAURI_INTERNALS__;
    const invoke = internals.invoke;
    internals.invoke = (cmd: string, ...rest: unknown[]) => {
      if (cmd === "plugin:updater|check")
        return Promise.resolve({ rid: 7, currentVersion: "0.10.1", version: "0.11.0", date: null, body: "", rawJson: {} });
      if (cmd === "plugin:updater|download_and_install") return new Promise(() => {});
      return invoke(cmd, ...rest);
    };
  };
  await boot(page, { init });
  await page.getByLabel("Preferences").click();
  const region = page.getByRole("region", { name: "Updates" });
  // The silent check at start-up has found it.
  const install = region.getByRole("button", { name: "Install update" });
  await expect(region).toContainText("Update 0.11.0 available");
  // Layout widths: the dialog's pop-in animation scales its box for a moment.
  const width = () => install.evaluate((el) => (el as HTMLElement).offsetWidth);
  const before = await width();
  await install.click();
  await expect(install).toHaveAttribute("aria-busy", "true");
  await expect(region).toContainText("Downloading update 0.11.0…");
  expect(await width()).toBe(before);
  // The label is painted, not only named.
  await expect(install.getByText("Install update")).toHaveCSS("opacity", "1");
});

for (const [width, height] of [
  [1280, 800],
  [800, 600],
] as const) {
  test(`${width} x ${height}: the Authentication select shows its longest option whole and stays in its form`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await boot(page);
    await page.getByLabel("Preferences").click();
    for (const form of ["prometheus-prefs", "elastic-prefs"]) {
      const scope = page.getByTestId(form);
      await scope.getByRole("radio", { name: "External" }).click();
      const select = scope.getByLabel("Authentication");
      const fit = await select.evaluate((el: HTMLSelectElement) => {
        // A native select sized by its content is as wide as its longest option.
        const probe = el.cloneNode(true) as HTMLSelectElement;
        probe.style.cssText = "position:absolute;visibility:hidden;width:auto;max-width:none";
        el.parentElement!.append(probe);
        const needed = probe.offsetWidth;
        probe.remove();
        const box = el.getBoundingClientRect();
        const form = el.closest('[data-testid$="-prefs"]')!.getBoundingClientRect();
        return { width: el.offsetWidth, needed, inside: box.left >= form.left - 0.5 && box.right <= form.right + 0.5 };
      });
      expect(fit.width, `${form}: the select cuts its longest option`).toBeGreaterThanOrEqual(fit.needed);
      expect(fit.inside, `${form}: the select leaves its form`).toBe(true);
    }
  });
}

test("every point of an icon button in the Preferences lists belongs to that button", async ({ page }) => {
  await boot(page);
  await page.getByLabel("Preferences").click();
  const prefs = page.getByRole("dialog", { name: "Preferences" });
  const buttons = {
    sidebar: prefs.getByTestId("navigation-prefs").getByRole("button", { name: "Move Deployments down", exact: true }),
    profiles: prefs.getByRole("list", { name: "Profiles" }).getByRole("button", { name: /^Move .+ down$/ }).first(),
    pins: prefs.getByRole("list", { name: /^Pins of / }).getByRole("button", { name: /^Move .+ down in / }).first(),
  };
  for (const [list, button] of Object.entries(buttons)) {
    await button.scrollIntoViewIfNeeded();
    // A row's button reaching into the row above (or below) would take this click.
    const misses = await button.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      // 1 px inside each edge: hit testing rounds a fractional point.
      const points: [string, number, number][] = [
        ["top", cx, r.top + 1],
        ["bottom", cx, r.bottom - 1],
        ["left", r.left + 1, cy],
        ["right", r.right - 1, cy],
      ];
      return points
        .filter(([, x, y]) => document.elementFromPoint(x, y)?.closest("button") !== el)
        .map(([edge, x, y]) => `${edge}: ${document.elementFromPoint(x, y)?.closest("button")?.getAttribute("aria-label")}`);
    });
    expect(misses, list).toEqual([]);
  }
});

test("the profile rename field is 36 px like every other form field", async ({ page }) => {
  await boot(page, { compact: false });
  await page.getByLabel("Preferences").click();
  const prefs = page.getByRole("dialog", { name: "Preferences" });
  await prefs.getByLabel("Profile name").fill("Mine");
  await prefs.getByRole("button", { name: "Create" }).click();
  await prefs.getByRole("button", { name: "Rename Mine" }).click();
  const height = (label: string) => prefs.getByLabel(label).evaluate((el) => (el as HTMLElement).offsetHeight);
  expect(await height("New name for Mine")).toBe(36);
  expect(await height("Profile name")).toBe(36);
});

for (const compact of [false, true]) {
  test(`${compact ? "compact" : "default"}: a dialog's one primary action is 48 px tall, as in the pod panel (§7)`, async ({
    page,
  }) => {
    await boot(page, { compact, onboarding: true });
    const tall = (button: ReturnType<Page["getByRole"]>) => button.evaluate((el) => (el as HTMLElement).offsetHeight);
    const onboarding = page.getByRole("dialog", { name: "Welcome to CubeLite" });
    expect(await tall(onboarding.getByRole("button", { name: "Continue" }))).toBe(48);
    await onboarding.getByRole("button", { name: "Continue" }).click();
    await onboarding.getByRole("button", { name: "Continue" }).click();
    expect(await tall(onboarding.getByRole("button", { name: "Start using CubeLite" }))).toBe(48);
    await onboarding.getByRole("button", { name: "Start using CubeLite" }).click();

    await page.getByRole("complementary").getByText("Pods", { exact: true }).click();
    await page.getByText("api-0", { exact: true }).click();
    await page.getByRole("dialog", { name: "api-0" }).getByRole("button", { name: "Delete" }).click();
    const del = page.getByRole("dialog", { name: "Delete Pod" });
    expect(await tall(del.getByRole("button", { name: "Delete Pod" }))).toBe(48);
    // The secondary action sits level with it.
    const centre = async (name: string) => {
      const b = (await del.getByRole("button", { name }).boundingBox())!;
      return b.y + b.height / 2;
    };
    expect(Math.abs((await centre("Cancel")) - (await centre("Delete Pod")))).toBeLessThan(1);
    await del.getByRole("button", { name: "Cancel" }).click();

    // The YAML editor's Apply is that dialog's one primary action (#632).
    await page.getByRole("dialog", { name: "api-0" }).getByRole("button", { name: "YAML" }).click();
    const yaml = page.getByRole("dialog", { name: "api-0.yaml" });
    await yaml.getByRole("button", { name: "Edit" }).click();
    expect(await tall(yaml.getByRole("button", { name: "Apply" }))).toBe(48);
  });
}

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

const TINTS = ["blue", "magenta", "teal", "violet", "indigo"] as const;

for (const theme of ["dark", "light"] as const) {
  for (const [t, tint] of TINTS.entries()) {
    // The other cluster takes another tint, so the palette shows two at once.
    const other = TINTS[(t + 2) % TINTS.length];
    test(`${theme}, ${tint}: controls and selections keep a 3:1 edge against their surface, and the chosen swatch its mark`, async ({
      page,
    }) => {
      await boot(page, { theme, colors: { "prod-aks": tint, staging: other } });
      // The window carries the active cluster's tint.
      expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--cl-tint-h"))).toBe(
        await page.evaluate((t) => getComputedStyle(document.documentElement).getPropertyValue(`--cl-hue-${t}`), tint),
      );
      await page.getByLabel("Preferences").click();
      const root = '[role="dialog"][aria-label="Preferences"]';
      const es = page.locator(root).getByTestId("elastic-prefs");
      await es.getByRole("radio", { name: "In cluster" }).click();
      await expect(es.getByLabel("Namespace")).toBeVisible();
      // Both states of the native checkbox.
      const boxes = page.locator(root).locator('input[type="checkbox"]');
      await expect(boxes).not.toHaveCount(0);
      await boxes.first().check();
      await page.mouse.move(0, 0);

      const selected = '[role="radiogroup"] [role="radio"][aria-checked="true"]:not([data-tint])';
      const measured = [
        ...(await edges(page, root, "input:not([type=checkbox]), select", "borderTopColor")),
        ...(await edges(page, root, '[role="switch"][aria-checked="false"]', "borderTopColor")),
        ...(await edges(page, root, '[role="switch"][aria-checked="true"]', "backgroundColor")),
        ...(await edges(page, root, '[role="radiogroup"][data-outlined="true"]', "borderTopColor")),
        ...(await edges(page, root, '[role="radio"][data-tint]', "backgroundColor")),
        ...(await edges(page, root, "[data-swatch-mark]", "color")),
      ];
      // The selected segment is told by a primary ring, not by its fill alone.
      const segments = await edges(page, root, selected, "ring");
      const checkboxes = await checkboxEdges(page, root);
      expect(segments.length).toBeGreaterThanOrEqual(4);
      expect(checkboxes.map((c) => c.name)).toEqual(expect.arrayContaining([expect.stringMatching(/on$/), expect.stringMatching(/off$/)]));
      // Fields, both switch states, every segmented group, ten swatches and two marks.
      expect(measured.length).toBeGreaterThan(20);
      for (const m of [...measured, ...segments, ...checkboxes]) expect(m.ratio, m.name).toBeGreaterThanOrEqual(3);
      // One mark per cluster, on the chosen swatch only.
      await expect(page.locator(root).locator('[role="radio"][aria-checked="true"] [data-swatch-mark]')).toHaveCount(2);
      await expect(page.locator(root).locator('[role="radio"][aria-checked="false"] [data-swatch-mark]')).toHaveCount(0);
      await page.getByRole("button", { name: "Close" }).click();

      // The palette's highlighted row: a ring in the row's own tint, on a cluster
      // row of each colour and on a resource row.
      const palette = '[data-testid="command-palette"]';
      await openPalette(page);
      const input = page.getByPlaceholder("Search clusters, resources, actions…");
      const rows: { name: string; ratio: number }[] = [];
      for (const query of ["prod-aks", "staging", "Deployments"]) {
        await input.fill(query);
        await expect(page.locator(`${palette} [data-selected]`)).toHaveCount(1);
        rows.push(...(await edges(page, palette, "[data-selected]", "ring")).map((r) => ({ ...r, name: query })));
      }
      for (const r of rows) expect(r.ratio, `highlighted ${r.name}`).toBeGreaterThanOrEqual(3);
    });
  }
}
