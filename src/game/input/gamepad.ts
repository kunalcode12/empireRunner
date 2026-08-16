/**
 * Gamepad input, via the Standard Gamepad mapping.
 *
 * Bindings from GAME_BIBLE §6.3. Button indices are the Standard Gamepad layout,
 * which every mainstream controller reports; a non-standard pad falls back to
 * d-pad and face buttons only.
 *
 * ## Stick hysteresis
 *
 * The stick is **edge-triggered with a hysteresis band**, never continuous.
 * Crossing `stickThreshold` (0.5) emits exactly one lane intent; the stick must
 * then return inside `stickReleaseThreshold` (0.25) before it can fire again.
 *
 * Without that band, a stick resting near the threshold chatters across it on
 * analogue noise and emits a stream of lane changes the player never asked for.
 * With a single threshold and no band, the same happens at exactly 0.5. The gap
 * between the two numbers is the entire mechanism, which is why
 * `tuning-invariants.test.ts` asserts `stickReleaseThreshold < stickThreshold`.
 */

import { TUNING } from "../config/tuning";
import type { Intent } from "../sim/intent";
import {
  createEdgeLatch,
  drainLatch,
  latchLateral,
  latchRoll,
  resetLatch,
  type EdgeLatch,
  type IntentSource,
} from "./intent-source";

const STICK_THRESHOLD = TUNING.input.gamepad.stickThreshold;
const STICK_RELEASE = TUNING.input.gamepad.stickReleaseThreshold;

/** Standard Gamepad button indices. */
const BUTTON_A = 0;
const BUTTON_B = 1;
const BUTTON_LB = 4;
const BUTTON_RB = 5;
const BUTTON_RT = 7;
const BUTTON_DPAD_LEFT = 14;
const BUTTON_DPAD_RIGHT = 15;

/** Left stick horizontal axis. */
const AXIS_LEFT_X = 0;

const ACTIVITY_WINDOW_MS = 3000;

/** Minimal shape we need from the Gamepad API, so tests can supply a fake. */
export interface GamepadLike {
  readonly axes: readonly number[];
  readonly buttons: readonly { readonly pressed: boolean }[];
  readonly connected: boolean;
}

export interface GamepadSourceOptions {
  /** Injectable so tests do not need a real controller. */
  getGamepads: () => readonly (GamepadLike | null)[];
  now?: () => number;
}

function isPressed(pad: GamepadLike, index: number): boolean {
  return pad.buttons[index]?.pressed === true;
}

export function createGamepadSource(options: GamepadSourceOptions): IntentSource {
  const getGamepads = options.getGamepads;
  const now = options.now ?? (() => Date.now());

  const latch: EdgeLatch = createEdgeLatch();
  let lastActivity = 0;

  /** -1, 0 or +1 — which side of the band the stick was last latched on. */
  let stickLatched = 0;
  let dpadLeftWas = false;
  let dpadRightWas = false;
  let lbWas = false;
  let rbWas = false;

  function firstConnected(): GamepadLike | null {
    const pads = getGamepads();
    for (let i = 0; i < pads.length; i += 1) {
      const pad = pads[i];
      if (pad !== null && pad !== undefined && pad.connected) {
        return pad;
      }
    }
    return null;
  }

  return {
    name: "gamepad",
    isActive: () => now() - lastActivity < ACTIVITY_WINDOW_MS,

    poll(out: Intent): void {
      const pad = firstConnected();
      if (pad === null) {
        drainLatch(latch, out);
        return;
      }

      const x = pad.axes[AXIS_LEFT_X] ?? 0;

      // Hysteresis: fire once on crossing out, re-arm only on returning inside.
      if (stickLatched === 0) {
        if (x >= STICK_THRESHOLD) {
          latchLateral(latch, 1);
          stickLatched = 1;
          lastActivity = now();
        } else if (x <= -STICK_THRESHOLD) {
          latchLateral(latch, -1);
          stickLatched = -1;
          lastActivity = now();
        }
      } else if (Math.abs(x) <= STICK_RELEASE) {
        stickLatched = 0;
      }

      const dpadLeft = isPressed(pad, BUTTON_DPAD_LEFT);
      if (dpadLeft && !dpadLeftWas) {
        latchLateral(latch, -1);
        lastActivity = now();
      }
      dpadLeftWas = dpadLeft;

      const dpadRight = isPressed(pad, BUTTON_DPAD_RIGHT);
      if (dpadRight && !dpadRightWas) {
        latchLateral(latch, 1);
        lastActivity = now();
      }
      dpadRightWas = dpadRight;

      const lb = isPressed(pad, BUTTON_LB);
      if (lb && !lbWas) {
        latchRoll(latch, -1);
        lastActivity = now();
      }
      lbWas = lb;

      const rb = isPressed(pad, BUTTON_RB);
      if (rb && !rbWas) {
        latchRoll(latch, 1);
        lastActivity = now();
      }
      rbWas = rb;

      // Held, not edge-triggered — the controller needs the release edge.
      latch.jump = isPressed(pad, BUTTON_A);
      latch.slide = isPressed(pad, BUTTON_B);
      // RT was already read here for activity detection but had nowhere to go
      // until the Intent gained an `overdrive` field at P08. GAME_BIBLE §6.3.
      latch.overdrive = isPressed(pad, BUTTON_RT);
      if (latch.jump || latch.slide || latch.overdrive) {
        lastActivity = now();
      }

      drainLatch(latch, out);
    },

    dispose(): void {
      resetLatch(latch);
      stickLatched = 0;
      dpadLeftWas = false;
      dpadRightWas = false;
      lbWas = false;
      rbWas = false;
    },
  };
}

/** Exposed for tests and a settings screen. */
export const GAMEPAD_BINDINGS = {
  jump: BUTTON_A,
  slide: BUTTON_B,
  rollLeft: BUTTON_LB,
  rollRight: BUTTON_RB,
  overdrive: BUTTON_RT,
  laneLeft: BUTTON_DPAD_LEFT,
  laneRight: BUTTON_DPAD_RIGHT,
  stickAxis: AXIS_LEFT_X,
} as const;
