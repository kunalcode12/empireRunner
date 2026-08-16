import { expect, test } from "@playwright/test";

/**
 * Boot smoke test.
 *
 * Deliberately thin: at P01 there is no canvas, so there is nothing to measure.
 * The draw-call and frame budgets in docs/TUNING.md §14 get wired into this
 * directory at P05, which is why playwright.config.ts already defines both a
 * desktop and a mobile project — the two budgets differ.
 */

test("the landing page boots and shows the AXIS wordmark", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);

  await expect(page.getByRole("heading", { level: 1, name: "AXIS" })).toBeVisible();
  await expect(page).toHaveTitle("AXIS");
});

test("the page renders on the theme background, not white", async ({ page }) => {
  await page.goto("/");

  // GAME_BIBLE §11.3: the background is the Kiln key-line black (#0b0b0c).
  // A white flash here means tokens.css failed to load.
  const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(background).toBe("rgb(11, 11, 12)");
});

test("no console errors on boot", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
  });
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/");
  await page.waitForLoadState("networkidle");

  expect(errors).toEqual([]);
});
