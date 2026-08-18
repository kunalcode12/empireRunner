/**
 * The sound-design table. **Every sound in AXIS is described here and nowhere else.**
 *
 * ## These are PLACEHOLDERS, and they are marked as such
 *
 * There are no audio assets in this repository. Rather than reference `.mp3` or
 * `.ogg` paths that would 404 at runtime — banned by CLAUDE.md, and the audio
 * equivalent of a missing-texture checkerboard — every sound here is a recipe
 * that `synth.ts` renders into an `AudioBuffer` at warm-up using oscillators and
 * noise. They are honest placeholders: they occupy the right frequency ranges,
 * have the right envelopes and the right relative loudness, so the MIX is real
 * even though the timbres are synthetic. Swapping in recorded audio later means
 * replacing the render step, not the architecture.
 *
 * ## Why this file is exempt from `no-magic-numbers`
 *
 * Identical case to `sim/level/chunks/**` and `render/animation/clips.ts`: every
 * number here IS the content. A kick's 118Hz start pitch is not a tunable
 * parameter that belongs in `tuning.ts` alongside jump gravity — it is one
 * character of the sound's spelling. Hoisting each to a named constant would
 * make the table unreadable to the person authoring the next sound, who is
 * exactly who it is written for. Values that affect the mix ACROSS sounds
 * (bus gains, jitter ranges, duck depth, the tempo grid) live in
 * `TUNING.audio`, not here.
 *
 * ## Frequency choices
 *
 * All four themes are pitched around A minor (A 110 / C 130.81 / D 146.83 /
 * E 164.81 / G 196) at one shared tempo. That is what lets a theme cross-fade at
 * a distance milestone sound like a transition rather than a collision, and it
 * is the same reason the Overdrive stem can swap on a bar line.
 */

import { SimEvent } from "@/game/sim/events";
import { Bus, type BusName } from "./settings";

/** One oscillator voice inside a sound. */
export interface ToneLayer {
  wave: OscillatorType;
  /** Hz — starting frequency. */
  freq: number;
  /** Hz — glides here across the decay. Omit to hold `freq`. */
  freqEnd?: number;
  /** cents — detune, for chorus and beating. */
  detune?: number;
  /** x — peak linear gain. */
  gain: number;
  /** s — attack. */
  attack: number;
  /** s — decay to silence. */
  decay: number;
  /** s — offset from the start of the sound. */
  start?: number;
  /** x — FM modulator frequency as a ratio of `freq`. */
  fmRatio?: number;
  /** x — FM depth as a ratio of `freq`. */
  fmIndex?: number;
}

/** One filtered noise voice inside a sound. */
export interface NoiseLayer {
  gain: number;
  attack: number;
  decay: number;
  filter: BiquadFilterType;
  /** Hz — filter cutoff or centre. */
  cutoff: number;
  /** Hz — sweeps here across the decay. */
  cutoffEnd?: number;
  q: number;
  start?: number;
}

/** A complete one-shot. */
export interface SoundRecipe {
  /** s — buffer length. Must cover the longest layer's start + attack + decay. */
  duration: number;
  /** x — overall gain, and the value the side-chain duck depth scales with. */
  gain: number;
  bus: BusName;
  /** -1..1 — static stereo position before per-shot jitter. */
  pan: number;
  tones: readonly ToneLayer[];
  noises: readonly NoiseLayer[];
}

/** A sustained layer that runs the whole loop without an envelope. */
export interface DroneLayer {
  wave: OscillatorType;
  freq: number;
  gain: number;
  detune?: number;
  /** Hz — lowpass applied to this drone. */
  cutoff?: number;
  /**
   * cycles per loop — amplitude LFO rate, as a WHOLE NUMBER of cycles.
   *
   * Integer only, and that is load-bearing: a fractional rate does not complete
   * at the loop point, so the amplitude jumps on every wrap. A whole number of
   * cycles per loop wraps seamlessly by construction.
   */
  lfoCycles?: number;
  lfoDepth?: number;
}

/** A rhythmic voice: one sound, placed at a list of beat positions. */
export interface StemPattern {
  hit: SoundRecipe;
  /** beats from the loop start. Fractional positions are fine. */
  beats: readonly number[];
  /** x — per-hit gain, indexed alongside `beats`. Defaults to 1. */
  accents?: readonly number[];
}

/** One layer of one theme's music. */
export interface StemRecipe {
  gain: number;
  drones: readonly DroneLayer[];
  patterns: readonly StemPattern[];
}

/** The four layers of one theme. */
export interface ThemeStems {
  name: string;
  base: StemRecipe;
  percussion: StemRecipe;
  tension: StemRecipe;
  overdrive: StemRecipe;
}

