/**
 * The mechanical counter's arithmetic.
 *
 * GAME_BIBLE §11.2 is unusually specific about this element: "digits translate
 * vertically, the way a fuel pump or an odometer moves. They never fade, never
 * scale-pop, never count up with an easing tween." The "never fade" half is
 * enforced in `tests/ui/tokens.test.ts` (no opacity in any transition) and in
 * the browser by `tests/e2e/ui.spec.ts`. This covers the digits themselves.
 */

import { describe, expect, it } from "vitest";
import { TUNING } from "@/game/config/tuning";
import { DIGITS, columnsFor, renderedText, stripOffsetPercent } from "@/ui/hud/odometer-math";

const MAX = TUNING.ui.odometerMaxDigits;

describe("digit columns", () => {
  it("puts the right digit in every place", () => {
    const columns = columnsFor(148_230, MAX, true);
    expect(renderedText(columns)).toBe("148,230");
  });

  it("marks leading zeros insignificant so they can be collapsed", () => {
    const columns = columnsFor(7, MAX, true);
    // The state model always describes every column; the renderer decides what
    // to do with an insignificant one. It collapses them — see the note in
    // Odometer.ts about the 375px collision that reserving their width caused.
    expect(columns).toHaveLength(MAX);
    expect(columns.filter((column) => column.significant)).toHaveLength(1);
    expect(renderedText(columns)).toBe("7");
  });

  it("renders zero as a single visible zero, not as nothing", () => {
    const columns = columnsFor(0, MAX, true);
    expect(renderedText(columns)).toBe("0");
    expect(columns[MAX - 1]?.significant).toBe(true);
  });

  it("groups thousands and never leaves a leading separator", () => {
    expect(renderedText(columnsFor(1_000, MAX, true))).toBe("1,000");
    expect(renderedText(columnsFor(999, MAX, true))).toBe("999");
    expect(renderedText(columnsFor(1_234_567, MAX, true))).toBe("1,234,567");
    // The most common bug in a grouped counter: ",999".
    expect(renderedText(columnsFor(999, MAX, true)).startsWith(",")).toBe(false);
  });

  it("omits separators when grouping is off — distance reads better ungrouped", () => {
    expect(renderedText(columnsFor(2_406, 5, false))).toBe("2406");
  });

  /**
   * A 20-minute run cannot reach seven digits, which is exactly the condition
   * under which nobody notices the wrong branch. Pinning to all-nines shows an
   * obviously-capped value; truncating would render 10,000,000 as "0,000,000" —
   * a *smaller* number than the one before it.
   */
  it("pins to all-nines past capacity rather than truncating", () => {
    const columns = columnsFor(99_999_999, MAX, false);
    expect(renderedText(columns)).toBe("9".repeat(MAX));
  });

  it("floors a fractional value rather than rounding it up", () => {
    // Distance is a float and the counter must never claim a metre not travelled.
    expect(renderedText(columnsFor(2_406.99, MAX, false))).toBe("2406");
  });

  it("renders a hostile value as zero rather than as NaN", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -50]) {
      expect(renderedText(columnsFor(bad, MAX, true))).toBe("0");
    }
  });
});

describe("the strip translation", () => {
  it("moves up by one tenth of the strip per digit", () => {
    expect(stripOffsetPercent(0)).toBe(-0);
    expect(stripOffsetPercent(1)).toBe(-10);
    expect(stripOffsetPercent(9)).toBe(-90);
  });

  it("never leaves the strip", () => {
    for (let digit = 0; digit < DIGITS; digit += 1) {
      const offset = stripOffsetPercent(digit);
      expect(offset).toBeLessThanOrEqual(0);
      expect(offset).toBeGreaterThan(-100);
    }
  });

  it("is a pure function of the digit, so any font size works", () => {
    // Percentages rather than pixels: the same component renders at 72px on the
    // death screen and 16px in the title bar.
    expect(stripOffsetPercent(4)).toBe(stripOffsetPercent(4));
    expect(stripOffsetPercent(4)).toBe(-40);
  });
});

describe("the counter's capacity is enough for the game", () => {
  it("holds more than any reachable score", () => {
    // The P08 balance harness put a modelled expert at ~557,000 at p90 over a
    // ~10 minute run. Seven digits is an order of magnitude clear of that.
    expect(10 ** MAX).toBeGreaterThan(1_000_000);
  });
});
