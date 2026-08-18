/**
 * The one-shot voice pool.
 *
 * ## What is actually pooled, and what the spec will not let us pool
 *
 * `AudioBufferSourceNode` is **single-use by specification**: once started it can
 * never be started again, and there is no reset. So a literal "no allocation per
 * shot" pool is not achievable in Web Audio, and claiming otherwise would be a
 * lie in a comment.
 *
 * What IS pooled is everything that matters: the gain and panner chain per slot,
 * pre-built and pre-connected at warm-up, and the slot itself. A buffer source is
 * a thin handle onto an already-decoded buffer — the expensive things (the buffer
 * data, the node graph, the connections) are created once. And the cap is what
 * the pool really buys: a hard ceiling on concurrent voices, so a shatter burst
 * during Overdrive cannot spawn two hundred nodes and stall the audio thread.
 *
 * ## Stealing fades, it does not cut
 *
 * When every slot is busy the oldest voice is taken. Calling `stop()` on a
 * sounding buffer truncates the waveform at whatever value it happened to be at,
 * which is a step discontinuity — a click, and a loud one. So the victim is
 * ramped to silence over `voiceStealFade` and the new sound begins at the end of
 * that ramp. Six milliseconds is below the threshold of rhythmic perception, so
 * the displacement is inaudible while the click is completely gone.
 *
 * The oldest voice is the right victim: it is the furthest into its decay, so it
 * is both the quietest and the one whose loss carries the least information.
 */

import { TUNING } from "@/game/config/tuning";

/** One reusable slot. The source is replaced per shot; nothing else is. */
interface VoiceSlot {
  readonly gain: GainNode;
  readonly panner: StereoPannerNode | null;
  source: AudioBufferSourceNode | null;
  /** Context time the current shot began. Oldest-first stealing sorts on this. */
  startedAt: number;
  /** Context time the current shot is expected to end. */
  endsAt: number;
  active: boolean;
  /**
   * Bumped every time the slot is reassigned.
   *
   * A stolen voice's `onended` fires AFTER the slot has been handed to a new
   * sound. Without a generation check that late callback frees a slot that is
   * currently playing, and the symptom is voices being stolen while the pool
   * looks half empty.
   */
  generation: number;
}

export interface PlayOptions {
  buffer: AudioBuffer;
  /** x — linear gain for this shot, after humanisation. */
  gain: number;
  /** x — playback rate. Doubles as the pitch control. */
  playbackRate: number;
  /** -1..1 — stereo position. Ignored where `StereoPannerNode` is unavailable. */
  pan: number;
  /** Absolute context time to start at. Must not be in the past. */
  when: number;
}

export interface VoicePool {
  /** Slots, fixed at construction. */
  readonly capacity: number;
  /** How many slots are currently sounding. */
  activeCount(): number;
  /** Highest concurrent count seen. Diagnostic; the perf gate reads it. */
  readonly peak: number;
  /** Starts a shot. Returns the time it actually begins, or null if it cannot. */
  play(options: PlayOptions): number | null;
  /** Silences everything. Used on run end and teardown. */
  stopAll(when: number): void;
  dispose(): void;
}

const PAN_MIN = -1;
const PAN_MAX = 1;
const MIN_PLAYBACK_RATE = 0.05;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return value < min ? min : value > max ? max : value;
}

/**
 * Builds a pool feeding one bus.
 *
 * One pool per bus rather than a bus argument per shot: a slot's chain is
 * connected once at warm-up and never re-routed, so there is no
 * connect/disconnect churn on the audio thread during play.
 */
