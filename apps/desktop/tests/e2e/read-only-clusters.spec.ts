import { type Locator, type Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { FIXTURES, tauriMockScript } from "./tauri-mock";

// Read-only clusters (#662, spec §4, §5, §6.1–6.3, §8): a Production context
// starts read-only, its write controls stay in view and say why, it is made
// writable for a while from the cluster menu (after a confirmation that can be
// turned off) and read-only again; Preferences → Clusters shows the access.

const CONTEXTS = [
  { ...FIXTURES.contexts[0], name: "aks-prod-01-emm", is_active: true },
  { ...FIXTURES.contexts[1], name: "minikube", is_active: false },
];
const REASON = "aks-prod-01-emm is read-only";

async function boot(page: Page, theme: "dark" | "light" = "dark") {
  await page.setViewportSize({ width: 1440, height: 900 });
  // No access recorded: both contexts go through first sight.
  await page.addInitScript(tauriMockScript({ contexts: CONTEXTS, clusterAccess: {} }));
  await page.addInitScript((t) => {
    window.localStorage.setItem("cubelite.onboardingSeen", "true");
    window.localStorage.setItem("cubelite.theme", JSON.stringify(t));
  }, theme);
  await page.goto("/");
}

const header = (page: Page) => page.locator("header").first();
const chip = (page: Page) => header(page).getByRole("button", { name: /^aks-prod-01-emm/ });
const access = (page: Page) => header(page).getByTestId("access-state");
const rail = (page: Page) => page.getByRole("navigation", { name: "Clusters" });
const railBadge = (page: Page) =>
  rail(page).getByRole("button", { name: /^aks-prod-01-emm,/ }).getByTestId("access-badge");

async function openDeployment(page: Page): Promise<Locator> {
  await page.getByRole("complementary").getByText("Deployments", { exact: true }).click();
  await page.getByRole("button", { name: /^api\b/ }).first().click();
  const panel = page.getByRole("dialog", { name: "api" });
  await expect(panel).toBeVisible();
  return panel;
}

async function openPod(page: Page): Promise<Locator> {
  await page.getByRole("complementary").getByText("Pods", { exact: true }).click();
  await page.getByText("api-0").click();
  const panel = page.getByRole("dialog", { name: "api-0" });
  await expect(panel).toBeVisible();
  return panel;
}

/** Choose a duration from the chip's "Make writable for" submenu. */
async function unlockFromChip(page: Page, duration: string) {
  await chip(page).click();
  await page.getByRole("menuitem", { name: "Make writable for" }).click();
  await page.getByRole("menuitem", { name: duration, exact: true }).click();
}

async function expectBlocked(control: Locator) {
  await expect(control).toHaveAttribute("aria-disabled", "true");
  // Not natively disabled (Playwright counts aria-disabled as disabled).
  await expect(control).not.toHaveAttribute("disabled");
  await expect(control).toHaveAttribute("title", REASON);
  await expect(control).toHaveAccessibleDescription(REASON);
}

test("a Production cluster starts read-only: chip, rail badge, and the write controls say why", async ({ page }) => {
  await boot(page);
  await expect(access(page)).toHaveAttribute("data-access", "read_only");
  await expect(access(page)).toHaveText("Read-only");
  await expect(railBadge(page)).toHaveAttribute("data-access", "read_only");
  await expect(rail(page).getByTitle("aks-prod-01-emm · Production · Read-only")).toBeAttached();
  // minikube has no environment word: writable, no badge.
  await expect(rail(page).getByRole("button", { name: /^minikube,/ }).getByTestId("access-badge")).toHaveCount(0);

  const panel = await openDeployment(page);
  await expect(panel.getByTestId("read-only-notice")).toHaveText(/aks-prod-01-emm is read-only\s*Make writable/);
  for (const name of ["Scale up", "Scale down", "Rollout Restart", "Adjust"]) {
    await expectBlocked(panel.getByRole("button", { name }));
  }
  // Reading stays: Logs and YAML.
  await expect(panel.getByRole("button", { name: "YAML" })).not.toHaveAttribute("aria-disabled");
  await expect(panel.getByRole("button", { name: "Logs" })).not.toHaveAttribute("aria-disabled");

  // A press does nothing (forced: Playwright will not press an aria-disabled
  // control): nothing held for the debounce, and after it no toast.
  await panel.getByRole("button", { name: "Scale up" }).click({ force: true });
  await page.waitForTimeout(1_000);
  await expect(panel.locator("[data-pending='true']")).toHaveCount(0);
  await expect(page.getByText(/scaled to/)).toHaveCount(0);
});

test("unlock for 5 minutes with the confirmation, scale, then read-only again", async ({ page }) => {
  await boot(page);
  const panel = await openDeployment(page);

  await unlockFromChip(page, "5 minutes");
  const dialog = page.getByRole("dialog", { name: "Make aks-prod-01-emm writable?" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Production · for 5 minutes");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await dialog.getByRole("button", { name: "Make writable" }).click();
  await expect(dialog).toHaveCount(0);

  await expect(access(page)).toHaveAttribute("data-access", "timed");
  await expect(access(page)).toHaveText(/Writable · 5 min/);
  await expect(railBadge(page)).toHaveAttribute("data-access", "timed");
  await expect(panel.getByTestId("read-only-notice")).toHaveCount(0);

  const up = panel.getByRole("button", { name: "Scale up" });
  await expect(up).not.toHaveAttribute("aria-disabled");
  await up.click();
  await expect(page.getByText("api scaled to 3")).toBeVisible();

  await chip(page).click();
  await page.getByRole("menuitem", { name: "Make read-only" }).click();
  await expect(access(page)).toHaveText("Read-only");
  await expectBlocked(panel.getByRole("button", { name: "Scale up" }));
  await expect(panel.getByTestId("read-only-notice")).toBeVisible();
});

test("when the unlock ends the cluster reads read-only again, everywhere", async ({ page }) => {
  await page.clock.install();
  await boot(page);
  const panel = await openDeployment(page);
  await unlockFromChip(page, "5 minutes");
  await page
    .getByRole("dialog", { name: "Make aks-prod-01-emm writable?" })
    .getByRole("button", { name: "Make writable" })
    .click();
  await expect(access(page)).toHaveText(/Writable · 5 min/);
  await page.clock.fastForward("04:30");
  await expect(access(page)).toHaveText(/Writable · \d+ s/);
  await page.clock.fastForward("00:31");
  await expect(access(page)).toHaveText("Read-only");
  await expect(railBadge(page)).toHaveAttribute("data-access", "read_only");
  await expectBlocked(panel.getByRole("button", { name: "Scale up" }));
  await expect(panel.getByTestId("read-only-notice")).toBeVisible();
});

test("the drawer notice's Make writable offers the durations and unlocks", async ({ page }) => {
  await boot(page);
  const panel = await openPod(page);
  await panel.getByTestId("read-only-notice").getByRole("button", { name: "Make writable" }).click();
  await expect(page.getByRole("menuitem")).toHaveText(["5 minutes", "15 minutes", "1 hour", "Always"]);
  await page.getByRole("menuitem", { name: "Always" }).click();
  const dialog = page.getByRole("dialog", { name: "Make aks-prod-01-emm writable?" });
  await expect(dialog).toContainText("It stays writable until you make it read-only.");
  await dialog.getByRole("button", { name: "Make writable" }).click();
  // Always is the normal state of a writable cluster: nothing shown.
  await expect(access(page)).toHaveCount(0);
  await expect(panel.getByTestId("read-only-notice")).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Restart" })).not.toHaveAttribute("aria-disabled");
});

test("Don't ask again: the next unlock opens no confirmation", async ({ page }) => {
  await boot(page);
  await unlockFromChip(page, "15 minutes");
  const dialog = page.getByRole("dialog", { name: "Make aks-prod-01-emm writable?" });
  await dialog.getByRole("checkbox", { name: "Don't ask again" }).check();
  await dialog.getByRole("button", { name: "Make writable" }).click();
  await expect(access(page)).toHaveText(/Writable · 15 min/);

  await chip(page).click();
  await page.getByRole("menuitem", { name: "Make read-only" }).click();
  await expect(access(page)).toHaveText("Read-only");

  await unlockFromChip(page, "5 minutes");
  await expect(access(page)).toHaveText(/Writable · 5 min/);
  await expect(page.getByRole("dialog", { name: /writable\?$/ })).toHaveCount(0);
});

test("the backend refuses a write to a read-only cluster, and the app says why in words", async ({ page }) => {
  await boot(page);
  await openDeployment(page);
  // A write that got past the interface: the mock refuses it as the guard does.
  const refusal = await page.evaluate(async () => {
    try {
      const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a: unknown) => Promise<unknown> } })
        .__TAURI_INTERNALS__;
      await internals.invoke("scale_deployment", {
        kubeconfigPath: "/home/test/.kube/config",
        namespace: "default",
        name: "api",
        replicas: 3,
        context: "aks-prod-01-emm",
      });
      return null;
    } catch (e) {
      return e;
    }
  });
  expect(refusal).toEqual({
    kind: "read_only",
    context: "aks-prod-01-emm",
    message: "aks-prod-01-emm is read-only. Make it writable from the cluster menu.",
  });
});

