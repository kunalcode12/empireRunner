import { describe, expect, it } from "vitest";
import { TUNING } from "@/game/config/tuning";
import { createVoicePool } from "@/game/audio/voices";
import { FakeAudioContext, asAudioBuffer, asBaseContext, asGainNode } from "../helpers/fake-audio";

function pool(capacity: number): {
  context: FakeAudioContext;
  voices: ReturnType<typeof createVoicePool>;
  buffer: ReturnType<FakeAudioContext["createBuffer"]>;
} {
  const context = new FakeAudioContext();
  const destination = context.createGain();
  const voices = createVoicePool(asBaseContext(context), asGainNode(destination), capacity);
  // 0.5s at 48kHz.
  const buffer = context.createBuffer(2, 24_000, 48_000);
  return { context, voices, buffer };
}

function shot(
  buffer: ReturnType<FakeAudioContext["createBuffer"]>,
  when: number,
): Parameters<ReturnType<typeof createVoicePool>["play"]>[0] {
  return { buffer: asAudioBuffer(buffer), gain: 0.5, playbackRate: 1, pan: 0, when };
}

describe("voice pool", () => {
  it("pre-builds its chains at construction, not per shot", () => {
    const { context } = pool(8);
    // One destination gain + eight slot gains. Nothing is built lazily.
    expect(context.created.gains.length).toBe(9);
  });

  it("plays a shot at the requested time", () => {
    const { voices, buffer } = pool(4);
    expect(voices.play(shot(buffer, 1.5))).toBe(1.5);
    expect(voices.activeCount()).toBe(1);
  });

  it("reuses a slot whose sound has already finished", () => {
    const { context, voices, buffer } = pool(1);
    voices.play(shot(buffer, 0));
    // The buffer is 0.5s; by t=1 the slot is free even though `onended` has
    // not been delivered. Waiting for the callback would under-use the pool at
    // exactly the moments it is busiest.
    expect(voices.play(shot(buffer, 1))).toBe(1);
    expect(context.created.sources.length).toBe(2);
  });

  it("caps concurrency at its capacity", () => {
    const { voices, buffer } = pool(3);
    for (let i = 0; i < 10; i += 1) {
      voices.play(shot(buffer, 0));
    }
    expect(voices.activeCount()).toBeLessThanOrEqual(3);
  });

  /**
   * The oldest voice is the right victim: furthest into its decay, so both the
   * quietest and the one whose loss carries the least information.
   */
  it("steals the oldest voice when full", () => {
    const { context, voices, buffer } = pool(2);
    voices.play(shot(buffer, 0.0));
    voices.play(shot(buffer, 0.1));
    voices.play(shot(buffer, 0.2));

    const first = context.created.sources[0];
    const second = context.created.sources[1];
    expect(first?.stoppedAt).not.toBeNull();
    expect(second?.stoppedAt).toBeNull();
  });

  /**
   * A hard `stop()` truncates the waveform wherever it happens to be, which is
   * a step discontinuity — a click, and a loud one.
   */
  it("fades a stolen voice out instead of cutting it", () => {
    const { context, voices, buffer } = pool(1);
    voices.play(shot(buffer, 0));
    const started = voices.play(shot(buffer, 0.1));

    const victim = context.created.sources[0];
    const ramp = context.created.gains[1]?.gain.last("linearRampToValueAtTime");

    expect(ramp?.value).toBe(0);
    expect(ramp?.time).toBeCloseTo(0.1 + TUNING.audio.voiceStealFade, 10);
    expect(victim?.stoppedAt).toBeCloseTo(0.1 + TUNING.audio.voiceStealFade, 10);
    // The replacement begins where the fade ends — never overlapping it.
    expect(started).toBeCloseTo(0.1 + TUNING.audio.voiceStealFade, 10);
  });

  /**
   * A stolen voice's `onended` fires AFTER the slot has been handed on. Without
   * the generation check it frees a slot that is currently playing, and voices
   * get stolen while the pool looks half empty.
   */
  it("a stolen voice's late onended does not free the slot that replaced it", () => {
    const { context, voices, buffer } = pool(1);
    voices.play(shot(buffer, 0));
    voices.play(shot(buffer, 0.1));

    context.created.sources[0]?.finish();
    expect(voices.activeCount()).toBe(1);
  });

  it("tracks a peak for the perf gate", () => {
    const { voices, buffer } = pool(4);
    voices.play(shot(buffer, 0));
    voices.play(shot(buffer, 0));
    voices.play(shot(buffer, 0));
    expect(voices.peak).toBe(3);
  });

  it("scales the end time by playback rate, so pitch shifts free the slot early", () => {
    const { voices, buffer } = pool(1);
    voices.play({ buffer: asAudioBuffer(buffer), gain: 1, playbackRate: 2, pan: 0, when: 0 });
    // 0.5s of buffer at 2x is 0.25s of sound. At 0.3 the slot is free.
    expect(voices.play(shot(buffer, 0.3))).toBe(0.3);
  });

  it("a zero-capacity pool refuses rather than throwing", () => {
    const { voices, buffer } = pool(0);
    expect(voices.play(shot(buffer, 0))).toBeNull();
  });

  it("stopAll fades everything down", () => {
    const { context, voices, buffer } = pool(2);
    voices.play(shot(buffer, 0));
    voices.play(shot(buffer, 0));
    voices.stopAll(0.4);

    for (const source of context.created.sources) {
      expect(source.stoppedAt).toBeCloseTo(0.4 + TUNING.audio.voiceStealFade, 10);
    }
  });
});
