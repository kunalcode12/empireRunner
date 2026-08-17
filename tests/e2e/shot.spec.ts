import { test } from "@playwright/test";

/**
 * Frame capture, for looking at the game.
 *
 * Not a gate — it asserts nothing. It exists because draw-call and triangle
 * counts cannot tell you whether the tunnel is on screen, whether obstacles are
 * where the sim thinks they are, or whether the whole thing renders as a black
 * rectangle. Somebody has to look at it, and this is how.
 *
 * Skipped unless AXIS_SHOTS is set, so it never runs as part of the normal gate.
 */

const CAPTURE = process.env["AXIS_SHOTS"] === "1";

test.describe("frame capture", () => {
  test.skip(!CAPTURE, "set AXIS_SHOTS=1 to capture");
  test.setTimeout(180_000);

  test("captures a sequence across the first seconds of a run", async ({ page }) => {
    await page.goto("/play?quality=HIGH");
    await page.waitForFunction(() => window.__axisPerf !== undefined, null, { timeout: 60_000 });

    // Let shaders compile and the first chunks arrive.
    const MOMENTS = [1_000, 2_500, 4_000, 6_000, 9_000];
    let previous = 0;
    for (const at of MOMENTS) {
      await page.waitForTimeout(at - previous);
      previous = at;
      await page.screenshot({ path: `shots/frame-${at}ms.png` });
    }
  });
});
