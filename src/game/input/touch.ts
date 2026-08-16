/**
 * Touch — the swipe recognizer.
 *
 * ## Fire on threshold crossing, never on touchend
 *
 * This is the whole difference between a runner that feels instant and one that
 * feels laggy. Waiting for `touchend` costs the entire remaining duration of the
 * gesture — 100ms or more of a fast flick — during which the player has already
 * decided and is waiting for the character. The moment travel passes
 * `swipeMinDistance` the direction is unambiguous, so the intent fires there and
 * the rest of the gesture is ignored.
 *
 * A minimum elapsed time guards the other direction: a genuine flick takes at
 * least a few milliseconds, and a zero-duration jump in coordinates is a stray
 * event or a palm, not a swipe.
 *
 * ## The dead zone
 *
 * A diagonal swipe is ambiguous — is it "left" or "up"? Resolving it by whichever
 * axis happens to be larger makes 45-degree swipes flip between answers on tiny
 * hand tremors, which reads as the game misreading you. Instead a swipe must be
 * clearly dominant on one axis: the minor axis must be under
 * `DIAGONAL_DEAD_ZONE` of the major. Anything inside the ambiguous wedge is
 * discarded rather than guessed.
 *
 * ## Two fingers for roll
 *
 * The riskiest decision in the touch layer (GAME_BIBLE §6.2). Two touches landing
 * within `twoFingerTolerance` are treated as one gesture; a horizontal swipe of
 * that gesture is a roll rather than a lane change. `twoFingerTolerance` is the
 * number to tune first if rolls misfire as lane changes on real hardware.
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

const SWIPE_MIN_DISTANCE = TUNING.input.touch.swipeMinDistance;
const TWO_FINGER_TOLERANCE = TUNING.input.touch.twoFingerTolerance;

/**
 * ms — a gesture shorter than this is noise, not a flick. The prompt specifies
 * 60ms; docs/TUNING.md §8 only bounds the maximum, so this is a floor added here.
 */
const SWIPE_MIN_DURATION_MS = 60;

/**
 * x — the minor axis must be under this fraction of the major axis for the
 * swipe to count as cardinal. 0.6 gives roughly a 31-degree wedge either side of
 * each axis, leaving the diagonals as dead zones.
 */
const DIAGONAL_DEAD_ZONE = 0.6;

/** ms — how long a held jump/slide from a swipe stays asserted. */
const HOLD_DURATION_MS = 120;

interface ActiveTouch {
  id: number;
  startX: number;
  startY: number;
  startTime: number;
  /** Set once this touch has produced an intent, so it fires at most once. */
  consumed: boolean;
}

const MAX_TRACKED_TOUCHES = 4;

export interface TouchSourceOptions {
  /** Element to listen on. */
  target: EventTarget;
  /** Injectable clock, so tests do not depend on wall time. */
  now?: () => number;
}

/**
 * Creates the touch source.
 *
 * Kept as a factory over a class so the pooled arrays are captured in a closure
 * and no `this` binding is needed in the hot listener path.
 */
