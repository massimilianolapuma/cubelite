import { test, expect, type Page } from "@playwright/test";
import { tauriMockScript } from "./tauri-mock";

async function boot(page: Page, opts: { onboardingSeen?: boolean } = {}) {
  await page.addInitScript(tauriMockScript());
  const seen = opts.onboardingSeen ?? true;
  await page.addInitScript(
    ([seenValue]) => {
      window.localStorage.setItem("cubelite.onboardingSeen", seenValue);
      window.localStorage.setItem("cubelite.theme", '"dark"');
    },
    [String(seen)],
  );
  await page.goto("/");
}

test("shell renders titlebar, rail, sidebar and status bar", async ({ page }) => {
  await boot(page);
  await expect(page.getByText("prod-aks").first()).toBeVisible();
  await expect(page.getByText("AKS", { exact: true })).toBeVisible();
  await expect(page.getByLabel("All Clusters")).toBeVisible();
  await expect(page.getByText("Workloads")).toBeVisible();
  await expect(page.getByText("https://prod.azmk8s.io:443")).toBeVisible();
});

test("first launch shows onboarding and completes", async ({ page }) => {
  await boot(page, { onboardingSeen: false });
  await expect(page.getByText("Welcome to CubeLite")).toBeVisible();
  await expect(page.getByText("2 contexts found")).toBeVisible();
  await page.getByText("Continue").click();
  await page.getByText("Continue").click();
  await page.getByText("Start using CubeLite").click();
  await expect(page.getByText("Welcome to CubeLite")).not.toBeVisible();
  // The init script would reset the flag on reload; assert persistence directly.
  const seen = await page.evaluate(() => window.localStorage.getItem("cubelite.onboardingSeen"));
  expect(seen).toBe("true");
});

test("pods view lists fixtures and opens the detail drawer, Esc closes", async ({ page }) => {
  await boot(page);
  await page.getByRole("complementary").getByText("Pods", { exact: true }).click();
  await expect(page.getByText("api-0")).toBeVisible();
  await expect(page.getByText("Pending", { exact: true })).toBeVisible();
  await page.getByText("api-0").click();
  await expect(page.getByRole("dialog", { name: "api-0" })).toBeVisible();
  await expect(page.getByText("Burstable")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "api-0" })).not.toBeVisible();
});

test("pod shell runs a line and shows its output (#488)", async ({ page }) => {
  await boot(page);
  await page.getByRole("complementary").getByText("Pods", { exact: true }).click();
  await page.getByText("api-0").click();
  await page.getByRole("button", { name: "Shell" }).click();
  const modal = page.getByRole("dialog", { name: "api-0 — shell" });
  await expect(modal.getByText("connected — line-based shell (/bin/sh, no TTY)")).toBeVisible();

  const sessionId = await page.evaluate(() => window.__lastExec?.sessionId as string);
  expect(await page.evaluate(() => window.__lastExec?.pod)).toBe("api-0");
  await modal.getByRole("textbox", { name: "Shell command" }).fill("echo hi");
  await page.keyboard.press("Enter");
  await expect(modal.getByText("$ echo hi")).toBeVisible();
  expect(await page.evaluate(() => window.__execSent)).toEqual(["echo hi\n"]);

  await page.evaluate(
    (id) => window.__emitTauriEvent?.(`exec-output:${id}`, { channel: "stdout", text: "hi" }),
    sessionId,
  );
  await expect(modal.getByText("hi", { exact: true })).toBeVisible();
});

test("YAML modal edits and applies the pod manifest", async ({ page }) => {
  await boot(page);
  await page.getByRole("complementary").getByText("Pods", { exact: true }).click();
  await page.getByText("api-0").click();
  await page.getByRole("button", { name: "YAML" }).click();
  const modal = page.getByRole("dialog", { name: "api-0.yaml" });
  await expect(modal.getByText("kind: Pod")).toBeVisible();

  await modal.getByRole("button", { name: "Edit" }).click();
  const editor = modal.getByRole("textbox", { name: "Manifest YAML" });
  await editor.fill("kind: Pod\nmetadata:\n  name: api-0\n  labels: {tier: web}\n");
  await modal.getByRole("button", { name: "Apply" }).click();

  await expect(modal).not.toBeVisible();
  const applied = await page.evaluate(() => window.__lastApply);
  expect(applied).toMatchObject({
    resourceType: "pod",
    namespace: "default",
    name: "api-0",
    yaml: "kind: Pod\nmetadata:\n  name: api-0\n  labels: {tier: web}\n",
  });
});

