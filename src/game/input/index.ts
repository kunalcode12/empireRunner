/**
 * The input layer — three devices, one intent stream.
 *
 * Everything here produces intent and nothing else. It never reads sim state and
 * never calls into the sim (docs/ARCHITECTURE.md §3). The sim pulls the assembled
 * intent at a tick boundary.
 *
 * The input buffer and coyote time are deliberately NOT here — see the note in
 * `intent-source.ts`. Short version: a buffered input is a decision, and every
 * decision has to be inside the replay log or server-side validation desyncs.
 */

import { clearIntent, createIntent, sanitizeIntent, type Intent } from "../sim/intent";
import { mergeInto, type IntentSource } from "./intent-source";

export {
  createEdgeLatch,
  drainLatch,
  latchLateral,
  latchRoll,
  mergeInto,
  resetLatch,
  type EdgeLatch,
  type IntentSource,
} from "./intent-source";

export { createKeyboardSource, KEYBOARD_BINDINGS, type KeyboardSourceOptions } from "./keyboard";
export { createTouchSource, TOUCH_CONSTANTS, type TouchSourceOptions } from "./touch";
export {
  createGamepadSource,
  GAMEPAD_BINDINGS,
  type GamepadLike,
  type GamepadSourceOptions,
} from "./gamepad";

/**
 * Combines several sources into one intent per frame.
 *
 * Holds one reusable `Intent` and one scratch, so polling every frame allocates
 * nothing — the same discipline the sim keeps, for the same reason.
 */
export interface InputManager {
  /** Polls every source and returns the merged intent. Do not retain the object. */
  poll(): Readonly<Intent>;
  /** The last polled intent, without re-polling. */
  current(): Readonly<Intent>;
  /** Releases every source's listeners. */
  dispose(): void;
  readonly sources: readonly IntentSource[];
}

export function createInputManager(sources: readonly IntentSource[]): InputManager {
  const merged = createIntent();
  const scratch = createIntent();

  return {
    sources,

    poll(): Readonly<Intent> {
      clearIntent(merged);
      for (let i = 0; i < sources.length; i += 1) {
        const source = sources[i];
        if (source === undefined) {
          continue;
        }
        clearIntent(scratch);
        source.poll(scratch);
        mergeInto(merged, scratch);
      }
      // The sim is a trust boundary; hand it only well-formed discrete values.
      sanitizeIntent(merged);
      return merged;
    },

    current: () => merged,

    dispose(): void {
      for (let i = 0; i < sources.length; i += 1) {
        sources[i]?.dispose();
      }
    },
  };
}
