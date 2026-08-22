/**
 * The crossfade state machine, in isolation.
 *
 * Pure arithmetic over a plain object, so it is tested here rather than through
 * a renderer — which is the point of keeping it separate from `ThemeDirector`.
 * Every timing claim in the brief lands in this file: the four-second fade, the
 * bar-boundary music window, both themes resident before it starts, and the prop
 * sets crossing rather than both being on screen at once.
 */

import { describe, expect, it } from "vitest";
import { TUNING } from "@/game/config/tuning";
import {
  blend,
  createCrossfade,
  incomingPropStrength,
  outgoingPropStrength,
  requestTransition,
  shouldSwapMusic,
  showTitleCard,
  stepCrossfade,
  TransitionPhase,
} from "@/game/render/theme/crossfade";

const STEP = 1 / 60;

/** Runs the fade to completion, returning the seconds it took. */
function runToIdle(state: ReturnType<typeof createCrossfade>, ready = true): number {
  let elapsed = 0;
  const LIMIT = 60;
  while (state.phase !== TransitionPhase.Idle && elapsed < LIMIT) {
    stepCrossfade(state, STEP, ready);
    elapsed += STEP;
  }
  return elapsed;
}

describe("crossfade", () => {
  it("starts idle and stays there without a request", () => {
    const state = createCrossfade(0);
    expect(state.phase).toBe(TransitionPhase.Idle);
    stepCrossfade(state, 1, true);
    expect(state.phase).toBe(TransitionPhase.Idle);
    // Idle reports a completed blend, so a caller can apply `t` unconditionally.
    expect(outgoingPropStrength(state)).toBe(0);
    expect(incomingPropStrength(state)).toBe(1);
  });

  it("takes exactly TUNING.theme.crossfadeSeconds once assets are ready", () => {
    const state = createCrossfade(0);
    requestTransition(state, 1);
    const seconds = runToIdle(state);
    // Within one frame of the tunable. The brief asks for "roughly 4 seconds";
    // this asserts it is the number in the tuning file rather than a number.
    expect(seconds).toBeGreaterThanOrEqual(TUNING.theme.crossfadeSeconds);
    expect(seconds).toBeLessThan(TUNING.theme.crossfadeSeconds + STEP * 2);
  });

  it("WAITS for assets rather than cutting", () => {
    // The brief: "Both themes' assets must be resident before the transition
    // starts." A fade that began anyway would show an unfurnished tunnel, which
    // is worse than a fade that starts a beat late.
    const state = createCrossfade(0);
    requestTransition(state, 1);

    for (let i = 0; i < 120; i += 1) {
      stepCrossfade(state, STEP, false);
    }
    expect(state.phase).toBe(TransitionPhase.Waiting);
    expect(state.t).toBe(0);
    // Nothing visual has moved.
    expect(outgoingPropStrength(state)).toBeGreaterThan(0.9);

    const seconds = runToIdle(state);
    expect(state.phase).toBe(TransitionPhase.Idle);
    // The wait did not eat into the fade — it still gets its full duration.
    expect(seconds).toBeGreaterThanOrEqual(TUNING.theme.crossfadeSeconds);
  });

  it("swaps music exactly once, inside the musical window", () => {
    const state = createCrossfade(0);
    requestTransition(state, 1);

    let swaps = 0;
    const fractions: number[] = [];
    let elapsed = 0;
    while (state.phase !== TransitionPhase.Idle && elapsed < 60) {
      stepCrossfade(state, STEP, true);
      elapsed += STEP;
      if (shouldSwapMusic(state)) {
        swaps += 1;
        fractions.push(state.elapsed / TUNING.theme.crossfadeSeconds);
        state.musicSwapped = true;
      }
    }

    expect(swaps, "music swapped more than once").toBe(1);
    const at = fractions[0] ?? -1;
    expect(at).toBeGreaterThanOrEqual(TUNING.theme.musicSwapWindowStart);
    expect(at).toBeLessThanOrEqual(TUNING.theme.musicSwapWindowEnd);
  });

  it("shows the title card for its own duration, not the fade's", () => {
    const state = createCrossfade(0);
    requestTransition(state, 1);
    expect(showTitleCard(state)).toBe(true);

    let elapsed = 0;
    while (showTitleCard(state) && elapsed < 60) {
      stepCrossfade(state, STEP, true);
      elapsed += STEP;
    }
    expect(elapsed).toBeGreaterThanOrEqual(TUNING.theme.titleCardSeconds);
    expect(elapsed).toBeLessThan(TUNING.theme.titleCardSeconds + STEP * 2);
    // And it goes before the fade does, which is why the palette cut has to
    // happen at the card's midpoint rather than at the fade's end.
    expect(TUNING.theme.titleCardSeconds).toBeLessThan(TUNING.theme.crossfadeSeconds);
  });

  it("clears the outgoing props before the incoming set is full", () => {
    // Two furnished themes on screen at once reads as clutter rather than as a
    // transition, so the sets pass rather than overlap.
    const state = createCrossfade(0);
    requestTransition(state, 1);

    let bothPresent = 0;
    let elapsed = 0;
    while (state.phase !== TransitionPhase.Idle && elapsed < 60) {
      stepCrossfade(state, STEP, true);
      elapsed += STEP;
      if (outgoingPropStrength(state) > 0.5 && incomingPropStrength(state) > 0.5) {
        bothPresent += 1;
      }
    }
    expect(bothPresent, "both prop sets were dense at the same time").toBe(0);
  });

  it("blends a numeric pair from one end to the other", () => {
    const state = createCrossfade(0);
    requestTransition(state, 1);
    stepCrossfade(state, 0, true);
    expect(blend(state, 10, 90)).toBeCloseTo(10, 6);

    const seen: number[] = [];
    let elapsed = 0;
    while (state.phase !== TransitionPhase.Idle && elapsed < 60) {
      stepCrossfade(state, STEP, true);
      elapsed += STEP;
      seen.push(blend(state, 10, 90));
    }
    expect(seen[seen.length - 1]).toBeCloseTo(90, 6);
    // Monotonic: a fog distance that reversed mid-fade would read as the tunnel
    // breathing, which is Static's trick and nobody else's.
    for (let i = 1; i < seen.length; i += 1) {
      expect(seen[i] ?? 0).toBeGreaterThanOrEqual((seen[i - 1] ?? 0) - 1e-9);
    }
  });

  it("survives an absurd delta without overshooting", () => {
    // A backgrounded tab hands the loop a multi-second delta on its first frame
    // back. The fade must land, not run past its end into negative time.
    const state = createCrossfade(0);
    requestTransition(state, 1);
    stepCrossfade(state, 30, true);
    expect(state.phase).toBe(TransitionPhase.Idle);
    expect(state.t).toBeLessThanOrEqual(1);
    expect(incomingPropStrength(state)).toBe(1);
  });

  it("records the destination ordinal it was asked for", () => {
    const state = createCrossfade(0);
    requestTransition(state, 7);
    expect(state.to).toBe(7);
    expect(state.from).toBe(0);
  });
});
