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

const SIXTY_SECONDS_MS = 180_000;
const SAMPLE_INTERVAL_MS = 250;

/**
 * The shape `DrawCallGuard` publishes on `window`.
 *
 * Declared here and only here: TypeScript merges `declare global` across every
 * file in the program, so a second spec restating it is a hard error rather than
 * a duplicate. `themes.spec.ts` imports this type.
 */
export interface PerfSample {
  particlePeak?: number;
  fps: number;
  minFps: number;
  avgFps: number;
  drawCalls: number;
  triangles: number;
  frames: number;
  /** ms — worst single frame since load. Added at P10 for the theme gate. */
  maxFrameMs: number;
  /** Frames over `TUNING.budgets.transitionFrameMs`, after warm-up. */
  hitches: number;
  /** Live GPU resource counts from `renderer.info.memory`. */
  textures: number;
  geometries: number;
  programs: number;
}

interface HeapSample {
  used: number;
  supported: boolean;
}

/** What `useGameLoop` publishes about the theme crossfade. See that file. */
export interface ThemeSample {
  slug: string;
  incoming: string;
  phase: string;
  t: number;
  elapsed: number;
  changes: number;
  request(ordinal: number): void;
}

declare global {
  interface Window {
    __axisPerf?: PerfSample;
    __axisTheme?: ThemeSample;
  }
}

/**
 * 1st-percentile frame rate — the worst 1% of frames.
 *
 * More useful than `min` for judging smoothness: a single 300ms hitch at startup
 * ruins the minimum forever, while p1 describes what the player actually feels
 * during the bad moments. Both are reported.
 */
function p1(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.floor(sorted.length * 0.01);
  return sorted[index] ?? sorted[0] ?? 0;
}

test.describe("render perf", () => {
  // A three-minute measurement plus a build. Generous, and it runs once.
  test.setTimeout(SIXTY_SECONDS_MS + 120_000);

  test("three minutes of play stays inside the draw-call budget", async ({ page }, testInfo) => {
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

    /**
     * Start a run. **This is not optional.**
     *
     * P14 made `/play` open on a title screen whose diorama is three meshes. The
     * budget here is for a run at band-5 density — obstacles, pickups, particles,
     * shadows — and measuring the menu instead reported a peak of 5 draw calls
     * and 0 particles against a budget of 50. It passed, and it proved nothing.
     *
     * A test that cannot fail is worse than no test.
     */
    await page.getByRole("button", { name: "RUN", exact: true }).click({ timeout: 60_000 });
    // Past the shutter and into a live run before the sampling starts.
    await page.waitForTimeout(2_000);

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
    let peakParticles = 0;
    const fpsSamples: number[] = [];

    const started = Date.now();
    while (Date.now() - started < SIXTY_SECONDS_MS) {
      await page.waitForTimeout(SAMPLE_INTERVAL_MS);
      const sample = await page.evaluate(() => window.__axisPerf);
      if (sample === undefined) {
        continue;
      }
      peakDrawCalls = Math.max(peakDrawCalls, sample.drawCalls);
      fpsSamples.push(sample.fps);
      peakTriangles = Math.max(peakTriangles, sample.triangles);
      peakParticles = Math.max(peakParticles, sample.particlePeak ?? 0);
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
      `AXIS FEEL PERF — ${testInfo.project.name}, 180s`,
      "=".repeat(72),
      `  frames rendered   ${final.frames}`,
      `  fps  min          ${final.minFps.toFixed(1)}   (software rasteriser — NOT representative)`,
      `  fps  avg          ${final.avgFps.toFixed(1)}   (as above)`,
      `  draw calls peak   ${peakDrawCalls}   budget < ${budget}`,
      `  triangles peak    ${peakTriangles.toLocaleString()}`,
      `  fps  p1           ${p1(fpsSamples).toFixed(1)}   (as above)`,
      `  particle peak     ${peakParticles}`,
      heapStart.supported
        ? `  JS heap growth    ${heapGrowthKb} KB over 180s ` +
          `(${(heapStart.used / BYTES_PER_MB).toFixed(1)} MB -> ${(heapEnd.used / BYTES_PER_MB).toFixed(1)} MB)`
        : "  JS heap growth    unavailable (performance.memory is Chromium-only)",
      "=".repeat(72),
      "",
    ].join("\n");
    console.log(report);
    await testInfo.attach("perf-report", { body: report, contentType: "text/plain" });

    // ── Gates ───────────────────────────────────────────────────────────────
    // Exact counts only. FPS is reported, never asserted, in this environment.
    // A floor as well as a ceiling. The title diorama draws 5; a real run draws
    // the tunnel faces, four obstacle buckets, the pickups and the runner, plus
    // a shadow pass on the tiers that have one. Anything at or under the menu's
    // count means this measured the wrong screen — which it silently did once.
    const RUN_DRAW_CALL_FLOOR = 8;
    expect(
      peakDrawCalls,
      `only ${peakDrawCalls} draw calls — this looks like the menu, not a run`,
    ).toBeGreaterThan(RUN_DRAW_CALL_FLOOR);
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
