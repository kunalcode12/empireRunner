import { describe, expect, it } from "vitest";
import { TUNING } from "@/game/config/tuning";
import { beatSeconds, createGrid, foldTail, quantiseDroneFrequency } from "@/game/audio/synth";
import { EVENT_SOUND, SOUNDS, THEME_STEMS, type SoundKey } from "@/game/audio/recipes";

/**
 * `OfflineAudioContext` does not exist under Node, so the rendering itself is
 * exercised in Chromium by tests/e2e/audio.spec.ts. What is tested here is the
 * arithmetic the rendering depends on — the part most likely to be wrong, and
 * the part whose failure is a click every 7.6 seconds forever.
 */

const RATES = [44_100, 48_000, 96_000];

describe("the musical grid", () => {
  it("derives from one tempo across every sample rate", () => {
    for (const rate of RATES) {
      const grid = createGrid(rate);
      expect(Number.isInteger(grid.loopSamples)).toBe(true);
      // The tempo bends to the sample rate rather than the other way round, so
      // it is not exactly the authored bpm — but the shift is about a
      // thousandth of a cent and no listener can measure it.
      const cents = 1200 * Math.log2(grid.beatSeconds / beatSeconds(TUNING.audio.musicBpm));
      expect(Math.abs(cents)).toBeLessThan(0.01);
    }
  });

  /**
   * Load-bearing. `music.ts` computes bar boundaries as `startTime + n * bar`,
   * so a bar that does not exactly tile the rendered loop puts every boundary a
   * fraction of a sample out and compounds it — 22 samples off the downbeat 78
   * loops into a ten-minute run.
   */
  it("bars tile the rendered loop exactly", () => {
    for (const rate of RATES) {
      const grid = createGrid(rate);
      expect(grid.loopSeconds).toBe(grid.loopSamples / rate);
      expect(grid.barSeconds * grid.barsPerLoop).toBe(grid.loopSeconds);
      expect(grid.beatSeconds * grid.beatsPerBar).toBeCloseTo(grid.barSeconds, 15);
      // Zero, not "within half a sample": the loop duration is defined by the
      // sample count rather than approximating it.
      expect(Math.abs(grid.loopSamples - grid.loopSeconds * rate)).toBe(0);
    }
  });
});

describe("drone frequency quantisation", () => {
  const loop = createGrid(48_000).loopSeconds;

  /**
   * A drone that does not complete a whole number of cycles in one loop ends at
   * a different point in its waveform than it started, and that step is a click
   * on every single wrap.
   */
  it("always fits a whole number of cycles into the loop", () => {
    for (const freq of [55, 61.7, 65.4, 73.4, 82.4, 110, 123.5, 146.8, 164.8, 220]) {
      const cycles = quantiseDroneFrequency(freq, loop) * loop;
      expect(cycles).toBeCloseTo(Math.round(cycles), 9);
    }
  });

  it("shifts by at most a few cents, which is inaudible", () => {
    for (const freq of [55, 65.4, 82.4, 110, 146.8, 220]) {
      const snapped = quantiseDroneFrequency(freq, loop);
      const cents = 1200 * Math.log2(snapped / freq);
      expect(Math.abs(cents)).toBeLessThan(5);
    }
  });

  it("clamps below one cycle per loop rather than producing DC", () => {
    expect(quantiseDroneFrequency(0.01, loop) * loop).toBe(1);
  });

  it("rejects nonsense instead of returning NaN", () => {
    expect(quantiseDroneFrequency(Number.NaN, loop)).toBe(0);
    expect(quantiseDroneFrequency(-100, loop)).toBe(0);
    expect(quantiseDroneFrequency(110, 0)).toBe(0);
  });

  it("every authored drone quantises cleanly", () => {
    for (const theme of THEME_STEMS) {
      for (const stem of [theme.base, theme.percussion, theme.tension, theme.overdrive]) {
        for (const drone of stem.drones) {
          const cycles = quantiseDroneFrequency(drone.freq, loop) * loop;
          expect(cycles).toBeCloseTo(Math.round(cycles), 9);
        }
      }
    }
  });

  it("every authored amplitude LFO is a whole number of cycles per loop", () => {
    for (const theme of THEME_STEMS) {
      for (const stem of [theme.base, theme.percussion, theme.tension, theme.overdrive]) {
        for (const drone of stem.drones) {
          if (drone.lfoCycles !== undefined) {
            expect(Number.isInteger(drone.lfoCycles)).toBe(true);
          }
        }
      }
    }
  });
});

