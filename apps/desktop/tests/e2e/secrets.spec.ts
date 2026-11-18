// Secret values stay in the backend until one is asked for (#661): the view
// reads one value per Reveal and drops it after the time set in Preferences;
// Copy and the .env download go through the backend, which never sends the
// value to the page.
import { type Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { FIXTURES, SECRETS, SECRET_VALUES, tauriMockScript } from "./tauri-mock";
import type { SecretInfo } from "../../src/lib/tauri.ts";

/** The Secrets list, in the sidebar's Config section. */
async function openSecrets(page: Page) {
  const aside = page.getByRole("complementary");
  const secrets = aside.getByText("Secrets", { exact: true });
  if (!(await secrets.isVisible())) await aside.getByRole("button", { name: /^Config \d+$/ }).click();
  await secrets.click();
}

async function boot(page: Page, hideAfter = 15, overrides: Partial<typeof FIXTURES> = {}) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.clock.install();
  await page.addInitScript(tauriMockScript({ secrets: SECRETS, ...overrides }));
  await page.addInitScript((seconds) => {
    window.localStorage.setItem("cubelite.onboardingSeen", "true");
    window.localStorage.setItem("cubelite.theme", '"dark"');
    window.localStorage.setItem("cubelite.secretHideAfter", JSON.stringify(seconds));
  }, hideAfter);
  await page.goto("/");
  await openSecrets(page);
  const keys = page.getByRole("group", { name: "Keys of api-credentials" });
  await expect(keys).toBeVisible();
  return keys;
}

const reveals = (page: Page) => page.evaluate(() => window.__secretReveals ?? []);
const copies = (page: Page) => page.evaluate(() => window.__secretCopies ?? []);
const exports = (page: Page) => page.evaluate(() => window.__secretExports ?? []);

/** No value of SECRET_VALUES is anywhere in the page. */
async function noValueInPage(page: Page) {
  for (const value of Object.values(SECRET_VALUES)) await expect(page.locator("body")).not.toContainText(value);
}

test("reveal one key: one read, for that key, and the value hides after the time", async ({ page }) => {
  const keys = await boot(page, 15);
  await expect(page.getByText("a value is read only when you reveal or copy it")).toBeVisible();
  // Nothing was read to draw the list.
  expect(await reveals(page)).toEqual([]);
  for (const value of Object.values(SECRET_VALUES)) await expect(page.locator("body")).not.toContainText(value);

  await keys.getByRole("button", { name: "Reveal DB_PASSWORD" }).click();
  const password = SECRET_VALUES["default/api-credentials/DB_PASSWORD"];
  await expect(keys.getByText(password)).toBeVisible();
  expect(await reveals(page)).toEqual([
    { kubeconfigPath: expect.any(String), namespace: "default", name: "api-credentials", key: "DB_PASSWORD", context: "prod-aks" },
  ]);
  for (const [id, value] of Object.entries(SECRET_VALUES)) {
    if (!id.endsWith("/DB_PASSWORD")) await expect(page.locator("body")).not.toContainText(value);
  }
  await expect(page.getByTestId("secret-status")).toHaveText("DB_PASSWORD shown");

  await page.clock.runFor(14_000);
  await expect(keys.getByText(password)).toBeVisible();
  await page.clock.runFor(1_000);
  await expect(page.locator("body")).not.toContainText(password);
  await expect(keys.getByRole("button", { name: "Reveal DB_PASSWORD" })).toBeVisible();
  await expect(page.getByTestId("secret-status")).toHaveText("DB_PASSWORD hidden");
});

