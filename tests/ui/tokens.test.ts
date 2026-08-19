/**
 * The token system's invariants.
 *
 * Two things are asserted here that a stylesheet cannot assert about itself:
 *
 *   - **Every UI duration is a whole number of sim ticks**, and the two long
 *     ones are the roll and the slide. That is the brief's "same clock as the
 *     game", and it is only true as long as nobody retunes `rollDuration`
 *     without looking at the UI.
 *   - **The boot palette in `tokens.css` matches the registry.** `:root` carries
 *     a hardcoded Kiln block so the first paint has real colour before any JS
 *     runs. That is the one duplication in the whole colour system, and this is
 *     what stops it drifting.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TUNING } from "@/game/config/tuning";
import { DEFAULT_THEME } from "@/game/config/themes";
import { EASE, MOTION, easeInOutCubic, easeOutCubic, ticksToMs } from "@/ui/motion";

const TOKENS_CSS = readFileSync(
  fileURLToPath(new URL("../../src/ui/tokens.css", import.meta.url)),
  "utf8",
);

/** Reads a custom property out of the `:root` block. */
function token(name: string): string | null {
  const match = new RegExp(`${name}:\\s*([^;]+);`).exec(TOKENS_CSS);
  return match?.[1]?.trim() ?? null;
}

describe("the motion scale is on the game's clock", () => {
  it("expresses every duration as a whole number of 60Hz ticks", () => {
    const ticks = [
      TUNING.ui.instantTicks,
      TUNING.ui.fastTicks,
      TUNING.ui.baseTicks,
      TUNING.ui.screenTicks,
      TUNING.ui.slowTicks,
      TUNING.ui.registerLeadTicks,
      TUNING.ui.odometerRollTicks,
      TUNING.ui.ringKickTicks,
      TUNING.ui.flowPopupTicks,
      TUNING.ui.deathBeatTicks,
      TUNING.ui.deathCountTicks,
    ];
    for (const value of ticks) {
      expect(Number.isInteger(value), `${value} is not a whole tick`).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
  });

  /**
   * The claim in TUNING §18 and in the brief's item 4. If someone retunes the
   * roll, this fails and they get to decide whether the UI follows — rather than
   * the two silently drifting apart.
   */
  it("makes a screen transition exactly as long as a roll", () => {
    expect(MOTION.screen).toBeCloseTo(TUNING.roll.rollDuration * 1000, 6);
    expect(TUNING.ui.screenTicks).toBe(Math.round(TUNING.roll.rollDuration * TUNING.sim.tickRate));
  });

  it("makes the slow beat exactly as long as a slide", () => {
    expect(MOTION.slow).toBeCloseTo(TUNING.slide.slideDuration * 1000, 6);
  });

  it("makes the fast beat exactly the coyote window", () => {
    expect(MOTION.fast).toBeCloseTo(TUNING.input.coyoteTime * 1000, 6);
  });

  it("orders the scale strictly", () => {
    expect(MOTION.instant).toBeLessThan(MOTION.fast);
    expect(MOTION.fast).toBeLessThan(MOTION.base);
    expect(MOTION.base).toBeLessThan(MOTION.screen);
    expect(MOTION.screen).toBeLessThan(MOTION.slow);
  });

  it("converts ticks to milliseconds exactly", () => {
    expect(ticksToMs(60)).toBeCloseTo(1000, 6);
    expect(ticksToMs(0)).toBe(0);
  });
});

describe("the easing curves are the sim's own", () => {
  it("reuses easeOutCubic and easeInOutCubic rather than inventing curves", () => {
    // The CSS strings and the JS functions have to be the same curve, because
    // some things animate in CSS (a button press) and some in JS (the shutter,
    // which must be interruptible at an arbitrary point).
    expect(EASE.out).toBe("cubic-bezier(0.215, 0.61, 0.355, 1)");
    expect(EASE.inOut).toBe("cubic-bezier(0.645, 0.045, 0.355, 1)");
  });

  it("easeOutCubic is monotonic and pinned at both ends", () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    let previous = -1;
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const value = easeOutCubic(t);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  it("easeOutCubic front-loads — half the time is 87.5% of the distance", () => {
    expect(easeOutCubic(0.5)).toBeCloseTo(0.875, 6);
  });

  it("easeInOutCubic is symmetric about the midpoint", () => {
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 10);
    for (const t of [0.1, 0.25, 0.4]) {
      expect(easeInOutCubic(t) + easeInOutCubic(1 - t)).toBeCloseTo(1, 10);
    }
  });

  it("clamps rather than extrapolating outside 0..1", () => {
    expect(easeOutCubic(-1)).toBe(0);
    expect(easeOutCubic(2)).toBe(1);
    expect(easeInOutCubic(-1)).toBe(0);
    expect(easeInOutCubic(2)).toBe(1);
  });
});

describe("the boot palette matches the theme registry", () => {
  /**
   * `tokens.css` hardcodes Kiln on `:root` so the first paint has real colour
   * before `theme.ts` runs. It is the only place a colour is written twice, and
   * a drift here means the page flashes one palette and settles into another.
   */
  it("uses the same six role values the registry declares for Kiln", () => {
    const ui = DEFAULT_THEME.ui;
    expect(token("--axis-ground")).toBe(ui.ground);
    expect(token("--axis-surface")).toBe(ui.surface);
    expect(token("--axis-text")).toBe(ui.text);
    expect(token("--axis-text-dim")).toBe(ui.textDim);
    expect(token("--axis-accent")).toBe(ui.accent);
    expect(token("--axis-structural")).toBe(ui.structural[0]);
  });

  it("declares the motion tokens at the same values the TS scale computes", () => {
    expect(token("--axis-motion-instant")).toBe(`${MOTION.instant}ms`);
    expect(token("--axis-motion-fast")).toBe(`${MOTION.fast}ms`);
    expect(token("--axis-motion-base")).toBe(`${MOTION.base}ms`);
    expect(token("--axis-motion-screen")).toBe(`${MOTION.screen}ms`);
    expect(token("--axis-motion-slow")).toBe(`${MOTION.slow}ms`);
  });
});

describe("the banned CSS idioms do not appear", () => {
  const SOURCES = ["../../src/ui/tokens.css", "../../src/ui/styles.css"].map((path) =>
    readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8"),
  );

  /**
   * GAME_BIBLE §11.1 bans soft gradients and blurred shadow. In the DOM those
   * arrive under different names, so the ban has to be written in CSS terms —
   * and it has to be a test, because "we agreed not to" survives exactly one
   * developer.
   */
  it("uses no backdrop-filter and no filter", () => {
    for (const source of SOURCES) {
      const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "");
      expect(stripped).not.toMatch(/backdrop-filter\s*:/);
      expect(stripped).not.toMatch(/[^-]filter\s*:/);
    }
  });

  it("gives every box-shadow a blur radius of zero", () => {
    for (const source of SOURCES) {
      const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "");
      const shadows = stripped.match(/box-shadow:\s*([^;]+);/g) ?? [];
      for (const shadow of shadows) {
        if (shadow.includes("var(") || shadow.includes("inset") || shadow.includes("none")) {
          continue;
        }
        // `Xpx Ypx BLUR SPREAD colour` — the third length is the blur.
        const lengths = shadow.match(/-?\d+px/g) ?? [];
        expect(lengths[2] ?? "0px", shadow).toBe("0px");
      }
    }
  });

  it("uses no border-radius", () => {
    for (const source of SOURCES) {
      const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "");
      expect(stripped).not.toMatch(/border-radius\s*:/);
    }
  });

  it("uses no gradient without hard stops", () => {
    const found: string[] = [];
    for (const source of SOURCES) {
      const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "");
      // One level of nesting, because every colour in these gradients is a
      // `var(--axis-*)` and a naive `[^)]*` terminates inside it. The first
      // version of this test did exactly that and reported a false failure.
      found.push(
        ...(stripped.match(/(?:linear|radial|conic)-gradient\((?:[^()]|\([^()]*\))*\)/g) ?? []),
      );
    }

    // Across both files, not per file: `tokens.css` legitimately has none.
    // Asserting at least one exists keeps the test from passing vacuously if a
    // refactor moves the halftone somewhere this regex no longer reaches.
    expect(found.length, "expected to find the halftone gradients").toBeGreaterThan(0);

    for (const gradient of found) {
      // A hard-stop gradient names two positions for the same boundary, e.g.
      // `X 0 45%, transparent 46%`. A soft ramp names one position or none.
      const stops = gradient.match(/\d+%/g) ?? [];
      expect(
        stops.length,
        `${gradient.replace(/\s+/g, " ")} has no hard stops`,
      ).toBeGreaterThanOrEqual(2);
    }
  });

  it("never transitions opacity", () => {
    for (const source of SOURCES) {
      const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "");
      const transitions = stripped.match(/transition[^;]*;/g) ?? [];
      for (const rule of transitions) {
        expect(rule, "numerals must never fade — GAME_BIBLE §11.2").not.toMatch(/opacity/);
      }
    }
  });
});