describe("tail folding", () => {
  it("truncates to exactly the loop length", () => {
    const rendered = new Float32Array(1_000);
    expect(foldTail(rendered, 600).length).toBe(600);
  });

  /**
   * The overhang IS what the previous iteration's decay would have been doing
   * if the loop were infinite. Adding it is not a trick, it is the correct
   * value.
   */
  it("adds the overhang onto the head", () => {
    const rendered = new Float32Array(10);
    rendered[0] = 0.1;
    rendered[1] = 0.2;
    rendered[6] = 0.05;
    rendered[7] = 0.03;

    const folded = foldTail(rendered, 6);
    expect(folded[0]).toBeCloseTo(0.15, 6);
    expect(folded[1]).toBeCloseTo(0.23, 6);
    expect(folded[2]).toBeCloseTo(0, 6);
  });

  it("clamps rather than letting a stacked decay clip", () => {
    const rendered = new Float32Array(4);
    rendered[0] = 0.9;
    rendered[2] = 0.9;
    const folded = foldTail(rendered, 2);
    expect(folded[0]).toBeLessThanOrEqual(1);
    expect(folded[0]).toBeGreaterThan(0.9);
  });

  it("handles a tail longer than the loop without reading past the end", () => {
    const rendered = new Float32Array(10).fill(0.01);
    expect(() => foldTail(rendered, 3)).not.toThrow();
    expect(foldTail(rendered, 3).length).toBe(3);
  });

  it("is a no-op when nothing overhangs", () => {
    const rendered = new Float32Array([0.1, 0.2, 0.3]);
    expect(Array.from(foldTail(rendered, 3))).toEqual([
      Math.fround(0.1),
      Math.fround(0.2),
      Math.fround(0.3),
    ]);
  });
});

describe("the recipe table", () => {
  it("every recipe is long enough for its own layers", () => {
    const all: [string, (typeof SOUNDS)[SoundKey]][] = Object.entries(SOUNDS) as [
      string,
      (typeof SOUNDS)[SoundKey],
    ][];

    for (const [name, recipe] of all) {
      for (const tone of recipe.tones) {
        const end = (tone.start ?? 0) + tone.attack + tone.decay;
        expect(end, `${name}: a tone outlives its buffer`).toBeLessThanOrEqual(recipe.duration);
      }
      for (const noise of recipe.noises) {
        const end = (noise.start ?? 0) + noise.attack + noise.decay;
        expect(end, `${name}: a noise layer outlives its buffer`).toBeLessThanOrEqual(
          recipe.duration,
        );
      }
    }
  });

  it("every recipe makes some sound", () => {
    for (const [name, recipe] of Object.entries(SOUNDS)) {
      expect(recipe.tones.length + recipe.noises.length, `${name} is silent`).toBeGreaterThan(0);
      expect(recipe.gain).toBeGreaterThan(0);
    }
  });

  it("every mapped event points at a real recipe", () => {
    for (const key of Object.values(EVENT_SOUND)) {
      expect(SOUNDS[key]).toBeDefined();
    }
  });

  it("all four themes are authored with all four layers", () => {
    expect(THEME_STEMS.length).toBe(4);
    for (const theme of THEME_STEMS) {
      for (const stem of [theme.base, theme.percussion, theme.tension, theme.overdrive]) {
        expect(stem.drones.length + stem.patterns.length).toBeGreaterThan(0);
      }
    }
  });

  /** A hit past the loop end would be folded onto the head as a phantom beat. */
  it("no stem hit is authored past the end of its loop", () => {
    const beatsPerLoop = TUNING.audio.beatsPerBar * TUNING.audio.barsPerLoop;
    for (const theme of THEME_STEMS) {
      for (const stem of [theme.base, theme.percussion, theme.tension, theme.overdrive]) {
        for (const pattern of stem.patterns) {
          for (const beat of pattern.beats) {
            expect(beat, `${theme.name}: beat ${beat} is past the loop`).toBeLessThan(beatsPerLoop);
            expect(beat).toBeGreaterThanOrEqual(0);
          }
        }
      }
    }
  });

  it("accent arrays line up with their beat arrays", () => {
    for (const theme of THEME_STEMS) {
      for (const stem of [theme.base, theme.percussion, theme.tension, theme.overdrive]) {
        for (const pattern of stem.patterns) {
          if (pattern.accents !== undefined) {
            expect(pattern.accents.length, `${theme.name}: accent/beat mismatch`).toBe(
              pattern.beats.length,
            );
          }
        }
      }
    }
  });

  /**
   * The decay has to fit in the tail that gets folded back, or it is truncated
   * at the render length and clicks.
   */
  it("every stem hit decays inside the folded tail", () => {
    for (const theme of THEME_STEMS) {
      for (const stem of [theme.base, theme.percussion, theme.tension, theme.overdrive]) {
        for (const pattern of stem.patterns) {
          expect(pattern.hit.duration).toBeLessThanOrEqual(TUNING.audio.stemTailSeconds);
        }
      }
    }
  });
});
