/**
 * Adaptive layered music.
 *
 * ## The one rule: stems are never started and stopped to change the music
 *
 * All four stems of a theme — base, percussion, tension, overdrive — start at
 * **one identical `AudioContext` time** and loop forever. Only their gains
 * change. Nothing is ever paused, restarted, or re-triggered to bring a layer in.
 *
 * That is the entire drift fix, and it is structural rather than a mitigation.
 * Two `AudioBufferSourceNode`s started at the same time on the same clock with
 * identical loop lengths cannot drift apart: they are read from the same sample
 * counter. The moment you stop a layer and restart it later you have introduced
 * a scheduling decision, and a scheduling decision made against anything other
 * than the audio clock accumulates error — at 60fps and a 16ms quantum, an
 * unlucky restart is a quarter of a beat out. Over ten minutes that is not a
 * subtle artifact; the layers audibly separate.
 *
 * ## The one exception, and why it is still exact
 *
 * A theme change genuinely does need a different set of buffers. The new set
 * starts at `startTime + n * loopSeconds` — an exact whole number of loops after
 * the global start — which puts it at precisely the phase it would have had if
 * it had been playing since the beginning. So it is phase-identical to "never
 * stopped", while the alternative (all sixteen stems of all four themes running
 * permanently) wastes three quarters of its work.
 *
 * The old set is stopped only after its gain has reached zero.
 *
 * ## Overdrive swaps on a bar line
 *
 * Snapping the Overdrive stem in the instant Flow hits 100 puts a downbeat
 * wherever the player happened to be, which sounds like a mistake. Waiting for
 * the next bar costs at most 1.9 seconds at 126bpm and makes the swap sound
 * deliberate. It is computed from `AudioContext.currentTime` against the shared
 * grid — never `setTimeout`, which cannot hit a bar line and drifts besides.
 */

import { TUNING } from "@/game/config/tuning";
import { createGrid, type MusicGrid } from "./synth";

/** The four rendered buffers of one theme. */
export interface ThemeBuffers {
  base: AudioBuffer;
  percussion: AudioBuffer;
  tension: AudioBuffer;
  overdrive: AudioBuffer;
}

/** The stem names, in mix order. */
export const Layer = {
  Base: "base",
  Percussion: "percussion",
  Tension: "tension",
  Overdrive: "overdrive",
} as const;
export type LayerName = (typeof Layer)[keyof typeof Layer];

const LAYER_ORDER: readonly LayerName[] = [
  Layer.Base,
  Layer.Percussion,
  Layer.Tension,
  Layer.Overdrive,
];

/** One playing stem. */
interface StemVoice {
  source: AudioBufferSourceNode;
  gain: GainNode;
  /** The last value scheduled, so `layerEpsilon` has something to compare to. */
  scheduled: number;
}

/** One theme's four stems plus the node they share. */
interface StemSet {
  themeId: number;
  themeGain: GainNode;
  voices: Record<LayerName, StemVoice>;
  startedAt: number;
}

export interface MusicSystem {
  readonly grid: MusicGrid;
  /** The context time every stem is aligned to. 0 before the first start. */
  readonly startTime: number;
  /** The theme currently playing, or -1. */
  readonly themeId: number;
  /** True once at least one stem set is running. */
  readonly playing: boolean;

  /**
   * Starts, or cross-fades to, a theme.
   *
   * Takes no time argument on purpose. Rendering four stems takes real
   * milliseconds, so any timestamp a caller could pass is stale by the time the
   * buffers exist; the clock is re-read after the await instead.
   */
  play(themeId: number): Promise<void>;
  /** Updates the adaptive layer mix. Safe to call every frame. */
  setIntensity(speedNorm: number, flowNorm: number, now: number): void;
  /** Requests the Overdrive swap. Lands on the next bar. */
  setOverdrive(active: boolean, now: number): void;
  /** The next bar boundary at or after `time`. */
  nextBar(time: number): number;
  /** Blend of speed and Flow currently driving the layers. Diagnostic. */
  readonly intensity: number;
  stop(now: number): void;
  dispose(): void;
}