// ─────────────────────────────────────────────────────────────────────────────
// One-shots
// ─────────────────────────────────────────────────────────────────────────────

/** Every one-shot the game can play. */
export const Sound = {
  Coin: "coin",
  Cell: "cell",
  Shard: "shard",
  NearMiss: "nearMiss",
  Jump: "jump",
  Land: "land",
  SlideStart: "slideStart",
  SlideEnd: "slideEnd",
  RollStart: "rollStart",
  RollEnd: "rollEnd",
  LaneChange: "laneChange",
  Crash: "crash",
  Stumble: "stumble",
  StumbleEnd: "stumbleEnd",
  ShieldAbsorb: "shieldAbsorb",
  OverdriveStart: "overdriveStart",
  OverdriveEnd: "overdriveEnd",
  Shatter: "shatter",
  FractureArm: "fractureArm",
  FractureSuccess: "fractureSuccess",
  FractureFail: "fractureFail",
  FlowFull: "flowFull",
  ThemeChange: "themeChange",
  BandChange: "bandChange",
  RunStart: "runStart",
  RunEnd: "runEnd",
} as const;
export type SoundKey = (typeof Sound)[keyof typeof Sound];

export const SOUNDS: Readonly<Record<SoundKey, SoundRecipe>> = Object.freeze({
  /** A bright two-partial ping. The streak ladder transposes it upward. */
  [Sound.Coin]: {
    duration: 0.3,
    gain: 0.5,
    bus: Bus.Sfx,
    pan: 0,
    tones: [
      { wave: "triangle", freq: 1174.7, gain: 0.6, attack: 0.002, decay: 0.16 },
      { wave: "sine", freq: 2349.3, gain: 0.25, attack: 0.002, decay: 0.1 },
    ],
    noises: [],
  },

  /** Cells are worth +35 Flow. Fuller and lower than a Bit, so they read as more. */
  [Sound.Cell]: {
    duration: 0.7,
    gain: 0.62,
    bus: Bus.Sfx,
    pan: 0,
    tones: [
      { wave: "sawtooth", freq: 329.6, freqEnd: 659.3, gain: 0.35, attack: 0.005, decay: 0.4 },
      { wave: "sine", freq: 659.3, gain: 0.3, attack: 0.01, decay: 0.45 },
      { wave: "sine", freq: 987.8, gain: 0.18, attack: 0.02, decay: 0.5, start: 0.04 },
    ],
    noises: [
      { gain: 0.12, attack: 0.001, decay: 0.18, filter: "highpass", cutoff: 3200, q: 0.7 },
    ],
  },

  /** Shards are the premium currency. Glassy, and it rings. */
  [Sound.Shard]: {
    duration: 1.1,
    gain: 0.6,
    bus: Bus.Sfx,
    pan: 0,
    tones: [
      { wave: "sine", freq: 1567.9, gain: 0.3, attack: 0.001, decay: 0.9 },
      { wave: "sine", freq: 2093, gain: 0.22, attack: 0.001, decay: 0.7, detune: 8 },
      { wave: "triangle", freq: 3135.9, gain: 0.12, attack: 0.001, decay: 0.45 },
    ],
    noises: [
      { gain: 0.1, attack: 0.001, decay: 0.12, filter: "bandpass", cutoff: 6000, q: 2 },
    ],
  },

  /**
   * The near-miss. A short upward whoosh past the ear.
   *
   * Quiet on purpose: near-misses are frequent, and this fires alongside a
   * camera kick and a Flow gain. If it is loud enough to notice individually it
   * is far too loud at band-5 density.
   */
  [Sound.NearMiss]: {
    duration: 0.34,
    gain: 0.3,
    bus: Bus.Sfx,
    pan: 0,
    tones: [],
    noises: [
      {
        gain: 0.55,
        attack: 0.02,
        decay: 0.2,
        filter: "bandpass",
        cutoff: 700,
        cutoffEnd: 4200,
        q: 1.4,
      },
    ],
  },

  /** Launch. Body, not a cartoon boing. */
  [Sound.Jump]: {
    duration: 0.34,
    gain: 0.45,
    bus: Bus.Sfx,
    pan: 0,
    tones: [{ wave: "sine", freq: 220, freqEnd: 380, gain: 0.4, attack: 0.004, decay: 0.16 }],
    noises: [
      {
        gain: 0.22,
        attack: 0.001,
        decay: 0.11,
        filter: "highpass",
        cutoff: 900,
        cutoffEnd: 2600,
        q: 0.8,
      },
    ],
  },

  /** Touchdown. Low thud plus grit; scaled by impact speed at the call site. */
  [Sound.Land]: {
    duration: 0.4,
    gain: 0.55,
    bus: Bus.Sfx,
    pan: 0,
    tones: [{ wave: "sine", freq: 150, freqEnd: 62, gain: 0.55, attack: 0.001, decay: 0.19 }],
    noises: [
      { gain: 0.3, attack: 0.001, decay: 0.14, filter: "lowpass", cutoff: 1800, q: 0.6 },
    ],
  },

  /** Slide entry — a scrape that opens up. */
  [Sound.SlideStart]: {
    duration: 0.5,
    gain: 0.42,
    bus: Bus.Sfx,
    pan: 0,
    tones: [],
    noises: [
      {
        gain: 0.5,
        attack: 0.012,
        decay: 0.36,
        filter: "bandpass",
        cutoff: 1500,
        cutoffEnd: 620,
        q: 1.1,
      },
    ],
  },

  /** Slide exit — the scrape closing. */
  [Sound.SlideEnd]: {
    duration: 0.26,
    gain: 0.3,
    bus: Bus.Sfx,
    pan: 0,
    tones: [],
    noises: [
      {
        gain: 0.35,
        attack: 0.004,
        decay: 0.16,
        filter: "bandpass",
        cutoff: 900,
        cutoffEnd: 2000,
        q: 1.2,
      },
    ],
  },

  /**
   * The roll — the signature verb, and the loudest movement sound in the game.
   *
   * A descending sweep with a body tone under it. It has to be unmistakable:
   * the roll re-anchors gravity, and the player needs to hear that a
   * commitment has been made even when their eyes are on the next obstacle.
   */
  [Sound.RollStart]: {
    duration: 0.55,
    gain: 0.6,
    bus: Bus.Sfx,
    pan: 0,
    tones: [
      { wave: "sawtooth", freq: 196, freqEnd: 98, gain: 0.3, attack: 0.005, decay: 0.3 },
      { wave: "sine", freq: 392, freqEnd: 147, gain: 0.22, attack: 0.002, decay: 0.24 },
    ],
    noises: [
      {
        gain: 0.4,
        attack: 0.006,
        decay: 0.32,
        filter: "bandpass",
        cutoff: 2600,
        cutoffEnd: 500,
        q: 0.9,
      },
    ],
  },

  /** The roll landing on the new face. A short confirming knock. */
  [Sound.RollEnd]: {
    duration: 0.3,
    gain: 0.45,
    bus: Bus.Sfx,
    pan: 0,
    tones: [{ wave: "triangle", freq: 130.8, gain: 0.4, attack: 0.001, decay: 0.16 }],
    noises: [
      { gain: 0.22, attack: 0.001, decay: 0.09, filter: "lowpass", cutoff: 2400, q: 0.7 },
    ],
  },

  /** Lane change. Very small — this happens constantly. */
  [Sound.LaneChange]: {
    duration: 0.18,
    gain: 0.22,
    bus: Bus.Sfx,
    pan: 0,
    tones: [],
    noises: [
      {
        gain: 0.3,
        attack: 0.004,
        decay: 0.1,
        filter: "bandpass",
        cutoff: 2200,
        cutoffEnd: 3400,
        q: 1.6,
      },
    ],
  },

  /**
   * Death. The largest sound in the game, and the only one that gets the
   * full duck.
   */
  [Sound.Crash]: {
    duration: 1.4,
    gain: 1,
    bus: Bus.Sfx,
    pan: 0,
    tones: [
      { wave: "sawtooth", freq: 98, freqEnd: 41, gain: 0.5, attack: 0.001, decay: 0.55 },
      { wave: "square", freq: 61.7, freqEnd: 32, gain: 0.3, attack: 0.001, decay: 0.75 },
      { wave: "sine", freq: 43.7, gain: 0.45, attack: 0.002, decay: 1 },
    ],
    noises: [
      {
        gain: 0.7,
        attack: 0.001,
        decay: 0.5,
        filter: "lowpass",
        cutoff: 5200,
        cutoffEnd: 380,
        q: 0.9,
      },
    ],
  },

  /** A stumble is momentum lost, not a death. Ugly, mid, and short. */
  [Sound.Stumble]: {
    duration: 0.55,
    gain: 0.6,
    bus: Bus.Sfx,
    pan: 0,
    tones: [
      { wave: "square", freq: 146.8, freqEnd: 116.5, gain: 0.24, attack: 0.001, decay: 0.22 },
    ],
    noises: [
      {
        gain: 0.45,
        attack: 0.001,
        decay: 0.3,
        filter: "bandpass",
        cutoff: 1400,
        cutoffEnd: 600,
        q: 0.8,
      },
    ],
  },

  /** Control returns. A small upward resolution — the player is fine. */
  [Sound.StumbleEnd]: {
    duration: 0.3,
    gain: 0.3,
    bus: Bus.Sfx,
    pan: 0,
    tones: [{ wave: "triangle", freq: 293.7, freqEnd: 440, gain: 0.28, attack: 0.006, decay: 0.2 }],
    noises: [],
  },

  /** The Shield eating a hit. Metallic, and clearly a save rather than a loss. */
  [Sound.ShieldAbsorb]: {
    duration: 0.9,
    gain: 0.8,
    bus: Bus.Sfx,
    pan: 0,
    tones: [
      { wave: "square", freq: 523.3, gain: 0.2, attack: 0.001, decay: 0.35, fmRatio: 1.41, fmIndex: 2.2 },
      { wave: "sine", freq: 261.6, gain: 0.3, attack: 0.001, decay: 0.5 },
    ],
    noises: [
      {
        gain: 0.4,
        attack: 0.001,
        decay: 0.42,
        filter: "bandpass",
        cutoff: 4200,
        cutoffEnd: 1600,
        q: 1.8,
      },
    ],
  },

  /**
   * Overdrive entry.
   *
   * A rising fifth into a bright chord. This is the loudest positive sound in
   * the game and it earns it — the player spent 100 Flow to hear it.
   */
  [Sound.OverdriveStart]: {
    duration: 1.6,
    gain: 0.95,
    bus: Bus.Sfx,
    pan: 0,
    tones: [
      { wave: "sawtooth", freq: 110, freqEnd: 220, gain: 0.3, attack: 0.01, decay: 0.5 },
      { wave: "sawtooth", freq: 164.8, freqEnd: 329.6, gain: 0.25, attack: 0.02, decay: 0.6, detune: 6 },
      { wave: "square", freq: 440, gain: 0.16, attack: 0.06, decay: 0.9, start: 0.12 },
      { wave: "sine", freq: 880, gain: 0.12, attack: 0.08, decay: 1, start: 0.18 },
    ],
    noises: [
      {
        gain: 0.3,
        attack: 0.1,
        decay: 0.5,
        filter: "highpass",
        cutoff: 1200,
        cutoffEnd: 7000,
        q: 0.7,
      },
    ],
  },

  /** Overdrive expiry. A falling fifth — the inverse of the entry. */
  [Sound.OverdriveEnd]: {
    duration: 1.1,
    gain: 0.6,
    bus: Bus.Sfx,
    pan: 0,
    tones: [
      { wave: "sawtooth", freq: 220, freqEnd: 110, gain: 0.24, attack: 0.005, decay: 0.6 },
      { wave: "sine", freq: 329.6, freqEnd: 164.8, gain: 0.18, attack: 0.005, decay: 0.5 },
    ],
    noises: [],
  },

  /** An obstacle destroyed during Overdrive. Fires often; kept short and dry. */
  [Sound.Shatter]: {
    duration: 0.45,
    gain: 0.55,
    bus: Bus.Sfx,
    pan: 0,
    tones: [
      { wave: "square", freq: 784, gain: 0.12, attack: 0.001, decay: 0.09, fmRatio: 2.7, fmIndex: 4 },
    ],
    noises: [
      {
        gain: 0.55,
        attack: 0.001,
        decay: 0.28,
        filter: "highpass",
        cutoff: 2400,
        cutoffEnd: 5200,
        q: 0.8,
      },
    ],
  },

  /**
   * The Fracture window opening.
   *
   * Time is about to slow to 0.3x for 1.2 real seconds and the player has one
   * verb to find. The sound is a held, tense, slightly detuned interval — it
   * says "decide now" without a countdown beep, which would be a clock the
   * player has to parse instead of an urgency they feel.
   */
  [Sound.FractureArm]: {
    duration: 1.4,
    gain: 0.85,
    bus: Bus.Sfx,
    pan: 0,
    tones: [
      { wave: "sine", freq: 110, gain: 0.4, attack: 0.004, decay: 1.2 },
      { wave: "sine", freq: 155.6, gain: 0.24, attack: 0.02, decay: 1.1, detune: 14 },
      { wave: "triangle", freq: 466.2, gain: 0.12, attack: 0.05, decay: 0.9 },
    ],
    noises: [
      { gain: 0.18, attack: 0.02, decay: 1.1, filter: "bandpass", cutoff: 320, q: 3 },
    ],
  },

  /** The right verb, in time. Release and reward. */
  [Sound.FractureSuccess]: {
    duration: 1.5,
    gain: 0.9,
    bus: Bus.Sfx,
    pan: 0,
    tones: [
      { wave: "triangle", freq: 261.6, gain: 0.3, attack: 0.004, decay: 0.5 },
      { wave: "triangle", freq: 392, gain: 0.26, attack: 0.02, decay: 0.7, start: 0.05 },
      { wave: "sine", freq: 523.3, gain: 0.22, attack: 0.03, decay: 0.9, start: 0.1 },
      { wave: "sine", freq: 784, gain: 0.14, attack: 0.05, decay: 1, start: 0.16 },
    ],
    noises: [],
  },

  /** Wrong verb, or the window closed. Terminal, and it sounds terminal. */
  [Sound.FractureFail]: {
    duration: 1.8,
    gain: 0.85,
    bus: Bus.Sfx,
    pan: 0,
    tones: [
      { wave: "sawtooth", freq: 110, freqEnd: 55, gain: 0.32, attack: 0.002, decay: 1.1 },
      { wave: "sine", freq: 51.9, gain: 0.35, attack: 0.01, decay: 1.5 },
    ],
    noises: [
      {
        gain: 0.3,
        attack: 0.002,
        decay: 0.9,
        filter: "lowpass",
        cutoff: 2200,
        cutoffEnd: 260,
        q: 0.8,
      },
    ],
  },

  /** Flow reached 100 and Overdrive is available. A held, expectant tone. */
  [Sound.FlowFull]: {
    duration: 1.2,
    gain: 0.6,
    bus: Bus.Ui,
    pan: 0,
    tones: [
      { wave: "sine", freq: 659.3, gain: 0.22, attack: 0.06, decay: 0.8 },
      { wave: "sine", freq: 987.8, gain: 0.14, attack: 0.1, decay: 0.9, start: 0.06 },
    ],
    noises: [],
  },

  /** Crossing into a new theme. Wide and airy — the transition tunnel. */
  [Sound.ThemeChange]: {
    duration: 2.4,
    gain: 0.55,
    bus: Bus.Ui,
    pan: 0,
    tones: [
      { wave: "sine", freq: 220, gain: 0.2, attack: 0.4, decay: 1.6 },
      { wave: "sine", freq: 330, gain: 0.14, attack: 0.6, decay: 1.6 },
    ],
    noises: [
      {
        gain: 0.2,
        attack: 0.3,
        decay: 1.8,
        filter: "bandpass",
        cutoff: 500,
        cutoffEnd: 3000,
        q: 0.6,
      },
    ],
  },

  /** A difficulty band boundary. Quiet: information, not an event. */
  [Sound.BandChange]: {
    duration: 0.6,
    gain: 0.3,
    bus: Bus.Ui,
    pan: 0,
    tones: [
      { wave: "triangle", freq: 174.6, gain: 0.2, attack: 0.01, decay: 0.4 },
      { wave: "triangle", freq: 261.6, gain: 0.14, attack: 0.03, decay: 0.4, start: 0.08 },
    ],
    noises: [],
  },

  /** Run start. */
  [Sound.RunStart]: {
    duration: 1,
    gain: 0.65,
    bus: Bus.Ui,
    pan: 0,
    tones: [
      { wave: "square", freq: 130.8, gain: 0.16, attack: 0.005, decay: 0.3 },
      { wave: "square", freq: 261.6, gain: 0.14, attack: 0.005, decay: 0.4, start: 0.09 },
      { wave: "sine", freq: 523.3, gain: 0.16, attack: 0.005, decay: 0.5, start: 0.18 },
    ],
    noises: [],
  },

  /** Run end. The mix is about to hand over to the death screen. */
  [Sound.RunEnd]: {
    duration: 1.6,
    gain: 0.6,
    bus: Bus.Ui,
    pan: 0,
    tones: [
      { wave: "sine", freq: 174.6, freqEnd: 87.3, gain: 0.3, attack: 0.02, decay: 1.2 },
      { wave: "triangle", freq: 261.6, freqEnd: 130.8, gain: 0.16, attack: 0.06, decay: 1 },
    ],
    noises: [],
  },
});

