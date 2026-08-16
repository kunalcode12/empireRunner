/**
 * The normalised frame input the sim consumes.
 *
 * Every device — keyboard, touch, gamepad — collapses to this one shape in
 * src/game/input/ (P03). The sim never sees a key, a touch, or a button, which
 * is what makes a replay device-agnostic and lets a server re-validate it.
 *
 * Every field is **discrete**. No analogue values reach the sim: a half-pushed
 * stick either crossed the threshold or it did not. Continuous input would make
 * the intent stream impossible to bitpack into one byte per tick, and would put
 * device-specific float noise into a deterministic simulation.
 */

/** Lateral intent: exactly one lane, left or right, or nothing. */
export const Lateral = {
  None: 0,
  Left: -1,
  Right: 1,
} as const;
export type LateralValue = (typeof Lateral)[keyof typeof Lateral];

/** Roll intent: re-anchor gravity to the adjacent face, or nothing. */
export const Roll = {
  None: 0,
  Left: -1,
  Right: 1,
} as const;
export type RollValue = (typeof Roll)[keyof typeof Roll];

export interface Intent {
  /** -1 left, 0 none, +1 right. */
  lateral: number;
  /** -1 left, 0 none, +1 right. */
  roll: number;
  jump: boolean;
  slide: boolean;
  /**
   * Spend the full Flow meter on Overdrive. Ignored below `overdriveCost`.
   *
   * A **held** state like `jump` and `slide`, not a press event — the sim derives
   * the press edge itself. Holding the key does not re-trigger, and it does not
   * queue: an Overdrive requested at 99 Flow is simply dropped, per GAME_BIBLE §6
   * ("Ignored below 100"), never buffered until the meter fills. Buffering it
   * would take the timing decision away from the player, and *when* to spend is
   * the whole decision.
   */
  overdrive: boolean;
}

/**
 * A shared do-nothing intent.
 *
 * Frozen because it is handed to callers that might otherwise mutate it and
 * silently poison every subsequent tick that reused it. Use `createIntent()` for
 * anything you intend to write to.
 */
export const IDLE_INTENT: Readonly<Intent> = Object.freeze({
  lateral: Lateral.None,
  roll: Roll.None,
  jump: false,
  slide: false,
  overdrive: false,
});

/** Creates a mutable intent. Callers reuse one instance rather than allocating per tick. */
export function createIntent(): Intent {
  return { lateral: Lateral.None, roll: Roll.None, jump: false, slide: false, overdrive: false };
}

/** Clears an intent in place. Allocates nothing. */
export function clearIntent(intent: Intent): void {
  intent.lateral = Lateral.None;
  intent.roll = Roll.None;
  intent.jump = false;
  intent.slide = false;
  intent.overdrive = false;
}

/** Copies an intent in place. Allocates nothing. */
export function copyIntent(dst: Intent, src: Intent): void {
  dst.lateral = src.lateral;
  dst.roll = src.roll;
  dst.jump = src.jump;
  dst.slide = src.slide;
  dst.overdrive = src.overdrive;
}

/**
 * Clamps an intent to legal discrete values.
 *
 * The sim is the trust boundary for replay validation: a submitted replay's
 * intents come from a client and cannot be assumed well-formed. An out-of-range
 * lateral of 7 would otherwise walk the player off the face during server-side
 * re-simulation. Non-integers and NaN collapse to None.
 */
export function sanitizeIntent(intent: Intent): void {
  intent.lateral = clampAxis(intent.lateral);
  intent.roll = clampAxis(intent.roll);
  intent.jump = intent.jump === true;
  intent.slide = intent.slide === true;
  intent.overdrive = intent.overdrive === true;
}

function clampAxis(value: number): number {
  if (value > 0) {
    return 1;
  }
  if (value < 0) {
    return -1;
  }
  // Also catches NaN, which is neither > 0 nor < 0.
  return 0;
}
