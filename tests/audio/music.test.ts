import { describe, expect, it } from "vitest";
import { TUNING } from "@/game/config/tuning";
import {
  Layer,
  createMusicSystem,
  intensityOf,
  layerTargets,
  rampBetween,
  type ThemeBuffers,
} from "@/game/audio/music";
import { createGrid } from "@/game/audio/synth";
import { FakeAudioContext, asAudioBuffer, asBaseContext, asGainNode } from "../helpers/fake-audio";

const SAMPLE_RATE = 48_000;

function themeBuffers(context: FakeAudioContext): ThemeBuffers {
  const grid = createGrid(SAMPLE_RATE);
  const make = (): AudioBuffer =>
    asAudioBuffer(context.createBuffer(2, grid.loopSamples, SAMPLE_RATE));
  return { base: make(), percussion: make(), tension: make(), overdrive: make() };
}

function system(): {
  context: FakeAudioContext;
  music: ReturnType<typeof createMusicSystem>;
  loads: number[];
} {
  const context = new FakeAudioContext();
  const destination = context.createGain();
  const loads: number[] = [];
  const music = createMusicSystem(asBaseContext(context), asGainNode(destination), {
    loadTheme: async (id) => {
      loads.push(id);
      return themeBuffers(context);
    },
    lead: 0,
  });
  return { context, music, loads };
}

describe("the intensity curve", () => {
  it("blends speed and Flow by their tuned weights", () => {
    expect(intensityOf(0, 0)).toBe(0);
    expect(intensityOf(1, 1)).toBe(1);
    expect(intensityOf(1, 0)).toBeCloseTo(TUNING.audio.musicSpeedWeight, 10);
    expect(intensityOf(0, 1)).toBeCloseTo(TUNING.audio.musicFlowWeight, 10);
  });

  it("clamps hostile inputs", () => {
    expect(intensityOf(-5, 12)).toBeGreaterThanOrEqual(0);
    expect(intensityOf(Number.NaN, Number.NaN)).toBe(0);
  });

  it("ramps between onset and full", () => {
    expect(rampBetween(0, 0.2, 0.6)).toBe(0);
    expect(rampBetween(0.4, 0.2, 0.6)).toBeCloseTo(0.5, 10);
    expect(rampBetween(1, 0.2, 0.6)).toBe(1);
  });
});

describe("layer targets", () => {
  it("keeps the base layer up at all times", () => {
    expect(layerTargets(0, false)[Layer.Base]).toBe(1);
  });

  it("brings percussion in before tension", () => {
    const early = layerTargets(TUNING.audio.percussionFull, false);
    expect(early[Layer.Percussion]).toBe(1);
    expect(early[Layer.Tension]).toBe(0);
  });

  it("raises the Overdrive stem and ducks the rest, without silencing them", () => {
    const on = layerTargets(1, true);
    expect(on[Layer.Overdrive]).toBe(1);
    expect(on[Layer.Base]).toBeCloseTo(1 - TUNING.audio.overdriveLayerDuck, 10);
    // Not to zero: the groove has to survive underneath, or the exit sounds
    // like the music restarted.
    expect(on[Layer.Base]).toBeGreaterThan(0);
  });

  it("keeps the Overdrive stem silent otherwise", () => {
    expect(layerTargets(1, false)[Layer.Overdrive]).toBe(0);
  });
});

describe("stem playback", () => {
  /**
   * The entire drift fix, and it is structural. Two sources started at the same
   * time on the same clock with identical loop lengths cannot separate — they
   * are read from one sample counter.
   */
  it("starts all four stems at one identical time", async () => {
    const { context, music } = system();
    context.advance(3.25);
    await music.play(0);

    const started = context.created.sources.map((source) => source.startedAt);
    expect(started.length).toBe(4);
    expect(new Set(started).size).toBe(1);
    expect(started[0]).toBeCloseTo(3.25, 10);
  });

  it("loops every stem, with the loop end stated explicitly", async () => {
    const { context, music } = system();
    await music.play(0);

    for (const source of context.created.sources) {
      expect(source.loop).toBe(true);
      expect(source.loopStart).toBe(0);
      expect(source.loopEnd).toBeCloseTo(music.grid.loopSeconds, 6);
    }
  });

  it("changing intensity never restarts a stem", async () => {
    const { context, music } = system();
    await music.play(0);
    const before = context.created.sources.length;

    for (let i = 0; i <= 20; i += 1) {
      context.advance(0.1);
      music.setIntensity(i / 20, i / 20, context.currentTime);
    }

    expect(context.created.sources.length).toBe(before);
  });

  it("ignores a re-request for the theme already playing", async () => {
    const { music, loads } = system();
    await music.play(0);
    await music.play(0);
    expect(loads).toEqual([0]);
  });

  /**
   * The one place a stem genuinely has to start late. Aligning to a whole
   * number of loops puts the new set at exactly the phase it would have had if
   * it had been playing since the beginning.
   */
  it("starts a new theme on an exact loop boundary from the origin", async () => {
    const { context, music } = system();
    await music.play(0);
    const origin = music.startTime;

    context.advance(10.4);
    await music.play(1);

    const late = context.created.sources.slice(4).map((source) => source.startedAt ?? 0);
    expect(late.length).toBe(4);
    for (const start of late) {
      const loops = (start - origin) / music.grid.loopSeconds;
      expect(loops).toBeCloseTo(Math.round(loops), 9);
      expect(Math.round(loops)).toBeGreaterThan(0);
    }
    expect(new Set(late).size).toBe(1);
  });

  it("stops the outgoing theme only after its fade has finished", async () => {
    const { context, music } = system();
    await music.play(0);
    context.advance(10.4);
    await music.play(1);

    const outgoing = context.created.sources.slice(0, 4);
    const incomingStart = context.created.sources[4]?.startedAt ?? 0;
    for (const source of outgoing) {
      expect(source.stoppedAt).toBeCloseTo(incomingStart + TUNING.audio.themeFade, 9);
    }
  });
});