export interface MusicOptions {
  /** Renders (or returns cached) buffers for a theme. */
  loadTheme(themeId: number): Promise<ThemeBuffers>;
  /** Seconds added to every schedule, from `latency.ts`. */
  lead?: number;
}

const NO_THEME = -1;

function clamp01(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  return value > 1 ? 1 : value;
}

/** 0 below `from`, 1 above `to`, linear between. */
export function rampBetween(value: number, from: number, to: number): number {
  if (to <= from) {
    return value >= to ? 1 : 0;
  }
  return clamp01((value - from) / (to - from));
}

/** The blend that drives the layers. Pure, so the mix curve is testable. */
export function intensityOf(speedNorm: number, flowNorm: number): number {
  return clamp01(
    TUNING.audio.musicSpeedWeight * clamp01(speedNorm) +
      TUNING.audio.musicFlowWeight * clamp01(flowNorm),
  );
}

/** The four layer gains for an intensity and Overdrive state. Pure. */
export function layerTargets(
  intensity: number,
  overdrive: boolean,
): Readonly<Record<LayerName, number>> {
  const duck = overdrive ? 1 - TUNING.audio.overdriveLayerDuck : 1;
  return {
    [Layer.Base]: duck,
    [Layer.Percussion]:
      rampBetween(intensity, TUNING.audio.percussionOnset, TUNING.audio.percussionFull) * duck,
    [Layer.Tension]:
      rampBetween(intensity, TUNING.audio.tensionOnset, TUNING.audio.tensionFull) * duck,
    [Layer.Overdrive]: overdrive ? 1 : 0,
  };
}

/** Schedules a gain change. Always from the param's real current value. */
function rampTo(param: AudioParam, target: number, at: number, duration: number): void {
  param.cancelScheduledValues(at);
  param.setValueAtTime(param.value, at);
  param.linearRampToValueAtTime(target, at + duration);
}

