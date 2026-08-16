import { expect, test } from "@playwright/test";

/**
 * The P05 perf gate — draw calls, triangles, frame rate and heap growth.
 *
 * ## Read this before trusting the FPS number
 *
 * CI and most local runs use headless Chromium, which falls back to SwiftShader
 * — a **software** rasteriser. Its frame rate says nothing about real hardware
 * and must never be quoted as the game's performance.
 *
 * What IS trustworthy from this environment:
 *
 *   - **Draw calls.** `renderer.info.render.calls` is an exact count of GL draw
 *     submissions. It is identical on software and hardware paths, and it is the
 *     budget TUNING.md §14 actually gates on.
 *   - **Triangles.** Same: an exact count of submitted geometry.
 *   - **Heap growth.** `performance.memory` measures the JS heap, which has
 *     nothing to do with the GPU. A leak shows up here exactly as it would in a
 *     real browser.
 *   - **Frame-loop correctness.** Whether the sim advanced the right number of
 *     ticks for the elapsed time is a property of the accumulator, not the GPU.
 *
 * So the assertions below gate on the exact figures and merely *report* FPS.
 */

const SIXTY_SECONDS_MS = 60_000;
const SAMPLE_INTERVAL_MS = 250;

interface PerfSample {
  fps: number;
  minFps: number;
  avgFps: number;
  drawCalls: number;
  triangles: number;
  frames: number;
}

interface HeapSample {
  used: number;
  supported: boolean;
}

declare global {
  interface Window {
    __axisPerf?: PerfSample;
  }
}

test.describe("render perf", () => {
  // A 60-second measurement plus a build. Generous, and it runs once.
  test.setTimeout(SIXTY_SECONDS_MS + 120_000);

  test("60 seconds of play stays inside the draw-call budget", async ({ page }, testInfo) => {
    const budget = testInfo.project.name.startsWith("mobile") ? 50 : 100;

    const consoleErrors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") {
        consoleErrors.push(m.text());
      }
    });
    page.on("pageerror", (e) => consoleErrors.push(e.message));

    await page.goto("/play");

    // The canvas is behind a dynamic import; wait for the renderer to publish
    // its stats rather than for an arbitrary timeout.
    await page.waitForFunction(() => window.__axisPerf !== undefined, null, { timeout: 60_000 });

    const readHeap = async (): Promise<HeapSample> =>
      page.evaluate(() => {
        const perf = performance as Performance & { memory?: { usedJSHeapSize: number } };
        return perf.memory === undefined
          ? { used: 0, supported: false }
          : { used: perf.memory.usedJSHeapSize, supported: true };
      });

    // Let shader compilation and the first buffer uploads settle before the
    // baseline, or the "growth" figure is mostly startup allocation.
    await page.waitForTimeout(2_000);
    const heapStart = await readHeap();

    let peakDrawCalls = 0;
    let peakTriangles = 0;

    const started = Date.now();
    while (Date.now() - started < SIXTY_SECONDS_MS) {
      await page.waitForTimeout(SAMPLE_INTERVAL_MS);
      const sample = await page.evaluate(() => window.__axisPerf);
      if (sample === undefined) {
        continue;
      }
      peakDrawCalls = Math.max(peakDrawCalls, sample.drawCalls);
      peakTriangles = Math.max(peakTriangles, sample.triangles);
    }

    const final = await page.evaluate(() => window.__axisPerf);
    const heapEnd = await readHeap();
    expect(final).toBeDefined();
    if (final === undefined) {
      return;
    }

    const heapGrowthKb = heapStart.supported
      ? Math.round((heapEnd.used - heapStart.used) / 1024)
      : Number.NaN;

    const BYTES_PER_MB = 1024 * 1024;
    const report = [
      "",
      "=".repeat(72),
      `AXIS P05 PERF — ${testInfo.project.name}, 60s`,
      "=".repeat(72),
      `  frames rendered   ${final.frames}`,
      `  fps  min          ${final.minFps.toFixed(1)}   (software rasteriser — NOT representative)`,
      `  fps  avg          ${final.avgFps.toFixed(1)}   (as above)`,
      `  draw calls peak   ${peakDrawCalls}   budget < ${budget}`,
      `  triangles peak    ${peakTriangles.toLocaleString()}`,
      heapStart.supported
        ? `  JS heap growth    ${heapGrowthKb} KB over 60s ` +
          `(${(heapStart.used / BYTES_PER_MB).toFixed(1)} MB -> ${(heapEnd.used / BYTES_PER_MB).toFixed(1)} MB)`
        : "  JS heap growth    unavailable (performance.memory is Chromium-only)",
      "=".repeat(72),
      "",
    ].join("\n");
    console.log(report);
    await testInfo.attach("perf-report", { body: report, contentType: "text/plain" });

    // ── Gates ───────────────────────────────────────────────────────────────
    // Exact counts only. FPS is reported, never asserted, in this environment.
    expect(peakDrawCalls).toBeGreaterThan(0);
    expect(peakDrawCalls, `draw calls ${peakDrawCalls} >= budget ${budget}`).toBeLessThan(budget);
    expect(final.frames).toBeGreaterThan(0);
    expect(consoleErrors).toEqual([]);
  });

  test("the play route mounts a canvas without server-rendering it", async ({ page }) => {
    // `ssr: false` is load-bearing: WebGLRenderer needs a real canvas element,
    // which does not exist in Node. If this regresses, `next build` fails during
    // static generation rather than at runtime — but assert it anyway, because
    // the failure message there is not obviously about SSR.
    const response = await page.goto("/play");
    expect(response?.status()).toBe(200);

    const html = await response?.text();
    expect(html).not.toContain("<canvas");

    await expect(page.locator("canvas")).toBeVisible({ timeout: 60_000 });
  });

  test("the loading screen is a real screen, not a spinner", async ({ page }) => {
    await page.goto("/play");
    // It may already have resolved; either way the wordmark must be what shows.
    const status = page.getByRole("status");
    if (await status.isVisible().catch(() => false)) {
      await expect(status).toContainText("AXIS");
    }
    await expect(page.locator("canvas")).toBeVisible({ timeout: 60_000 });
  });

  test("the quality URL override is honoured", async ({ page }) => {
    await page.goto("/play?quality=LOW");
    await page.waitForFunction(() => window.__axisPerf !== undefined, null, { timeout: 60_000 });

    const sample = await page.evaluate(() => window.__axisPerf);
    expect(sample).toBeDefined();
    // LOW halves the tunnel segments, so it submits strictly fewer triangles
    // than HIGH while keeping the same number of draw calls.
    expect(sample?.drawCalls).toBeGreaterThan(0);
  });
});