test("binary, Helm and every key's row read as the spec says", async ({ page }) => {
  const keys = await boot(page);
  const crt = keys.locator('[data-key-row="ca.crt"]');
  await expect(crt).toContainText("1.8 KiB");
  await expect(crt).toContainText("binary");
  const helm = page.getByRole("group", { name: "Keys of sh.helm.release.v1.api.v7" });
  const release = helm.locator('[data-key-row="release"]');
  await expect(release).toContainText("release");
  await expect(release).toContainText("48.2 KiB");
  await expect(release).toContainText("Helm release payload, shown in Helm");
  await expect(helm.getByRole("button")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Download sh.helm.release.v1.api.v7 as .env" })).toHaveCount(0);
  // A binary value: no Reveal, Copy base64.
  await expect(crt.getByRole("button")).toHaveCount(1);
  await expect(crt.getByRole("button", { name: "Copy ca.crt as base64" })).toHaveText("Copy base64");
});

test("keyboard: the Secret's .env, then per key Reveal and Copy, each with its ring; Enter keeps the focus on the button", async ({ page }) => {
  const keys = await boot(page);
  const first = page.getByRole("button", { name: "Download api-credentials as .env" });
  await page.keyboard.press("Shift");
  await first.focus();
  const order: string[] = [];
  for (let i = 0; i < 11; i++) {
    const focused = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement;
      const s = getComputedStyle(el);
      return {
        name: el.getAttribute("aria-label") ?? "",
        ring: s.outlineStyle !== "none" && parseFloat(s.outlineWidth) >= 2 && el.matches(":focus-visible"),
      };
    });
    expect(focused.ring, focused.name).toBe(true);
    order.push(focused.name);
    await page.keyboard.press("Tab");
  }
  // The binary ca.crt has Copy only; the next Secret's .env comes before its key.
  expect(order).toEqual([
    "Download api-credentials as .env",
    "Reveal API_KEY",
    "Copy API_KEY",
    "Reveal DB_PASSWORD",
    "Copy DB_PASSWORD",
    "Reveal DB_USER",
    "Copy DB_USER",
    "Copy ca.crt as base64",
    "Download registry-pull as .env",
    "Reveal .dockerconfigjson",
    "Copy .dockerconfigjson",
  ]);

  const password = keys.getByRole("button", { name: "Reveal DB_PASSWORD" });
  await password.focus();
  await page.keyboard.press("Enter");
  const hide = keys.getByRole("button", { name: "Hide DB_PASSWORD" });
  await expect(hide).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(keys.getByRole("button", { name: "Reveal DB_PASSWORD" })).toBeFocused();
  await expect(page.locator("body")).not.toContainText(SECRET_VALUES["default/api-credentials/DB_PASSWORD"]);

  // Copy with Enter: the button says Copied, keeps the focus, and says Copy again after 2 s.
  await keys.getByRole("button", { name: "Copy DB_USER" }).focus();
  await page.keyboard.press("Enter");
  await expect(keys.getByRole("button", { name: "Copied DB_USER" })).toBeFocused();
  await page.clock.runFor(2_000);
  await expect(keys.getByRole("button", { name: "Copy DB_USER" })).toBeFocused();
});

test("copy: one call, for that key, with the time from Preferences; no value reaches the page", async ({ page }) => {
  const keys = await boot(page, 15);
  const revealAt = async () => (await keys.getByRole("button", { name: "Reveal DB_PASSWORD" }).boundingBox())!.x;
  const before = await revealAt();
  await keys.getByRole("button", { name: "Copy DB_PASSWORD" }).click();
  await expect(keys.getByRole("button", { name: "Copied DB_PASSWORD" })).toHaveText("Copied");
  // "Copied" takes no more room than "Copy": Reveal does not move.
  expect(await revealAt()).toBe(before);
  expect(await copies(page)).toEqual([
    {
      kubeconfigPath: expect.any(String),
      namespace: "default",
      name: "api-credentials",
      key: "DB_PASSWORD",
      clearAfterSecs: 15,
      context: "prod-aks",
    },
  ]);
  await expect(page.getByTestId("secret-status")).toHaveText(
    "DB_PASSWORD copied, the clipboard is cleared in 15 seconds",
  );
  // Copy neither reads for the page nor reveals.
  expect(await reveals(page)).toEqual([]);
  await expect(keys.getByRole("button", { name: "Reveal DB_PASSWORD" })).toBeVisible();
  await noValueInPage(page);

  await keys.getByRole("button", { name: "Copy ca.crt as base64" }).click();
  await expect(keys.getByRole("button", { name: "Copied ca.crt as base64" })).toBeVisible();
  await expect(page.getByTestId("secret-status")).toHaveText("ca.crt copied, the clipboard is cleared in 15 seconds");
});

test("copy with Never sends no time and says only copied", async ({ page }) => {
  const keys = await boot(page, 0);
  await keys.getByRole("button", { name: "Copy API_KEY" }).click();
  await expect(page.getByTestId("secret-status")).toHaveText("API_KEY copied");
  expect((await copies(page)).map((c) => c.clearAfterSecs)).toEqual([null]);
});

