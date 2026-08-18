/**
 * Procedural synthesis — turning the recipes in `recipes.ts` into `AudioBuffer`s.
 *
 * ## Rendered once, offline, at warm-up
 *
 * Every sound is built through an `OfflineAudioContext` during warm-up and kept
 * as a finished buffer. Playing one then costs a single `AudioBufferSourceNode`.
 *
 * The alternative — building the oscillator/filter/envelope graph live on every
 * shot — is what makes procedural audio expensive: a crash is eight nodes with
 * twenty automation events, and at band-5 density with a shatter burst that is
 * hundreds of nodes a second on the audio thread. Rendering offline moves all of
 * that to load time and leaves the run-time cost identical to playing a sample.
 * It is also what makes the CPU budget in TUNING.md §14 achievable at all.
 *
 * ## Seamless loops are two separate problems
 *
 * **Decays that cross the loop point.** A kick on the last beat is still ringing
 * when the loop wraps, and truncating it is a click. So a stem is rendered
 * `stemTailSeconds` longer than the loop and the overhang is *folded* back onto
 * the head — which is precisely what the previous iteration's decay would have
 * been doing if the loop were infinite. No fade, no gap, and the tail is real.
 *
 * **Sustained drones.** A drone whose frequency does not complete a whole number
 * of cycles in one loop ends at a different point in its waveform than it
 * started, and that step is a click on every single wrap — once every 7.6
 * seconds, forever. `quantiseDroneFrequency` snaps each drone to the nearest
 * frequency that fits an integer number of cycles. The shift is at most a few
 * cents, which is inaudible; the click it removes is not.
 *
 * Amplitude LFOs get the same treatment via the integer `lfoCycles` field.
 *
 * ## Everything except the rendering itself is pure
 *
 * `OfflineAudioContext` does not exist under Node, so vitest cannot render. The
 * loop arithmetic, the frequency quantisation and the tail fold — the parts most
 * likely to be wrong — are pure functions with no context, and they are unit
 * tested. The rendering is exercised in Chromium by `tests/e2e/audio.spec.ts`,
 * which is where the drift and click gates live anyway.
 */

import { TUNING } from "@/game/config/tuning";
import type { DroneLayer, SoundRecipe, StemRecipe } from "./recipes";

/** The shared musical grid. Every stem in every theme is rendered against it. */
export interface MusicGrid {
  /** bpm — the tempo actually rendered, after sample-rate snapping. */
  bpm: number;
  beatsPerBar: number;
  barsPerLoop: number;
  /** s — one beat. */
  beatSeconds: number;
  /** s — one bar. Overdrive swaps quantise to this. */
  barSeconds: number;
  /** s — one full stem loop. Exactly `loopSamples / sampleRate`. */
  loopSeconds: number;
  /** samples — the loop, as an exact integer at this sample rate. */
  loopSamples: number;
  sampleRate: number;
}

const SECONDS_PER_MINUTE = 60;
/** Floor for an exponential ramp target: the ramp is undefined at zero. */
const SILENCE_FLOOR = 0.0001;
/** s — noise source buffer length. Long enough not to hear it repeat. */
const NOISE_BUFFER_SECONDS = 2;
/** Hard limit applied after folding, so a stacked decay cannot clip. */
const PEAK_LIMIT = 0.99;
/** s — padding past a layer's end before its oscillator is stopped. */
const STOP_PAD = 0.02;
const CENTS_UNITY = 0;
const DEFAULT_ACCENT = 1;

/** s — one beat at `bpm`. */
export function beatSeconds(bpm: number): number {
  return SECONDS_PER_MINUTE / bpm;
}

