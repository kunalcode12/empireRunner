import { expect, test } from "@playwright/test";

/**
 * Reduced motion, verified in a real browser.
 *
 * The unit tests prove the gate resolves correctly; this proves the game still
 * BOOTS AND RUNS with it on, which is the part that actually matters. A
 * reduced-motion mode that makes the game unplayable is not an accessibility
 * feature.
 */
test.describe("reduced motion", () => {
  test.setTimeout(120_000);

  test("the game runs, renders and stays in budget with motion reduced", async ({
    page,
  }, testInfo) => {
    const budget = testInfo.project.name.startsWith("mobile") ? 50 : 100;
    const errors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") {
        errors.push(m.text());
      }
    });
    page.on("pageerror", (e) => errors.push(e.message));

    await page.goto("/play?motion=reduced");
    await page.waitForFunction(() => window.__axisPerf !== undefined, null, { timeout: 60_000 });
    await page.waitForTimeout(8_000);

    const sample = await page.evaluate(() => window.__axisPerf);
    expect(sample).toBeDefined();
    // Still rendering: the scene is not blanked by turning effects off.
    expect(sample?.drawCalls ?? 0).toBeGreaterThan(0);
    expect(sample?.drawCalls ?? 0).toBeLessThan(budget);
    expect(sample?.frames ?? 0).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });

  test("full motion and reduced motion both boot without error", async ({ page }) => {
    for (const mode of ["full", "reduced"]) {
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(`/play?motion=${mode}`);
      await expect(page.locator("canvas")).toBeVisible({ timeout: 60_000 });
      expect(errors, mode).toEqual([]);
    }
  });
});