test(".env: the confirmation says what is written and what is left out, then the backend saves and a toast says where", async ({
  page,
}) => {
  await boot(page);
  const env = page.getByRole("button", { name: "Download api-credentials as .env" });
  await env.click();
  const dialog = page.getByRole("dialog", { name: "Download api-credentials as .env" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("3 values will be written to a file in plain text:");
  await expect(dialog).toContainText("API_KEY, DB_PASSWORD, DB_USER");
  await expect(dialog).toContainText("1 key is left out:");
  await expect(dialog).toContainText("ca.crt (binary)");
  await expect(dialog).toContainText("Written for a shell: set -a; . ./api-credentials.env");
  await expect(dialog).toContainText("Anyone who can read the file can read these values. CubeLite does not delete it.");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  // Nothing was read to draw it.
  expect(await exports(page)).toEqual([]);
  expect(await reveals(page)).toEqual([]);

  // Escape closes it, writing nothing; the focus goes back to .env.
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(env).toBeFocused();
  expect(await exports(page)).toEqual([]);

  await env.click();
  await dialog.getByRole("button", { name: "Choose where to save…" }).click();
  await expect(dialog).toHaveCount(0);
  expect(await exports(page)).toEqual([
    { kubeconfigPath: expect.any(String), namespace: "default", name: "api-credentials", context: "prod-aks" },
  ]);
  await expect(page.getByText("3 values of api-credentials saved to /home/test/Downloads/api-credentials.env")).toBeVisible();
  await noValueInPage(page);
});

test(".env: a cancelled save dialog says nothing", async ({ page }) => {
  await boot(page, 15, { envExportDir: null });
  await page.getByRole("button", { name: "Download registry-pull as .env" }).click();
  const dialog = page.getByRole("dialog", { name: "Download registry-pull as .env" });
  // .dockerconfigjson is not a variable name: nothing can be written.
  await expect(dialog).toContainText("No value of registry-pull can be written to a .env file.");
  await expect(dialog).toContainText(".dockerconfigjson (not a variable name)");
  await expect(dialog.getByRole("button", { name: /Choose where to save/ })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Close" }).last().click();

  await page.getByRole("button", { name: "Download service-tokens as .env" }).click();
  const tokens = page.getByRole("dialog", { name: "Download service-tokens as .env" });
  await expect(tokens).toContainText("1 value will be written to a file in plain text:");
  await tokens.getByRole("button", { name: "Choose where to save…" }).click();
  await expect(tokens).toHaveCount(0);
  expect(await exports(page)).toHaveLength(1);
  await expect(page.getByText(/saved to/)).toHaveCount(0);
});

test("at 800 px a shown value takes the row's width, under its key; Reveal and Copy stay on the key's line", async ({ page }) => {
  await boot(page);
  await page.setViewportSize({ width: 800, height: 600 });
  const block = page.getByRole("group", { name: "Keys of service-tokens" });
  for (const key of ["SESSION_TOKEN", "tls.key"]) {
    await block.getByRole("button", { name: `Reveal ${key}` }).click();
    const row = block.locator(`[data-key-row="${key}"]`);
    const value = row.locator("[data-key-shown]");
    await expect(value).toBeVisible();
    const [blockBox, valueBox, nameBox, buttonBox, copyBox] = await Promise.all([
      block.boundingBox(),
      value.boundingBox(),
      row.getByText(key, { exact: true }).boundingBox(),
      row.getByRole("button", { name: `Hide ${key}` }).boundingBox(),
      row.getByRole("button", { name: `Copy ${key}` }).boundingBox(),
    ]);
    expect(valueBox!.width, `${key}: value width`).toBeGreaterThanOrEqual(0.6 * blockBox!.width);
    // The value is under the key's line; Hide and Copy are on it, inside the block.
    expect(valueBox!.y).toBeGreaterThanOrEqual(nameBox!.y + nameBox!.height - 1);
    const middle = nameBox!.y + nameBox!.height / 2;
    for (const box of [buttonBox!, copyBox!]) expect(Math.abs(box.y + box.height / 2 - middle)).toBeLessThan(4);
    expect(copyBox!.x).toBeGreaterThan(buttonBox!.x + buttonBox!.width);
    expect(copyBox!.x + copyBox!.width).toBeLessThanOrEqual(blockBox!.x + blockBox!.width);
  }
  // The rows of a block keep their columns: sizes and Copy buttons line up, with a
  // value shown or not.
  const creds = page.getByRole("group", { name: "Keys of api-credentials" });
  await creds.getByRole("button", { name: "Reveal DB_PASSWORD" }).click();
  await expect(creds.getByRole("button", { name: "Hide DB_PASSWORD" })).toBeVisible();
  const rights = (selector: string) =>
    creds.locator(selector).evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().right)));
  const sizes = await rights("[data-key-size]");
  expect(new Set(sizes).size, `size columns ${sizes}`).toBe(1);
  const copiesAt = await rights("[data-key-copy]");
  expect(new Set(copiesAt).size, `Copy buttons ${copiesAt}`).toBe(1);
  // The PEM keeps its four lines (a long one may wrap once at this width), all in view.
  const pem = block.locator('[data-key-row="tls.key"] [data-key-shown]');
  const lines = await pem.evaluate((el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)));
  expect(lines).toBeGreaterThanOrEqual(4);
  expect(lines).toBeLessThanOrEqual(8);
});

