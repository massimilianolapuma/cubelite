// Tonal phase 9 (#632): the accessibility pass on the rendered page (spec §9.1).
// Media features (more contrast, forced colours, reduced motion) and focus
// rings only exist in a real browser: jsdom can emulate none of them.
import { type Locator, type Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { tauriMockScript } from "./tauri-mock";

type Theme = "dark" | "light";
const THEMES: Theme[] = ["dark", "light"];

type HangWindow = { __hang: string[] };

/**
 * `hang`: commands that never answer, so their spinner or placeholder stays on
 * screen. `window.__hang` can be changed later (`hangFrom`), once the app has
 * started.
 */
async function boot(page: Page, theme: Theme = "dark", hang: string[] = []) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(tauriMockScript());
  await page.addInitScript((cmds) => {
    type Internals = { invoke: (cmd: string, args: unknown) => unknown };
    const w = window as unknown as { __TAURI_INTERNALS__: Internals } & HangWindow;
    w.__hang = cmds;
    const invoke = w.__TAURI_INTERNALS__.invoke.bind(w.__TAURI_INTERNALS__);
    w.__TAURI_INTERNALS__.invoke = (cmd, args) => (w.__hang.includes(cmd) ? new Promise(() => {}) : invoke(cmd, args));
  }, hang);
  await page.addInitScript((t) => {
    window.localStorage.setItem("cubelite.onboardingSeen", "true");
    window.localStorage.setItem("cubelite.theme", JSON.stringify(t));
    // prod-aks teal, staging magenta: the rail shows two tints besides the window's.
    window.localStorage.setItem("cubelite.identityColors", JSON.stringify({ "prod-aks": "teal", staging: "magenta" }));
  }, theme);
  await page.goto("/");
}

/** The Pods list with api-0 selected: the content card, the panel and its tiles. */
async function podsWithPanel(page: Page) {
  await page.getByRole("complementary").getByText("Pods", { exact: true }).click();
  await page.getByText("api-0", { exact: true }).click();
  const panel = page.getByRole("dialog", { name: "api-0" });
  await expect(panel).toBeVisible();
  return panel;
}

/** The colour `value` resolves to inside `scope` (a tinted subtree resolves its own tint). */
async function resolvedIn(scope: Locator, value: string): Promise<string> {
  return scope.evaluate((el, v) => {
    const probe = document.createElement("span");
    probe.style.color = v;
    el.append(probe);
    const out = getComputedStyle(probe).color;
    probe.remove();
    return out;
  }, value);
}

async function edge(el: Locator) {
  return el.evaluate((node) => {
    const s = getComputedStyle(node);
    return { style: s.outlineStyle, width: s.outlineWidth, color: s.outlineColor };
  });
}

/**
 * Every card, tile and overlay of the main surfaces, opened one after another:
 * calls `check` with a name and the element while it is on screen.
 */
async function eachCard(page: Page, check: (name: string, el: Locator) => Promise<void>) {
  const panel = await podsWithPanel(page);
  await check("content card", page.locator("main"));
  await check("detail panel", panel);
  await check("tile", panel.locator("[data-tone]").first());
  await check("panel card", panel.locator("[data-container]").first());

  await page.getByRole("button", { name: /^prod-aks AKS/ }).click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await check("menu", menu);
  await menu.getByRole("menuitem", { name: "Copy server address" }).click();
  const toast = page.getByRole("status").locator("[data-tone]").first();
  await expect(toast).toBeVisible();
  await check("toast", toast);

  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /Search & switch/ }).click();
  const palette = page.getByTestId("command-palette");
  await expect(palette).toBeVisible();
  await check("palette", palette);
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();

  await page.getByLabel("Preferences").click();
  const prefs = page.getByRole("dialog", { name: "Preferences" });
  await expect(prefs).toBeVisible();
  await check("modal", prefs);
}