describe("layout budgets", () => {
  it("keeps every interactive target at or above 44px", () => {
    expect(TUNING.ui.minTargetPx).toBeGreaterThanOrEqual(44);
  });

  it("keeps the mobile ring above the 56px hit target GAME_BIBLE §6.2 requires", () => {
    // The ring is the Overdrive button on touch, so its size is a control size,
    // not a decoration size.
    expect(TUNING.ui.ringSizeMobile).toBeGreaterThanOrEqual(56);
    expect(TUNING.ui.ringSizeDesktop).toBeGreaterThanOrEqual(TUNING.ui.ringSizeMobile);
  });

  it("thickens the ring's stroke when full rather than adding glow", () => {
    expect(TUNING.ui.ringStrokeFull).toBeGreaterThan(TUNING.ui.ringStroke);
  });

  it("keeps the near-miss kick larger than the idle pulse", () => {
    // Otherwise a near-miss at 100 Flow is invisible under the breathing.
    expect(TUNING.ui.ringKickScale).toBeGreaterThan(TUNING.ui.ringPulseScale);
  });

  it("pushes the HUD well under the sim tick rate", () => {
    expect(TUNING.ui.hudPushHz).toBeLessThanOrEqual(15);
    expect(TUNING.ui.hudPushHz * 2).toBeLessThan(TUNING.sim.tickRate);
  });
});
