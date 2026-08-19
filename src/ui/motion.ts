/**
 * The motion scale, in the one unit the rest of the game uses.
 *
 * Every UI duration is authored as a whole number of 60Hz sim ticks in
 * `TUNING.ui`, and converted here. Nothing else in `src/ui/` should touch
 * `fixedDelta` — if a duration is not on this list, it does not exist.
 *
 * Two of these are borrowed rather than chosen: `screen` is `rollDuration` and
 * `slow` is `slideDuration`, so a screen transition takes exactly as long as the
 * roll the player already has in their hands. `tests/ui/tokens.test.ts` asserts
 * that, so retuning either verb either updates the UI or fails the suite.
 */

import { TUNING } from "@/game/config/tuning";

const MS_PER_SECOND = 1000;

/** Converts sim ticks to milliseconds. */
export function ticksToMs(ticks: number): number {
  return ticks * TUNING.sim.fixedDelta * MS_PER_SECOND;
}

/** The scale, resolved once. */
export const MOTION = Object.freeze({
  instant: ticksToMs(TUNING.ui.instantTicks),
  fast: ticksToMs(TUNING.ui.fastTicks),
  base: ticksToMs(TUNING.ui.baseTicks),
  screen: ticksToMs(TUNING.ui.screenTicks),
  slow: ticksToMs(TUNING.ui.slowTicks),
  registerLead: ticksToMs(TUNING.ui.registerLeadTicks),
  odometerRoll: ticksToMs(TUNING.ui.odometerRollTicks),
  ringKick: ticksToMs(TUNING.ui.ringKickTicks),
  flowPopup: ticksToMs(TUNING.ui.flowPopupTicks),
  deathBeat: ticksToMs(TUNING.ui.deathBeatTicks),
  deathCount: ticksToMs(TUNING.ui.deathCountTicks),
});

/** The sim's easing curves, as CSS. Reused, never re-chosen. */
export const EASE = Object.freeze({
  out: "cubic-bezier(0.215, 0.61, 0.355, 1)",
  inOut: "cubic-bezier(0.645, 0.045, 0.355, 1)",
  step: "steps(4, end)",
});

/**
 * `easeOutCubic`, evaluated.
 *
 * The same curve as `EASE.out` and as the sim's lane tween, for the places that
 * animate in JS rather than in CSS — the death-screen count-up and the shutter,
 * both of which need to be interruptible at an arbitrary point, which a CSS
 * transition cannot be.
 */
export function easeOutCubic(t: number): number {
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  const inverse = 1 - clamped;
  return 1 - inverse * inverse * inverse;
}

/** `easeInOutCubic` — the roll's curve. Used by the shutter. */
export function easeInOutCubic(t: number): number {
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  const HALF = 0.5;
  const FOUR = 4;
  const TWO = 2;
  if (clamped < HALF) {
    return FOUR * clamped * clamped * clamped;
  }
  const shifted = -TWO * clamped + TWO;
  return 1 - (shifted * shifted * shifted) / TWO;
}

/** True when the player or their OS has asked for reduced motion. */
export function motionIsReduced(): boolean {
  if (typeof document === "undefined") {
    return false;
  }
  const explicit = document.documentElement.dataset["motion"];
  if (explicit === "reduced") {
    return true;
  }
  if (explicit === "full") {
    return false;
  }
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}