test("keyboard: Tab reaches the disabled Shell and Restart, each described by the reason", async ({ page }) => {
  await boot(page);
  const panel = await openPod(page);
  await panel.getByRole("button", { name: "Open logs" }).focus();
  await page.keyboard.press("Tab");
  const shell = panel.getByRole("button", { name: "Shell" });
  await expect(shell).toBeFocused();
  await expect(shell).toHaveAccessibleDescription(REASON);
  await page.keyboard.press("Tab");
  await expect(panel.getByRole("button", { name: "YAML" })).toBeFocused();
  await page.keyboard.press("Tab");
  const restart = panel.getByRole("button", { name: "Restart" });
  await expect(restart).toBeFocused();
  await expect(restart).toHaveAttribute("aria-disabled", "true");
  await expect(restart).toHaveAccessibleDescription(REASON);
  // Enter on it does nothing: the pod stays, no shell, no toast.
  await page.keyboard.press("Enter");
  await shell.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "api-0 shell" })).toHaveCount(0);
  await expect(page.getByText(/Pod api-0 deleted/)).toHaveCount(0);

  // The confirmation gives the focus back to what opened it: the notice's
  // button, whose menu has closed with the choice.
  const notice = panel.getByTestId("read-only-notice").getByRole("button", { name: "Make writable" });
  await notice.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menuitem", { name: "5 minutes", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Make aks-prod-01-emm writable?" });
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(notice).toBeFocused();
  // Made writable, the notice and its button go: the focus lands on the cluster chip.
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menuitem", { name: "5 minutes", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Make writable" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(access(page)).toHaveAttribute("data-access", "timed");
  await expect(chip(page)).toBeFocused();
});