/** A Secret whose key names are long but ordinary. */
const REPLICAS: SecretInfo = {
  name: "db-replicas",
  namespace: "default",
  secret_type: "Opaque",
  keys: [
    { key: "DB_PASSWORD_PRIMARY", size: 24, binary: false },
    { key: "DB_PASSWORD_REPLICA", size: 24, binary: false },
    { key: "ca.crt", size: 1843, binary: true },
  ],
  helm_release: false,
  resource_version: "5",
  creation_timestamp: "2026-11-02T09:00:00Z",
};

test("at 800 x 600 every key name shows whole, Reveal and Copy stay on its line, and the columns line up", async ({
  page,
}) => {
  await boot(page, 15, { secrets: [...SECRETS, REPLICAS] });
  await page.setViewportSize({ width: 800, height: 600 });
  for (const secret of [...SECRETS, REPLICAS].filter((s) => !s.helm_release)) {
    const block = page.getByRole("group", { name: `Keys of ${secret.name}` });
    await block.scrollIntoViewIfNeeded();
    const blockBox = (await block.boundingBox())!;
    for (const { key } of secret.keys) {
      const row = block.locator(`[data-key-row="${key}"]`);
      const name = row.locator("[data-key-name]");
      expect(await name.evaluate((el) => el.scrollWidth <= el.clientWidth), `${secret.name}/${key}: name whole`).toBe(true);
      await expect(name).toHaveAttribute("title", key);
      const nameBox = (await name.boundingBox())!;
      const middle = nameBox.y + nameBox.height / 2;
      for (const button of await row.locator("[data-key-actions] button").all()) {
        const box = (await button.boundingBox())!;
        expect(Math.abs(box.y + box.height / 2 - middle), `${key}: button on the key's line`).toBeLessThan(4);
        expect(box.x + box.width, `${key}: button inside the block`).toBeLessThanOrEqual(blockBox.x + blockBox.width);
      }
    }
    // The value area gives way first: what it shows is whole, or not shown at all.
    const cut = await block.locator("[data-key-row] > span[data-key-value]").evaluateAll((cells) =>
      cells
        .filter((cell) =>
          [...cell.children].some(
            (c) => getComputedStyle(c).visibility !== "hidden" && !c.classList.contains("sr-only") && c.getBoundingClientRect().width > cell.clientWidth + 0.5,
          ),
        )
        .map((cell) => cell.parentElement?.getAttribute("data-key-row")),
    );
    expect(cut, `${secret.name}: value areas cut mid-glyph`).toEqual([]);
    // A row is no taller than its line, unless a value is shown under it.
    const tall = await block.locator("[data-key-row]").evaluateAll((rows) =>
      rows.filter((r) => r.getBoundingClientRect().height > 48).map((r) => r.getAttribute("data-key-row")),
    );
    expect(tall, `${secret.name}: rows taller than their line`).toEqual([]);
    const rights = (selector: string) =>
      block.locator(selector).evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().right)));
    const lefts = (selector: string) =>
      block.locator(selector).evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left)));
    for (const [what, at] of [
      ["sizes", await rights("[data-key-size]")],
      ["values", await lefts("[data-key-row] > span[data-key-value]")],
      ["Copy buttons", await rights("[data-key-copy]")],
    ] as const) {
      expect(new Set(at).size, `${secret.name}: ${what} ${at}`).toBe(1);
    }
  }
});
