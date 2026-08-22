/**
 * The theme crossfade, as pure state.
 *
 * No three, no DOM, no side effects — this file decides *how far through* a
 * transition the run is and what every blended value should be at that point.
 * `ThemeDirector` applies the result to the scene. Splitting them is what lets
 * the whole transition be tested without a GPU, and the transition is the piece
 * most likely to be wrong in a way a screenshot cannot show.
 *
 * ## The clock is render time, not sim time
 *
 * GAME_BIBLE §10 gives the transition tunnel as 120m of guaranteed-empty track.
 * At the mid-run speed that is about 4.8 seconds, but at 12 u/s it is ten and at
 * 34 u/s it is three and a half. The fade runs on a fixed **4 second wall clock**
 * regardless, because it is presentation: tying it to distance would make the
 * fade slower for a worse player, which is precisely backwards, and tying it to
 * the sim would make it a gameplay value that has to be deterministic.
 *
 * ## Music is the one thing that does not follow this clock
 *
 * Stems swap on a musical bar (P11), which cannot be scheduled to land exactly
 * with the palette. `shouldSwapMusic` opens a window in the middle of the fade
 * and the audio layer takes the first bar inside it. Outside that window a swap
 * reads as either a premature cut or a late correction.
 */

import { TUNING } from "@/game/config/tuning";

/** Guards every division by a tunable that a designer could set to zero. */
const EPSILON = 0.0001;

/** Where a transition is. */
export const TransitionPhase = {
  /** No transition running. */
  Idle: "idle",
  /** Waiting for the incoming theme's assets. The fade has NOT started. */
  Waiting: "waiting",
  /** Fading. */
  Running: "running",
} as const;
export type TransitionPhaseName = (typeof TransitionPhase)[keyof typeof TransitionPhase];

export interface CrossfadeState {
  phase: TransitionPhaseName;
  /** Theme ordinal being faded from. */
  from: number;
  /** Theme ordinal being faded to. Equals `from` when idle. */
  to: number;
  /** s — elapsed since the fade began. */
  elapsed: number;
  /** 0..1 — eased progress. The value everything else is derived from. */
  t: number;
  /** True once the music swap has been requested, so it fires exactly once. */
  musicSwapped: boolean;
  /** s — how long the title card has been showing. */
  cardElapsed: number;
}

export function createCrossfade(initialTheme = 0): CrossfadeState {
  return {
    phase: TransitionPhase.Idle,
    from: initialTheme,
    to: initialTheme,
    elapsed: 0,
    t: 0,
    musicSwapped: false,
    cardElapsed: 0,
  };
}

/**
 * Requests a transition to `ordinal`.
 *
 * Enters `Waiting` rather than `Running`: the brief requires both themes to be
 * resident before the fade starts, so the director holds here until the incoming
 * assets report loaded. In practice the preloader has had a whole theme's worth
 * of distance to fetch 8KB, so this is a formality — but a formality that turns
 * a stall into a wait instead of into a pop.
 *
 * A request for the theme already showing is ignored. A request arriving mid-fade
 * retargets from wherever the fade currently is, so two milestones in quick
 * succession cannot leave the scene half-blended forever.
 */
export function requestTransition(state: CrossfadeState, ordinal: number): void {
  if (!Number.isFinite(ordinal)) {
    return;
  }
  const target = Math.max(0, Math.floor(ordinal));
  if (target === state.to && state.phase !== TransitionPhase.Idle) {
    return;
  }
  if (target === state.to && state.phase === TransitionPhase.Idle) {
    return;
  }

  // Retarget from the CURRENT blend, not from the original source. Snapping back
  // to `from` would visibly rewind the scene.
  state.from = state.phase === TransitionPhase.Running ? state.to : state.from;
  state.to = target;
  state.phase = TransitionPhase.Waiting;
  state.elapsed = 0;
  state.t = 0;
  state.musicSwapped = false;
  state.cardElapsed = 0;
}

/**
 * Advances the crossfade.
 *
 * `assetsReady` gates the move from `Waiting` to `Running` — the director passes
 * whether the incoming theme's geometry is resident.
 */
export function stepCrossfade(state: CrossfadeState, delta: number, assetsReady: boolean): void {
  if (state.phase === TransitionPhase.Idle) {
    return;
  }

  if (state.phase === TransitionPhase.Waiting) {
    if (!assetsReady) {
      return;
    }
    state.phase = TransitionPhase.Running;
  }

  const duration = TUNING.theme.crossfadeSeconds;
  state.elapsed += Math.max(0, delta);
  state.cardElapsed += Math.max(0, delta);

  const raw = duration <= 0 ? 1 : Math.min(1, state.elapsed / duration);
  state.t = easeInOutCubic(raw);

  if (raw >= 1) {
    state.phase = TransitionPhase.Idle;
    state.from = state.to;
    state.t = 0;
    state.elapsed = 0;
  }
}

/**
 * Whether the music should swap on the next bar.
 *
 * True exactly once per transition, inside the middle window. The caller sets
 * `musicSwapped` when it has acted, which is why this reads rather than mutates
 * — a query that changes state is a query nobody can call twice safely.
 */
export function shouldSwapMusic(state: CrossfadeState): boolean {
  if (state.phase !== TransitionPhase.Running || state.musicSwapped) {
    return false;
  }
  const raw = state.elapsed / Math.max(TUNING.theme.crossfadeSeconds, EPSILON);
  return raw >= TUNING.theme.musicSwapWindowStart && raw <= TUNING.theme.musicSwapWindowEnd;
}

/** Whether the theme title card should be on screen. */
export function showTitleCard(state: CrossfadeState): boolean {
  return state.phase !== TransitionPhase.Idle && state.cardElapsed < TUNING.theme.titleCardSeconds;
}

/**
 * How strongly the OUTGOING prop set should still be drawn, 0..1.
 *
 * Clears before the incoming set reaches full strength — two furnished themes on
 * screen at once reads as clutter rather than as a transition.
 */
export function outgoingPropStrength(state: CrossfadeState): number {
  if (state.phase === TransitionPhase.Idle) {
    return 0;
  }
  const cut = Math.max(TUNING.theme.propFadeOut, EPSILON);
  return Math.max(0, 1 - state.t / cut);
}

/** How strongly the INCOMING prop set should be drawn, 0..1. */
export function incomingPropStrength(state: CrossfadeState): number {
  if (state.phase === TransitionPhase.Idle) {
    return 1;
  }
  const start = TUNING.theme.propFadeOut;
  if (state.t <= start) {
    return 0;
  }
  return Math.min(1, (state.t - start) / Math.max(1 - start, EPSILON));
}

/** The roll's easing curve, reused. See `src/ui/motion.ts` for the same choice. */
function easeInOutCubic(t: number): number {
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

/**
 * Blends a scalar between the two themes at the current point in the fade.
 *
 * The one place every numeric blend goes through, so fog, light intensity and
 * every material parameter cannot drift apart in how they ease.
 */
export function blend(state: CrossfadeState, fromValue: number, toValue: number): number {
  if (state.phase === TransitionPhase.Idle) {
    return toValue;
  }
  return fromValue + (toValue - fromValue) * state.t;
}
