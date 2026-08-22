/**
 * The theme director — one object that owns which place the run is in.
 *
 * It holds the crossfade state, drives the preloader, applies the blend to the
 * tunnel, the lights, the fog and the two prop fields, and tells the audio and UI
 * layers when to follow. Everything it touches it was handed; it reaches into
 * nothing.
 *
 * ## Preload one theme ahead, always
 *
 * The brief's rule, and the reason a transition never stalls. The moment a theme
 * becomes current, the director asks the loader for the *next* one. By the time
 * the player has run 1,200m — a minute at least — an 13KB bundle has long since
 * arrived. If it somehow has not, `requestTransition` parks in `Waiting` and the
 * fade simply starts late rather than cutting.
 *
 * ## The sim decides WHEN, the director decides WHAT
 *
 * `SimEvent.ThemeChange` carries an ordinal and nothing else. Which theme that
 * ordinal means — and whether the player has unlocked it — is a presentation
 * question, answered here against the registry. That separation is what keeps
 * Static's unlock out of the deterministic sim: two players crossing 5,120m on
 * the same seed run identically, and only one of them sees Static.
 */

import * as THREE from "three";
import { TUNING } from "@/game/config/tuning";
import {
  DEFAULT_THEME,
  nextThemeOrdinal,
  playableThemeByOrdinal,
  themeBySlug,
  type Theme,
} from "@/game/config/themes";
import {
  blend,
  createCrossfade,
  incomingPropStrength,
  outgoingPropStrength,
  requestTransition,
  shouldSwapMusic,
  showTitleCard,
  stepCrossfade,
  TransitionPhase,
  type CrossfadeState,
} from "./crossfade";
import { ensureLoaded, isLoaded, type ThemeAssets } from "./loader";
import { blendTints, resetTints } from "./tints";

/** What the director needs to drive. All optional: a title diorama has no props. */
export interface ThemeTargets {
  /** Blends the tunnel's surface. */
  tunnel?: { blend(from: Theme, to: Theme, t: number): void } | null;
  /** Blends the light rig. */
  lighting?: { blend(from: Theme, to: Theme, t: number): void } | null;
  /** The scene's fog, written directly. */
  fog?: THREE.Fog | null;
  /** The scene's background colour, kept equal to the fog so the tunnel has no
   *  visible end — a background that differs from the fog draws a hard disc at
   *  the vanishing point. */
  background?: THREE.Color | null;
}

/** What the director reports outward, once per change rather than per frame. */
export interface ThemeListener {
  /** The visible theme changed. Drives the UI tokens and the title card. */
  onThemeChanged?(theme: Theme, ordinal: number): void;
  /** Time to swap music, on the next musical bar. */
  onMusicSwap?(theme: Theme): void;
  /** The title card should show or hide. */
  onTitleCard?(theme: Theme | null): void;
}

export interface ThemeDirector {
  /** The theme currently dominant — what the UI should be coloured as. */
  readonly current: Theme;
  /** The theme being faded toward, or `current` when idle. */
  readonly incoming: Theme;
  readonly state: Readonly<CrossfadeState>;
  /** Assets for `current`, or null before they land. */
  readonly currentAssets: ThemeAssets | null;
  /** Assets for `incoming`, or null. */
  readonly incomingAssets: ThemeAssets | null;
  /** 0..1 — how much of the outgoing theme's furniture to draw. */
  readonly outgoingProps: number;
  /** 0..1 — how much of the incoming theme's. */
  readonly incomingProps: number;

  /** A `SimEvent.ThemeChange` arrived. */
  requestTheme(ordinal: number): void;
  /** Advances the fade and applies it. Called once per rendered frame. */
  update(delta: number, targets: ThemeTargets): void;
  /** Which themes the player has unlocked. Changing it re-resolves the cycle. */
  setUnlocked(slugs: readonly string[]): void;
  /**
   * Attaches the music swap callback after construction.
   *
   * Separate from `options.listener` because of who holds what. The director is
   * built in `Scene.tsx`, which has no audio; the audio director is acquired in
   * `useGameLoop.ts`, which receives this object as a ref. Rather than thread
   * audio down into the scene or hoist the director up into the loop, the loop
   * attaches the one callback it can answer.
   *
   * It matters that this goes through the director at all. The sim's
   * `ThemeChange` carries the ordinal the RUN reached, and a player who has not
   * unlocked Static never sees it — so keying the music off the raw event, as
   * the audio director did on its own, plays Static's stems over Kiln's walls.
   */
  setMusicListener(swap: ((stemSet: number) => void) | null): void;
  dispose(): void;
}

export interface ThemeDirectorOptions {
  /** Which bundle tier to fetch. Follows the render quality tier. */
  tier: "desktop" | "mobile";
  /** Theme slugs the player has earned. Static is the only locked one today. */
  unlocked?: readonly string[];
  /**
   * Start in this theme rather than at ordinal 0, ignoring its unlock.
   *
   * A presentation override with no sim consequence whatsoever — see the note on
   * `SceneProps.themeOverride`. An unrecognised slug is ignored rather than
   * throwing: this arrives from a query string.
   */
  startSlug?: string | null;
  listener?: ThemeListener;
}