test.describe("more contrast (prefers-contrast: more)", () => {
  for (const theme of THEMES) {
    test(`${theme}: subtle text reads as muted text, on the window and in a tinted subtree`, async ({ page }) => {
      await page.emulateMedia({ contrast: "more" });
      await boot(page, theme);
      await podsWithPanel(page);
      const body = page.locator("body");
      // A rail avatar carries another cluster's tint.
      const tinted = page.locator('[data-tint][data-testid="identity-avatar"]').nth(1);
      for (const scope of [body, tinted]) {
        expect(await resolvedIn(scope, "var(--color-text-subtle)")).toBe(
          await resolvedIn(scope, "var(--color-text-muted)"),
        );
      }
      // Text written in the subtle role (the list's count) now paints in the muted one.
      const count = page.getByTestId("list-count");
      expect(await count.evaluate((el) => getComputedStyle(el).color)).toBe(
        await resolvedIn(body, "var(--color-text-muted)"),
      );
    });

    test(`${theme}: every card, tile and overlay gains an outline-strong edge`, async ({ page }) => {
      await page.emulateMedia({ contrast: "more" });
      await boot(page, theme);
      await eachCard(page, async (name, el) => {
        expect(await edge(el), name).toEqual({
          style: "solid",
          width: "1px",
          color: await resolvedIn(el, "var(--color-outline-strong)"),
        });
      });
    });
  }

  test("with no preference, subtle text and the cards are as before", async ({ page }) => {
    await page.emulateMedia({ contrast: "no-preference" });
    await boot(page, "dark");
    const body = page.locator("body");
    expect(await resolvedIn(body, "var(--color-text-subtle)")).not.toBe(
      await resolvedIn(body, "var(--color-text-muted)"),
    );
    await eachCard(page, async (name, el) => {
      expect((await edge(el)).style, name).toBe("none");
    });
  });
});

/** The colour a system colour keyword (Highlight, CanvasText…) resolves to on this page. */
const sys = (page: Page, keyword: string) => resolvedIn(page.locator("body"), keyword);

const bg = (el: Locator) => el.evaluate((n) => getComputedStyle(n).backgroundColor);
/**
 * A filled item must opt out of the forcing: otherwise the browser paints a
 * Canvas backplate behind each run of its text, and HighlightText (or
 * ButtonFace) on that backplate cannot be read.
 */
const unforced = async (el: Locator) =>
  expect(await el.evaluate((n) => getComputedStyle(n).forcedColorAdjust)).toBe("none");
const fg = (el: Locator) => el.evaluate((n) => getComputedStyle(n).color);
async function border(el: Locator) {
  return el.evaluate((n) => {
    const s = getComputedStyle(n);
    return { style: s.borderTopStyle, width: parseFloat(s.borderTopWidth) };
  });
}