export function createMusicSystem(
  context: BaseAudioContext,
  destination: AudioNode,
  options: MusicOptions,
): MusicSystem {
  const grid = createGrid(context.sampleRate);
  const lead = options.lead ?? TUNING.audio.scheduleAhead;

  let startTime = 0;
  /**
   * Whether `startTime` has been established.
   *
   * A separate flag rather than testing `startTime === 0`, because zero is a
   * legitimate origin — a context that has only just been created reads
   * `currentTime` at or very near 0, and the sentinel version silently made
   * `nextBar` the identity function for the first moments of every session.
   * Which is to say: the Overdrive swap was not quantised at all if the player
   * reached Flow 100 quickly enough.
   */
  let originSet = false;
  let current: StemSet | null = null;
  let retiring: StemSet | null = null;
  let overdriveOn = false;
  let intensity = 0;
  /** While a bar-quantised swap is pending, intensity ramps stand down. */
  let swapPendingUntil = Number.NEGATIVE_INFINITY;
  let disposed = false;
  /** Guards against two overlapping `play` calls racing to become `current`. */
  let loadToken = 0;

  function nextBar(time: number): number {
    if (!originSet) {
      return time;
    }
    const elapsed = time - startTime;
    const bars = Math.ceil(elapsed / grid.barSeconds);
    return startTime + bars * grid.barSeconds;
  }

  /** The next loop boundary strictly after `time`. New stem sets start here. */
  function nextLoop(time: number): number {
    const elapsed = time - startTime;
    const loops = Math.floor(elapsed / grid.loopSeconds) + 1;
    return startTime + loops * grid.loopSeconds;
  }

  function buildSet(themeId: number, buffers: ThemeBuffers, at: number): StemSet {
    const themeGain = context.createGain();
    themeGain.gain.value = 0;
    themeGain.connect(destination);

    const voices = {} as Record<LayerName, StemVoice>;
    const targets = layerTargets(intensity, overdriveOn);

    for (const name of LAYER_ORDER) {
      const gain = context.createGain();
      gain.gain.value = targets[name];
      gain.connect(themeGain);

      const source = context.createBufferSource();
      source.buffer = buffers[name];
      source.loop = true;
      source.loopStart = 0;
      // Explicit rather than left at 0 (which means "the whole buffer"): every
      // stem buffer is rendered to exactly `loopSamples`, and stating the loop
      // end makes that contract visible at the one place it could break.
      source.loopEnd = buffers[name].duration;
      source.connect(gain);
      source.start(at);

      voices[name] = { source, gain, scheduled: targets[name] };
    }

    return { themeId, themeGain, voices, startedAt: at };
  }

  /** Fades a set out and tears it down once it is silent. */
  function retire(set: StemSet, now: number, fade: number): void {
    rampTo(set.themeGain.gain, 0, now, fade);
    const stopAt = now + fade;
    for (const name of LAYER_ORDER) {
      const voice = set.voices[name];
      voice.source.onended = () => {
        try {
          voice.source.disconnect();
          voice.gain.disconnect();
        } catch {
          // Torn down with the context.
        }
      };
      try {
        voice.source.stop(stopAt);
      } catch {
        // Never started.
      }
    }
  }

  function applyTargets(at: number, fade: number): void {
    if (current === null) {
      return;
    }
    const targets = layerTargets(intensity, overdriveOn);
    for (const name of LAYER_ORDER) {
      const voice = current.voices[name];
      const target = targets[name];
      if (Math.abs(target - voice.scheduled) < TUNING.audio.layerEpsilon) {
        continue;
      }
      rampTo(voice.gain.gain, target, at, fade);
      voice.scheduled = target;
    }
  }

  function stopAll(now: number): void {
    if (retiring !== null) {
      retire(retiring, now, TUNING.audio.overdriveFade);
      retiring = null;
    }
    if (current !== null) {
      retire(current, now, TUNING.audio.themeFade);
      current = null;
    }
    startTime = 0;
    originSet = false;
    overdriveOn = false;
    swapPendingUntil = Number.NEGATIVE_INFINITY;
  }

  return {
    grid,
    get startTime() {
      return startTime;
    },
    get themeId() {
      return current?.themeId ?? NO_THEME;
    },
    get playing() {
      return current !== null;
    },
    get intensity() {
      return intensity;
    },

    nextBar,

    async play(themeId: number): Promise<void> {
      if (disposed) {
        return;
      }
      if (current !== null && current.themeId === themeId) {
        return;
      }
      loadToken += 1;
      const token = loadToken;

      const buffers = await options.loadTheme(themeId);
      if (disposed || token !== loadToken) {
        return;
      }

      // Re-read the clock: rendering four stems takes real time, and scheduling
      // against a timestamp captured before an await is how cues end up in the
      // past.
      const at = context.currentTime + lead;

      if (current === null) {
        // First start defines the grid origin for the entire session. Every
        // later alignment is measured from here.
        startTime = at;
        originSet = true;
        const set = buildSet(themeId, buffers, at);
        rampTo(set.themeGain.gain, 1, at, TUNING.audio.themeFade);
        current = set;
        return;
      }

      // A whole number of loops after the origin, so the new set is at exactly
      // the phase it would have had if it had been playing all along.
      const aligned = nextLoop(at);
      const set = buildSet(themeId, buffers, aligned);
      rampTo(set.themeGain.gain, 1, aligned, TUNING.audio.themeFade);

      if (retiring !== null) {
        retire(retiring, at, TUNING.audio.overdriveFade);
      }
      retiring = current;
      retire(current, aligned, TUNING.audio.themeFade);
      current = set;
    },

    setIntensity(speedNorm: number, flowNorm: number, now: number): void {
      if (current === null || now < swapPendingUntil) {
        // Deferred rather than dropped: a bar-quantised swap owns the layer
        // gains until it lands, and a second writer would cancel its automation.
        intensity = intensityOf(speedNorm, flowNorm);
        return;
      }
      intensity = intensityOf(speedNorm, flowNorm);
      applyTargets(now, TUNING.audio.layerFade);
    },

    setOverdrive(active: boolean, now: number): void {
      if (current === null || active === overdriveOn) {
        return;
      }
      overdriveOn = active;
      const at = nextBar(now + lead);
      swapPendingUntil = at + TUNING.audio.overdriveFade;
      applyTargets(at, TUNING.audio.overdriveFade);
    },

    stop: stopAll,

    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      stopAll(context.currentTime);
    },
  };
}
