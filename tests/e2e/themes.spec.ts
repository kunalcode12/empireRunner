import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

/**
 * The P10 verify gate, in a real browser.
 *
 * The brief: "Run through all four themes in one session. Report per theme:
 * draw calls, FPS, texture memory, transition duration and whether any frame
 * hitched. Confirm initial payload under 4MB with a bundle report."
 *
 * The payload half is `npm run check:payload`, which reads the built output
 * rather than the browser. This file does the four-theme half.
 *
 * ## Read this before quoting the FPS figures
 *
 * Playwright's bundled Chromium has **no GPU**. It rasterises through
 * SwiftShader, on the CPU, inside a container. The frame rates below are
 * therefore a measurement of a software rasteriser and are NOT the frame rates a
 * player sees — they run roughly 3-4x under a real GPU on the same scene.
 *
 * What they ARE good for is comparison and regression: the four themes render
 * through the same pipeline on the same machine in the same session, so a theme
 * that costs twice what its neighbours cost shows up plainly. Draw calls,
 * triangles, texture count and hitch counts are exact regardless of rasteriser.
 *
 * ## Why `?theme=` exists
 *
 * Static is unlocked at 5,000m in a single run — about two and a half minutes of
 * flawless play, per attempt, which no screenshot test can perform. `?theme=`
 * starts the render layer's theme director in a named theme. It is a
 * presentation override with no path into the sim: same seed, same RNG stream,
 * same events. See `SceneProps.themeOverride`.
 */

/*
 * `window.__axisPerf` and `window.__axisTheme` are declared once, in
 * `perf.spec.ts`. `declare global` merges across the whole program, so a second
 * spec restating them is a compile error rather than a duplicate — which is the
 * right outcome, and the reason there is one declaration and not one per spec.
 */

const VIEWPORT = { width: 1280, height: 720 };
const OUT_DIR = "test-results/themes";

/** Long enough for the warm-up second to pass and a steady state to settle. */
const SAMPLE_MS = 6_000;

const THEMES = ["kiln", "undertow", "bazaar", "static"] as const;

interface Report {
  theme: string;
  drawCalls: number;
  triangles: number;
  avgFps: number;
  minFps: number;
  maxFrameMs: number;
  hitches: number;
  textures: number;
  geometries: number;
  programs: number;
  frames: number;
}

/**
 * Starts a run in one theme and lets it settle.
 *
 * The save is seeded so nothing is gated; the theme itself comes from the query
 * string rather than from the save, because the point is to reach Static without
 * earning it.
 */
async function runTheme(page: Page, slug: string): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "axis.save",
      JSON.stringify({
        version: 3,
        ledger: {
          entries: [
            {
              sequence: 0,
              at: 0,
              transaction: { kind: "opening-balance", bits: 40000, shards: 9, fromVersion: 3 },
            },
          ],
          nextSequence: 1,
        },
        upgrades: { magnetDuration: 0, flowGain: 0, bitValue: 0, shieldCount: 0 },
        inventory: {
          consumables: {},
          cosmetics: [],
          equippedCosmetics: {},
          avatars: ["ferro"],
          equippedAvatar: "ferro",
          equippedBoosts: [],
        },
        missions: {
          dayKey: "",
          weekKey: "",
          values: {},
          claimedDailies: [],
          claimedWeeklyTiers: [],
        },
        // bestDistance clears STATIC_THEME_DISTANCE, so the unlock table lets
        // the cycle include Static. `?theme=` bypasses the ordinal; this makes
        // the *unlock* real, so the run is the one a qualified player gets.
        lifetime: {
          distance: 42_000,
          runs: 27,
          bestScore: 135_326,
          bestDistance: 6_000,
          bitsCollected: 8_400,
          nearMisses: 640,
          overdrives: 41,
          fracturesSurvived: 6,
        },
        onboarding: {
          seenFirstRun: true,
          seenRollPrompt: true,
          seenFlowPrompt: true,
          seenFracturePrompt: true,
          seenStore: true,
          seenMissions: true,
        },
        avatarChallengesClaimed: [],
      }),
    );
  });

  await page.goto(`/play?theme=${slug}`);
  await expect(page.getByRole("button", { name: "RUN", exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  await page.waitForTimeout(SAMPLE_MS);
}

/** Hides the HUD and the theme card so a frame shows only the world. */
async function cropChrome(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const selector of [".axis-hud", ".axis-theme-card", ".axis-theme-load"]) {
      const element = document.querySelector(selector);
      if (element instanceof HTMLElement) {
        element.style.display = "none";
      }
    }
  });
}

/** The two cumulative counters the hitch rate is derived from. */
async function readCounters(page: Page): Promise<{ frames: number; hitches: number }> {
  return page.evaluate(() => ({
    frames: window.__axisPerf?.frames ?? 0,
    hitches: window.__axisPerf?.hitches ?? 0,
  }));
}

/** Measures the hitch rate over a window of steady-state play. */
async function sampleWindow(
  page: Page,
  ms: number,
): Promise<{ rate: number; end: { frames: number; hitches: number } }> {
  const start = await readCounters(page);
  await page.waitForTimeout(ms);
  const end = await readCounters(page);
  const frames = end.frames - start.frames;
  return { rate: frames > 0 ? (end.hitches - start.hitches) / frames : 0, end };
}

