// The resources editor end to end (#650 §3, §6, §9), against the Tauri mock:
// it answers resource_facts, evaluate_resources, apply_resources and
// clear_resources_override for default/api from fixtures (tauri-mock.ts).
import { type Locator, type Page } from "@playwright/test";
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

/**
 * The element is in view as it is now, nothing scrolled: inside the window, and
 * the topmost thing at its first line (so no scroller clips it and nothing
 * covers it).
 */
async function expectInView(locator: Locator, what: string) {
  const seen = await locator.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const x = box.left + Math.min(8, box.width / 2);
    const y = box.top + Math.min(8, box.height / 2);
    const hit = document.elementFromPoint(x, y);
    return {
      top: box.top,
      bottom: box.bottom,
      height: window.innerHeight,
      hit: hit !== null && (el === hit || el.contains(hit)),
    };
  });
  expect(seen.top, `${what}: top`).toBeGreaterThanOrEqual(0);
  expect(seen.bottom, `${what}: bottom`).toBeLessThanOrEqual(seen.height);
  expect(seen.hit, `${what}: not clipped or covered`).toBe(true);
}

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

/** The editor's scrolling body. */
const scrollBody = (editor: Locator) => editor.locator("[data-editor-step]").locator("..");

for (const size of [
  { width: 1440, height: 900 },
  { width: 800, height: 600 },
]) {
  test(`at ${size.width} × ${size.height} the check's first finding is in view while typing, the warning and the block`, async ({
    page,
  }) => {
    await boot(page, {}, size);
    const { editor } = await openEditor(page);
    const field = editor.getByLabel("worker memory limit");
    const findings = editor.getByRole("list", { name: "Findings" });

    await field.fill("1Gi");
    await expect(findings).toContainText("Memory limits on node-1 add up to 103%");
    await expect(findings).not.toHaveAttribute("aria-busy", "true");
    expect(await scrollBody(editor).evaluate((el) => el.scrollTop)).toBe(0);
    await expectInView(findings.getByRole("listitem").first(), "the warning");

    await field.fill("128Mi");
    await expect(findings).toContainText("The limit (128Mi) is under the request (256Mi).");
    await expect(editor.getByRole("button", { name: "Review" })).toBeDisabled();
    expect(await scrollBody(editor).evaluate((el) => el.scrollTop)).toBe(0);
    await expectInView(findings.getByRole("listitem").first(), "the block");
    // The fields stay usable above the check.
    await expectInView(field, "the field");
  });
}

test("at 800 × 600 a refused dry run says why in view, under a warning", async ({ page }) => {
  await boot(page, { dryRunError: "You are not allowed to change this deployment." }, { width: 800, height: 600 });
  const { editor } = await openEditor(page);
  await editor.getByRole("button", { name: "Double memory limit of worker" }).click();
  await expect(editor.getByRole("list", { name: "Findings" })).toContainText("Memory limits on node-1 add up to 103%");
  await editor.getByRole("button", { name: "Review" }).click();
  const review = page.getByRole("dialog", { name: "Review · api" });
  await expect(review.getByRole("heading", { name: "Warnings (1)" })).toBeAttached();
  const alert = review.getByRole("alert");
  await expect(alert).toHaveText("You are not allowed to change this deployment.");
  await expect(review.getByRole("button", { name: "Apply anyway" })).toBeDisabled();
  // As the step opens: the click on the step above may have left the body scrolled.
  await scrollBody(review).evaluate((el) => el.scrollTo(0, 0));
  await expectInView(alert, "the refusal");
});