export function createTouchSource(options: TouchSourceOptions): IntentSource {
  const target = options.target;
  const now = options.now ?? (() => Date.now());

  const latch: EdgeLatch = createEdgeLatch();
  const touches: ActiveTouch[] = [];
  for (let i = 0; i < MAX_TRACKED_TOUCHES; i += 1) {
    touches.push({ id: -1, startX: 0, startY: 0, startTime: 0, consumed: false });
  }
  let activeCount = 0;
  let lastActivity = 0;
  let jumpHoldUntil = 0;
  let slideHoldUntil = 0;

  function findSlot(id: number): ActiveTouch | undefined {
    for (let i = 0; i < activeCount; i += 1) {
      if (touches[i]?.id === id) {
        return touches[i];
      }
    }
    return undefined;
  }

  function addTouch(id: number, x: number, y: number, time: number): void {
    if (activeCount >= MAX_TRACKED_TOUCHES) {
      return;
    }
    const slot = touches[activeCount];
    if (slot === undefined) {
      return;
    }
    slot.id = id;
    slot.startX = x;
    slot.startY = y;
    slot.startTime = time;
    slot.consumed = false;
    activeCount += 1;
  }

  function removeTouch(id: number): void {
    for (let i = 0; i < activeCount; i += 1) {
      if (touches[i]?.id === id) {
        const last = touches[activeCount - 1];
        const current = touches[i];
        if (last !== undefined && current !== undefined && i !== activeCount - 1) {
          current.id = last.id;
          current.startX = last.startX;
          current.startY = last.startY;
          current.startTime = last.startTime;
          current.consumed = last.consumed;
        }
        activeCount -= 1;
        return;
      }
    }
  }

  /** True when a second finger landed close enough in time to pair with this one. */
  function isTwoFingerGesture(slot: ActiveTouch): boolean {
    if (activeCount < 2) {
      return false;
    }
    for (let i = 0; i < activeCount; i += 1) {
      const other = touches[i];
      if (other === undefined || other.id === slot.id) {
        continue;
      }
      if (Math.abs(other.startTime - slot.startTime) <= TWO_FINGER_TOLERANCE) {
        return true;
      }
    }
    return false;
  }

  /**
   * Classifies a swipe and latches the intent. Fires the moment the threshold is
   * crossed, and marks every touch in the gesture consumed so a two-finger roll
   * cannot also emit two lane changes.
   */
  function recognise(slot: ActiveTouch, x: number, y: number, time: number): void {
    if (slot.consumed) {
      return;
    }

    const dx = x - slot.startX;
    const dy = y - slot.startY;
    const absX = Math.abs(dx);
    const absY = Math.abs(dy);
    const travel = absX > absY ? absX : absY;

    if (travel < SWIPE_MIN_DISTANCE) {
      return;
    }
    if (time - slot.startTime < SWIPE_MIN_DURATION_MS) {
      return;
    }

    const major = travel;
    const minor = absX > absY ? absY : absX;
    if (minor > major * DIAGONAL_DEAD_ZONE) {
      // Ambiguous diagonal. Discard rather than guess — a wrong guess here reads
      // as the game misreading the player, which is worse than no response.
      return;
    }

    const horizontal = absX > absY;
    if (horizontal) {
      const direction = dx > 0 ? 1 : -1;
      if (isTwoFingerGesture(slot)) {
        latchRoll(latch, direction);
        consumeAll();
      } else {
        latchLateral(latch, direction);
        slot.consumed = true;
      }
      return;
    }

    if (dy < 0) {
      latch.jump = true;
      jumpHoldUntil = time + HOLD_DURATION_MS;
    } else {
      latch.slide = true;
      slideHoldUntil = time + HOLD_DURATION_MS;
    }
    slot.consumed = true;
  }

  function consumeAll(): void {
    for (let i = 0; i < activeCount; i += 1) {
      const slot = touches[i];
      if (slot !== undefined) {
        slot.consumed = true;
      }
    }
  }

  function onTouchStart(event: Event): void {
    const touchEvent = event as TouchEvent;
    const time = now();
    lastActivity = time;
    for (let i = 0; i < touchEvent.changedTouches.length; i += 1) {
      const touch = touchEvent.changedTouches[i];
      if (touch !== undefined) {
        addTouch(touch.identifier, touch.clientX, touch.clientY, time);
      }
    }
  }

  function onTouchMove(event: Event): void {
    const touchEvent = event as TouchEvent;
    const time = now();
    lastActivity = time;
    for (let i = 0; i < touchEvent.changedTouches.length; i += 1) {
      const touch = touchEvent.changedTouches[i];
      if (touch === undefined) {
        continue;
      }
      const slot = findSlot(touch.identifier);
      if (slot !== undefined) {
        recognise(slot, touch.clientX, touch.clientY, time);
      }
    }
  }

  function onTouchEnd(event: Event): void {
    const touchEvent = event as TouchEvent;
    lastActivity = now();
    for (let i = 0; i < touchEvent.changedTouches.length; i += 1) {
      const touch = touchEvent.changedTouches[i];
      if (touch !== undefined) {
        removeTouch(touch.identifier);
      }
    }
  }

  target.addEventListener("touchstart", onTouchStart, { passive: true });
  target.addEventListener("touchmove", onTouchMove, { passive: true });
  target.addEventListener("touchend", onTouchEnd, { passive: true });
  target.addEventListener("touchcancel", onTouchEnd, { passive: true });

  const ACTIVITY_WINDOW_MS = 3000;

  return {
    name: "touch",
    isActive: () => now() - lastActivity < ACTIVITY_WINDOW_MS,
    poll(out: Intent): void {
      const time = now();
      latch.jump = time < jumpHoldUntil;
      latch.slide = time < slideHoldUntil;
      drainLatch(latch, out);
    },
    dispose(): void {
      target.removeEventListener("touchstart", onTouchStart);
      target.removeEventListener("touchmove", onTouchMove);
      target.removeEventListener("touchend", onTouchEnd);
      target.removeEventListener("touchcancel", onTouchEnd);
      resetLatch(latch);
      activeCount = 0;
    },
  };
}

/** Exposed for tests: the recognizer's tuning, in one place. */
export const TOUCH_CONSTANTS = {
  swipeMinDistance: SWIPE_MIN_DISTANCE,
  swipeMinDurationMs: SWIPE_MIN_DURATION_MS,
  twoFingerToleranceMs: TWO_FINGER_TOLERANCE,
  diagonalDeadZone: DIAGONAL_DEAD_ZONE,
} as const;
