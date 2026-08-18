import { describe, expect, it } from "vitest";
import { TUNING } from "@/game/config/tuning";
import { SimEvent } from "@/game/sim/events";
import { createSfxSystem } from "@/game/audio/sfx";
import { EVENT_SOUND, Sound, SOUNDS, type SoundKey } from "@/game/audio/recipes";
import { createVoicePool, type PlayOptions } from "@/game/audio/voices";
import { createDucker } from "@/game/audio/ducking";
import {
  FakeAudioContext,
  FakeAudioParam,
  asAudioBuffer,
  asAudioParam,
  asBaseContext,
  asGainNode,
} from "../helpers/fake-audio";

interface Harness {
  sfx: ReturnType<typeof createSfxSystem>;
  shots: PlayOptions[];
  duckParam: FakeAudioParam;
}

/** Builds an sfx system over a recording pool, with a fixed random source. */
function harness(random: () => number = () => 0.5): Harness {
  const context = new FakeAudioContext();
  const destination = context.createGain();
  const real = createVoicePool(asBaseContext(context), asGainNode(destination), 32);

  const shots: PlayOptions[] = [];
  const recording = {
    ...real,
    play(options: PlayOptions): number | null {
      shots.push(options);
      return real.play(options);
    },
  };

  // Every sound gets a buffer, so nothing is skipped for being unrendered.
  const buffers = new Map<SoundKey, AudioBuffer>();
  for (const key of Object.keys(SOUNDS) as SoundKey[]) {
    buffers.set(key, asAudioBuffer(context.createBuffer(2, 4_800, 48_000)));
  }

  const duckParam = new FakeAudioParam(1);
  const sfx = createSfxSystem({
    buffers,
    sfxPool: recording,
    uiPool: recording,
    ducker: createDucker(asAudioParam(duckParam)),
    latencyOffset: () => 0,
    random,
  });

  return { sfx, shots, duckParam };
}

describe("sfx event mapping", () => {
  it("plays a sound for every mapped sim event", () => {
    for (const [type] of Object.entries(EVENT_SOUND)) {
      const h = harness();
      h.sfx.handle(Number(type), 0, 0);
      expect(h.shots.length, `event ${type} produced no sound`).toBe(1);
    }
  });

  /**
   * These fire every tick or near enough. A per-tick sound is not a sound, it
   * is a tone generator — they drive the music's intensity and the ducking
   * instead.
   */
  it("stays silent for the per-tick and telemetry events", () => {
    const silent = [
      SimEvent.OverdriveTick,
      SimEvent.FlowGain,
      SimEvent.FractureTick,
      SimEvent.CornerForgive,
      SimEvent.GeneratorUnwinnable,
    ];
    for (const type of silent) {
      const h = harness();
      h.sfx.handle(type, 0, 0);
      expect(h.shots.length, `event ${type} should be silent`).toBe(0);
    }
  });

  it("picks the Fracture outcome from payload0", () => {
    const win = harness();
    win.sfx.handle(SimEvent.FractureResolve, 1, 0);
    const lose = harness();
    lose.sfx.handle(SimEvent.FractureResolve, 0, 0);

    // Success resolves upward, failure downward — different buffers, and both
    // must be distinguishable without looking at the screen.
    expect(win.shots.length).toBe(1);
    expect(lose.shots.length).toBe(1);
    expect(win.shots[0]?.buffer).not.toBe(lose.shots[0]?.buffer);
  });

  it("scales a landing by impact speed", () => {
    const soft = harness();
    soft.sfx.handle(SimEvent.Land, -1, 0);
    const hard = harness();
    hard.sfx.handle(SimEvent.Land, -TUNING.feel.squashFullImpactSpeed, 0);

    expect(hard.shots[0]?.gain).toBeGreaterThan(soft.shots[0]?.gain ?? 0);
  });
});