/**
 * Sim event to sound.
 *
 * Events deliberately absent: `OverdriveTick`, `FlowGain`, `FractureTick` and
 * `CornerForgive` fire every tick or near enough, and `GeneratorUnwinnable` is
 * developer telemetry. A per-tick sound is not a sound, it is a tone generator.
 * Those events drive the music's intensity and the ducking instead.
 *
 * `Coin` is here but the *pitch* it plays at is not: the streak ladder in
 * `sfx.ts` owns that.
 */
export const EVENT_SOUND: Readonly<Record<number, SoundKey>> = Object.freeze({
  [SimEvent.RunStart]: Sound.RunStart,
  [SimEvent.RunEnd]: Sound.RunEnd,
  [SimEvent.Coin]: Sound.Coin,
  [SimEvent.NearMiss]: Sound.NearMiss,
  [SimEvent.Jump]: Sound.Jump,
  [SimEvent.Land]: Sound.Land,
  [SimEvent.SlideStart]: Sound.SlideStart,
  [SimEvent.SlideEnd]: Sound.SlideEnd,
  [SimEvent.RollStart]: Sound.RollStart,
  [SimEvent.RollEnd]: Sound.RollEnd,
  [SimEvent.LaneChange]: Sound.LaneChange,
  [SimEvent.Crash]: Sound.Crash,
  [SimEvent.ShieldAbsorb]: Sound.ShieldAbsorb,
  [SimEvent.OverdriveStart]: Sound.OverdriveStart,
  [SimEvent.OverdriveEnd]: Sound.OverdriveEnd,
  [SimEvent.Shatter]: Sound.Shatter,
  [SimEvent.FractureArm]: Sound.FractureArm,
  [SimEvent.ThemeChange]: Sound.ThemeChange,
  [SimEvent.BandChange]: Sound.BandChange,
  [SimEvent.FlowFull]: Sound.FlowFull,
  [SimEvent.Stumble]: Sound.Stumble,
  [SimEvent.StumbleEnd]: Sound.StumbleEnd,
});

