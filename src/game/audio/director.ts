/**
 * The audio director — the one object the rest of the game talks to.
 *
 * Owns the engine, the voice pools, the ducker, the sfx mapper and the music
 * system, and hides all of them. The render layer's contract is three calls:
 * `handleEvent` per drained sim event, `setTelemetry` once per frame, and
 * `dispose` on teardown.
 *
 * ## Framework-free, on purpose
 *
 * No React, no three, no r3f. `src/game/audio/` sits beside `src/game/input/` in
 * the §3 layering diagram, and `input/` is plain TypeScript for the same reason:
 * a layer that imports React can only be driven from a component, which makes it
 * untestable under Node and couples audio scheduling to the render schedule.
 *
 * ## Warm-up is lazy and per-theme
 *
 * Rendering all sixteen stems plus twenty-six one-shots up front is several
 * hundred milliseconds of main-thread work at exactly the moment the player is
 * trying to start a run. So the one-shots (which are short) render first, then
 * the starting theme's four stems, and every other theme renders on the
 * `ThemeChange` that needs it — roughly a minute of play ahead of time.
 *
 * ## Reading the sim
 *
 * `SimEvent` is imported from `sim/events.ts` for its event-kind constants. The
 * ring buffer is the sanctioned one-way channel from sim to presentation (see
 * the header of that file), and the alternative — duplicating a 28-entry enum
 * whose numeric values are part of the replay format — would be strictly worse.
 * Nothing here writes to the sim, and nothing here can change a run's outcome.
 */

import { TUNING } from "@/game/config/tuning";
import { SimEvent } from "@/game/sim/events";
import { createAudioEngine, type AudioEngine, type AudioEngineOptions } from "./engine";
import { createDucker, type Ducker } from "./ducking";
import { createMusicSystem, type MusicSystem, type ThemeBuffers } from "./music";
import { SOUNDS, THEME_STEMS, type SoundKey } from "./recipes";
import { createSfxSystem, type SfxSystem } from "./sfx";
import {
  canRenderOffline,
  createGrid,
  renderSound,
  renderStem,
  type OfflineFactory,
} from "./synth";
import { createVoicePool, type VoicePool } from "./voices";

/** The shape drained from the sim event ring. Structural, not an import. */
export interface AudioEvent {
  readonly type: number;
  readonly payload0: number;
}

/**
 * Read-only diagnostics published on `window.__axisAudio`.
 *
 * Same precedent as `window.__axisPerf` in `render/perf/PerfMonitor.tsx`: the
 * numbers a gate needs cannot be read from outside the module graph, and the
 * e2e suite runs against a **production** build, so a `NODE_ENV` guard would
 * strip exactly the thing the gate exists to measure.
 *
 * `stems` hands out the live `AudioBuffer`s so the gate can render and analyse
 * real audio — the loop seam, the click scan and the two-minute drift check all
 * read actual samples rather than trusting an argument about the design.
 *
 * Nothing here is writable and nothing reads back into the game.
 */
export interface AudioDiagnostics {
  ready: boolean;
  contextState: string;
  sampleRate: number;
  /** The context time every stem is aligned to. */
  startTime: number;
  themeId: number;
  intensity: number;
  voicePeak: number;
  /** s — measured output latency. */
  latency: number;
  grid: {
    beatSeconds: number;
    barSeconds: number;
    loopSeconds: number;
    loopSamples: number;
  } | null;
  stems: Record<string, AudioBuffer> | null;
}

interface AudioWindow extends Window {
  __axisAudio?: AudioDiagnostics;
}

export interface AudioDirectorOptions {
  /** An engine to use. One is built from `engineOptions` when omitted. */
  engine?: AudioEngine;
  engineOptions?: AudioEngineOptions;
  /** Injected for tests; defaults to the real `OfflineAudioContext`. */
  offlineFactory?: OfflineFactory;
  /** Injected for tests; defaults to `Math.random`. */
  random?: () => number;
}

export interface AudioDirector {
  readonly engine: AudioEngine;
  /** True once buffers are rendered and the graph is playing. */
  readonly ready: boolean;
  /** The music system, or null before warm-up completes. Diagnostic. */
  readonly music: MusicSystem | null;
  /** Peak concurrent sfx voices this session. The perf gate reads it. */
  readonly voicePeak: number;

