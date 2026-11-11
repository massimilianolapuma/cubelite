import { test as base, expect, type Page } from "@playwright/test";

/**
 * Every spec imports `test` from here: `page.goto` and `page.reload` return
 * only once the app has finished starting up (<html data-app-ready>, set by
 * +page.svelte). Before that the top bar and the cluster rail still change
 * size, and a click can lose its target mid-way (#584).
 */
async function waitForApp(page: Page): Promise<void> {
  await page.locator("html[data-app-ready]").waitFor({ state: "attached" });
}

export const test = base.extend({
  page: async ({ page }, use) => {
    const goto = page.goto.bind(page);
    const reload = page.reload.bind(page);
    page.goto = async (...args: Parameters<Page["goto"]>) => {
      const response = await goto(...args);
      await waitForApp(page);
      return response;
    };
    page.reload = async (...args: Parameters<Page["reload"]>) => {
      const response = await reload(...args);
      await waitForApp(page);
      return response;
    };
    await use(page);
  },
});

export { expect };