/**
 * Builds the grid for a sample rate. Pure.
 *
 * ## The tempo bends to the sample rate, not the other way round
 *
 * A loop buffer is a whole number of samples — there is no such thing as a
 * 365,714.28-sample buffer. So the rendered loop is `round(ideal * sampleRate)`
 * samples, and its true duration is `loopSamples / sampleRate`, which at 126bpm
 * and 48kHz is 5.95 microseconds shorter than the ideal 7.619047s.
 *
 * Everything downstream must use that *true* duration rather than the ideal, and
 * this is not a rounding nicety. `music.ts` computes bar boundaries as
 * `startTime + n * barSeconds`. If `barSeconds` came from the ideal tempo, every
 * bar boundary would sit a fraction of a sample away from the actual musical bar
 * in the buffer, and the error would compound: 78 loops into a ten-minute run
 * the Overdrive swap would land 22 samples off the downbeat. That is the exact
 * class of drift this design exists to eliminate, reintroduced through the back
 * door of a `60 / bpm` division.
 *
 * So the bar and beat are derived by *dividing the real loop*, which tiles it
 * exactly by construction. The cost is a tempo shift of about 0.00008% —
 * roughly a thousandth of a cent, and unmeasurable by any means available to a
 * listener.
 */
export function createGrid(sampleRate: number): MusicGrid {
  const beatsPerBar = TUNING.audio.beatsPerBar;
  const barsPerLoop = TUNING.audio.barsPerLoop;
  const idealLoop = beatSeconds(TUNING.audio.musicBpm) * beatsPerBar * barsPerLoop;

  const loopSamples = Math.round(idealLoop * sampleRate);
  const loop = loopSamples / sampleRate;
  const bar = loop / barsPerLoop;
  const beat = bar / beatsPerBar;

  return {
    bpm: SECONDS_PER_MINUTE / beat,
    beatsPerBar,
    barsPerLoop,
    beatSeconds: beat,
    barSeconds: bar,
    loopSeconds: loop,
    loopSamples,
    sampleRate,
  };
}

/**
 * Snaps a drone frequency to a whole number of cycles per loop.
 *
 * Below one cycle per loop the result would be a DC offset, so it clamps to one.
 */
export function quantiseDroneFrequency(freq: number, loopSeconds: number): number {
  if (!Number.isFinite(freq) || freq <= 0 || loopSeconds <= 0) {
    return 0;
  }
  const cycles = Math.max(1, Math.round(freq * loopSeconds));
  return cycles / loopSeconds;
}

/**
 * Folds a rendered overhang back onto the head and truncates to the loop.
 *
 * Pure, operating on a single channel, so it is testable without any audio API.
 */
export function foldTail(rendered: Float32Array, loopSamples: number): Float32Array {
  const out = new Float32Array(loopSamples);
  const copy = Math.min(loopSamples, rendered.length);
  out.set(rendered.subarray(0, copy));

  const tail = rendered.length - loopSamples;
  const fold = Math.min(tail, loopSamples);
  for (let i = 0; i < fold; i += 1) {
    const value = (out[i] ?? 0) + (rendered[loopSamples + i] ?? 0);
    out[i] = value > PEAK_LIMIT ? PEAK_LIMIT : value < -PEAK_LIMIT ? -PEAK_LIMIT : value;
  }
  return out;
}

/** Builds an `OfflineAudioContext`. Injected so this module stays testable. */
export type OfflineFactory = (
  channels: number,
  length: number,
  sampleRate: number,
) => OfflineAudioContext;

function defaultOfflineFactory(
  channels: number,
  length: number,
  sampleRate: number,
): OfflineAudioContext {
  return new OfflineAudioContext(channels, length, sampleRate);
}

/** True when this environment can render offline at all. */
export function canRenderOffline(): boolean {
  return typeof OfflineAudioContext !== "undefined";
}

/** White noise, built once per render context and shared by every noise layer. */
function createNoiseBuffer(context: BaseAudioContext): AudioBuffer {
  const length = Math.ceil(context.sampleRate * NOISE_BUFFER_SECONDS);
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i += 1) {
    // Math.random is fine here and only here: this is presentation, it never
    // reaches the sim, and the ban in eslint.config.mjs is scoped to sim/.
    data[i] = Math.random() * 2 - 1;
  }
  return buffer;
}

