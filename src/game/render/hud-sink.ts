/**
 * The render layer's output port for the HUD.
 *
 * ## Why this interface exists here and not in `src/ui/`
 *
 * `eslint.config.mjs` forbids `src/ui/**` from importing `@/game/render/**`, and
 * docs/ARCHITECTURE.md §3 puts `ui` *above* `render`, so render may not import
 * from ui either. Neither side may name the other. That is not an obstacle to
 * work around — it is the layering law doing its job, because a HUD that imports
 * the render loop is a HUD that cannot be tested without a WebGL context.
 *
 * So: **render declares the port, ui implements it structurally, and
 * `src/app/play/page.tsx` performs the assignment.** `app` sits above both and
 * may import both, so that one line is where TypeScript checks the two halves
 * agree. There is no duplicated enum and no drift — which matters, because
 * duplicated sim constants have now caused two real bugs in this repo (the
 * `ThemeChange` payload at P11 and the pickup kinds at P13).
 *
 * ## Every method is a setter, and none of them return anything
 *
 * The frame loop must never read from the HUD. A read is a layout flush, and a
 * layout flush inside `useFrame` is a synchronous style recalculation in the
 * middle of the frame budget. Setters only, fire and forget.
 *
 * ## This is called at `TUNING.ui.hudPushHz`, not at 60Hz
 *
 * docs/ARCHITECTURE.md §3.1. The eye cannot read a number changing 60 times a
 * second, and writing one costs real layout work. The sim still runs at 60; only
 * the DOM writes are rate-limited.
 */

/**
 * Everything the run HUD can be told.
 *
 * Implementations must tolerate being called before their DOM exists and after
 * it is gone — the frame loop has no way to know either.
 */
export interface HudSink {
  /** Score in points. Already multiplied; the HUD does no arithmetic. */
  setScore(value: number): void;
  /** Distance in metres. */
  setDistance(value: number): void;
  /** Bits collected this run. */
  setBits(value: number): void;
  /** Flow 0..100. Drives the AXIS ring's fill. */
  setFlow(value: number): void;
  /** Current score multiplier, e.g. 2.4. */
  setMultiplier(value: number): void;
  /** Which of the four faces is currently the floor, 0..3. */
  setFace(face: number): void;
  /** Shields held. Rendered as pips beside the ring. */
  setShields(value: number): void;

  /** A Flow award landed. `amount` is the value, for the floating numeral. */
  flowGain(amount: number): void;
  /** A near-miss. Kicks the ring independently of the Flow it awarded. */
  nearMiss(): void;
  /** Overdrive opened or closed. Inverts the whole HUD palette. */
  setOverdrive(active: boolean): void;
  /**
   * The Fracture window. `fraction` is 1 at the moment it arms and drains to 0.
   * `verb` is the single clearing verb; `shardCost` is what a resume costs.
   * Called with `null` to clear it.
   */
  setFracture(state: { fraction: number; verb: number; shardCost: number } | null): void;
  /** The run crossed a theme milestone. Payload is the theme ordinal. */

  /** Paused or resumed. The HUD dims rather than unmounting. */
  setPaused(paused: boolean): void;
  /** Clears every counter back to zero. Called at run start. */
  reset(): void;
}

/**
 * A sink that does nothing.
 *
 * The frame loop takes an optional sink and this is the default, so the null
 * check happens once here instead of at eleven call sites inside `useFrame`.
 * Also what the headless perf tests run against.
 */
export const NULL_HUD_SINK: HudSink = Object.freeze({
  setScore(): void {},
  setDistance(): void {},
  setBits(): void {},
  setFlow(): void {},
  setMultiplier(): void {},
  setFace(): void {},
  setShields(): void {},
  flowGain(): void {},
  nearMiss(): void {},
  setOverdrive(): void {},
  setFracture(): void {},

  setPaused(): void {},
  reset(): void {},
});