// ─────────────────────────────────────────────────────────────────────────────
// Music stems — GAME_BIBLE §10
//
// Four layers per theme. `base` always plays; `percussion` and `tension` fade in
// with intensity; `overdrive` swaps in on a bar line.
//
// Every hit below is a full SoundRecipe, rendered into the stem buffer at its
// beat position by `synth.ts`. Beats are in quarter notes from the loop start,
// and a loop is TUNING.audio.barsPerLoop bars of TUNING.audio.beatsPerBar.
// ─────────────────────────────────────────────────────────────────────────────

const KICK: SoundRecipe = {
  duration: 0.5,
  gain: 0.9,
  bus: Bus.Music,
  pan: 0,
  tones: [{ wave: "sine", freq: 118, freqEnd: 44, gain: 0.9, attack: 0.001, decay: 0.26 }],
  noises: [{ gain: 0.18, attack: 0.001, decay: 0.03, filter: "highpass", cutoff: 1800, q: 0.7 }],
};

const CLANK: SoundRecipe = {
  duration: 0.5,
  gain: 0.34,
  bus: Bus.Music,
  pan: 0.2,
  tones: [
    { wave: "square", freq: 621, gain: 0.1, attack: 0.001, decay: 0.11, fmRatio: 1.73, fmIndex: 3.1 },
    { wave: "square", freq: 933, gain: 0.06, attack: 0.001, decay: 0.07, fmRatio: 2.41, fmIndex: 2.2 },
  ],
  noises: [
    { gain: 0.3, attack: 0.001, decay: 0.16, filter: "bandpass", cutoff: 3100, cutoffEnd: 1900, q: 1.6 },
  ],
};