/**
 * Applies an attack/decay envelope to a gain param.
 *
 * The decay is exponential because that is what a physical resonator does;
 * a linear decay reads as synthetic on anything percussive. The final
 * `setValueAtTime(0, ...)` is not decoration — an exponential ramp can only
 * approach zero, and leaving the node at a tiny non-zero gain leaks the
 * oscillator's tail into everything that follows.
 */
function envelope(
  param: AudioParam,
  at: number,
  peak: number,
  attack: number,
  decay: number,
): void {
  const attackEnd = at + attack;
  const end = attackEnd + decay;
  param.setValueAtTime(0, at);
  param.linearRampToValueAtTime(peak, attackEnd);
  param.exponentialRampToValueAtTime(Math.max(SILENCE_FLOOR, peak * SILENCE_FLOOR), end);
  param.setValueAtTime(0, end);
}

/** Schedules one recipe into a render context at an absolute time. */
function scheduleRecipe(
  context: BaseAudioContext,
  destination: AudioNode,
  noise: AudioBuffer,
  recipe: SoundRecipe,
  at: number,
  gainScale: number,
): void {
  const overall = recipe.gain * gainScale;

  for (const tone of recipe.tones) {
    const start = at + (tone.start ?? 0);
    const end = start + tone.attack + tone.decay;

    const osc = context.createOscillator();
    osc.type = tone.wave;
    osc.detune.value = tone.detune ?? CENTS_UNITY;
    osc.frequency.setValueAtTime(tone.freq, start);
    if (tone.freqEnd !== undefined && tone.freqEnd > 0) {
      osc.frequency.exponentialRampToValueAtTime(tone.freqEnd, end);
    }

    if (tone.fmRatio !== undefined && tone.fmIndex !== undefined) {
      const modulator = context.createOscillator();
      modulator.type = "sine";
      modulator.frequency.value = tone.freq * tone.fmRatio;
      const depth = context.createGain();
      depth.gain.value = tone.freq * tone.fmIndex;
      modulator.connect(depth);
      depth.connect(osc.frequency);
      modulator.start(start);
      modulator.stop(end + STOP_PAD);
    }

    const gain = context.createGain();
    envelope(gain.gain, start, tone.gain * overall, tone.attack, tone.decay);
    osc.connect(gain);
    gain.connect(destination);
    osc.start(start);
    osc.stop(end + STOP_PAD);
  }

  for (const layer of recipe.noises) {
    const start = at + (layer.start ?? 0);
    const end = start + layer.attack + layer.decay;

    const source = context.createBufferSource();
    source.buffer = noise;
    source.loop = true;

    const filter = context.createBiquadFilter();
    filter.type = layer.filter;
    filter.Q.value = layer.q;
    filter.frequency.setValueAtTime(layer.cutoff, start);
    if (layer.cutoffEnd !== undefined && layer.cutoffEnd > 0) {
      filter.frequency.exponentialRampToValueAtTime(layer.cutoffEnd, end);
    }

    const gain = context.createGain();
    envelope(gain.gain, start, layer.gain * overall, layer.attack, layer.decay);

    source.connect(filter);
    filter.connect(gain);
    gain.connect(destination);
    source.start(start);
    source.stop(end + STOP_PAD);
  }
}

