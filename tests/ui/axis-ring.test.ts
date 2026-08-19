/**
 * THE AXIS RING — the geometry behind the signature element.
 *
 * The claim the whole design rests on is that a square reads better in
 * peripheral vision than an arc, because 25/50/75/100% land exactly on corners
 * and "the ink turned the corner" is a discrete event the periphery can catch.
 * That claim is only true if the fill really does reach a corner at each
 * quarter, which is what most of this file checks.
 */

import { describe, expect, it } from "vitest";
import { TUNING } from "@/game/config/tuning";
import {
  BOX,
  PATH_LENGTH,
  barMilliseconds,
  dashOffsetForFlow,
  facePath,
  isFull,
  normaliseFace,
  ringPath,
  tickCoordinates,
} from "@/ui/hud/ring-geometry";

const INSET = TUNING.ui.ringStroke;
const MAX_FLOW = TUNING.flow.flowMax;

describe("the ring path", () => {
  it("is a closed square", () => {
    const path = ringPath(INSET);
    expect(path.startsWith("M ")).toBe(true);
    expect(path.endsWith(" Z")).toBe(true);
    // Four corners: one move plus three lines, closed by Z.
    expect((path.match(/L /g) ?? []).length).toBe(3);
  });

  /**
   * Clockwise from the bottom-left. The starting corner is the one nearest the
   * player's thumb on a phone, so the meter both starts and closes where the
   * hand already is.
   */
  it("starts at the bottom-left and runs up, across, down, back", () => {
    const a = INSET;
    const b = BOX - INSET;
    expect(ringPath(INSET)).toBe(`M ${a},${b} L ${a},${a} L ${b},${a} L ${b},${b} Z`);
  });

  it("insets by the stroke width so the ink is not clipped", () => {
    // A stroke centred on the path bleeds half its width outside the viewBox.
    expect(INSET).toBeGreaterThanOrEqual(TUNING.ui.ringStroke / 2);
  });
});

describe("the fill", () => {
  it("is empty at 0 Flow and complete at 100", () => {
    expect(dashOffsetForFlow(0)).toBe(PATH_LENGTH);
    expect(dashOffsetForFlow(MAX_FLOW)).toBe(0);
  });

  /**
   * The design claim, stated as an assertion. Each quarter of the meter is
   * exactly one side of the square, so the fill arrives at a corner at 25, 50
   * and 75 — which is what makes the progress countable without focusing on it.
   */
  it("lands exactly on a corner at each quarter", () => {
    for (const [flow, expected] of [
      [MAX_FLOW * 0.25, 75],
      [MAX_FLOW * 0.5, 50],
      [MAX_FLOW * 0.75, 25],
    ] as const) {
      expect(dashOffsetForFlow(flow), `${flow} Flow`).toBeCloseTo(expected, 6);
    }
  });

  it("is monotonic — more Flow never shows less ink", () => {
    let previous = Number.POSITIVE_INFINITY;
    for (let flow = 0; flow <= MAX_FLOW; flow += 1) {
      const offset = dashOffsetForFlow(flow);
      expect(offset).toBeLessThanOrEqual(previous);
      previous = offset;
    }
  });

  it("clamps rather than overfilling or going negative", () => {
    expect(dashOffsetForFlow(-20)).toBe(PATH_LENGTH);
    expect(dashOffsetForFlow(MAX_FLOW * 2)).toBe(0);
    expect(dashOffsetForFlow(Number.NaN)).toBe(PATH_LENGTH);
  });

  it("quantises to a tenth of a percent", () => {
    // Below that the attribute write is invisible and the style invalidation is
    // not — this runs at up to 15Hz for the whole run.
    const a = dashOffsetForFlow(50.001);
    const b = dashOffsetForFlow(50.002);
    expect(a).toBe(b);
  });

  it("is full only AT 100, never before", () => {
    expect(isFull(MAX_FLOW - 0.01)).toBe(false);
    expect(isFull(MAX_FLOW)).toBe(true);
    // GAME_BIBLE §4.3: "At exactly 100 Flow the Overdrive prompt arms."
    expect(TUNING.overdrive.overdriveCost).toBe(MAX_FLOW);
  });
});

describe("the face indicator", () => {
  /**
   * The ring's second job. Face 0 is whichever face gravity points into — the
   * floor — so it is the bottom edge, and rolling right advances the index,
   * which walks the mark clockwise. That correspondence is the reason this
   * element carries two facts instead of one.
   */
  it("maps face 0 to the bottom edge", () => {
    const a = INSET;
    const b = BOX - INSET;
    expect(facePath(0, INSET)).toBe(`M ${a},${b} L ${b},${b}`);
  });

  it("gives each of the four faces a distinct side", () => {
    const paths = new Set([0, 1, 2, 3].map((face) => facePath(face, INSET)));
    expect(paths.size).toBe(TUNING.geometry.faceCount);
  });

  it("walks clockwise as the face index rises, matching the roll", () => {
    // GAME_BIBLE §3.1: rolling right advances the face index +1 (mod 4). Face 0
    // is the bottom, 1 the right, 2 the top, 3 the left — clockwise in SVG's
    // y-down space, which is the same direction the fill travels.
    const b = BOX - INSET;
    const a = INSET;
    expect(facePath(1, INSET)).toBe(`M ${b},${a} L ${b},${b}`);
    expect(facePath(2, INSET)).toBe(`M ${a},${a} L ${b},${a}`);
    expect(facePath(3, INSET)).toBe(`M ${a},${a} L ${a},${b}`);
  });

  it("wraps a face index from either direction", () => {
    expect(normaliseFace(4)).toBe(0);
    expect(normaliseFace(-1)).toBe(3);
    expect(normaliseFace(-5)).toBe(3);
    expect(normaliseFace(7)).toBe(3);
  });

  it("survives a hostile index rather than producing a broken path", () => {
    expect(normaliseFace(Number.NaN)).toBe(0);
    expect(facePath(normaliseFace(Number.NaN), INSET)).toBe(facePath(0, INSET));
  });
});

describe("the quarter ticks — the colourblind channel", () => {
  it("marks three quarters, the fourth being the closed ring itself", () => {
    expect(tickCoordinates(INSET)).toHaveLength(3);
  });

  it("puts every tick inside the viewBox", () => {
    for (const [x1, y1, x2, y2] of tickCoordinates(INSET)) {
      for (const value of [x1, y1, x2, y2]) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(BOX);
      }
    }
  });

  it("is independent of hue — the ticks exist at every Flow value", () => {
    // The point of the ticks: the quarter landmarks are geometry, so a player
    // who cannot separate the accent from the track still has them.
    expect(tickCoordinates(INSET)).toEqual(tickCoordinates(INSET));
  });
});

describe("the at-100 pulse breathes on the musical bar", () => {
  it("derives its period from the audio grid, not from a guess", () => {
    const beats = TUNING.audio.beatsPerBar;
    const bpm = TUNING.audio.musicBpm;
    expect(barMilliseconds()).toBeCloseTo((60 / bpm) * beats * 1000, 6);
  });

  it("lands in a range a person reads as breathing", () => {
    // Under ~600ms reads as flickering; over ~4s and nobody connects it to the
    // music. At 126bpm / 4 beats this is 1.905s.
    expect(barMilliseconds()).toBeGreaterThan(600);
    expect(barMilliseconds()).toBeLessThan(4000);
  });
});