export function createThemeDirector(options: ThemeDirectorOptions): ThemeDirector {
  const listener = options.listener ?? {};
  let unlocked: readonly string[] = options.unlocked ?? [];
  let disposed = false;

  // Reused for every fog blend for the life of the director.
  const scratchFrom = new THREE.Color();
  const scratchTo = new THREE.Color();

  const forced = options.startSlug === null ? undefined : themeBySlug(options.startSlug ?? "");
  const state = createCrossfade(forced?.id ?? 0);
  let current: Theme = forced ?? playableThemeByOrdinal(0, unlocked) ?? DEFAULT_THEME;
  let incoming: Theme = current;
  let currentAssets: ThemeAssets | null = null;
  let incomingAssets: ThemeAssets | null = null;
  let cardShowing = false;
  let musicSwap: ((stemSet: number) => void) | null = null;

  /** Fetches a theme's geometry and stores it in the right slot. */
  function warm(theme: Theme, slot: "current" | "incoming"): void {
    void ensureLoaded(theme.slug, options.tier).then((assets) => {
      if (disposed) {
        return;
      }
      if (slot === "current" && theme.slug === current.slug) {
        currentAssets = assets;
      }
      if (slot === "incoming" && theme.slug === incoming.slug) {
        incomingAssets = assets;
      }
    });
  }

  /** Warms the theme AFTER the one currently showing. The brief's rule. */
  function preloadNext(): void {
    if (TUNING.theme.preloadAhead <= 0) {
      return;
    }
    const ahead = playableThemeByOrdinal(nextThemeOrdinal(state.to), unlocked);
    if (ahead.slug !== current.slug) {
      void ensureLoaded(ahead.slug, options.tier);
    }
  }

  // Snapped, not blended: before the first frame there is no previous theme to
  // come from, and a material built against an unset tint renders white.
  resetTints(current);

  warm(current, "current");
  preloadNext();
  listener.onThemeChanged?.(current, 0);

  return {
    get current() {
      return current;
    },
    get incoming() {
      return incoming;
    },
    get state() {
      return state;
    },
    get currentAssets() {
      return currentAssets;
    },
    get incomingAssets() {
      return incomingAssets;
    },
    get outgoingProps() {
      return outgoingPropStrength(state);
    },
    get incomingProps() {
      return state.phase === TransitionPhase.Idle ? 1 : incomingPropStrength(state);
    },

    requestTheme(ordinal: number): void {
      if (disposed || !Number.isFinite(ordinal)) {
        return;
      }
      const target = playableThemeByOrdinal(ordinal, unlocked);
      if (target.slug === incoming.slug) {
        return;
      }
      requestTransition(state, Math.max(0, Math.floor(ordinal)));
      incoming = target;
      incomingAssets = null;
      warm(target, "incoming");
      // The card announces the place being ARRIVED at, from the moment the
      // transition is requested — it is a signpost, not a receipt.
      cardShowing = true;
      listener.onTitleCard?.(target);
    },

    update(delta: number, targets: ThemeTargets): void {
      if (disposed) {
        return;
      }

      const ready = isLoaded(incoming.slug, options.tier);
      const wasRunning = state.phase !== TransitionPhase.Idle;
      stepCrossfade(state, delta, ready);

      if (shouldSwapMusic(state)) {
        state.musicSwapped = true;
        listener.onMusicSwap?.(incoming);
        musicSwap?.(incoming.stemSet);
      }

      const t = state.phase === TransitionPhase.Idle ? 1 : state.t;
      const from = current;
      const to = incoming;

      targets.tunnel?.blend(from, to, t);
      targets.lighting?.blend(from, to, t);
      // Particles, obstacles, pickups and the runner, on the SAME t as the walls
      // and the lights. Switching them at the halfway point instead would make a
      // transition arrive in visible stages, which is the one thing a four-second
      // crossfade exists to avoid.
      blendTints(from, to, t);

      const fog = targets.fog;
      if (fog !== null && fog !== undefined) {
        fog.near = blend(state, from.fog.near, to.fog.near);
        fog.far = unstableFar(to, blend(state, from.fog.far, to.fog.far), state.elapsed);
        // Two scratch Colors reused for the life of the director, so a fog blend
        // running every frame of a four-second transition allocates nothing.
        fog.color.copy(scratchFrom.set(from.fog.color)).lerp(scratchTo.set(to.fog.color), t);
        targets.background?.copy(fog.color);
      }

      if (cardShowing && !showTitleCard(state)) {
        cardShowing = false;
        listener.onTitleCard?.(null);
      }

      // The fade finished this frame: promote, and warm the next one.
      if (wasRunning && state.phase === TransitionPhase.Idle) {
        current = incoming;
        currentAssets = incomingAssets;
        incomingAssets = null;
        listener.onThemeChanged?.(current, state.to);
        preloadNext();
      }
    },

    setMusicListener(swap: ((stemSet: number) => void) | null): void {
      musicSwap = swap;
    },

    setUnlocked(slugs: readonly string[]): void {
      unlocked = slugs;
      preloadNext();
    },

    dispose(): void {
      disposed = true;
    },
  };
}

/**
 * Static's fog breathes; every other theme's is a constant.
 *
 * Driven off the crossfade's own elapsed clock rather than a wall clock, so it
 * is reproducible in a screenshot test and cannot drift between the fog and
 * anything else keyed to the same time.
 *
 * The oscillation is clamped to the theme's own bounds, and the LOWER bound is a
 * gameplay floor — TUNING §13 requires `fogFar > minReactionTime * maxSpeed` in
 * every theme, "Static included (its `unstableMin` is the binding value)".
 */
function unstableFar(theme: Theme, base: number, elapsed: number): number {
  const unstable = theme.fog.unstable;
  if (unstable === null) {
    return base;
  }
  const phase = Math.sin(elapsed * unstable.rate * Math.PI * 2);
  const mid = (unstable.min + unstable.max) / 2;
  const half = (unstable.max - unstable.min) / 2;
  return Math.max(unstable.min, Math.min(unstable.max, mid + phase * half));
}