const RIM: SoundRecipe = {
  duration: 0.6,
  gain: 0.4,
  bus: Bus.Music,
  pan: -0.25,
  tones: [{ wave: "triangle", freq: 440, freqEnd: 320, gain: 0.16, attack: 0.001, decay: 0.06 }],
  noises: [
    { gain: 0.34, attack: 0.001, decay: 0.4, filter: "bandpass", cutoff: 2100, cutoffEnd: 900, q: 2.4 },
  ],
};

const DUB_BASS: SoundRecipe = {
  duration: 1.2,
  gain: 0.55,
  bus: Bus.Music,
  pan: 0,
  tones: [
    { wave: "sine", freq: 55, gain: 0.7, attack: 0.006, decay: 0.7 },
    { wave: "triangle", freq: 110, gain: 0.16, attack: 0.006, decay: 0.35 },
  ],
  noises: [],
};

const OUD: SoundRecipe = {
  duration: 0.9,
  gain: 0.4,
  bus: Bus.Music,
  pan: -0.15,
  tones: [
    { wave: "sawtooth", freq: 293.7, gain: 0.2, attack: 0.002, decay: 0.5 },
    { wave: "sawtooth", freq: 440, gain: 0.1, attack: 0.002, decay: 0.42, detune: 7 },
  ],
  noises: [{ gain: 0.1, attack: 0.001, decay: 0.04, filter: "highpass", cutoff: 2600, q: 0.8 }],
};