test("Preferences → Clusters shows each context's access and the two switches", async ({ page }) => {
  await boot(page);
  await page.getByRole("button", { name: "Preferences" }).click();
  const section = page.getByRole("region", { name: "Clusters" });
  await section.scrollIntoViewIfNeeded();
  const table = section.getByRole("table", { name: "Cluster environments" });
  await expect(table.getByRole("columnheader", { name: "Access" })).toBeVisible();
  const row = (name: string) => table.getByRole("row").filter({ hasText: name });
  await expect(row("aks-prod-01-emm").getByTestId("access-state")).toHaveText("Read-only");
  await expect(row("minikube").getByTestId("access-state")).toHaveText("Writable");
  await expect(row("aks-prod-01-emm").getByRole("button", { name: "Make writable: aks-prod-01-emm" })).toBeVisible();
  await expect(row("minikube").getByRole("button", { name: "Make read-only: minikube" })).toBeVisible();

  await expect(section.getByRole("switch", { name: "Ask before making a cluster writable" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  const start = section.getByRole("group", { name: "Read-only from the start" });
  await expect(start.getByRole("checkbox", { name: "Production" })).toBeChecked();
  await expect(start.getByRole("checkbox", { name: "Test" })).not.toBeChecked();

  // Made read-only from here, the chip follows.
  await row("minikube").getByRole("button", { name: "Make read-only: minikube" }).click();
  await expect(row("minikube").getByTestId("access-state")).toHaveText("Read-only");
});

test("the confirmation opened from Preferences stacks above it: Preferences is dimmed and out of reach", async ({ page }) => {
  await boot(page);
  await page.getByRole("button", { name: "Preferences" }).click();
  const prefs = page.getByRole("dialog", { name: "Preferences" });
  const section = prefs.getByRole("region", { name: "Clusters" });
  await section.scrollIntoViewIfNeeded();
  const unlock = section.getByRole("button", { name: "Make writable: aks-prod-01-emm" });
  await unlock.click();
  await page.getByRole("menuitem", { name: "5 minutes", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Make aks-prod-01-emm writable?" });
  await expect(dialog).toBeVisible();
  // Settled: the menu's exit and the dialog's entrance are over.
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"));

  // Preferences' own close button, away from the confirmation's card: what the
  // pointer meets there is the confirmation's backdrop.
  const close = prefs.getByRole("button", { name: "Close" });
  const box = (await close.boundingBox())!;
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const hit = await page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    const paint = el ? getComputedStyle(el).backgroundColor : "";
    return {
      inPreferences: el?.closest('[aria-label="Preferences"]') !== null,
      // The confirmation's backdrop, one level above Preferences'.
      role: el?.getAttribute("role") ?? null,
      depth: el?.getAttribute("data-modal-depth") ?? null,
      dimmed: paint !== "" && paint !== "transparent" && paint !== "rgba(0, 0, 0, 0)",
      // Named on a failure: what was there instead.
      html: el?.outerHTML.slice(0, 200),
    };
  }, at);
  expect(hit).toMatchObject({ inPreferences: false, role: "presentation", depth: "1", dimmed: true });

  // A click there reaches the backdrop only: the confirmation is cancelled,
  // Preferences stays open, and the focus goes back to the row's button.
  await page.mouse.click(at.x, at.y);
  await expect(dialog).toHaveCount(0);
  await expect(prefs).toBeVisible();
  await expect(unlock).toBeFocused();
  await expect(section.getByRole("table").getByRole("row").filter({ hasText: "aks-prod-01-emm" }).getByTestId("access-state")).toHaveText(
    "Read-only",
  );
});

// --- How the chip, the rail badge and the drawer line read in each theme and
// system setting.

/** WCAG contrast of two CSS colours as the browser paints them. */
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

/** The text colour of `el` and the first opaque background behind it. */
const paint = (el: Locator) =>
  el.evaluate((n) => {
    let at: Element | null = n;
    let back = "rgba(0, 0, 0, 0)";
    while (at) {
      const c = getComputedStyle(at).backgroundColor;
      if (c !== "rgba(0, 0, 0, 0)" && c !== "transparent") {
        back = c;
        break;
      }
      at = at.parentElement;
    }
    return { text: getComputedStyle(n).color, back };
  });

/** What `value` resolves to inside `scope`. */
const resolvedIn = (scope: Locator, value: string) =>
  scope.evaluate((el, v) => {
    const probe = document.createElement("span");
    probe.style.color = v;
    el.append(probe);
    const out = getComputedStyle(probe).color;
    probe.remove();
    return out;
  }, value);

async function readable(page: Page, el: Locator, name: string, least: number) {
  await expect(el, name).toBeVisible();
  const { text, back } = await paint(el);
  expect(await contrast(page, text, back), `${name}: ${text} on ${back}`).toBeGreaterThanOrEqual(least);
}

for (const theme of ["dark", "light"] as const) {
  test(`${theme}: the chip, the rail badge and the drawer line can be read`, async ({ page }) => {
    await boot(page, theme);
    const panel = await openDeployment(page);
    await readable(page, access(page).getByText("Read-only"), "Read-only", 4.5);
    await readable(page, railBadge(page), "lock badge", 3);
    const line = panel.getByTestId("read-only-notice");
    await readable(page, line.getByText(REASON), "drawer line", 4.5);
    // Read-only is a muted mark, not a state colour.
    expect((await paint(access(page))).text).toBe(await resolvedIn(header(page), "var(--color-text-muted)"));

    await unlockFromChip(page, "5 minutes");
    await page.getByRole("dialog", { name: "Make aks-prod-01-emm writable?" }).getByRole("button", { name: "Make writable" }).click();
    await expect(access(page)).toHaveText(/Writable · 5 min/);
    // Writable for a while: on-warning-container on warning-container.
    await readable(page, access(page), "Writable · 5 min", 4.5);
    expect((await paint(access(page))).back).toBe(
      await access(page).evaluate((n) => {
        const probe = document.createElement("span");
        probe.style.backgroundColor = "var(--color-warning-container)";
        n.append(probe);
        const out = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return out;
      }),
    );
    await readable(page, railBadge(page), "timer badge", 3);
  });
}

test("more contrast: the chip, the badge and the drawer line keep the muted role, readable", async ({ page }) => {
  await page.emulateMedia({ contrast: "more" });
  await boot(page);
  const panel = await openDeployment(page);
  const muted = await resolvedIn(page.locator("body"), "var(--color-text-muted)");
  for (const [name, el] of [
    ["chip", access(page)],
    ["badge", railBadge(page)],
    ["drawer line", panel.getByTestId("read-only-notice").getByText(REASON)],
  ] as const) {
    expect((await paint(el)).text, name).toBe(muted);
    await readable(page, el, name, name === "badge" ? 3 : 4.5);
  }
});

test("forced colours: the badges keep an edge, and every mark takes the text's system colour", async ({ page }) => {
  await page.emulateMedia({ forcedColors: "active", colorScheme: "dark" });
  await boot(page);
  const panel = await openDeployment(page);
  const edged = (el: Locator) =>
    el.evaluate((n) => {
      const s = getComputedStyle(n);
      return { style: s.borderTopStyle, width: parseFloat(s.borderTopWidth) };
    });
  const badge = await edged(railBadge(page));
  expect(badge.style).toBe("solid");
  expect(badge.width).toBeGreaterThanOrEqual(1);
  // The lock follows its text, not an authored colour.
  const lock = access(page).locator("svg");
  expect(await lock.evaluate((n) => getComputedStyle(n).color)).toBe(
    await access(page).evaluate((n) => getComputedStyle(n).color),
  );
  const line = panel.getByTestId("read-only-notice");
  await expect(line.getByText(REASON)).toBeVisible();
  // The way out is a text button: it gets a system-colour edge.
  const out = await line
    .getByRole("button", { name: "Make writable" })
    .evaluate((n) => getComputedStyle(n).outlineStyle);
  expect(out).toBe("solid");

  await unlockFromChip(page, "5 minutes");
  await page.getByRole("dialog", { name: "Make aks-prod-01-emm writable?" }).getByRole("button", { name: "Make writable" }).click();
  await expect(access(page)).toHaveText(/Writable · 5 min/);
  const timed = await edged(access(page));
  expect(timed.style).toBe("solid");
  expect(timed.width).toBeGreaterThanOrEqual(1);
});