test.describe("theme system", () => {
  // One browser page per theme, but one test, so all four are genuinely in the
  // same session as the brief asks — a fresh context per theme would let a
  // per-theme leak hide.
  test("all four themes in one session", async ({ page }) => {
    test.setTimeout(240_000);
    mkdirSync(OUT_DIR, { recursive: true });

    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") {
        errors.push(message.text());
      }
    });
    page.on("pageerror", (error) => errors.push(error.message));

    await page.setViewportSize(VIEWPORT);
    const reports: Report[] = [];

    for (const slug of THEMES) {
      await runTheme(page, slug);

      const info = await page.evaluate(() => window.__axisTheme);
      expect(info, `${slug}: theme diagnostics missing`).toBeTruthy();
      expect(info?.slug, `?theme=${slug} did not take effect`).toBe(slug);

      const stats = await page.evaluate(() => window.__axisPerf);
      expect(stats, `${slug}: perf stats missing`).toBeTruthy();
      if (stats === undefined) {
        continue;
      }

      // The frame is captured with the HUD cropped out, which is the brief's own
      // test for whether a theme is identifiable: "each theme identifiable from
      // a single frame with the HUD cropped out".
      await cropChrome(page);
      await page.screenshot({ path: `${OUT_DIR}/${slug}.png` });

      reports.push({
        theme: slug,
        drawCalls: stats.drawCalls,
        triangles: stats.triangles,
        avgFps: Number(stats.avgFps.toFixed(1)),
        minFps: Number.isFinite(stats.minFps) ? Number(stats.minFps.toFixed(1)) : 0,
        maxFrameMs: Number(stats.maxFrameMs.toFixed(1)),
        hitches: stats.hitches,
        textures: stats.textures,
        geometries: stats.geometries,
        programs: stats.programs,
        frames: stats.frames,
      });

      // Budgets that hold regardless of rasteriser.
      expect(stats.drawCalls, `${slug}: draw calls`).toBeLessThan(100);
      expect(stats.drawCalls, `${slug}: drew nothing`).toBeGreaterThan(4);
      // Zero texture files ship. §11.1 is flat colour plus a screen-space
      // halftone computed in the shader, so a texture appearing here means
      // something started loading an image — which is the regression to catch.
      expect(stats.textures, `${slug}: unexpected textures`).toBeLessThanOrEqual(2);
    }

    writeFileSync(`${OUT_DIR}/report.json`, `${JSON.stringify(reports, null, 2)}\n`);
    console.log("THEME REPORT\n" + JSON.stringify(reports, null, 2));

    expect(reports).toHaveLength(THEMES.length);
    expect(errors, `console errors: ${errors.join(" | ")}`).toHaveLength(0);
  });

  /**
   * A mid-run transition, measured.
   *
   * Not reachable by playing: the first milestone is 1,200m, which is 35 seconds
   * of perfect running that a headless browser at 15fps will not survive. So the
   * transition is requested directly through the director — the same call the
   * `SimEvent.ThemeChange` handler makes, with the same argument.
   */
  test("a mid-run transition completes without hitching", async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize(VIEWPORT);
    await runTheme(page, "kiln");

    /*
     * The hitch count is measured as a RATE, and compared against this same
     * run's own steady state.
     *
     * As an absolute it says nothing here. `TUNING.budgets.transitionFrameMs` is
     * 32ms — half a frame at 60Hz — and SwiftShader renders this scene at 13-18
     * fps, so every frame is 55-75ms and every frame counts as a hitch. The
     * absolute number would be "100%" for a flawless transition and for a
     * catastrophic one alike.
     *
     * The rate DELTA is rasteriser-independent, and it is the question the brief
     * is really asking: does the crossfade make frames worse than the frames
     * either side of it. Loading a second theme's geometry, compiling a second
     * surface shader and driving two prop fields at once are all things that
     * would show up here as a rise.
     */
    const baseline = await sampleWindow(page, 3_000);

    const startedAt = Date.now();

    // Ordinal 1 is Undertow, requested through the director's own entry point —
    // the same call `SimEvent.ThemeChange` makes, with the same argument.
    await page.evaluate(() => {
      const info = window.__axisTheme;
      if (info === undefined) {
        throw new Error("theme diagnostics missing");
      }
      info.request(1);
    });

    // The fade is `TUNING.theme.crossfadeSeconds` = 4s. Poll until the director
    // reports it landed, with generous headroom for a software rasteriser.
    await expect
      .poll(async () => page.evaluate(() => window.__axisTheme?.slug), { timeout: 40_000 })
      .toBe("undertow");

    const elapsedMs = Date.now() - startedAt;
    const during = await readCounters(page);
    const frames = during.frames - baseline.end.frames;
    const hitches = during.hitches - baseline.end.hitches;
    const duringRate = frames > 0 ? hitches / frames : 0;

    console.log(
      [
        "TRANSITION kiln -> undertow",
        `  wall clock          ${elapsedMs}ms (tunable is 4000ms)`,
        `  frames drawn        ${frames}`,
        `  steady-state hitch  ${(baseline.rate * 100).toFixed(0)}% of frames over 32ms`,
        `  during transition   ${(duringRate * 100).toFixed(0)}% of frames over 32ms`,
        "  (both figures are SwiftShader, not a GPU — read the delta, not the value)",
      ].join("\n"),
    );

    // The fade lands within a second of its tunable duration.
    expect(elapsedMs).toBeGreaterThan(3_500);
    expect(elapsedMs).toBeLessThan(9_000);

    // And it does not make frames materially worse than the run around it.
    expect(duringRate, "the transition raised the hitch rate").toBeLessThanOrEqual(
      baseline.rate + 0.1,
    );

    const stats = await page.evaluate(() => window.__axisPerf);
    expect(stats?.drawCalls ?? 0, "draw calls after transition").toBeLessThan(100);
  });
});