test.describe("forced colours (forced-colors: active)", () => {
  // The window's theme and the system's palette are independent: check both pairs that differ.
  for (const [theme, scheme] of [
    ["dark", "light"],
    ["light", "dark"],
  ] as const) {
    test(`${theme} app on a ${scheme} system palette: selection, current items and pressed controls are system colours`, async ({
      page,
    }) => {
      await page.emulateMedia({ forcedColors: "active", colorScheme: scheme });
      await boot(page, theme);
      const panel = await podsWithPanel(page);
      const [highlight, highlightText, canvasText] = [
        await sys(page, "Highlight"),
        await sys(page, "HighlightText"),
        await sys(page, "CanvasText"),
      ];

      // Selected list row: the row and every cell in it.
      const row = page.locator('.list-row[data-selected="true"]');
      expect(await bg(row)).toBe(highlight);
      await unforced(row);
      expect(await fg(row.getByText("api-0", { exact: true }))).toBe(highlightText);
      expect(await fg(row.getByText("Running"))).toBe(highlightText);
      // A glyph follows its text instead of keeping its state's colour.
      expect(await fg(row.locator("[data-glyph]").first())).toBe(highlightText);
      // An unselected row's badge keeps a shape: its fill is gone, its edge is not.
      const pending = page.locator('.list-row:not([data-selected="true"]) [data-state="warn"]');
      expect(await border(pending)).toEqual({ style: "solid", width: 1 });
      expect(await fg(pending.locator("[data-glyph]"))).toBe(canvasText);

      // Current nav row and the active rail avatar.
      const nav = page.locator('[data-nav][data-active="true"]');
      expect(await bg(nav)).toBe(highlight);
      expect(await fg(nav.getByText("Pods", { exact: true }))).toBe(highlightText);
      await unforced(nav);
      const avatars = page.getByTestId("identity-avatar");
      const active = avatars.and(page.locator('[data-active="true"]'));
      expect(await bg(active)).toBe(highlight);
      expect(await fg(active)).toBe(highlightText);
      await unforced(active);
      expect(await border(avatars.and(page.locator('[data-active="false"]')).first())).toEqual({
        style: "solid",
        width: 1,
      });

      // Pressed chip.
      const chips = page.getByRole("group", { name: "Filter by status" });
      await chips.getByRole("button", { name: /Running/ }).click();
      expect(await bg(chips.getByRole("button", { pressed: true }))).toBe(highlight);
      await unforced(chips.getByRole("button", { pressed: true }));
      expect(await border(chips.getByRole("button", { pressed: false }).first())).toEqual({ style: "solid", width: 1 });

      // Primary and tonal buttons differ by more than a fill: primary is inverted, tonal outlined.
      const openLogs = panel.getByRole("button", { name: "Open logs" });
      expect(await bg(openLogs)).toBe(await sys(page, "ButtonText"));
      expect(await fg(openLogs)).toBe(await sys(page, "ButtonFace"));
      await unforced(openLogs);
      expect(await border(panel.getByRole("button", { name: "Restart" }))).toEqual({ style: "solid", width: 1 });

      // An icon given a role colour of its own follows its text too.
      const chip = page.getByRole("button", { name: /^prod-aks AKS/ });
      expect(await fg(chip.locator("svg.lucide-chevron-down"))).toBe(canvasText);

      // Fields keep their edge.
      expect(await border(page.getByPlaceholder("Filter pods…"))).toEqual({ style: "solid", width: 1 });
    });

    test(`${theme} app on a ${scheme} system palette: Preferences, menus, palette and meters`, async ({ page }) => {
      await page.emulateMedia({ forcedColors: "active", colorScheme: scheme });
      await boot(page, theme);
      const highlight = await sys(page, "Highlight");

      // Meters on All Clusters: the track has an edge, the fill a system colour.
      await page.getByRole("button", { name: "All Clusters" }).click();
      const meter = page.locator("[data-level]").first();
      await expect(meter).toBeVisible();
      expect(await border(meter.locator("[data-meter-track]"))).toEqual({ style: "solid", width: 1 });
      expect(await bg(meter.getByTestId("meter-fill"))).toBe(await sys(page, "CanvasText"));

      // The highlighted menu item.
      await page.getByRole("button", { name: /^prod-aks AKS/ }).click();
      const item = page.getByRole("menuitem", { name: "Reconnect" });
      await item.hover();
      expect(await bg(item)).toBe(highlight);
      await page.keyboard.press("Escape");

      // The palette's highlighted row.
      await page.getByRole("button", { name: /Search & switch/ }).click();
      const selected = page.getByTestId("command-palette").locator("[data-selected]").first();
      await expect(selected).toBeVisible();
      expect(await bg(selected)).toBe(highlight);
      await page.keyboard.press("Escape");

      // Preferences: selected segment, switch on and off, a swatch, a disabled segment.
      await page.getByLabel("Preferences").click();
      const prefs = page.getByRole("dialog", { name: "Preferences" });
      const theme_ = prefs.getByRole("radiogroup", { name: "Theme" });
      expect(await bg(theme_.getByRole("radio", { checked: true }))).toBe(highlight);
      await unforced(theme_.getByRole("radio", { checked: true }));
      const tls = prefs.getByRole("switch", { name: "Skip TLS verification" });
      const hints = prefs.getByRole("switch", { name: "Show integration hints in panels" });
      for (const sw of [tls, hints]) {
        const on = (await sw.getAttribute("aria-checked")) === "true";
        const knob = sw.locator("[data-knob]");
        expect(await border(sw)).toEqual({ style: "solid", width: 1 });
        expect(await bg(knob)).toBe(await sys(page, on ? "HighlightText" : "ButtonText"));
        if (on) expect(await bg(sw)).toBe(highlight);
      }
      const swatches = prefs.getByRole("radiogroup", { name: "Color for prod-aks" });
      expect(await border(swatches.getByRole("radio", { checked: false }).first())).toEqual({
        style: "solid",
        width: 1,
      });
      expect(await bg(swatches.getByRole("radio", { checked: true }))).toBe(highlight);

      // A disabled control is grey text, whatever its role colour was. The browser
      // does this for a native disabled control; this checks no rule above undoes it.
      expect(await fg(prefs.getByRole("button", { name: "Move On-call up" }))).toBe(await sys(page, "GrayText"));
    });

    test(`${theme} app on a ${scheme} system palette: cards keep an edge`, async ({ page }) => {
      await page.emulateMedia({ forcedColors: "active", colorScheme: scheme });
      await boot(page, theme);
      await eachCard(page, async (name, el) => {
        expect((await edge(el)).style, name).toBe("solid");
      });
    });
  }
});