test("each step opens at the top of its body, however far step 1 was scrolled", async ({ page }) => {
  await boot(page, {}, { width: 800, height: 600 });
  const { editor } = await openEditor(page);
  await editor.getByLabel("worker memory limit").fill("768Mi");
  await editor.getByLabel("envoy CPU request").fill("150m");
  await expect(editor.getByRole("button", { name: "Review" })).toBeEnabled();
  expect(await scrollBody(editor).evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await editor.getByRole("button", { name: "Review" }).click();
  const review = page.getByRole("dialog", { name: "Review · api" });
  await expect(review.getByRole("heading", { name: "Review · api" })).toBeFocused();
  await expect(review.getByRole("button", { name: "Apply", exact: true })).toBeEnabled();
  expect(await scrollBody(review).evaluate((el) => el.scrollTop)).toBe(0);
  await expectInView(review.getByTestId("editor-context"), "the header line");
});

test("an API message with a long unbreakable token wraps inside the editor", async ({ page }) => {
  // No slash, no hyphen: nothing a line may break at.
  const token = "[azurepolicyk8sazurev3containerlimits" + "5fb2d0b8c1a2".repeat(8) + "]";
  await boot(page, { dryRunError: `admission webhook "limits.example.com" denied the request: see ${token}` }, { width: 800, height: 600 });
  const { editor } = await openEditor(page);
  await editor.getByRole("button", { name: "Raise memory limit of worker by 50%" }).click();
  await editor.getByRole("button", { name: "Review" }).click();
  const review = page.getByRole("dialog", { name: "Review · api" });
  const alert = review.getByRole("alert");
  await expect(alert).toContainText(token);
  const fit = await alert.evaluate((el) => {
    const dialog = el.closest("[role=dialog]")!.getBoundingClientRect();
    const text = el.querySelector("span:last-child")!.getBoundingClientRect();
    return { overflow: el.scrollWidth - el.clientWidth, right: text.right, dialogRight: dialog.right };
  });
  expect(fit.overflow).toBeLessThanOrEqual(0);
  expect(fit.right).toBeLessThanOrEqual(fit.dialogRight);
});

test("the same amount in another text: nothing to review, and the editor says why", async ({ page }) => {
  await boot(page, { compareAmounts: true });
  const { editor } = await openEditor(page);
  await editor.getByLabel("worker CPU limit").fill("0.5");
  const why = editor.getByText("Nothing changes: these are the same amounts as on the cluster.");
  await expect(why).toBeVisible();
  await expectInView(why, "the reason");
  await expect(editor.getByRole("button", { name: "Review" })).toBeDisabled();
  await editor.getByLabel("worker memory limit").fill("1Gi");
  await expect(why).toHaveCount(0);
  await expect(editor.getByRole("button", { name: "Review" })).toBeEnabled();
});

test("the editor does not survive leaving the Deployments list", async ({ page }) => {
  await boot(page);
  const { editor } = await openEditor(page);
  await editor.getByLabel("worker memory limit").fill("768Mi");
  const mac = await page.evaluate(() => navigator.userAgent.includes("Mac"));
  await page.keyboard.press(`${mac ? "Meta" : "Control"}+KeyK`);
  const input = page.getByPlaceholder("Search clusters, resources, actions…");
  await expect(input).toBeVisible();
  await input.fill("pods");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "Pods" })).toBeVisible();
  await expect(page.getByRole("dialog", { name: /Adjust resources/ })).toHaveCount(0);
  await page.getByRole("complementary").getByText("Deployments", { exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Deployments" })).toBeVisible();
  await expect(page.getByRole("dialog", { name: /Adjust resources/ })).toHaveCount(0);
  // Opened again, it starts from the cluster's values.
  await page.getByRole("button", { name: /^api/ }).first().click();
  await page.getByRole("dialog", { name: "api" }).getByRole("button", { name: "Adjust" }).click();
  await expect(page.getByRole("dialog", { name: "Adjust resources · api" }).getByLabel("worker memory limit")).toHaveValue("512Mi");
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

test("a refused Remove mark says why in a toast that wraps a long token", async ({ page }) => {
  const token = "[azurepolicyk8sazurev3metadata" + "5fb2d0b8c1a2".repeat(6) + "]";
  await boot(page, { clearOverrideError: `admission webhook denied the request: ${token}` });
  const { banner } = await override(page);
  await banner.getByRole("button", { name: "Keep these values" }).click();
  await banner.getByRole("button", { name: "Remove mark" }).click();
  const toast = page.getByText(`Could not remove the mark: admission webhook denied the request: ${token}`);
  await expect(toast).toBeVisible();
  const fit = await toast.evaluate((el) => {
    const card = el.parentElement!;
    return { overflow: card.scrollWidth - card.clientWidth, right: el.getBoundingClientRect().right, cardRight: card.getBoundingClientRect().right };
  });
  expect(fit.overflow).toBeLessThanOrEqual(0);
  expect(fit.right).toBeLessThanOrEqual(fit.cardRight);
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

/** The name a keyboard user hears for the focused element. */
const focusedName = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return el?.getAttribute("aria-label") ?? el?.textContent?.trim() ?? "";
  });

/** Press Tab until `name` has the focus; every name passed on the way, in order. */
async function tabTo(page: Page, name: string, max = 40): Promise<string[]> {
  const seen: string[] = [];
  for (let i = 0; i < max; i++) {
    await page.keyboard.press("Tab");
    const now = await focusedName(page);
    seen.push(now);
    if (now === name) return seen;
  }
  throw new Error(`Tab never reached ${name}: ${seen.join(" | ")}`);
}

test("keyboard only: Adjust, every field, the choice and the steps, the node disclosure, Review, Back, Esc", async ({
  page,
}) => {
  await boot(page);
  const panel = await deploymentPanel(page);
  await tabTo(page, "Adjust");
  await page.keyboard.press("Enter");
  const editor = page.getByRole("dialog", { name: "Adjust resources · api" });
  await expect(editor.getByRole("heading", { name: "Adjust resources · api" })).toBeFocused();
  await expect(editor.getByLabel("worker memory limit")).toHaveValue("512Mi");

  // Close, the scrolling body (a stop of its own, for WebKit), worker's fields, then the
  // choice of the field the steps raise: memory limit, as nothing chose another.
  expect(await tabTo(page, "Memory limit")).toEqual([
    "Close",
    "Containers and nodes",
    "worker CPU request",
    "worker CPU limit",
    "worker memory request",
    "worker memory limit",
    "Memory limit",
  ]);
  // The arrows move the choice to the CPU limit; the steps follow it.
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  expect(await focusedName(page)).toBe("CPU limit");
  await expect(editor.getByRole("radiogroup", { name: "Field the steps raise, worker" }).getByRole("radio", { name: "CPU limit" })).toBeChecked();
  expect(await tabTo(page, "Raise CPU limit of worker by 50%")).toEqual([
    "Raise CPU limit of worker by 25%",
    "Raise CPU limit of worker by 50%",
  ]);
  await page.keyboard.press("Enter");
  await expect(editor.getByLabel("worker CPU limit")).toHaveValue("750m");
  await expect(editor.getByRole("list", { name: "Findings" })).toContainText("Not checked: namespace quota");

  // Then reset (worker changed), envoy, whose memory limit is unset: its steps are off and Tab passes them.
  expect(await tabTo(page, "1 other node")).toEqual([
    "Double CPU limit of worker",
    "Reset worker to the cluster's values",
    "envoy CPU request",
    "envoy CPU limit",
    "envoy memory request",
    "envoy memory limit",
    "Memory limit",
    "1 other node",
  ]);
  await expect(editor.getByText("no value on the cluster to step from")).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(editor.getByRole("button", { name: "1 other node" })).toHaveAttribute("aria-expanded", "true");
  await expect(editor.getByTestId("node-node-2")).toBeVisible();

  await tabTo(page, "Review");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Review · api" })).toBeFocused();
  await expect(page.getByRole("list", { name: "Changes" })).toContainText("500m → 750m");
  await tabTo(page, "Back");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Adjust resources · api" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(editor).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Adjust" })).toBeFocused();
  // The panel stays: Esc closed only the editor.
  await expect(panel).toBeVisible();
});

