/**
 * The render layer's output port for everything OUTSIDE the canvas that a theme
 * change has to move: the DOM's design tokens, the transition title card, and
 * the music stem set.
 *
 * ## The same port pattern as `hud-sink.ts`, for the same reason
 *
 * `eslint.config.mjs` forbids `src/ui/**` from importing `@/game/render/**`, and
 * ARCHITECTURE §3 puts `ui` above `render`, so neither side may name the other.
 * Render declares the port, `src/ui/` implements it structurally, and
 * `src/app/play/page.tsx` performs the assignment — the one place TypeScript
 * checks the two halves agree.
 *
 * A second port rather than more methods on `HudSink` because the two have
 * completely different clocks. `HudSink` is called at `TUNING.ui.hudPushHz`
 * during a run and its implementation must never allocate; this one fires a
 * handful of times across a whole session, does real work (re-deriving the token
 * set, starting a CSS animation, crossfading audio), and is allowed to.
 *
 * ## Slugs, not theme objects and not token bundles
 *
 * The port carries the theme's `slug` and nothing else. An earlier draft passed
 * a `ThemeTokens` bundle so the UI would never need the registry — which sounds
 * like better layering and is not, because `src/ui/theme.ts` already imports
 * `@/game/config/themes` and is entitled to: config sits below every layer, and
 * only `render` is off-limits. So the bundle was a verbatim restatement of
 * `ThemeUiRoles` with a second name, i.e. exactly the kind of duplicated
 * contract this repo has twice been bitten by. One slug, resolved through the
 * one registry, on both sides.
 */

/** Everything the DOM layer can be told about the active theme. */
export interface ThemeSink {
  /**
   * The visible theme changed. Repaints the token set and the `data-theme`
   * attribute.
   *
   * Fires once at start-up and once per completed transition — never per frame.
   */
  setTheme(slug: string): void;

  /**
   * Show or hide the transition title card.
   *
   * `null` hides it. Called with the theme being ARRIVED at, from the moment the
   * transition is requested: the card is a signpost, not a receipt.
   */
  setTitleCard(slug: string | null): void;

  /**
   * Swap to a theme's music stems, on the next bar.
   *
   * The director fires this inside the crossfade's musical window rather than at
   * its start or end — see `crossfade.ts`. The audio layer still owns *when*
   * within the bar the swap lands.
   */
  swapStems(stemSet: number): void;

  /**
   * Loading progress for the first theme, 0..1, and whether it is done.
   *
   * Real bytes over expected bytes, not a timer. The brief is explicit that the
   * indicator must be "tied to actual bytes".
   */
  setLoadProgress(fraction: number, done: boolean): void;
}

/**
 * A sink that does nothing.
 *
 * The default, so a `Scene` mounted without a DOM layer — the title diorama, a
 * test harness, a screenshot spec — needs no null checks anywhere in the loop.
 */
export const NULL_THEME_SINK: ThemeSink = {
  setTheme(): void {
    /* no DOM to paint */
  },
  setTitleCard(): void {
    /* no card to show */
  },
  swapStems(): void {
    /* no audio graph attached */
  },
  setLoadProgress(): void {
    /* nothing is waiting on it */
  },
};