/** Every element of the page that animates or has a transition, by a short description. */
async function moving(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    // A transition runs only for a property it names and with a duration above zero.
    const list = (v: string) => v.split(",").map((x) => x.trim());
    const busy = (s: CSSStyleDeclaration) => {
      const props = list(s.transitionProperty);
      const times = list(s.transitionDuration).map(parseFloat);
      const transition = props.some((p, i) => p !== "none" && times[i % times.length] > 0);
      return transition || list(s.animationName).some((n) => n !== "none");
    };
    const out: string[] = [];
    for (const el of document.querySelectorAll("*")) {
      for (const pseudo of [null, "::before", "::after"]) {
        const s = getComputedStyle(el, pseudo);
        if (busy(s)) out.push(`${el.tagName.toLowerCase()}${pseudo ?? ""}.${String(el.getAttribute("class")).slice(0, 60)}`);
      }
    }
    return out;
  });
}

test.describe("reduced motion (prefers-reduced-motion: reduce)", () => {
  test("nothing moves: placeholders, overlays, panel, toasts, spinners, chevrons and the tint", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await boot(page);
    expect(await moving(page), "overview").toEqual([]);

    // Placeholder rows while a list loads: still, not pulsing.
    await page.evaluate(() => ((window as unknown as HangWindow).__hang = ["list_pods"]));
    await page.getByRole("complementary").getByText("Pods", { exact: true }).click();
    await page.getByRole("button", { name: /^Namespace/ }).click();
    await page.getByRole("menuitemradio", { name: /kube-system/ }).click();
    await expect(page.locator("[data-placeholder]").first()).toBeVisible();
    expect(await moving(page), "loading list").toEqual([]);

    // A section opened in the sidebar (its chevron turns), the cluster menu and a toast.
    await page.getByRole("complementary").getByRole("button", { name: /Workloads/ }).click();
    await page.getByRole("button", { name: /^prod-aks AKS/ }).click();
    await page.getByRole("menuitem", { name: "Copy server address" }).click();
    await expect(page.getByRole("status").locator("[data-tone]").first()).toBeVisible();
    expect(await moving(page), "menu and toast").toEqual([]);

    await page.getByRole("button", { name: /Search & switch/ }).click();
    await expect(page.getByTestId("command-palette")).toBeVisible();
    expect(await moving(page), "palette").toEqual([]);
    await page.keyboard.press("Escape");

    await page.getByLabel("Preferences").click();
    await expect(page.getByRole("dialog", { name: "Preferences" })).toBeVisible();
    expect(await moving(page), "preferences").toEqual([]);
  });

  test("the detail panel, the log panel and a cluster switch do not move", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.addInitScript(tauriMockScript());
    await page.addInitScript(() => window.localStorage.setItem("cubelite.onboardingSeen", "true"));
    await page.goto("/");
    await podsWithPanel(page);
    await page.getByRole("button", { name: "Open logs" }).click();
    await expect(page.getByLabel("Pod logs panel")).toBeVisible();
    expect(await moving(page), "panel overlaid, log panel open").toEqual([]);
    await page.getByRole("list", { name: "Contexts" }).getByRole("button", { name: /^staging,/ }).click();
    expect(await moving(page), "cluster switch").toEqual([]);
  });

  test("a spinner stops and keeps its word", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.addInitScript(() =>
      window.localStorage.setItem(
        "cubelite.prometheus.endpoints",
        JSON.stringify({
          "prod-aks": {
            target: { kind: "in-cluster", namespace: "monitoring", service: "prometheus-operated", port: 9090, https: false },
            cluster: null,
            grafanaDatasource: null,
            grafanaUrl: null,
            skipTlsVerify: false,
          },
        }),
      ),
    );
    await boot(page, "dark", ["apply_resource_yaml", "prometheus_metrics"]);
    const panel = await podsWithPanel(page);

    // Loading metrics: a still circle and the words, which are otherwise read out only.
    const section = panel.getByTestId("metrics-section");
    await section.scrollIntoViewIfNeeded();
    await expect(section.getByText("Loading metrics", { exact: true })).toBeVisible();

    // A pending button with no icon of its own keeps its label in view.
    await panel.getByRole("button", { name: "YAML" }).click();
    const yaml = page.getByRole("dialog", { name: "api-0.yaml" });
    await yaml.getByRole("button", { name: "Edit" }).click();
    const apply = yaml.getByRole("button", { name: "Apply" });
    await apply.click();
    await expect(apply).toHaveAttribute("aria-busy", "true");
    const label = apply.getByText("Apply");
    expect(Number(await label.evaluate((el) => getComputedStyle(el).opacity))).toBeGreaterThan(0.4);
    expect(await moving(page), "pending").toEqual([]);
  });

  test("with motion allowed, the spinner turns and the label gives way to it", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await boot(page, "dark", ["apply_resource_yaml"]);
    const panel = await podsWithPanel(page);
    await panel.getByRole("button", { name: "YAML" }).click();
    const yaml = page.getByRole("dialog", { name: "api-0.yaml" });
    await yaml.getByRole("button", { name: "Edit" }).click();
    const apply = yaml.getByRole("button", { name: "Apply" });
    await apply.click();
    await expect(apply).toHaveAttribute("aria-busy", "true");
    expect(await apply.getByText("Apply").evaluate((el) => getComputedStyle(el).opacity)).toBe("0");
    expect(await apply.locator("svg").evaluate((el) => getComputedStyle(el).animationName)).toBe("spin");
  });
});

