"use client";

/**
 * UI state — which screen is open, and the player's settings.
 *
 * docs/ARCHITECTURE.md §3.1: "UI state (screen, menu selection, modal) → zustand.
 * Changes rarely, needs React." Both halves of that matter. This store drives
 * React re-renders, which is correct *because* it changes at human speed — a
 * screen opens, a slider moves. Nothing in a frame path may ever write to it.
 *
 * ## Settings are applied to the DOM, not just stored
 *
 * Motion, colourblind mode and audio volumes all have a side effect outside
 * React — a root attribute, or a write into the audio layer's own persisted
 * settings. Doing that in the action rather than in a `useEffect` somewhere means
 * there is one place the setting takes hold, and it cannot get out of step with
 * the store.
 */

import { create } from "zustand";
import { setColorblindSafe } from "../a11y/colorblind";

/** Every screen. `run` is the absence of a screen — the game itself. */
export const Screen = {
  Title: "title",
  Run: "run",
  Death: "death",
  Pause: "pause",
  Shop: "shop",
  Inventory: "inventory",
  Avatars: "avatars",
  Missions: "missions",
  Settings: "settings",
  Leaderboard: "leaderboard",
} as const;
export type ScreenName = (typeof Screen)[keyof typeof Screen];

/** `null` follows the OS; `true`/`false` are an explicit override, both ways. */
export type MotionPreference = boolean | null;

export interface UiSettings {
  masterVolume: number;
  musicVolume: number;
  sfxVolume: number;
  uiVolume: number;
  muted: boolean;
  /** s — the audio offset slider. Clamped by the audio layer on every read. */
  audioOffset: number;
  reducedMotion: MotionPreference;
  colorblindSafe: boolean;
  /** `null` = auto-detect. Otherwise a forced quality tier. */
  quality: string | null;
}

export interface UiState {
  screen: ScreenName;
  /** Where "back" goes. One level is enough; this is not a browser. */
  previous: ScreenName;
  /** Bumped on every run start, so the canvas remounts with a fresh seed. */
  runId: number;
  seed: number;
  /**
   * The signed run token for the run in progress, or null.
   *
   * Null means the run cannot be submitted — the server was unreachable when it
   * started, so the seed is a local one and no leaderboard place is possible.
   * The run itself is unaffected; see `ui/state/runApi.ts` for why offline play
   * degrades rather than blocks.
   */
  runToken: string | null;
  /**
   * Starting Shards for the run in progress, as the SERVER quoted them.
   *
   * Passed straight into `createSim({ shards })`. It is part of the simulated
   * state and therefore part of the replay hash, so using the local save's
   * number instead would make every run fail verification.
   */
  runShards: number;
  /** ms epoch when the current run started. The submitted wall-clock figure. */
  runStartedAt: number;
  settings: UiSettings;

  go(screen: ScreenName): void;
  back(): void;
  startRun(options?: { seed?: number; runToken?: string | null; shards?: number }): void;
  /**
   * Fetches a server-issued seed, then starts the run.
   *
   * What RUN and RETRY actually call. It is one round trip on a page that is
   * already sitting still, and it is the difference between a leaderboard and a
   * suggestion box — see `startRun`.
   *
   * Never rejects. `runApi.startRun` falls back to a local seed when the server
   * cannot be reached, so a player with no connection still plays; they simply
   * cannot submit.
   */
  beginRun(): Promise<void>;
  updateSettings(patch: Partial<UiSettings>): void;
}

const DEFAULT_SETTINGS: UiSettings = {
  masterVolume: 0.9,
  musicVolume: 0.6,
  sfxVolume: 0.85,
  uiVolume: 0.7,
  muted: false,
  audioOffset: 0,
  reducedMotion: null,
  colorblindSafe: false,
  quality: null,
};

/** Applies the settings that live outside React. */
function applySideEffects(settings: UiSettings): void {
  if (typeof document === "undefined") {
    return;
  }
  const root = document.documentElement;
  // Three states, and the attribute has to distinguish "explicitly full" from
  // "unset", or a player who wants full motion on a system set to reduce cannot
  // get it — `tokens.css` keys its media query off exactly that.
  if (settings.reducedMotion === null) {
    delete root.dataset["motion"];
  } else {
    root.dataset["motion"] = settings.reducedMotion ? "reduced" : "full";
  }
  setColorblindSafe(settings.colorblindSafe, root);
}

import { startRun as requestRunSeed } from "./runApi";

export const useUiStore = create<UiState>()((set, get) => ({
  screen: Screen.Title,
  previous: Screen.Title,
  runId: 0,
  // Seeded from the clock on the first run rather than at module load, so two
  // tabs opened together do not play the identical track.
  seed: 1,
  runToken: null,
  runShards: 0,
  runStartedAt: 0,
  settings: DEFAULT_SETTINGS,

  go(screen: ScreenName): void {
    const current = get().screen;
    if (current === screen) {
      return;
    }
    set({ screen, previous: current });
  },

  back(): void {
    set((state) => ({ screen: state.previous, previous: Screen.Title }));
  },

  /**
   * Begins a run.
   *
   * **The seed is normally the SERVER's.** `app/play/page.tsx` fetches one from
   * `/api/run/start` before calling this, because a client that picks its own
   * seed can generate ten thousand layouts offline, find the one worth 400,000
   * points, and submit a perfectly genuine replay of it — no forgery required.
   *
   * The local fallback survives only for the offline path and for tests. A run
   * started that way has `runToken: null` and can never be submitted.
   */
  startRun(options?: { seed?: number; runToken?: string | null; shards?: number }): void {
    set((state) => ({
      screen: Screen.Run,
      previous: Screen.Title,
      runId: state.runId + 1,
      seed: options?.seed ?? Date.now() % 0x7fffffff,
      runToken: options?.runToken ?? null,
      runShards: options?.shards ?? 0,
      runStartedAt: Date.now(),
    }));
  },

  async beginRun(): Promise<void> {
    const issued = await requestRunSeed();
    get().startRun({
      seed: issued.seed,
      runToken: issued.runToken,
      shards: issued.shards,
    });
  },

  updateSettings(patch: Partial<UiSettings>): void {
    const settings = { ...get().settings, ...patch };
    applySideEffects(settings);
    set({ settings });
  },
}));

/** Re-applies stored settings after a rehydration or a remount. */
export function applyStoredSettings(): void {
  applySideEffects(useUiStore.getState().settings);
}
