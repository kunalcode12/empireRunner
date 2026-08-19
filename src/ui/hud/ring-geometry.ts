/**
 * The AXIS ring's geometry, as pure functions.
 *
 * Split out of `AxisRing.ts` so it can be tested without a DOM. The repository
 * has no jsdom and adding one is a dependency change, but more to the point the
 * interesting part of that component is arithmetic — where the corners fall, how
 * much of the perimeter a Flow value fills, how long a musical bar is — and
 * arithmetic is better tested directly than through a rendered element.
 *
 * The DOM behaviour that remains in `AxisRing.ts` is covered by
 * `tests/e2e/ui.spec.ts` against a real browser.
 */

import { TUNING } from "@/game/config/tuning";

/** The path is declared with `pathLength="100"`, so all fill maths is percent. */
export const PATH_LENGTH = 100;
/** viewBox units. Independent of the rendered pixel size. */
export const BOX = 100;
/** Corner ticks: the redundant, non-hue channel for the quarter marks. */
export const TICK_LENGTH = 9;
/**
 * How far inside the stroke the ticks start.
 *
 * They used to begin exactly on the path, which drew them *over* the track — so
 * on an empty meter they read as three gaps in the ring rather than as marks
 * beside it. Clearing the stroke turns them back into what they are.
 */
export const TICK_GAP = 7;

const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;

/**
 * One bar of music, in ms — the at-100 pulse period.
 *
 * Derived arithmetically from `TUNING.audio` rather than read from the audio
 * layer, so the meter breathes in time with the track without `src/ui/` taking
 * a dependency on the Web Audio graph. It is the ideal tempo rather than the
 * sample-quantised one the stems actually run at; the difference is 5.95µs per
 * loop (TUNING §16.3) and no eye resolves that in a CSS animation.
 */
export function barMilliseconds(): number {
  const beatSeconds = SECONDS_PER_MINUTE / TUNING.audio.musicBpm;
  return beatSeconds * TUNING.audio.beatsPerBar * MS_PER_SECOND;
}

/**
 * The ring path, clockwise from the bottom-left corner.
 *
 * Up the left side, across the top, down the right, back along the bottom. In
 * SVG's y-down space that is `M x0,y1 -> x0,y0 -> x1,y0 -> x1,y1 -> Z`, so the
 * fill starts at the corner nearest the player's thumb and closes there.
 */
export function ringPath(inset: number): string {
  const a = inset;
  const b = BOX - inset;
  return `M ${a},${b} L ${a},${a} L ${b},${a} L ${b},${b} Z`;
}

/**
 * One side of the square, by face index.
 *
 * Face 0 is whichever face gravity points into — the floor — so it is the bottom
 * edge. 1 is the right wall, 2 the ceiling, 3 the left wall, matching the
 * `+1 = roll right` convention in GAME_BIBLE §3.1.
 */
export function facePath(face: number, inset: number): string {
  const a = inset;
  const b = BOX - inset;
  switch (face) {
    case 1:
      return `M ${b},${a} L ${b},${b}`;
    case 2:
      return `M ${a},${a} L ${b},${a}`;
    case 3:
      return `M ${a},${a} L ${a},${b}`;
    default:
      return `M ${a},${b} L ${b},${b}`;
  }
}

/** Wraps any integer into 0..3. Negative and out-of-range inputs are expected. */
export function normaliseFace(face: number): number {
  const count = TUNING.geometry.faceCount;
  if (!Number.isFinite(face)) {
    return 0;
  }
  return ((Math.trunc(face) % count) + count) % count;
}

/**
 * `stroke-dashoffset` for a Flow value.
 *
 * 100 at empty, 0 at full. Quantised to a tenth of a percent — below that the
 * attribute write is invisible and the style invalidation is not.
 */
export function dashOffsetForFlow(flow: number): number {
  if (!Number.isFinite(flow)) {
    return PATH_LENGTH;
  }
  const clamped = Math.max(0, Math.min(TUNING.flow.flowMax, flow));
  const rounded = Math.round(clamped * 10) / 10;
  return PATH_LENGTH - (rounded / TUNING.flow.flowMax) * PATH_LENGTH;
}

/** True once the meter is full and Overdrive can be spent. */
export function isFull(flow: number): boolean {
  return Number.isFinite(flow) && flow >= TUNING.flow.flowMax;
}

/**
 * Where the three quarter-marks sit, as `[x1, y1, x2, y2]`.
 *
 * 25/50/75% land exactly on corners of the square, which is the readability
 * argument for the whole shape — but a corner is only a landmark if the eye can
 * find it, so these ticks mark the midpoint of each traversed side.
 */
export function tickCoordinates(
  inset: number,
): readonly (readonly [number, number, number, number])[] {
  const half = BOX / 2;
  const start = inset + TICK_GAP;
  const end = start + TICK_LENGTH;
  return [
    [start, half, end, half],
    [half, start, half, end],
    [BOX - start, half, BOX - end, half],
  ];
}
