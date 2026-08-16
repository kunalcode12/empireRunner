/**
 * Forgiveness — coyote time and the input buffer.
 *
 * These are invisible to players and they are the entire difference between
 * "tight" and "this game cheats me". Nobody ever writes a review praising the
 * input buffer; they write reviews saying the controls feel bad when it is
 * missing.
 *
 * ## Why these live in the sim and not in src/game/input/
 *
 * docs/ARCHITECTURE.md §3 says the input layer produces intents and does not
 * call into the sim, and docs/TUNING.md §8 files both of these under "input
 * forgiveness", which reads like they belong in `input/`. They cannot.
 *
 * Both decisions depend on sim state — is the player grounded, is a roll's
 * commit lock active, has the slide recovery finished — and, decisively, **a
 * buffered input is a decision**. The replay log records the raw per-tick intent
 * stream. If the buffer lived in the input layer, the buffered decision would
 * happen outside the log, and a server re-simulating from the log would not
 * reproduce it. Every replay would desync.
 *
 * So `input/` normalises devices into intents, and this module — inside the sim,
 * inside the tick, inside the hash — decides when those intents take effect.
 *
 * ## The one place the buffer does NOT apply
 *
 * Lateral input during `rollCommitLock` is **dropped, not buffered**
 * (docs/TUNING.md §7, GAME_BIBLE §6.4). That is deliberate and is the whole risk
 * of the roll: you commit to the destination face before you can see how it
 * plays out. Buffering it would hand the player a free correction and turn the
 * Full-Face Wall back into a non-threat.
 */

import { TUNING } from "@/game/config/tuning";
import { F, Verb, type SimState } from "@/game/sim/state";
import { tickDown, timerActive } from "./timer";

const COYOTE_TIME = TUNING.input.coyoteTime;
const INPUT_BUFFER = TUNING.input.inputBuffer;

/** Starts the coyote window. Called on the tick the player leaves the ground. */
export function beginCoyote(state: SimState): void {
  state.f[F.playerCoyoteTimer] = COYOTE_TIME;
}

/** Clears the coyote window. Called on landing and on jumping. */
export function clearCoyote(state: SimState): void {
  state.f[F.playerCoyoteTimer] = 0;
}

/**
 * True while a jump is still legal after leaving the ground.
 *
 * Boundary behaviour is exact: the timer is decremented at the END of the tick,
 * so a jump on the tick where the timer reaches exactly 0 is rejected and the
 * tick before it is accepted. `forgiveness.test.ts` pins both.
 */
export function coyoteActive(state: SimState): boolean {
  return timerActive(state.f[F.playerCoyoteTimer] ?? 0);
}

/**
 * Queues a verb that is not legal yet.
 *
 * One slot, newest wins — `bufferDepth` is 1 in docs/TUNING.md §8. A deeper
 * queue lets a panic mash commit the player to a sequence they cannot cancel,
 * which reads as the character ignoring you.
 */
export function bufferVerb(state: SimState, verb: number): void {
  state.player.bufferedVerb = verb;
  state.f[F.playerBufferedTimer] = INPUT_BUFFER;
}

/** Discards any buffered verb. */
export function clearBuffer(state: SimState): void {
  state.player.bufferedVerb = Verb.None;
  state.f[F.playerBufferedTimer] = 0;
}

/** The buffered verb, or `Verb.None` if the buffer is empty or expired. */
export function peekBuffer(state: SimState): number {
  if (!timerActive(state.f[F.playerBufferedTimer] ?? 0)) {
    return Verb.None;
  }
  return state.player.bufferedVerb;
}

/** Takes the buffered verb and clears the slot. */
export function consumeBuffer(state: SimState): number {
  const verb = peekBuffer(state);
  if (verb !== Verb.None) {
    clearBuffer(state);
  }
  return verb;
}

/**
 * Ages both windows by one tick.
 *
 * Called at the END of the player step, so a window opened this tick survives
 * the whole of its stated duration rather than losing its first tick. That is
 * the difference between `coyoteTime` meaning 6 ticks and meaning 5.
 */
export function ageForgiveness(state: SimState, dt: number): void {
  state.f[F.playerCoyoteTimer] = tickDown(state.f[F.playerCoyoteTimer] ?? 0, dt);

  const buffered = tickDown(state.f[F.playerBufferedTimer] ?? 0, dt);
  if (buffered <= 0 && (state.f[F.playerBufferedTimer] ?? 0) > 0) {
    clearBuffer(state);
  } else {
    state.f[F.playerBufferedTimer] = buffered;
  }
}