export function createVoicePool(
  context: BaseAudioContext,
  destination: AudioNode,
  capacity: number = TUNING.audio.maxVoices,
): VoicePool {
  const hasPanner = typeof context.createStereoPanner === "function";
  const slots: VoiceSlot[] = [];

  for (let i = 0; i < capacity; i += 1) {
    const gain = context.createGain();
    gain.gain.value = 0;
    const panner = hasPanner ? context.createStereoPanner() : null;
    if (panner === null) {
      gain.connect(destination);
    } else {
      gain.connect(panner);
      panner.connect(destination);
    }
    slots.push({ gain, panner, source: null, startedAt: 0, endsAt: 0, active: false, generation: 0 });
  }

  let peak = 0;
  let disposed = false;

  function release(slot: VoiceSlot, generation: number): void {
    if (slot.generation !== generation) {
      return;
    }
    slot.active = false;
    if (slot.source !== null) {
      slot.source.onended = null;
      try {
        slot.source.disconnect();
      } catch {
        // Already disconnected by the implementation.
      }
      slot.source = null;
    }
  }

  /** A free slot, or the oldest active one. Never null: capacity is fixed. */
  function acquire(now: number): VoiceSlot | null {
    let oldest: VoiceSlot | null = null;
    for (const slot of slots) {
      // A slot whose sound has already finished but whose `onended` has not been
      // delivered yet is free for our purposes. Waiting for the callback would
      // under-use the pool at exactly the moments it is busiest.
      if (!slot.active || slot.endsAt <= now) {
        return slot;
      }
      if (oldest === null || slot.startedAt < oldest.startedAt) {
        oldest = slot;
      }
    }
    return oldest;
  }

  return {
    capacity,

    activeCount(): number {
      let count = 0;
      for (const slot of slots) {
        if (slot.active) {
          count += 1;
        }
      }
      return count;
    },

    get peak() {
      return peak;
    },

    play(options: PlayOptions): number | null {
      if (disposed || capacity === 0) {
        return null;
      }
      const slot = acquire(options.when);
      if (slot === null) {
        return null;
      }

      const fade = TUNING.audio.voiceStealFade;
      const stealing = slot.active && slot.endsAt > options.when;
      const startAt = stealing ? options.when + fade : options.when;

      if (stealing && slot.source !== null) {
        slot.gain.gain.cancelScheduledValues(options.when);
        slot.gain.gain.setValueAtTime(slot.gain.gain.value, options.when);
        slot.gain.gain.linearRampToValueAtTime(0, startAt);
        try {
          slot.source.stop(startAt);
        } catch {
          // Never started, or already stopped.
        }
      }

      slot.generation += 1;
      const generation = slot.generation;

      const source = context.createBufferSource();
      source.buffer = options.buffer;
      source.playbackRate.value = Math.max(MIN_PLAYBACK_RATE, options.playbackRate);
      source.connect(slot.gain);

      slot.gain.gain.setValueAtTime(clamp(options.gain, 0, Number.MAX_SAFE_INTEGER), startAt);
      if (slot.panner !== null) {
        slot.panner.pan.setValueAtTime(clamp(options.pan, PAN_MIN, PAN_MAX), startAt);
      }

      source.onended = () => release(slot, generation);
      source.start(startAt);

      slot.source = source;
      slot.active = true;
      slot.startedAt = startAt;
      slot.endsAt = startAt + options.buffer.duration / source.playbackRate.value;

      let live = 0;
      for (const entry of slots) {
        if (entry.active) {
          live += 1;
        }
      }
      if (live > peak) {
        peak = live;
      }

      return startAt;
    },

    stopAll(when: number): void {
      const fade = TUNING.audio.voiceStealFade;
      for (const slot of slots) {
        if (!slot.active || slot.source === null) {
          continue;
        }
        slot.gain.gain.cancelScheduledValues(when);
        slot.gain.gain.setValueAtTime(slot.gain.gain.value, when);
        slot.gain.gain.linearRampToValueAtTime(0, when + fade);
        try {
          slot.source.stop(when + fade);
        } catch {
          // Already stopped.
        }
      }
    },

    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      for (const slot of slots) {
        release(slot, slot.generation);
        try {
          slot.gain.disconnect();
          slot.panner?.disconnect();
        } catch {
          // Already torn down with the context.
        }
      }
    },
  };
}