/** WCAG contrast of two CSS colours as the browser paints them (oklch, color-mix…). */
async function contrast(page: Page, a: string, b: string): Promise<number> {
  return page.evaluate(
    ([x, y]) => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
      const lum = (c: string) => {
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = c;
        ctx.fillRect(0, 0, 1, 1);
        const [r, g, bl] = [...ctx.getImageData(0, 0, 1, 1).data].map((v) =>
          v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4,
        );
        return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
      };
      const [hi, lo] = [lum(x), lum(y)].sort((p, q) => q - p);
      return (hi + 0.05) / (lo + 0.05);
    },
    [a, b] as const,
  );
}

/** The colour of an element's inset ring (an inset box-shadow with a spread, no blur). */
const ring = (el: Locator) =>
  el.evaluate((n) => {
    const shadows = getComputedStyle(n).boxShadow.split(/,(?![^(]*\))/);
    const drawn = shadows.find((sh) => /inset/.test(sh) && /\s0px\s0px\s0px\s[1-9][\d.]*px/.test(sh));
    return drawn?.match(/^\s*(\w+\([^)]*\)|#\w+|\w+)/)?.[1] ?? "transparent";
  });
/** The colour of an element's top border; transparent when it has none. */
const borderColour = (el: Locator) =>
  el.evaluate((n) => {
    const s = getComputedStyle(n);
    return parseFloat(s.borderTopWidth) >= 1 && s.borderTopStyle !== "none" ? s.borderTopColor : "transparent";
  });

test.describe("non-text contrast (WCAG 1.4.11) of the controls the token matrix cannot see", () => {
  for (const theme of THEMES) {
    test(`${theme}: a pressed chip's ring and a meter track's edge reach 3:1`, async ({ page }) => {
      await boot(page, theme);
      const panel = await podsWithPanel(page);
      const card = await bg(page.locator("main"));
      const chips = page.getByRole("group", { name: "Filter by status" });
      for (const name of [/Running/, /Pending/]) {
        const chip = chips.getByRole("button", { name });
        await chip.click();
        await expect(chip).toHaveAttribute("aria-pressed", "true");
        const edge = await ring(chip);
        expect(edge, `${name} has a ring`).not.toBe("transparent");
        expect(await contrast(page, edge, await bg(chip)), `${name} ring on its fill`).toBeGreaterThanOrEqual(3);
        expect(await contrast(page, edge, card), `${name} ring on the card`).toBeGreaterThanOrEqual(3);
        await chip.click();
      }

      // A meter track on the panel's card (no metrics: an empty track) and on a dashboard card.
      const track = panel.locator("[data-meter-track]").first();
      const panelCard = await bg(track.locator("xpath=ancestor::*[contains(@class,'card')][1]"));
      expect(await borderColour(track)).not.toBe("transparent");
      expect(await contrast(page, await borderColour(track), panelCard)).toBeGreaterThanOrEqual(3);
      await page.getByRole("button", { name: "All Clusters" }).click();
      const dashTrack = page.locator("[data-meter-track]").first();
      await expect(dashTrack).toBeVisible();
      const dashCard = await bg(dashTrack.locator("xpath=ancestor::*[contains(@class,'card')][1]"));
      expect(await borderColour(dashTrack)).not.toBe("transparent");
      expect(await contrast(page, await borderColour(dashTrack), dashCard)).toBeGreaterThanOrEqual(3);
    });
  }
});

/**
 * Presses Tab up to `max` times, or until the focus comes back to an element it
 * has already visited, and returns how many elements inside `scope` took the
 * focus and those that showed no visible ring: a solid outline of 2 px or more,
 * on the element or, for a list row, on its ::after (drawn above the sticky cell).
 */
async function tabWalk(page: Page, scope: string, max = 80): Promise<{ visited: number; missing: string[] }> {
  const missing: string[] = [];
  let visited = 0;
  for (let i = 0; i < max; i++) {
    await page.keyboard.press("Tab");
    const r = await page.evaluate((sel) => {
      const el = document.activeElement as HTMLElement | null;
      const root = document.querySelector(sel);
      if (!el || !root || !root.contains(el) || el === document.body) return { inside: false, again: false, name: "", ok: true };
      const again = el.dataset.walked === "true";
      el.dataset.walked = "true";
      const ring = (s: CSSStyleDeclaration) =>
        s.outlineStyle !== "none" && parseFloat(s.outlineWidth) >= 2 && s.outlineColor !== "rgba(0, 0, 0, 0)";
      const ok = ring(getComputedStyle(el)) || ring(getComputedStyle(el, "::after"));
      const name =
        el.getAttribute("aria-label") ??
        el.getAttribute("placeholder") ??
        (el.textContent?.trim().slice(0, 40) || el.tagName.toLowerCase());
      return { inside: true, again, name: `${el.tagName.toLowerCase()} "${name}"`, ok };
    }, scope);
    if (!r.inside) continue;
    if (r.again) break;
    visited++;
    if (!r.ok) missing.push(r.name);
  }
  return { visited, missing };
}

test.describe("focus: every control shows the ring from the keyboard", () => {
  test("shell, list, detail panel and log panel", async ({ page }) => {
    await boot(page);
    await page.getByRole("complementary").getByText("Pods", { exact: true }).click();
    await page.getByText("api-0", { exact: true }).click();
    await page.getByRole("button", { name: "Open logs" }).click();
    await expect(page.getByLabel("Pod logs panel")).toBeVisible();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    const walk = await tabWalk(page, "body", 200);
    // The rail, the sidebar, the top bar, the list, the panel and the log toolbar.
    expect(walk.visited).toBeGreaterThan(40);
    expect(walk.missing).toEqual([]);
  });

  test("Preferences, the palette and a dialog", async ({ page }) => {
    await boot(page);
    await page.getByLabel("Preferences").click();
    const prefs = await tabWalk(page, '[role="dialog"][aria-label="Preferences"]', 150);
    expect(prefs.visited).toBeGreaterThan(20);
    expect(prefs.missing, "preferences").toEqual([]);
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: /Search & switch/ }).click();
    expect((await tabWalk(page, '[data-testid="command-palette"]', 10)).missing, "palette").toEqual([]);
    await page.keyboard.press("Escape");

    const panel = await podsWithPanel(page);
    await panel.getByRole("button", { name: "YAML" }).click();
    expect((await tabWalk(page, '[role="dialog"][aria-label="api-0.yaml"]', 10)).missing, "yaml").toEqual([]);
    await page.keyboard.press("Escape");
    await panel.getByRole("button", { name: "Delete" }).click();
    expect((await tabWalk(page, '[role="dialog"][aria-label="Delete Pod"]', 10)).missing, "delete").toEqual([]);
  });
});