const HAND_PERC: SoundRecipe = {
  duration: 0.4,
  gain: 0.42,
  bus: Bus.Music,
  pan: 0.3,
  tones: [{ wave: "sine", freq: 196, freqEnd: 130, gain: 0.3, attack: 0.001, decay: 0.12 }],
  noises: [
    { gain: 0.26, attack: 0.001, decay: 0.1, filter: "bandpass", cutoff: 1600, q: 1.1 },
  ],
};

const CLOCK_TICK: SoundRecipe = {
  duration: 0.3,
  gain: 0.36,
  bus: Bus.Music,
  pan: 0.1,
  tones: [{ wave: "square", freq: 1245, gain: 0.06, attack: 0.001, decay: 0.02 }],
  noises: [
    { gain: 0.24, attack: 0.001, decay: 0.05, filter: "bandpass", cutoff: 4400, q: 3.2 },
  ],
};

const FM_LEAD: SoundRecipe = {
  duration: 1,
  gain: 0.34,
  bus: Bus.Music,
  pan: 0,
  tones: [
    { wave: "sine", freq: 329.6, gain: 0.18, attack: 0.01, decay: 0.6, fmRatio: 1.98, fmIndex: 3.4 },
    { wave: "sine", freq: 329.6, gain: 0.1, attack: 0.02, decay: 0.5, detune: 22, fmRatio: 2.02, fmIndex: 2.8 },
  ],
  noises: [],
};

