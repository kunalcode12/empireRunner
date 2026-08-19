"use client";

/**
 * The screen-print wipe.
 *
 * Not a fade, not a slide, not a dissolve. A hard-edged bar of flat ink is pulled
 * across the frame the way a squeegee is pulled across a screen, and the incoming
 * screen is revealed behind it.
 *
 * ## The mis-registration is the whole point
 *
 * A two-colour screen print is never in perfect register — the second pull lands
 * a fraction off the first, and for one moment you can see both. So the incoming
 * screen's **key-line layer arrives `registerLeadTicks` (2 ticks, 33ms) before
 * its colour layer, offset by 3px**, then snaps into register.
 *
 * That detail is the difference between this and a generic wipe. It is also the
 * one thing in the interface that could not have come out of a component library,
 * because no library models a printing defect.
 *
 * ## Two layers, one number
 *
 * Both read `--axis-wipe` from the host, which `useTransition` writes every
 * frame. The ink bar's `translateX` and the reveal's `clip-path` are both derived
 * from it in CSS, so there is exactly one animated value in the system and
 * nothing can desynchronise.
 *
 * `aria-hidden` and `pointer-events: none`: it is ink. It must never be
 * described, and it must never eat the tap that lands as it clears.
 */

import { type TransitionPhase } from "./useTransition";

export interface ShutterProps {
  readonly phase: TransitionPhase;
}

export function Shutter({ phase }: ShutterProps): React.ReactElement | null {
  if (phase === "idle") {
    // Unmounted between transitions rather than left at zero opacity. A
    // full-viewport element that is merely invisible still costs a composite
    // layer on every frame of gameplay underneath it.
    return null;
  }

  return (
    <div className="axis-shutter" data-phase={phase} aria-hidden="true">
      {/* The colour pull. */}
      <div className="axis-shutter-ink" />
      {/* The key-line pull, running 2 ticks ahead and 3px off register. */}
      <div className="axis-shutter-key" />
    </div>
  );
}
