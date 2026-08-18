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

    ready = true;
    await music.play(themeIndex);
    if (disposed || music === null) {
      return;
    }
    music.setIntensity(speedNorm, flowNorm, engine.now());
    if (overdriveActive) {
      music.setOverdrive(true, engine.now());
    }
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
          themeIndex = Math.max(0, Math.trunc(event.payload0));
          if (music !== null) {
            void music.play(themeIndex);
          }
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

    setTelemetry(worldSpeed: number, flow: number): void {
      if (disposed) {
        return;
      }
      speedNorm = normalise(worldSpeed, TUNING.speed.baseSpeed, SPEED_SPAN);
      flowNorm = normalise(flow, 0, TUNING.flow.flowMax);
      music?.setIntensity(speedNorm, flowNorm, engine.now());
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
    },
  };
}
