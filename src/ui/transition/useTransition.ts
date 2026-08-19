"use client";

/**
 * The transition clock.
 *
 * One scalar, `progress`, driven from 0 to 1 by rAF. That is the whole
 * mechanism, and it is a scalar rather than a CSS transition for one reason:
 * **every transition must have an interruptible reverse.** A CSS transition can
 * be reversed, but only by swapping the target and letting it re-ease from the
 * current computed value, which browsers do inconsistently for `clip-path`. A
 * number you own can be reversed exactly, from wherever it happens to be, with no
 * jump.
 *
 * ## Progress lives in a ref, not in state
 *
 * The value changes every frame while a wipe is running. Putting it in
 * `useState` would re-render the screen tree sixty times per transition, which is
 * precisely the cost this whole UI is built to avoid. The ref is written by the
 * rAF loop, and the loop pushes it straight onto a CSS custom property. React
 * hears about the transition exactly twice: when it starts and when it ends.
 *
 * ## Duration
 *
 * `MOTION.screen` — 300ms, which is 18 sim ticks, which is `rollDuration`. A
 * screen change takes exactly as long as the roll the player already has in their
 * hands, on the roll's own easing curve.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { MOTION, easeInOutCubic } from "../motion";

export type TransitionPhase = "idle" | "covering" | "revealing";

export interface TransitionApi {
  /** What the shutter is doing. Drives the DOM only at phase boundaries. */
  readonly phase: TransitionPhase;
  /**
   * Runs a screen change.
   *
   * Covers the frame, calls `swap` at full cover — the one frame the outgoing
   * screen is completely hidden — then reveals. Calling it again mid-flight
   * reverses cleanly rather than queuing.
   */
  begin(swap: () => void): void;
  /** The element the shutter should attach its progress property to. */
  readonly hostRef: React.RefObject<HTMLDivElement | null>;
}

export function useScreenTransition(): TransitionApi {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [phase, setPhase] = useState<TransitionPhase>("idle");

  const progress = useRef(0);
  const direction = useRef<1 | -1>(1);
  const frame = useRef<number | null>(null);
  const swapRef = useRef<(() => void) | null>(null);
  const startedAt = useRef(0);
  const startFrom = useRef(0);

  const write = useCallback((value: number): void => {
    const host = hostRef.current;
    if (host !== null) {
      // A custom property, so the shutter's own rules decide what the number
      // means. Writing `clip-path` here would put the visual design in the
      // driver, which is the wrong place for it.
      host.style.setProperty("--axis-wipe", value.toFixed(4));
    }
  }, []);

  const stop = useCallback((): void => {
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current);
      frame.current = null;
    }
  }, []);

  const run = useCallback((): void => {
    const step = (): void => {
      const elapsed = performance.now() - startedAt.current;
      // Remaining distance, not total: a reversal partway through takes only as
      // long as it has left to travel, so an interrupted wipe never feels
      // sluggish on the way back.
      const target = direction.current === 1 ? 1 : 0;
      const span = Math.abs(target - startFrom.current);
      const duration = Math.max(1, MOTION.screen * span);
      const t = Math.min(1, elapsed / duration);
      const eased = easeInOutCubic(t);
      progress.current =
        direction.current === 1
          ? startFrom.current + (1 - startFrom.current) * eased
          : startFrom.current * (1 - eased);
      write(progress.current);

      if (t < 1) {
        frame.current = requestAnimationFrame(step);
        return;
      }

      frame.current = null;
      if (direction.current === 1) {
        // Fully covered. This is the only frame in which swapping the screen is
        // invisible, so it is the only frame it may happen on.
        swapRef.current?.();
        swapRef.current = null;
        setPhase("revealing");
        direction.current = -1;
        startFrom.current = 1;
        startedAt.current = performance.now();
        frame.current = requestAnimationFrame(step);
      } else {
        setPhase("idle");
        write(0);
      }
    };

    stop();
    startedAt.current = performance.now();
    startFrom.current = progress.current;
    frame.current = requestAnimationFrame(step);
  }, [stop, write]);

  const begin = useCallback(
    (swap: () => void): void => {
      // A second request while covering replaces the pending swap rather than
      // queueing it. The player pressed two buttons; the last one is what they
      // meant, and playing both would show a screen nobody asked for.
      swapRef.current = swap;
      direction.current = 1;
      setPhase("covering");
      run();
    },
    [run],
  );

  useEffect(() => stop, [stop]);

  return { phase, begin, hostRef };
}