test("command palette navigates views", async ({ page }) => {
  await boot(page);
  await page.getByText("Search & switch…").click();
  await expect(page.getByPlaceholder("Search clusters, views, actions…")).toBeVisible();
  await page.getByText("Go to Deployments").click();
  await expect(page.getByText("Replicas · Actions")).toBeVisible();
});

test("cluster switch from the rail lands on the new cluster", async ({ page }) => {
  await boot(page);
  await page.getByTitle("staging").click();
  await expect(page.getByText("staging").first()).toBeVisible();
  await expect(page.getByLabel("All Clusters")).toBeVisible();
});

test("preferences persist the refresh interval across reloads", async ({ page }) => {
  await boot(page);
  await page.getByLabel("Preferences").click();
  await page.getByRole("radio", { name: "1m" }).click();
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(page.getByText("refresh 1m")).toBeVisible();
});

test("preferences list every kubeconfig file with its context count", async ({ page }) => {
  await boot(page);
  await page.getByLabel("Preferences").click();
  const files = page.getByRole("list", { name: "Kubeconfig files" });
  await expect(files.getByRole("listitem")).toHaveCount(2);
  await expect(files.getByText("/home/test/.kube/team.yaml")).toBeVisible();
  await expect(files.getByText(/1 merged/)).toBeVisible();
});

test("adding a kubeconfig file lists it and reloads contexts", async ({ page }) => {
  await boot(page);
  await page.getByLabel("Preferences").click();
  await page.getByRole("button", { name: "Add file…" }).click();
  const files = page.getByRole("list", { name: "Kubeconfig files" });
  await expect(files.getByText("/home/test/.kube/extra.yaml")).toBeVisible();
  await expect(page.getByText("Custom list", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTitle(/^extra/)).toBeVisible(); // rail avatar of the new context
  await page.getByLabel("Preferences").click();
  await page.getByRole("button", { name: "Use defaults" }).click();
  await expect(page.getByText("From KUBECONFIG", { exact: true })).toBeVisible();
});

test("All Clusters dashboard aggregates stats across contexts", async ({ page }) => {
  await boot(page);
  await page.getByLabel("All Clusters").click();
  await expect(page.getByText("Clusters online")).toBeVisible();
  await expect(page.getByText("Contexts watched")).toBeVisible();
  await expect(page.getByText(/^2 contexts · \d+ pods$/)).toBeVisible();
  // The online cluster shows capacity bars; the unreachable one its reason.
  await expect(page.getByText("CPU", { exact: true })).toBeVisible();
  await expect(page.getByText("connection timed out")).toBeVisible();
});

test("preferences reorder and hide sidebar types, headers sort lists (#496)", async ({ page }) => {
  await boot(page);
  const sidebar = page.locator("aside").first();
  await page.getByLabel("Preferences").click();
  await page.getByRole("button", { name: "Hide Services" }).click();
  await page.getByRole("button", { name: "Hide Ingresses" }).click();
  await page.getByRole("button", { name: "Move Deployments up" }).click();
  await page.keyboard.press("Escape");

  await expect(sidebar.getByText("Network")).toHaveCount(0);
  await expect(sidebar.getByText("Services")).toHaveCount(0);
  const items = await sidebar.locator("button").allTextContents();
  const pos = (label: string) => items.findIndex((t) => t.trim().startsWith(label));
  expect(pos("Deployments")).toBeLessThan(pos("Pods"));

  await page.reload();
  await expect(sidebar.getByText("Services")).toHaveCount(0);

  await sidebar.getByText("Pods").click();
  const header = page.getByRole("button", { name: "Sort by Name", exact: true });
  await header.click();
  await expect(header).toHaveAttribute("data-sort", "ascending");
});
