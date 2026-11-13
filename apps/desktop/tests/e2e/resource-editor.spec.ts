// The resources editor end to end (#650 §3, §6, §9), against the Tauri mock:
// it answers resource_facts, evaluate_resources, apply_resources and
// clear_resources_override for default/api from fixtures (tauri-mock.ts).
import { type Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { API_0_METRICS, FIXTURES, tauriMockScript } from "./tauri-mock";

type Overrides = Parameters<typeof tauriMockScript>[0];
type ApplyCall = { dryRun: boolean; proposal: unknown; namespace: string; name: string };

async function boot(page: Page, overrides: Overrides = {}, size = { width: 1440, height: 900 }) {
  await page.setViewportSize(size);
  // The editor's "Now" agrees with the panel's usage.
  await page.addInitScript(tauriMockScript({ podMetrics: [API_0_METRICS], ...overrides }));
  await page.addInitScript(() => {
    window.localStorage.setItem("cubelite.onboardingSeen", "true");
    window.localStorage.setItem("cubelite.theme", '"dark"');
  });
  await page.goto("/");
}

/** The Deployments list with api's panel open. */
async function deploymentPanel(page: Page) {
  await page.getByRole("complementary").getByText("Deployments", { exact: true }).click();
  await page.getByRole("button", { name: /^api/ }).first().click();
  const panel = page.getByRole("dialog", { name: "api" });
  await expect(panel).toBeVisible();
  return panel;
}

/** api's panel, Adjust, and the editor once the cluster's values are checked. */
async function openEditor(page: Page) {
  const panel = await deploymentPanel(page);
  await panel.getByRole("button", { name: "Adjust" }).click();
  const editor = page.getByRole("dialog", { name: "Adjust resources · api" });
  await expect(editor.getByLabel("worker memory limit")).toHaveValue("512Mi");
  await expect(editor.getByRole("list", { name: "Findings" })).toBeVisible();
  return { panel, editor };
}

const applies = (page: Page) => page.evaluate(() => (window.__resourcesApplies ?? []) as unknown as ApplyCall[]);

test("raise the worker's memory limit by half, review and apply: the toast, the banner and the badge", async ({ page }) => {
  await boot(page);
  const { panel, editor } = await openEditor(page);
  await editor.getByRole("button", { name: "Raise memory limit of worker by 50%" }).click();
  await expect(editor.getByLabel("worker memory limit")).toHaveValue("768Mi");
  await expect(editor.getByText("was 512Mi")).toBeVisible();
  await editor.getByRole("button", { name: "Review" }).click();

  const review = page.getByRole("dialog", { name: "Review · api" });
  await expect(review.getByRole("heading", { name: "Review · api" })).toBeFocused();
  await expect(review.getByRole("list", { name: "Changes" })).toContainText("worker");
  await expect(review.getByRole("list", { name: "Changes" })).toContainText("512Mi → 768Mi");
  await expect(review.getByText("(nothing else changes)")).toBeVisible();
  await review.getByRole("button", { name: "Apply", exact: true }).click();

  await expect(page.getByText("Resources of api updated, rollout started")).toBeVisible();
  await expect(review).toHaveCount(0);
  const banner = panel.locator("[data-override-banner]");
  await expect(banner).toContainText("Resources overridden from CubeLite");
  await expect(banner).toContainText("512Mi → 768Mi");
  await expect(page.locator("main").getByText("Override", { exact: true })).toBeVisible();

  const calls = await applies(page);
  expect(calls.map((c) => c.dryRun)).toEqual([true, false]);
  expect(calls[1].proposal).toEqual({
    kind: "adjust",
    containers: [
      { name: "worker", resources: { cpu: { request: "250m", limit: "500m" }, memory: { request: "256Mi", limit: "768Mi" } } },
    ],
  });
  // Focus is back on what opened the editor.
  await expect(panel.getByRole("button", { name: "Adjust" })).toBeFocused();
});

test("a value the check blocks: the field is invalid, the finding is listed, Review is disabled", async ({ page }) => {
  await boot(page);
  const { editor } = await openEditor(page);
  const field = editor.getByLabel("worker memory limit");
  await field.fill("128Mi");
  await expect(field).toHaveAttribute("aria-invalid", "true");
  await expect(editor.getByRole("list", { name: "Findings" })).toContainText("The limit (128Mi) is under the request (256Mi).");
  await expect(editor.locator('[data-editor-container="worker"]')).toContainText(
    "The limit (128Mi) is under the request (256Mi).",
  );
  await expect(editor.getByRole("button", { name: "Review" })).toBeDisabled();
});

test("a warning asks for Apply anyway, and so does a lone not-checked finding", async ({ page }) => {
  await boot(page);
  const { editor } = await openEditor(page);
  await editor.getByRole("button", { name: "Double memory limit of worker" }).click();
  await expect(editor.getByRole("list", { name: "Findings" })).toContainText("Memory limits on node-1 add up to 103%");
  await editor.getByRole("button", { name: "Review" }).click();
  const review = page.getByRole("dialog", { name: "Review · api" });
  await expect(review.getByRole("heading", { name: "Warnings (1)" })).toBeVisible();
  await expect(review.getByRole("button", { name: "Apply anyway" })).toBeEnabled();

  await review.getByRole("button", { name: "Back" }).click();
  await editor.getByRole("button", { name: "Reset worker to the cluster's values" }).click();
  await editor.getByLabel("worker CPU limit").focus();
  await editor.getByRole("button", { name: "Raise CPU limit of worker by 50%" }).click();
  await expect(editor.getByLabel("worker CPU limit")).toHaveValue("750m");
  await expect(editor.getByRole("list", { name: "Findings" })).toContainText("Not checked: namespace quota");
  await editor.getByRole("button", { name: "Review" }).click();
  await expect(review.getByRole("button", { name: "Apply anyway" })).toBeEnabled();
});

test("a refused dry run shows inline, offers nothing to apply and sends no apply", async ({ page }) => {
  await boot(page, { dryRunError: "You are not allowed to change this deployment." });
  const { editor } = await openEditor(page);
  await editor.getByRole("button", { name: "Raise memory limit of worker by 50%" }).click();
  await editor.getByRole("button", { name: "Review" }).click();
  const review = page.getByRole("dialog", { name: "Review · api" });
  await expect(review.getByRole("alert")).toHaveText("You are not allowed to change this deployment.");
  await expect(review.getByRole("button", { name: "Apply", exact: true })).toBeDisabled();
  expect((await applies(page)).map((c) => c.dryRun)).toEqual([true]);
});

/** Apply +50% on the worker's memory limit and wait for the banner. */
async function override(page: Page) {
  const { panel, editor } = await openEditor(page);
  await editor.getByRole("button", { name: "Raise memory limit of worker by 50%" }).click();
  await editor.getByRole("button", { name: "Review" }).click();
  await page.getByRole("dialog", { name: "Review · api" }).getByRole("button", { name: "Apply", exact: true }).click();
  const banner = panel.locator("[data-override-banner]");
  await expect(banner).toBeVisible();
  return { panel, banner };
}

test("Restore from the banner opens Review with Restore, then the banner is gone", async ({ page }) => {
  await boot(page);
  const { banner } = await override(page);
  await banner.getByRole("button", { name: "Restore" }).click();
  const restore = page.getByRole("dialog", { name: "Restore · api" });
  await expect(restore.getByRole("list", { name: "Changes" })).toContainText("768Mi → 512Mi");
  await expect(restore.getByText("The override mark is removed.")).toBeVisible();
  await expect(restore.getByRole("button", { name: "Back" })).toHaveCount(0);
  await restore.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(page.getByText("Resources of api restored, rollout started")).toBeVisible();
  await expect(banner).toHaveCount(0);
  await expect(page.locator("main").getByText("Override", { exact: true })).toHaveCount(0);
  expect((await applies(page)).at(-1)?.proposal).toEqual({ kind: "restore", containers: [] });
});

test("Keep these values removes the mark and leaves the values", async ({ page }) => {
  await boot(page);
  const { panel, banner } = await override(page);
  await banner.getByRole("button", { name: "Keep these values" }).click();
  await expect(banner).toContainText("Remove the override mark? The values stay as they are.");
  await banner.getByRole("button", { name: "Remove mark" }).click();
  await expect(page.getByText("Override mark removed from api")).toBeVisible();
  await expect(banner).toHaveCount(0);
  await expect(page.locator("main").getByText("Override", { exact: true })).toHaveCount(0);
  await panel.getByRole("button", { name: "Adjust" }).click();
  await expect(page.getByRole("dialog", { name: "Adjust resources · api" }).getByLabel("worker memory limit")).toHaveValue("768Mi");
});

test("facts that cannot be read: the reason and Try again, no field", async ({ page }) => {
  await boot(page, { resourceFacts: null });
  const panel = await deploymentPanel(page);
  await panel.getByRole("button", { name: "Adjust" }).click();
  const editor = page.getByRole("dialog", { name: "Adjust resources · api" });
  await expect(editor.getByRole("alert")).toHaveText("pods is forbidden: User cannot list resource pods");
  await expect(editor.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(editor.getByRole("textbox")).toHaveCount(0);
});

test("keyboard only: Adjust, every field and step, the node disclosure, Review, Back, Esc", async ({ page }) => {
  await boot(page);
  const panel = await deploymentPanel(page);
  const adjust = panel.getByRole("button", { name: "Adjust" });
  await adjust.focus();
  await page.keyboard.press("Enter");
  const editor = page.getByRole("dialog", { name: "Adjust resources · api" });
  await expect(editor.getByRole("heading", { name: "Adjust resources · api" })).toBeFocused();
  await expect(editor.getByLabel("worker memory limit")).toHaveValue("512Mi");

  // Close, then each container's fields, quick steps and reset, then the node disclosure.
  // Nothing is changed yet, so both resets are disabled; envoy has no memory limit,
  // the field its steps act on, so they are disabled too: Tab passes them.
  const order: string[] = [];
  for (let i = 0; i < 30; i++) {
    await page.keyboard.press("Tab");
    const name = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return el?.getAttribute("aria-label") ?? el?.textContent?.trim() ?? "";
    });
    order.push(name);
    if (name === "1 other node") break;
  }
  expect(order).toEqual([
    "Close",
    "worker CPU request",
    "worker CPU limit",
    "worker memory request",
    "worker memory limit",
    "Raise memory limit of worker by 25%",
    "Raise memory limit of worker by 50%",
    "Double memory limit of worker",
    "envoy CPU request",
    "envoy CPU limit",
    "envoy memory request",
    "envoy memory limit",
    "1 other node",
  ]);
  await page.keyboard.press("Enter");
  await expect(editor.getByRole("button", { name: "1 other node" })).toHaveAttribute("aria-expanded", "true");
  await expect(editor.getByTestId("node-node-2")).toBeVisible();

  // A step from the keyboard, then Review.
  await editor.getByRole("button", { name: "Raise memory limit of worker by 50%" }).focus();
  await page.keyboard.press("Enter");
  await expect(editor.getByLabel("worker memory limit")).toHaveValue("768Mi");
  const review = editor.getByRole("button", { name: "Review" });
  await expect(review).toBeEnabled();
  await review.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Review · api" })).toBeFocused();
  await page.getByRole("button", { name: "Back" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Adjust resources · api" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(editor).toHaveCount(0);
  await expect(adjust).toBeFocused();
  // The panel stays: Esc closed only the editor.
  await expect(panel).toBeVisible();
});

/** Eight containers (one with a 60-character name) and fifty nodes, two of them hosting the pods. */
function crowded(): Overrides {
  const facts = structuredClone(FIXTURES.resourceFacts)!;
  const long = "a-container-with-a-name-that-is-exactly-sixty-characters-xyz";
  const worker = facts.workload.containers[0];
  facts.workload.containers = [
    worker,
    ...Array.from({ length: 6 }, (_, i) => ({ ...worker, name: `side-${i + 1}` })),
    { ...worker, name: long },
  ];
  const node = facts.nodes.state === "known" ? facts.nodes.value[1] : null;
  if (facts.nodes.state === "known" && node) {
    facts.nodes.value = [
      ...facts.nodes.value,
      ...Array.from({ length: 48 }, (_, i) => ({ ...node, name: `aks-pool-${String(i + 3).padStart(2, "0")}` })),
    ];
  }
  return { resourceFacts: facts };
}

test("at 800 × 600 with eight containers and fifty nodes the modal does not overflow and its footer stays usable", async ({
  page,
}) => {
  await boot(page, crowded(), { width: 800, height: 600 });
  const { editor } = await openEditor(page);
  expect("a-container-with-a-name-that-is-exactly-sixty-characters-xyz").toHaveLength(60);
  await expect(editor.locator("[data-editor-container]")).toHaveCount(9);
  await editor.getByRole("button", { name: "49 other nodes" }).click();
  await expect(editor.getByTestId("node-aks-pool-50")).toBeAttached();
  const box = (await editor.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(800);
  expect(box.y + box.height).toBeLessThanOrEqual(600);
  // Nothing inside is wider than the dialog.
  const overflow = await editor.evaluate((el) => {
    const right = el.getBoundingClientRect().right;
    return [...el.querySelectorAll("*")]
      .filter((c) => c.getBoundingClientRect().right > right + 0.5)
      .map((c) => c.tagName + "." + String(c.getAttribute("class")).slice(0, 40));
  });
  expect(overflow).toEqual([]);
  for (const name of ["Cancel", "Review"]) {
    const button = editor.getByRole("button", { name, exact: true });
    const b = (await button.boundingBox())!;
    expect(b.y + b.height, name).toBeLessThanOrEqual(600);
  }
  await editor.getByRole("button", { name: "Raise memory limit of worker by 50%" }).click();
  await editor.getByRole("button", { name: "Review" }).click();
  await expect(page.getByRole("dialog", { name: "Review · api" })).toBeVisible();
});

test("the pod panel's Adjust on deployment api opens that deployment's editor", async ({ page }) => {
  await boot(page);
  await page.getByRole("complementary").getByText("Pods", { exact: true }).click();
  await page.getByText("api-0", { exact: true }).click();
  const pod = page.getByRole("dialog", { name: "api-0" });
  await pod.getByRole("button", { name: "Adjust on deployment api" }).click();
  await expect(page.getByRole("dialog", { name: "Adjust resources · api" }).getByLabel("worker memory limit")).toHaveValue(
    "512Mi",
  );
  await expect(page.getByRole("dialog", { name: "api", exact: true })).toBeVisible();
  await expect(pod).toHaveCount(0);
});