test("a quantity of ten characters shows whole, and the fields keep their columns", async ({ page }) => {
  await boot(page, {}, { width: 800, height: 600 });
  const { editor } = await openEditor(page);
  const field = editor.getByLabel("worker memory limit");
  // The value a field had shows whole beside it.
  await field.fill("768Mi");
  const was = editor.getByText("was 512Mi");
  await expect(was).toBeVisible();
  expect(await was.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
  await field.fill("1073741824");
  await expect(field).toHaveValue("1073741824");
  expect(await field.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
  // All four read in one frame: one box at a time, a read can land in another
  // frame of the dialog's opening animation and the columns look apart.
  for (const column of ["request", "limit"]) {
    const xs = await editor.evaluate(
      (root, labels) =>
        labels.map((label) => {
          const input = root.querySelector(`input[aria-label="${label}"]`);
          return input ? Math.round(input.getBoundingClientRect().x) : null;
        }),
      ["worker CPU", "worker memory", "envoy CPU", "envoy memory"].map((f) => `${f} ${column}`),
    );
    expect(xs, column).not.toContain(null);
    expect(new Set(xs).size, column).toBe(1);
  }
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
  // Only the body scrolls: the card itself never does, so the title and the footer stay put.
  expect(await editor.evaluate((el) => el.scrollTop)).toBe(0);
  expect(await editor.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(0);
  await expectInView(editor.getByRole("heading", { name: "Adjust resources · api" }), "the title");
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

/** Overridden deployments named with 19, 30 and 40 characters, beside the fixtures. */
function longOverrides(): { overrides: Overrides; names: string[] } {
  const api = FIXTURES.deployments[0];
  const mark = {
    at: "2026-11-13T12:20:00Z",
    containers: [
      {
        name: "worker",
        original: { cpu: { request: "250m", limit: "500m" }, memory: { request: "256Mi", limit: "512Mi" } },
        applied: { cpu: { request: "250m", limit: "500m" }, memory: { request: "256Mi", limit: "768Mi" } },
      },
    ],
  };
  const names = ["payments-gateway-v2", "checkout-frontend-canary-rel01", "notification-dispatcher-worker-blue-eu01"];
  return {
    names,
    overrides: {
      deployments: [
        ...FIXTURES.deployments,
        ...names.map((name) => ({ ...structuredClone(api), name, resources_override: mark })),
      ] as typeof FIXTURES.deployments,
    },
  };
}

for (const size of [
  { width: 1440, height: 900 },
  { width: 800, height: 600 },
]) {
  test(`at ${size.width} px the Override badge keeps its word beside a long name, the name truncates`, async ({ page }) => {
    const { overrides, names } = longOverrides();
    expect(names.map((n) => n.length)).toEqual([19, 30, 40]);
    await boot(page, overrides, size);
    await page.getByRole("complementary").getByText("Deployments", { exact: true }).click();
    for (const name of names) {
      const row = page.getByRole("button", { name: new RegExp(`^${name}`) }).first();
      await expect(row).toBeVisible();
      const seen = await row.evaluate((el) => {
        const badge = el.querySelector<HTMLElement>('[data-state="warn"]')!;
        const word = badge.querySelector<HTMLElement>("span.truncate")!;
        const next = el.children[1] as HTMLElement;
        const nameEl = el.querySelector<HTMLElement>("[title]")!;
        return {
          word: word.textContent,
          cut: word.scrollWidth - word.clientWidth,
          badgeRight: badge.getBoundingClientRect().right,
          nextLeft: next.getBoundingClientRect().left,
          title: nameEl.getAttribute("title"),
        };
      });
      expect(seen.word, name).toBe("Override");
      expect(seen.cut, `${name}: the word is whole`).toBeLessThanOrEqual(0);
      expect(seen.badgeRight, `${name}: no overlap with the next column`).toBeLessThanOrEqual(seen.nextLeft);
      expect(seen.title).toBe(name);
    }
  });
}

/** The left edge of each cell of each row of a list: rows of columns. */
const columnsOf = (list: Locator) =>
  list.evaluate((ul) =>
    [...ul.querySelectorAll(":scope > li")].map((li) => [...li.children].map((c) => Math.round(c.getBoundingClientRect().left))),
  );

test("the rows of changes line up, in Review and in the banner", async ({ page }) => {
  await boot(page);
  const { panel, editor } = await openEditor(page);
  await editor.getByRole("button", { name: "Raise memory limit of worker by 50%" }).click();
  await editor.getByLabel("envoy CPU request").fill("150m");
  await expect(editor.getByRole("button", { name: "Review" })).toBeEnabled();
  await editor.getByRole("button", { name: "Review" }).click();
  const review = page.getByRole("dialog", { name: "Review · api" });
  const changes = review.getByRole("list", { name: "Changes" });
  await expect(changes.getByRole("listitem")).toHaveCount(2);
  const rows = await columnsOf(changes);
  expect(rows[0], "container, label, values").toHaveLength(3);
  expect(rows[1]).toEqual(rows[0]);

  await review.getByRole("button", { name: "Apply", exact: true }).click();
  const banner = panel.locator("[data-override-banner]");
  const overridden = banner.getByRole("list", { name: "Overridden values" });
  await expect(overridden.getByRole("listitem")).toHaveCount(2);
  const bannerRows = await columnsOf(overridden);
  expect(bannerRows[0]).toHaveLength(3);
  expect(bannerRows[1]).toEqual(bannerRows[0]);
});
