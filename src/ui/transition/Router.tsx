"use client";

/**
 * The screen stack.
 *
 * Owns three things nothing else should: which screen is mounted, the shutter
 * that covers the swap, and the gamepad navigator that is only alive while a
 * screen is open.
 *
 * ## The mounted screen lags the store by half a transition
 *
 * `useUiStore().screen` is where the player asked to go. `mounted` is what is on
 * screen. They differ for the ~150ms the shutter takes to cover the frame,
 * because the swap happens on the single frame the outgoing screen is completely
 * hidden — that is the only frame on which a swap is invisible.
 *
 * ## Why the gamepad navigator is scoped to menus
 *
 * During a run the pad belongs to the game. If the menu navigator were always
 * running, a D-pad press would change lane *and* move focus on whatever button
 * sat behind the HUD, and the next A press — which the player means as jump —
 * would activate it. So it starts when the first screen opens and stops when the
 * last one closes.
 *
 * ## Escape is handled per screen, not here
 *
 * What Escape means depends on where you are: close the modal, resume the run, go
 * back a level. A global handler would have to know all three, so each screen
 * owns its own and this file stays ignorant.
 */

import { useEffect, useRef, useState } from "react";
import { Screen, useUiStore, type ScreenName } from "../state/uiStore";
import { startGamepadNav, type GamepadNav } from "../a11y/gamepad-nav";
import { Shutter } from "./Shutter";
import { useScreenTransition } from "./useTransition";
import { countRender } from "../CommitCounter";

/*
 * There was a `screenShowsWorld(screen)` helper here, used to unmount the canvas
 * behind opaque screens. It is gone: unmounting the canvas destroyed the WebGL
 * context and the audio graph every time the player opened the shop, and the
 * saving — a handful of draw calls behind an opaque plate — was not worth it.
 * The canvas is now mounted for the whole session. See `app/play/page.tsx`.
 */

export interface RouterProps {
  /** Renders the screen. Called with whatever is currently mounted. */
  readonly render: (screen: ScreenName) => React.ReactNode;
}

export function Router({ render }: RouterProps): React.ReactElement {
  countRender("Router");

  const requested = useUiStore((state) => state.screen);
  const { phase, begin, hostRef } = useScreenTransition();
  const [mounted, setMounted] = useState<ScreenName>(requested);

  useEffect(() => {
    if (mounted === requested) {
      return;
    }
    // One state write per screen change, on the covered frame. Not per frame of
    // the transition — the wipe itself is a CSS custom property the rAF loop
    // writes directly, and React never sees it.
    begin(() => setMounted(requested));
  }, [requested, mounted, begin]);

  const navRef = useRef<GamepadNav | null>(null);
  useEffect(() => {
    const inMenu = mounted !== Screen.Run;
    if (inMenu && navRef.current === null) {
      navRef.current = startGamepadNav();
    } else if (!inMenu && navRef.current !== null) {
      navRef.current.stop();
      navRef.current = null;
    }
  }, [mounted]);

  useEffect(
    () => () => {
      navRef.current?.stop();
      navRef.current = null;
    },
    [],
  );

  return (
    <div ref={hostRef} className="axis-router" data-phase={phase}>
      {render(mounted)}
      <Shutter phase={phase} />
    </div>
  );
}
