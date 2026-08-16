/**
 * Keyboard input.
 *
 * Bindings from GAME_BIBLE §6.1. `W`/`ArrowUp` doubling as jump is deliberate:
 * the reflex from every other three-lane runner is "up = jump", and fighting
 * that reflex costs first-run retention for no benefit.
 *
 * Lateral and roll are **edge-triggered** — a held key produces one lane change,
 * not sixty. Jump and slide are **held**, because the controller needs the
 * release edge for variable jump height.
 */

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

/** Physical `KeyboardEvent.code` values, so bindings survive keyboard layouts. */
const LANE_LEFT_KEYS = ["KeyA", "ArrowLeft"] as const;
const LANE_RIGHT_KEYS = ["KeyD", "ArrowRight"] as const;
const JUMP_KEYS = ["Space", "KeyW", "ArrowUp"] as const;
// Shift is deliberately NOT here. It reads as "crouch" from every shooter, and
// P03 bound it to slide on that instinct — but GAME_BIBLE §6.1 assigns Shift to
// OVERDRIVE, and a key cannot be both. The bible wins; corrected at P08.
const SLIDE_KEYS = ["KeyS", "ArrowDown"] as const;
const OVERDRIVE_KEYS = ["ShiftLeft", "ShiftRight", "KeyF"] as const;
const ROLL_LEFT_KEYS = ["KeyQ", "Comma"] as const;
const ROLL_RIGHT_KEYS = ["KeyE", "Period"] as const;

const ACTIVITY_WINDOW_MS = 3000;

function includes(list: readonly string[], code: string): boolean {
  for (let i = 0; i < list.length; i += 1) {
    if (list[i] === code) {
      return true;
    }
  }
  return false;
}

export interface KeyboardSourceOptions {
  target: EventTarget;
  now?: () => number;
}

export function createKeyboardSource(options: KeyboardSourceOptions): IntentSource {
  const target = options.target;
  const now = options.now ?? (() => Date.now());

  const latch: EdgeLatch = createEdgeLatch();
  let lastActivity = 0;

  // Tracked so a key held across frames does not re-fire, and so releasing one
  // of two held jump keys does not drop the jump.
  let jumpHeldCount = 0;
  let slideHeldCount = 0;
  let overdriveHeldCount = 0;
  const down = new Set<string>();

  function onKeyDown(event: Event): void {
    const key = event as KeyboardEvent;
    if (key.repeat) {
      return;
    }
    const code = key.code;
    if (down.has(code)) {
      return;
    }
    down.add(code);
    lastActivity = now();

    if (includes(LANE_LEFT_KEYS, code)) {
      latchLateral(latch, -1);
    } else if (includes(LANE_RIGHT_KEYS, code)) {
      latchLateral(latch, 1);
    } else if (includes(ROLL_LEFT_KEYS, code)) {
      latchRoll(latch, -1);
    } else if (includes(ROLL_RIGHT_KEYS, code)) {
      latchRoll(latch, 1);
    } else if (includes(JUMP_KEYS, code)) {
      jumpHeldCount += 1;
      latch.jump = true;
    } else if (includes(SLIDE_KEYS, code)) {
      slideHeldCount += 1;
      latch.slide = true;
    } else if (includes(OVERDRIVE_KEYS, code)) {
      overdriveHeldCount += 1;
      latch.overdrive = true;
    }
  }

  function onKeyUp(event: Event): void {
    const key = event as KeyboardEvent;
    const code = key.code;
    if (!down.delete(code)) {
      return;
    }
    lastActivity = now();

    if (includes(JUMP_KEYS, code)) {
      jumpHeldCount = jumpHeldCount > 0 ? jumpHeldCount - 1 : 0;
      latch.jump = jumpHeldCount > 0;
    } else if (includes(SLIDE_KEYS, code)) {
      slideHeldCount = slideHeldCount > 0 ? slideHeldCount - 1 : 0;
      latch.slide = slideHeldCount > 0;
    } else if (includes(OVERDRIVE_KEYS, code)) {
      overdriveHeldCount = overdriveHeldCount > 0 ? overdriveHeldCount - 1 : 0;
      latch.overdrive = overdriveHeldCount > 0;
    }
  }

  /** A lost focus must release everything, or the player returns mid-jump. */
  function onBlur(): void {
    down.clear();
    jumpHeldCount = 0;
    slideHeldCount = 0;
    overdriveHeldCount = 0;
    resetLatch(latch);
  }

  target.addEventListener("keydown", onKeyDown);
  target.addEventListener("keyup", onKeyUp);
  target.addEventListener("blur", onBlur);

  return {
    name: "keyboard",
    isActive: () => now() - lastActivity < ACTIVITY_WINDOW_MS,
    poll(out: Intent): void {
      drainLatch(latch, out);
    },
    dispose(): void {
      target.removeEventListener("keydown", onKeyDown);
      target.removeEventListener("keyup", onKeyUp);
      target.removeEventListener("blur", onBlur);
      onBlur();
    },
  };
}

/** Exposed so a settings screen can render the current bindings. */
export const KEYBOARD_BINDINGS = {
  laneLeft: LANE_LEFT_KEYS,
  laneRight: LANE_RIGHT_KEYS,
  jump: JUMP_KEYS,
  slide: SLIDE_KEYS,
  rollLeft: ROLL_LEFT_KEYS,
  rollRight: ROLL_RIGHT_KEYS,
  overdrive: OVERDRIVE_KEYS,
} as const;