  /** Routes one drained sim event. Cheap, and safe before warm-up. */
  handleEvent(event: AudioEvent): void;
  /**
   * Crossfades to a theme's stem set, aligned to a loop boundary.
   *
   * **Changed at P10.** This used to happen inside `handleEvent`, on
   * `SimEvent.ThemeChange`. It cannot: that event carries the ordinal the RUN
   * reached, and the theme a player actually SEES is resolved against the unlock
   * table by `render/theme/ThemeDirector` — so a player without Static crossed
   * 5,120m and heard Static's detuned FM lead over Kiln's foundry walls.
   *
   * The event is still tracked here, so a player who unmutes mid-run gets the
   * right stems; it just no longer triggers the swap. The visual director does,
   * from inside the crossfade's musical window.
   */
  setTheme(themeIndex: number): void;
  /** Per-frame state the music adapts to. Cheap; safe to call every frame. */
  setTelemetry(worldSpeed: number, flow: number): void;
  dispose(): void;
}

const SPEED_SPAN = TUNING.speed.maxSpeed - TUNING.speed.baseSpeed;
const FIRST_THEME = 0;

function normalise(value: number, min: number, span: number): number {
  if (span <= 0 || !Number.isFinite(value)) {
    return 0;
  }
  const t = (value - min) / span;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

export function createAudioDirector(options: AudioDirectorOptions = {}): AudioDirector {
  const engine = options.engine ?? createAudioEngine(options.engineOptions);

  let sfxPool: VoicePool | null = null;
  let uiPool: VoicePool | null = null;
  let ducker: Ducker | null = null;
  let sfx: SfxSystem | null = null;
  let music: MusicSystem | null = null;
  let disposed = false;
  let ready = false;

  /** Theme the run is in, tracked even before audio exists. */
  let themeIndex = FIRST_THEME;
  /** Overdrive state, likewise — so warm-up can start in the right place. */
  let overdriveActive = false;
  let speedNorm = 0;
  let flowNorm = 0;

  const stemCache = new Map<number, ThemeBuffers>();

  /**
   * The diagnostics object, allocated once and mutated in place.
   *
   * `publish` runs from `setTelemetry`, which the render loop calls every frame.
   * Rebuilding this object there would be 60 allocations a second of garbage
   * nobody reads — the same reasoning that keeps `RenderView` a reused struct.
   */
  const diagnostics: AudioDiagnostics = {
    ready: false,
    contextState: "none",
    sampleRate: 0,
    startTime: 0,
    themeId: 0,
    intensity: 0,
    voicePeak: 0,
    latency: 0,
    grid: null,
    stems: null,
  };

  /** Refreshes the published diagnostics in place. Allocates nothing. */
  function publish(): void {
    if (typeof window === "undefined") {
      return;
    }
    diagnostics.ready = ready;
    diagnostics.contextState = engine.context?.state ?? "none";
    diagnostics.sampleRate = engine.context?.sampleRate ?? 0;
    diagnostics.startTime = music?.startTime ?? 0;
    diagnostics.themeId = music?.themeId ?? themeIndex;
    diagnostics.intensity = music?.intensity ?? 0;
    diagnostics.voicePeak = Math.max(sfxPool?.peak ?? 0, uiPool?.peak ?? 0);
    diagnostics.latency = engine.latency.effective;

    if (music !== null) {
      diagnostics.grid = {
        beatSeconds: music.grid.beatSeconds,
        barSeconds: music.grid.barSeconds,
        loopSeconds: music.grid.loopSeconds,
        loopSamples: music.grid.loopSamples,
      };
    }

    const stems = stemCache.get(themeIndex);
    if (stems !== undefined) {
      diagnostics.stems = {
        base: stems.base,
        percussion: stems.percussion,
        tension: stems.tension,
        overdrive: stems.overdrive,
      };
    }

    (window as AudioWindow).__axisAudio = diagnostics;
  }

  async function loadTheme(id: number): Promise<ThemeBuffers> {
    const cached = stemCache.get(id);
    if (cached !== undefined) {
      return cached;
    }
    const context = engine.context;
    const recipe = THEME_STEMS[id % THEME_STEMS.length];
    if (context === null || recipe === undefined) {
      throw new Error(`No stem recipe for theme ${id}`);
    }
    // The grid is derived from the sample rate alone, so it is identical to the
    // one the music system built — there is no second source of truth here.
    const grid = createGrid(context.sampleRate);
    // Sequential rather than `Promise.all`: four concurrent offline renders
    // contend for the same thread and finish no sooner, while making the first
    // one — the only one anybody is waiting on — arrive last.
    const base = await renderStem(context, recipe.base, grid, options.offlineFactory);
    const percussion = await renderStem(context, recipe.percussion, grid, options.offlineFactory);
    const tension = await renderStem(context, recipe.tension, grid, options.offlineFactory);
    const overdrive = await renderStem(context, recipe.overdrive, grid, options.offlineFactory);
    const buffers: ThemeBuffers = { base, percussion, tension, overdrive };
    stemCache.set(id, buffers);
    return buffers;
  }

  async function warmUp(): Promise<void> {
    const context = engine.context;
    const buses = engine.buses;
    if (context === null || buses === null || disposed) {
      return;
    }
    if (!canRenderOffline() && options.offlineFactory === undefined) {
      // No offline rendering available. The game runs silent rather than broken.
      return;
    }

    sfxPool = createVoicePool(context, buses.sfx);
    uiPool = createVoicePool(context, buses.ui);
    ducker = createDucker(buses.musicDuck.gain);

    const buffers = new Map<SoundKey, AudioBuffer>();
    for (const key of Object.keys(SOUNDS) as SoundKey[]) {
      const recipe = SOUNDS[key];
      try {
        buffers.set(key, await renderSound(context, recipe, options.offlineFactory));
      } catch {
        // One sound failing to render must not take the whole mix down. A
        // missing key is simply skipped by `sfx.play`.
      }
      if (disposed) {
        return;
      }
    }

    sfx = createSfxSystem({
      buffers,
      sfxPool,
      uiPool,
      ducker,
      latencyOffset: () => engine.settings.latencyOffset,
      random: options.random,
    });

    music = createMusicSystem(context, buses.music, {
      loadTheme,
      lead: Math.max(TUNING.audio.scheduleAhead, engine.latency.effective),
    });

    // `ready` flips only once the stems are rendered AND playing.
    //
    // Setting it before the await would make it mean "the graph exists", which
    // is not what any caller wants to know and is not what it says. The e2e gate
    // reads `ready` and then immediately reads `stems`; with the flag raised
    // early it saw `stems: null` and four assertions failed on a lie rather than
    // on a defect.
    await music.play(themeIndex);
    if (disposed || music === null) {
      return;
    }
    ready = true;
    music.setIntensity(speedNorm, flowNorm, engine.now());
    if (overdriveActive) {
      music.setOverdrive(true, engine.now());
    }
    publish();
  }

  const unsubscribe = engine.onReady(() => {
    void warmUp();
  });

  return {
    engine,
    get ready() {
      return ready;
    },
    get music() {
      return music;
    },
    get voicePeak() {
      return Math.max(sfxPool?.peak ?? 0, uiPool?.peak ?? 0);
    },

    handleEvent(event: AudioEvent): void {
      if (disposed) {
        return;
      }

      // Theme and Overdrive are tracked whether or not audio is up yet, so a
      // player who unmutes at 3,000m gets Bazaar rather than Kiln.
      switch (event.type) {
        case SimEvent.ThemeChange:
          // Tracked, NOT played — see `setTheme`. An unmute after this point
          // still starts on the right theme, because warm-up reads this value.
          themeIndex = Math.max(0, Math.trunc(event.payload0));
          break;
        case SimEvent.OverdriveStart:
          overdriveActive = true;
          music?.setOverdrive(true, engine.now());
          break;
        case SimEvent.OverdriveEnd:
          overdriveActive = false;
          music?.setOverdrive(false, engine.now());
          break;
        case SimEvent.RunStart:
          overdriveActive = false;
          music?.setOverdrive(false, engine.now());
          break;
        default:
          break;
      }

      sfx?.handle(event.type, event.payload0, engine.now());
    },

    setTheme(index: number): void {
      if (disposed || !Number.isFinite(index)) {
        return;
      }
      themeIndex = Math.max(0, Math.trunc(index));
      if (music !== null) {
        void music.play(themeIndex).then(publish);
      }
    },

    setTelemetry(worldSpeed: number, flow: number): void {
      if (disposed) {
        return;
      }
      speedNorm = normalise(worldSpeed, TUNING.speed.baseSpeed, SPEED_SPAN);
      flowNorm = normalise(flow, 0, TUNING.flow.flowMax);
      music?.setIntensity(speedNorm, flowNorm, engine.now());
      publish();
    },

    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      ready = false;
      unsubscribe();
      const now = engine.now();
      music?.dispose();
      sfxPool?.stopAll(now);
      uiPool?.stopAll(now);
      sfxPool?.dispose();
      uiPool?.dispose();
      music = null;
      sfx = null;
      sfxPool = null;
      uiPool = null;
      ducker = null;
      stemCache.clear();
      engine.dispose();
      if (typeof window !== "undefined") {
        delete (window as AudioWindow).__axisAudio;
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The session director
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One `AudioContext` for the whole session, reference-counted.
 *
 * ## Why this exists — a bug P14 walked straight into
 *
 * Until P14 the director was created in exactly one place, by the game loop, and
 * a per-mount instance was harmless. Then the title screen got a diorama with its
 * own audio, and pressing RUN unmounted one director and mounted another. Three
 * things broke at once:
 *
 *   1. **Audio stopped on every run start.** The new context is created locked,
 *      and its gesture listeners are armed *after* the click that started the
 *      run — so the click that should have unlocked it was already spent. Music
 *      played on the menu and died the moment you pressed RUN.
 *   2. **Contexts leak.** Chrome allows roughly six `AudioContext`s per page.
 *      Six runs and the seventh is silent for good.
 *   3. **Warm-up repeats.** Every run re-rendered twenty-six one-shots and four
 *      stems — hundreds of milliseconds of main-thread work at precisely the
 *      moment the player expects the game to start.
 *
 * An `AudioContext` is a **session** resource, like a WebGL context. It belongs
 * to the page, not to whichever component happens to be mounted.
 *
 * ## Reference counting, not a bare singleton
 *
 * Callers still pair `acquire`/`dispose` exactly as before, so nothing at the
 * call site changes and the last release still tears the graph down — which
 * matters for tests and for a route change away from the game. What changes is
 * that a mid-session handover, where one consumer mounts before the other
 * unmounts, keeps the same context alive.
 */
let sessionDirector: AudioDirector | null = null;
let sessionRefs = 0;
let teardownTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * A handle on the shared director.
 *
 * The returned object is a thin wrapper whose `dispose` releases one reference
 * rather than destroying the graph. Calling it twice is safe and counts once.
 */
export function acquireAudioDirector(options: AudioDirectorOptions = {}): AudioDirector {
  // A pending teardown means the last release was part of a handover, not a
  // shutdown. Cancelling it here is what keeps the context alive across it.
  if (teardownTimer !== null) {
    clearTimeout(teardownTimer);
    teardownTimer = null;
  }
  if (sessionDirector === null) {
    sessionDirector = createAudioDirector(options);
  }
  sessionRefs += 1;
  const shared = sessionDirector;
  let released = false;

  return {
    get engine() {
      return shared.engine;
    },
    get ready() {
      return shared.ready;
    },
    get music() {
      return shared.music;
    },
    get voicePeak() {
      return shared.voicePeak;
    },
    handleEvent(event: AudioEvent): void {
      shared.handleEvent(event);
    },
    setTheme(index: number): void {
      shared.setTheme(index);
    },
    setTelemetry(worldSpeed: number, flow: number): void {
      shared.setTelemetry(worldSpeed, flow);
    },
    dispose(): void {
      if (released) {
        return;
      }
      released = true;
      sessionRefs -= 1;
      if (sessionRefs > 0) {
        return;
      }
      sessionRefs = 0;

      /**
       * Teardown is deferred by one turn of the event loop, and that is the
       * whole point.
       *
       * React unmounts the outgoing tree **before** it mounts the incoming one,
       * so during a title -> run handover the reference count passes through
       * zero even though audio is wanted continuously. Tearing down there threw
       * the context away and built a fresh, locked one whose gesture listeners
       * were armed after the click that started the run — so the music died on
       * every single RUN press and never recovered.
       *
       * A zero-delay timer outlives that gap, because React commits the unmount
       * and the mount in one synchronous pass. If nothing re-acquires, the
       * teardown lands on the next tick exactly as it would have.
       */
      if (teardownTimer !== null) {
        clearTimeout(teardownTimer);
      }
      teardownTimer = setTimeout(() => {
        teardownTimer = null;
        if (sessionRefs > 0) {
          return;
        }
        sessionDirector?.dispose();
        sessionDirector = null;
      }, 0);
    },
  };
}

/** Tests only: drops the session director immediately, refs or not. */
export function resetAudioSession(): void {
  if (teardownTimer !== null) {
    clearTimeout(teardownTimer);
    teardownTimer = null;
  }
  sessionDirector?.dispose();
  sessionDirector = null;
  sessionRefs = 0;
}
