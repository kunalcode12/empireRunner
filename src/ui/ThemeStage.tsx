"use client";

/**
 * The DOM half of the theme system: the transition title card, the token swap it
 * hides, and the byte-accurate load bar.
 *
 * Implements `ThemeSink` structurally. It never names anything in
 * `@/game/render` — `src/app/play/page.tsx` performs the assignment. See the
 * header of `game/render/theme-sink.ts` for why the dependency points this way.
 *
 * ## The card is what makes the palette swap legal
 *
 * `ui/theme.ts` explains at length why the six role tokens CUT rather than
 * transition: interpolating custom properties across every surface at once
 * produces a two-second soft gradient, which is precisely what GAME_BIBLE §11.1
 * forbids. A cut needs cover, and the theme card is it — struck across the frame
 * at full opacity, holding, then leaving. The tokens change while it is opaque,
 * so the cut is never on screen.
 *
 * That is why `applyTheme` is called from the CARD's timeline rather than from
 * `setTheme`. `setTheme` still calls it, because start-up and any path with no
 * card must still land somewhere — and `applyTheme` short-circuits when the
 * theme is already active, so the double call costs a comparison.
 *
 * ## No React state per frame, same as everywhere else
 *
 * The card is one element mutated through a ref. Its three beats (strike, hold,
 * leave) are CSS animations driven by a `data-phase` attribute, so the whole
 * transition costs three attribute writes across four seconds.
 */

import { useEffect, useImperativeHandle, useRef } from "react";
import { themeBySlug } from "@/game/config/themes";
import { MOTION, motionIsReduced } from "./motion";
import { applyTheme } from "./theme";

/** What `app` hands to the canvas. Structurally identical to `ThemeSink`. */
export interface ThemeStageController {
  setTheme(slug: string): void;
  setTitleCard(slug: string | null): void;
  swapStems(stemSet: number): void;
  setLoadProgress(fraction: number, done: boolean): void;
}

export interface ThemeStageProps {
  onReady: (controller: ThemeStageController | null) => void;
  /**
   * Fired when the first theme's geometry lands.
   *
   * The one React state change this component causes, and it happens once per
   * session rather than per frame. The page uses it to hold the first run until
   * the tunnel it is about to draw is actually furnished — the brief's "first
   * theme blocks the first run".
   */
  onFirstThemeLoaded?: () => void;
}

/** Where in its three beats the card is. Mirrors the CSS. */
const Phase = {
  Absent: "absent",
  Strike: "strike",
  Hold: "hold",
  Leave: "leave",
} as const;

const PERCENT = 100;

export function ThemeStage({ onReady, onFirstThemeLoaded }: ThemeStageProps): React.ReactElement {
  const cardRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLSpanElement>(null);
  const blurbRef = useRef<HTMLSpanElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const barHostRef = useRef<HTMLDivElement>(null);

  /** Pending beat timers, cleared whenever a new transition interrupts one. */
  const timersRef = useRef<number[]>([]);

  const controllerRef = useRef<ThemeStageController>(null);

  /*
   * Held in a ref so the imperative handle does not have to be rebuilt when the
   * callback identity changes — rebuilding it would hand the render layer a new
   * sink mid-run, which remounts the theme director.
   */
  const loadedRef = useRef(onFirstThemeLoaded);
  const announcedRef = useRef(false);

  // Written in an effect, never during render: `react-hooks/refs` forbids the
  // latter and is right to — a ref mutated during render is a torn read waiting
  // to happen under concurrent rendering.
  useEffect(() => {
    loadedRef.current = onFirstThemeLoaded;
  }, [onFirstThemeLoaded]);

  useImperativeHandle(controllerRef, (): ThemeStageController => {
    function clearTimers(): void {
      for (const id of timersRef.current) {
        window.clearTimeout(id);
      }
      timersRef.current = [];
    }

    function later(fn: () => void, ms: number): void {
      timersRef.current.push(window.setTimeout(fn, ms));
    }

    return {
      setTheme(slug: string): void {
        const theme = themeBySlug(slug);
        if (theme !== null) {
          applyTheme(theme);
        }
      },

      setTitleCard(slug: string | null): void {
        const card = cardRef.current;
        if (card === null) {
          return;
        }
        clearTimers();

        if (slug === null) {
          card.dataset["phase"] = Phase.Leave;
          later(() => {
            card.dataset["phase"] = Phase.Absent;
          }, MOTION.screen);
          return;
        }

        const theme = themeBySlug(slug);
        if (theme === null) {
          return;
        }

        const name = nameRef.current;
        const blurb = blurbRef.current;
        if (name !== null) {
          name.textContent = theme.name;
        }
        if (blurb !== null) {
          blurb.textContent = theme.blurb;
        }

        card.dataset["phase"] = Phase.Strike;
        // The cut, hidden. Reduced motion has no strike animation to wait
        // behind, so the tokens go immediately rather than after a delay that
        // would leave the old palette showing under an already-opaque card.
        later(
          () => {
            applyTheme(theme);
            card.dataset["phase"] = Phase.Hold;
          },
          motionIsReduced() ? 0 : MOTION.screen,
        );
      },

      swapStems(): void {
        // Nothing for the DOM to do. The music crossfade is owned by
        // `game/audio/director.ts`, driven from the render layer's theme
        // director — see `ThemeDirector.setMusicListener`. The method exists
        // because the port declares it, and a sink that silently dropped a
        // call it was supposed to forward would be worse than one that says
        // here, in one place, that this half has no part in it.
      },

      setLoadProgress(fraction: number, done: boolean): void {
        if (done && !announcedRef.current) {
          announcedRef.current = true;
          loadedRef.current?.();
        }
        const bar = barRef.current;
        const host = barHostRef.current;
        if (bar !== null) {
          const clamped = fraction < 0 ? 0 : fraction > 1 ? 1 : fraction;
          bar.style.width = `${(clamped * PERCENT).toFixed(1)}%`;
        }
        if (host !== null) {
          host.dataset["done"] = done ? "1" : "0";
        }
      },
    };
  }, []);

  useEffect(() => {
    const controller = controllerRef.current;
    onReady(controller);
    const timers = timersRef;
    return () => {
      onReady(null);
      for (const id of timers.current) {
        window.clearTimeout(id);
      }
      timers.current = [];
    };
  }, [onReady]);

  return (
    <>
      {/*
        The theme card. `aria-live` polite rather than assertive: arriving
        somewhere new is worth announcing and is never urgent, and a screen
        reader must not interrupt a run callout for it.
      */}
      <div
        ref={cardRef}
        className="axis-theme-card"
        data-phase={Phase.Absent}
        role="status"
        aria-live="polite"
      >
        <span ref={nameRef} className="axis-theme-card-name" />
        <span ref={blurbRef} className="axis-theme-card-blurb" />
      </div>

      {/*
        The load bar. Real bytes over expected bytes, from the loader's manifest
        — it stalls when the network stalls, which is the only reason to show a
        bar at all. Hidden once the first theme is resident.
      */}
      <div ref={barHostRef} className="axis-theme-load" data-done="1" aria-hidden="true">
        <div ref={barRef} className="axis-theme-load-bar" style={{ width: "0%" }} />
      </div>
    </>
  );
}