describe("sfx humanisation", () => {
  /**
   * The ear is extremely good at spotting an identical waveform played twice,
   * and once it does, every later repeat is heard as "the sound file" rather
   * than as the event.
   */
  it("never plays two identical shots", () => {
    let seed = 0;
    const h = harness(() => {
      seed += 0.17;
      return seed % 1;
    });

    for (let i = 0; i < 6; i += 1) {
      h.sfx.handle(SimEvent.Shatter, 0, i);
    }
    const rates = new Set(h.shots.map((shot) => shot.playbackRate));
    const gains = new Set(h.shots.map((shot) => shot.gain));
    expect(rates.size).toBe(6);
    expect(gains.size).toBe(6);
  });

  it("keeps pitch jitter inside +/-8%", () => {
    for (const value of [0, 0.5, 1]) {
      const h = harness(() => value);
      h.sfx.handle(SimEvent.Jump, 0, 0);
      const rate = h.shots[0]?.playbackRate ?? 0;
      expect(rate).toBeGreaterThanOrEqual(1 - TUNING.audio.pitchJitter);
      expect(rate).toBeLessThanOrEqual(1 + TUNING.audio.pitchJitter);
    }
  });

  it("keeps gain jitter inside +/-6%", () => {
    const recipe = SOUNDS[Sound.Jump];
    for (const value of [0, 1]) {
      const h = harness(() => value);
      h.sfx.handle(SimEvent.Jump, 0, 0);
      const gain = h.shots[0]?.gain ?? 0;
      expect(gain).toBeGreaterThanOrEqual(recipe.gain * (1 - TUNING.audio.gainJitter) - 1e-9);
      expect(gain).toBeLessThanOrEqual(recipe.gain * (1 + TUNING.audio.gainJitter) + 1e-9);
    }
  });

  it("triggers the duck in proportion to loudness", () => {
    const quiet = harness();
    quiet.sfx.handle(SimEvent.LaneChange, 0, 0);
    const loud = harness();
    loud.sfx.handle(SimEvent.Crash, 0, 0);

    const quietDip = quiet.duckParam.last("linearRampToValueAtTime")?.value ?? 1;
    const loudDip = loud.duckParam.last("linearRampToValueAtTime")?.value ?? 1;
    expect(loudDip).toBeLessThan(quietDip);
  });
});

describe("the coin streak ladder", () => {
  /**
   * This communicates the whole bit-streak system with no UI element. The
   * player hears the pitch rising, hears it reset when they miss, and works out
   * what they did.
   */
  it("climbs a semitone per pickup", () => {
    const h = harness();
    h.sfx.handle(SimEvent.Coin, 0, 0);
    h.sfx.handle(SimEvent.Coin, 0, 0.2);
    h.sfx.handle(SimEvent.Coin, 0, 0.4);

    const rates = h.shots.map((shot) => shot.playbackRate);
    expect(rates[1]).toBeGreaterThan(rates[0] ?? 0);
    expect(rates[2]).toBeGreaterThan(rates[1] ?? 0);
    expect(h.sfx.streakSemitones).toBe(2 * TUNING.audio.coinStreakSemitone);
  });

  it("stops climbing at one octave", () => {
    const h = harness();
    for (let i = 0; i < 40; i += 1) {
      h.sfx.handle(SimEvent.Coin, 0, i * 0.1);
    }
    expect(h.sfx.streakSemitones).toBe(TUNING.audio.coinStreakMax);
  });

  /**
   * The sim has no "streak broken" event — the streak is internal to scoring.
   * A gap IS the break as the player experiences it.
   */
  it("resets after a gap", () => {
    const h = harness();
    h.sfx.handle(SimEvent.Coin, 0, 0);
    h.sfx.handle(SimEvent.Coin, 0, 0.2);
    expect(h.sfx.streakSemitones).toBeGreaterThan(0);

    h.sfx.handle(SimEvent.Coin, 0, 0.2 + TUNING.audio.coinStreakResetSeconds + 0.01);
    expect(h.sfx.streakSemitones).toBe(0);
  });

  it("resets on a crash", () => {
    const h = harness();
    h.sfx.handle(SimEvent.Coin, 0, 0);
    h.sfx.handle(SimEvent.Coin, 0, 0.1);
    h.sfx.handle(SimEvent.Crash, 0, 0.2);
    expect(h.sfx.streakSemitones).toBe(0);
  });

  it("resets on a stumble and at run start", () => {
    const stumble = harness();
    stumble.sfx.handle(SimEvent.Coin, 0, 0);
    stumble.sfx.handle(SimEvent.Coin, 0, 0.1);
    stumble.sfx.handle(SimEvent.Stumble, 0, 0.2);
    expect(stumble.sfx.streakSemitones).toBe(0);

    const start = harness();
    start.sfx.handle(SimEvent.Coin, 0, 0);
    start.sfx.handle(SimEvent.Coin, 0, 0.1);
    start.sfx.handle(SimEvent.RunStart, 0, 0.2);
    expect(start.sfx.streakSemitones).toBe(0);
  });

  it("a crash still makes its own sound while resetting the ladder", () => {
    const h = harness();
    h.sfx.handle(SimEvent.Crash, 0, 0);
    expect(h.shots.length).toBe(1);
  });

  /** A missing buffer is skipped, not thrown — one failed render is not fatal. */
  it("skips a sound with no rendered buffer", () => {
    const context = new FakeAudioContext();
    const destination = context.createGain();
    const shots: PlayOptions[] = [];
    const real = createVoicePool(asBaseContext(context), asGainNode(destination), 8);

    const sfx = createSfxSystem({
      buffers: new Map(),
      sfxPool: {
        ...real,
        play(options: PlayOptions) {
          shots.push(options);
          return real.play(options);
        },
      },
      uiPool: real,
      ducker: createDucker(asAudioParam(new FakeAudioParam(1))),
      latencyOffset: () => 0,
    });

    expect(() => sfx.handle(SimEvent.Crash, 0, 0)).not.toThrow();
    expect(shots.length).toBe(0);
  });
});