/** Schedules a sustained drone across exactly one loop. */
function scheduleDrone(
  context: BaseAudioContext,
  destination: AudioNode,
  drone: DroneLayer,
  grid: MusicGrid,
  gainScale: number,
): void {
  const freq = quantiseDroneFrequency(drone.freq, grid.loopSeconds);
  if (freq <= 0) {
    return;
  }

  const osc = context.createOscillator();
  osc.type = drone.wave;
  osc.frequency.value = freq;
  osc.detune.value = drone.detune ?? CENTS_UNITY;

  let node: AudioNode = osc;
  if (drone.cutoff !== undefined) {
    const filter = context.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = drone.cutoff;
    node.connect(filter);
    node = filter;
  }

  const gain = context.createGain();
  const peak = drone.gain * gainScale;
  const depth = drone.lfoDepth ?? 0;
  gain.gain.value = peak * (1 - depth);

  if (drone.lfoCycles !== undefined && drone.lfoCycles > 0 && depth > 0) {
    const lfo = context.createOscillator();
    lfo.type = "sine";
    // Whole cycles per loop: the LFO is at the same phase at the loop point as
    // it was at zero, so the wrap is continuous in amplitude as well as in
    // waveform.
    lfo.frequency.value = drone.lfoCycles / grid.loopSeconds;
    const lfoDepth = context.createGain();
    lfoDepth.gain.value = peak * depth;
    lfo.connect(lfoDepth);
    lfoDepth.connect(gain.gain);
    lfo.start(0);
    lfo.stop(grid.loopSeconds);
  }

  node.connect(gain);
  gain.connect(destination);
  osc.start(0);
  // Stopped exactly at the loop point, NOT into the tail. A drone that ran
  // through the overhang would be folded back onto the head and play twice.
  osc.stop(grid.loopSeconds);
}

/** Copies a rendered offline result into a buffer owned by the live context. */
function toBuffer(
  target: BaseAudioContext,
  rendered: AudioBuffer,
  frames: number,
  fold: boolean,
): AudioBuffer {
  const channels = rendered.numberOfChannels;
  const out = target.createBuffer(channels, frames, rendered.sampleRate);
  // A fresh array per channel rather than a view onto the rendered buffer:
  // `copyToChannel` requires a Float32Array backed by a plain ArrayBuffer, and a
  // subarray of a rendered result carries the renderer's buffer type.
  const data = new Float32Array(frames);
  for (let channel = 0; channel < channels; channel += 1) {
    const source = rendered.getChannelData(channel);
    data.set(fold ? foldTail(source, frames) : source.subarray(0, frames));
    out.copyToChannel(data, channel);
  }
  return out;
}

/** Renders a one-shot. */
export async function renderSound(
  target: BaseAudioContext,
  recipe: SoundRecipe,
  offlineFactory: OfflineFactory = defaultOfflineFactory,
): Promise<AudioBuffer> {
  const frames = Math.ceil(recipe.duration * target.sampleRate);
  const context = offlineFactory(TUNING.audio.channels, frames, target.sampleRate);
  const noise = createNoiseBuffer(context);
  scheduleRecipe(context, context.destination, noise, recipe, 0, 1);
  const rendered = await context.startRendering();
  return toBuffer(target, rendered, frames, false);
}

/** Renders one stem: drones for the loop, hits placed on the beat grid. */
export async function renderStem(
  target: BaseAudioContext,
  recipe: StemRecipe,
  grid: MusicGrid,
  offlineFactory: OfflineFactory = defaultOfflineFactory,
): Promise<AudioBuffer> {
  const tailFrames = Math.ceil(TUNING.audio.stemTailSeconds * grid.sampleRate);
  const context = offlineFactory(
    TUNING.audio.channels,
    grid.loopSamples + tailFrames,
    grid.sampleRate,
  );
  const noise = createNoiseBuffer(context);

  for (const drone of recipe.drones) {
    scheduleDrone(context, context.destination, drone, grid, recipe.gain);
  }

  for (const pattern of recipe.patterns) {
    for (let i = 0; i < pattern.beats.length; i += 1) {
      const beat = pattern.beats[i] ?? 0;
      const accent = pattern.accents?.[i] ?? DEFAULT_ACCENT;
      scheduleRecipe(
        context,
        context.destination,
        noise,
        pattern.hit,
        beat * grid.beatSeconds,
        recipe.gain * accent,
      );
    }
  }

  const rendered = await context.startRendering();
  return toBuffer(target, rendered, grid.loopSamples, true);
}
