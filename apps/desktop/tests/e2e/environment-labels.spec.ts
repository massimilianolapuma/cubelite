import { type Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { FIXTURES, tauriMockScript } from "./tauri-mock";

// Environment labels (#662, spec §3, §5.1, §5.2, §6): detected from the context
// name or set by hand, on the top bar chip, in the rail tooltip and in
// Preferences → Clusters.

const CONTEXTS = [
  { ...FIXTURES.contexts[0], name: "aks-prod-01-emm", is_active: true },
  { ...FIXTURES.contexts[1], name: "minikube", is_active: false },
];

async function boot(page: Page, theme: "dark" | "light" = "dark") {
  await page.addInitScript(tauriMockScript({ contexts: CONTEXTS }));
  await page.addInitScript((t) => {
    window.localStorage.setItem("cubelite.onboardingSeen", "true");
    window.localStorage.setItem("cubelite.theme", JSON.stringify(t));
  }, theme);
  await page.goto("/");
}

const header = (page: Page) => page.locator("header").first();
const chip = (page: Page) => header(page).getByRole("button", { name: /^aks-prod-01-emm|^minikube/ });
const tag = (page: Page) => header(page).getByTestId("environment-tag");

async function switchTo(page: Page, name: string) {
  await page.getByRole("navigation", { name: "Clusters" }).getByRole("button", { name: new RegExp(`^${name},`) }).click();
  await expect(header(page).getByText(name, { exact: true })).toBeVisible();
}

for (const theme of ["dark", "light"] as const) {
  test(`${theme}: the active cluster shows its detected environment; set by hand it follows`, async ({ page }) => {
    await boot(page, theme);
    await expect(tag(page)).toHaveText("Production");
    await expect(
      page.getByRole("navigation", { name: "Clusters" }).getByTitle("aks-prod-01-emm · Production"),
    ).toBeAttached();

    // minikube has no environment word: nothing shown.
    await switchTo(page, "minikube");
    await expect(tag(page)).toHaveCount(0);

    await chip(page).click();
    await page.getByRole("menuitem", { name: "Environment" }).click();
    await expect(page.getByRole("menuitemradio", { name: "Detect from name (Not set)" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await page.getByRole("menuitemradio", { name: "Development" }).click();
    await expect(tag(page)).toHaveText("Development");
    await expect(page.getByRole("navigation", { name: "Clusters" }).getByTitle("minikube · Development")).toBeAttached();

    // The tag is readable on the chip: a neutral role, not a state colour.
    const colours = await tag(page).evaluate((n) => {
      const s = getComputedStyle(n);
      const chipStyle = getComputedStyle(n.closest("button")!);
      return { tag: s.backgroundColor, chip: chipStyle.backgroundColor, text: s.color };
    });
    expect(colours.tag).not.toBe(colours.chip);
    expect(colours.text).not.toBe("rgba(0, 0, 0, 0)");
  });
}

test("the Environment submenu works from the keyboard", async ({ page }) => {
  await boot(page);
  await chip(page).focus();
  await page.keyboard.press("Enter");
  const environment = page.getByRole("menuitem", { name: "Environment" });
  await expect(environment).toBeVisible();
  // Down from the first item until Environment has the focus.
  for (let i = 0; i < 5 && !(await environment.evaluate((n) => n === document.activeElement)); i++) {
    await page.keyboard.press("ArrowDown");
  }
  await expect(environment).toBeFocused();
  await page.keyboard.press("ArrowRight");
  const detect = page.getByRole("menuitemradio", { name: "Detect from name (Production)" });
  await expect(detect).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitemradio", { name: "Test" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(tag(page)).toHaveText("Test");
  await expect(page.getByRole("menu")).toHaveCount(0);
});

test("Preferences → Clusters lists every context and sets one", async ({ page }) => {
  await boot(page);
  await page.getByRole("button", { name: "Preferences" }).click();
  const section = page.getByRole("region", { name: "Clusters" });
  await section.scrollIntoViewIfNeeded();
  const table = section.getByRole("table", { name: "Cluster environments" });
  await expect(table.getByRole("row")).toHaveCount(3);
  const prod = section.getByRole("combobox", { name: "Environment of aks-prod-01-emm" });
  const mini = section.getByRole("combobox", { name: "Environment of minikube" });
  await expect(prod.locator("option:checked")).toHaveText("Production (detected)");
  await expect(mini.locator("option:checked")).toHaveText("Not set (detected)");

  await prod.selectOption("staging");
  await expect(tag(page)).toHaveText("Staging");

  // Environment names: a word in two environments is refused, naming the other.
  await section.getByRole("button", { name: "Environment names" }).click();
  const test_ = section.getByRole("textbox", { name: "Test" });
  await test_.fill("test, tst, qa, prod");
  await test_.blur();
  await expect(section.getByText('"prod" is already in Production')).toBeVisible();
  await expect(test_).toHaveValue("test, tst, qa, prod");
});

test("forced colours: the environment tag keeps an edge and its text", async ({ page }) => {
  await page.emulateMedia({ forcedColors: "active", colorScheme: "dark" });
  await boot(page);
  await expect(tag(page)).toHaveText("Production");
  const look = await tag(page).evaluate((n) => {
    const s = getComputedStyle(n);
    return { style: s.borderTopStyle, width: parseFloat(s.borderTopWidth), colour: s.color };
  });
  expect(look.style).toBe("solid");
  expect(look.width).toBeGreaterThanOrEqual(1);
});