describe("the Overdrive swap", () => {
  it("lands on a bar boundary, not immediately", async () => {
    const { context, music } = system();
    await music.play(0);
    const origin = music.startTime;

    // Deliberately off the grid.
    context.advance(music.grid.barSeconds * 1.37);
    music.setOverdrive(true, context.currentTime);

    // The overdrive stem's gain is the 4th layer gain of the current set.
    const overdriveGain = context.created.gains.at(-1);
    const ramp = overdriveGain?.gain.last("linearRampToValueAtTime");
    expect(ramp).toBeDefined();

    const bars = ((ramp?.time ?? 0) - TUNING.audio.overdriveFade - origin) / music.grid.barSeconds;
    expect(bars).toBeCloseTo(Math.round(bars), 8);
    expect(Math.round(bars)).toBe(2);
  });

  it("never schedules the swap in the past", async () => {
    const { context, music } = system();
    await music.play(0);
    context.advance(music.grid.barSeconds * 3);

    // Only the events the swap itself adds. The set-up automation from `play`
    // is legitimately behind us by now.
    const before = context.created.gains.map((gain) => gain.gain.events.length);
    music.setOverdrive(true, context.currentTime);

    let checked = 0;
    context.created.gains.forEach((gain, index) => {
      for (const event of gain.gain.events.slice(before[index] ?? 0)) {
        expect(event.time).toBeGreaterThanOrEqual(context.currentTime - 1e-9);
        checked += 1;
      }
    });
    expect(checked).toBeGreaterThan(0);
  });

  it("ignores a redundant swap request", async () => {
    const { context, music } = system();
    await music.play(0);
    music.setOverdrive(true, context.currentTime);
    const after = context.created.gains.at(-1)?.gain.events.length ?? 0;
    music.setOverdrive(true, context.currentTime);
    expect(context.created.gains.at(-1)?.gain.events.length).toBe(after);
  });

  /**
   * A bar-quantised swap owns the layer gains until it lands. A second writer
   * would cancel its automation, and the swap would silently never happen.
   */
  it("defers intensity ramps while a swap is pending", async () => {
    const { context, music } = system();
    await music.play(0);
    music.setIntensity(0, 0, context.currentTime);
    music.setOverdrive(true, context.currentTime);

    const percussion = context.created.gains.at(-3);
    const before = percussion?.gain.events.length ?? 0;
    music.setIntensity(1, 1, context.currentTime);
    expect(percussion?.gain.events.length).toBe(before);
  });

  it("resumes intensity ramps once the swap has landed", async () => {
    const { context, music } = system();
    await music.play(0);
    music.setIntensity(0, 0, context.currentTime);
    music.setOverdrive(true, context.currentTime);

    context.advance(music.grid.barSeconds * 2 + TUNING.audio.overdriveFade + 0.01);
    const percussion = context.created.gains.at(-3);
    const before = percussion?.gain.events.length ?? 0;
    music.setIntensity(1, 1, context.currentTime);
    expect(percussion?.gain.events.length).toBeGreaterThan(before);
  });

  /**
   * Without this the frame loop queues an automation event 60 times a second
   * for changes of 0.001 — real CPU, and zipper artifacts.
   */
  it("ignores a sub-epsilon intensity change", async () => {
    const { context, music } = system();
    await music.play(0);
    music.setIntensity(0.5, 0.5, context.currentTime);

    const percussion = context.created.gains.at(-3);
    const before = percussion?.gain.events.length ?? 0;
    for (let i = 0; i < 30; i += 1) {
      context.advance(1 / 60);
      music.setIntensity(0.5 + i * 1e-5, 0.5, context.currentTime);
    }
    expect(percussion?.gain.events.length).toBe(before);
  });
});

describe("the bar grid", () => {
  it("nextBar returns whole bars from the origin", async () => {
    const { music } = system();
    await music.play(0);
    const origin = music.startTime;

    for (const offset of [0.01, 1.5, 7.3, 30]) {
      const bar = music.nextBar(origin + offset);
      const index = (bar - origin) / music.grid.barSeconds;
      expect(index).toBeCloseTo(Math.round(index), 9);
      expect(bar).toBeGreaterThanOrEqual(origin + offset);
    }
  });

  it("the grid derives a whole number of samples per loop", () => {
    const grid = createGrid(SAMPLE_RATE);
    expect(Number.isInteger(grid.loopSamples)).toBe(true);
    expect(grid.loopSeconds).toBeCloseTo(grid.barSeconds * TUNING.audio.barsPerLoop, 12);
    expect(grid.barSeconds).toBeCloseTo(grid.beatSeconds * TUNING.audio.beatsPerBar, 12);
  });
});