const BRASS_STAB: SoundRecipe = {
  duration: 0.8,
  gain: 0.38,
  bus: Bus.Music,
  pan: 0,
  tones: [
    { wave: "sawtooth", freq: 164.8, gain: 0.16, attack: 0.03, decay: 0.4 },
    { wave: "sawtooth", freq: 246.9, gain: 0.11, attack: 0.04, decay: 0.4, detune: 9 },
  ],
  noises: [],
};

/** Indexed by theme ordinal, matching `SimEvent.ThemeChange` payload0. */
export const THEME_STEMS: readonly ThemeStems[] = Object.freeze([
  {
    name: "Kiln",
    base: {
      gain: 0.9,
      drones: [
        { wave: "sawtooth", freq: 55, gain: 0.1, cutoff: 320, lfoCycles: 1, lfoDepth: 0.25 },
        { wave: "sawtooth", freq: 82.4, gain: 0.06, cutoff: 400, detune: 5 },
      ],
      patterns: [{ hit: KICK, beats: [0, 2, 4, 6, 8, 10, 12, 14] }],
    },
    percussion: {
      gain: 0.85,
      drones: [],
      patterns: [
        { hit: CLANK, beats: [1, 3.5, 5, 7, 9, 11.5, 13, 15], accents: [1, 0.6, 0.85, 0.7, 1, 0.6, 0.9, 0.75] },
        { hit: KICK, beats: [3.5, 11.5], accents: [0.55, 0.55] },
      ],
    },
    tension: {
      gain: 0.75,
      drones: [{ wave: "square", freq: 110, gain: 0.035, cutoff: 900, lfoCycles: 2, lfoDepth: 0.5 }],
      patterns: [{ hit: BRASS_STAB, beats: [0, 6, 8, 14], accents: [1, 0.7, 1, 0.8] }],
    },
    overdrive: {
      gain: 1,
      drones: [{ wave: "sawtooth", freq: 110, gain: 0.07, cutoff: 1600 }],
      patterns: [
        { hit: KICK, beats: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] },
        { hit: CLANK, beats: [0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5, 8.5, 9.5, 10.5, 11.5, 12.5, 13.5, 14.5, 15.5] },
        { hit: BRASS_STAB, beats: [0, 4, 8, 12] },
      ],
    },
  },

  {
    name: "Undertow",
    base: {
      gain: 0.9,
      drones: [
        { wave: "triangle", freq: 65.4, gain: 0.12, cutoff: 240, lfoCycles: 1, lfoDepth: 0.3 },
        { wave: "sine", freq: 98, gain: 0.07, cutoff: 300, detune: 11 },
      ],
      patterns: [{ hit: DUB_BASS, beats: [0, 6, 8, 14], accents: [1, 0.7, 0.9, 0.6] }],
    },
    percussion: {
      gain: 0.8,
      drones: [],
      patterns: [
        { hit: RIM, beats: [2, 6, 10, 14] },
        { hit: RIM, beats: [3.75, 11.75], accents: [0.5, 0.5] },
      ],
    },
    tension: {
      gain: 0.7,
      drones: [
        { wave: "sawtooth", freq: 146.8, gain: 0.03, cutoff: 700, lfoCycles: 3, lfoDepth: 0.6 },
      ],
      patterns: [{ hit: DUB_BASS, beats: [3, 11], accents: [0.6, 0.6] }],
    },
    overdrive: {
      gain: 1,
      drones: [{ wave: "sawtooth", freq: 65.4, gain: 0.09, cutoff: 1400 }],
      patterns: [
        { hit: DUB_BASS, beats: [0, 2, 4, 6, 8, 10, 12, 14] },
        { hit: RIM, beats: [1, 3, 5, 7, 9, 11, 13, 15] },
      ],
    },
  },

  {
    name: "Bazaar",
    base: {
      gain: 0.9,
      drones: [{ wave: "sawtooth", freq: 73.4, gain: 0.08, cutoff: 420, lfoCycles: 2, lfoDepth: 0.2 }],
      patterns: [
        {
          hit: OUD,
          beats: [0, 1.5, 3, 4, 5.5, 7, 8, 9.5, 11, 12, 13.5, 15],
          accents: [1, 0.6, 0.8, 0.9, 0.6, 0.8, 1, 0.6, 0.8, 0.9, 0.6, 0.7],
        },
      ],
    },
    percussion: {
      gain: 0.85,
      drones: [],
      patterns: [
        {
          hit: HAND_PERC,
          beats: [0, 0.75, 2, 2.75, 3.5, 4, 4.75, 6, 6.75, 7.5, 8, 8.75, 10, 10.75, 11.5, 12, 12.75, 14, 14.75, 15.5],
          accents: [1, 0.5, 0.8, 0.5, 0.6, 1, 0.5, 0.8, 0.5, 0.6, 1, 0.5, 0.8, 0.5, 0.6, 1, 0.5, 0.8, 0.5, 0.6],
        },
      ],
    },
    tension: {
      gain: 0.7,
      drones: [{ wave: "square", freq: 220, gain: 0.025, cutoff: 1100, lfoCycles: 4, lfoDepth: 0.7 }],
      patterns: [{ hit: FM_LEAD, beats: [2, 10], accents: [0.8, 0.8] }],
    },
    overdrive: {
      gain: 1,
      drones: [{ wave: "sawtooth", freq: 146.8, gain: 0.06, cutoff: 1800 }],
      patterns: [
        { hit: HAND_PERC, beats: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10, 10.5, 11, 11.5, 12, 12.5, 13, 13.5, 14, 14.5, 15, 15.5] },
        { hit: OUD, beats: [0, 2, 4, 6, 8, 10, 12, 14] },
      ],
    },
  },

  {
    name: "Static",
    base: {
      gain: 0.9,
      drones: [
        { wave: "triangle", freq: 61.7, gain: 0.09, cutoff: 260, lfoCycles: 1, lfoDepth: 0.45 },
        { wave: "sawtooth", freq: 123.5, gain: 0.03, cutoff: 520, detune: 18 },
      ],
      patterns: [{ hit: CLOCK_TICK, beats: [0, 2.25, 4, 6.5, 8, 10.25, 12, 14.5] }],
    },
    percussion: {
      gain: 0.85,
      drones: [],
      patterns: [
        {
          hit: CLOCK_TICK,
          beats: [1, 1.25, 3, 5, 5.25, 7, 9, 9.25, 11, 13, 13.25, 15],
          accents: [1, 0.4, 0.8, 1, 0.4, 0.8, 1, 0.4, 0.8, 1, 0.4, 0.8],
        },
        { hit: RIM, beats: [4, 12], accents: [0.7, 0.7] },
      ],
    },
    tension: {
      gain: 0.75,
      drones: [{ wave: "sawtooth", freq: 164.8, gain: 0.03, cutoff: 1300, lfoCycles: 5, lfoDepth: 0.8 }],
      patterns: [{ hit: FM_LEAD, beats: [0, 3, 8, 11], accents: [1, 0.6, 1, 0.6] }],
    },
    overdrive: {
      gain: 1,
      drones: [{ wave: "square", freq: 82.4, gain: 0.05, cutoff: 2000 }],
      patterns: [
        { hit: CLOCK_TICK, beats: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10, 10.5, 11, 11.5, 12, 12.5, 13, 13.5, 14, 14.5, 15, 15.5] },
        { hit: FM_LEAD, beats: [0, 2, 4, 6, 8, 10, 12, 14] },
      ],
    },
  },
]);
