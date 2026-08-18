import { describe, expect, it } from "vitest";
import { TUNING } from "@/game/config/tuning";
import { createDucker } from "@/game/audio/ducking";
import { FakeAudioParam, asAudioParam } from "../helpers/fake-audio";

function ducker(): { param: FakeAudioParam; duck: ReturnType<typeof createDucker> } {
  const param = new FakeAudioParam(1);
  return { param, duck: createDucker(asAudioParam(param)) };
}

const RELEASE_TAU = TUNING.audio.duckRelease / 3;

describe("side-chain ducking", () => {
  it("attacks linearly over exactly duckAttack", () => {
    const { param, duck } = ducker();
    duck.trigger(2, 1);

    const ramp = param.last("linearRampToValueAtTime");
    expect(ramp?.time).toBeCloseTo(2 + TUNING.audio.duckAttack, 10);
    expect(ramp?.value).toBeCloseTo(1 - TUNING.audio.duckDepth, 10);
  });

  /**
   * `setTargetAtTime` takes a time constant, not a duration, and reaches ~95%
   * after three of them. Getting this wrong makes the release three times too
   * long, which reads as the music pumping.
   */
  it("releases exponentially with duckRelease/3 as the time constant", () => {
    const { param, duck } = ducker();
    duck.trigger(0, 1);

    const release = param.last("setTargetAtTime");
    expect(release?.value).toBe(1);
    expect(release?.timeConstant).toBeCloseTo(RELEASE_TAU, 10);
    expect(release?.time).toBeCloseTo(TUNING.audio.duckAttack, 10);
  });

  it("scales the dip by the triggering sound's loudness", () => {
    const { param, duck } = ducker();
    duck.trigger(0, 0.25);
    expect(param.last("linearRampToValueAtTime")?.value).toBeCloseTo(
      1 - TUNING.audio.duckDepth * 0.25,
      10,
    );
  });

  it("never dips past duckMaxDepth", () => {
    const { param, duck } = ducker();
    // An amount above 1 is clamped before it ever reaches the depth maths.
    duck.trigger(0, 50);
    const floor = param.last("linearRampToValueAtTime")?.value ?? 0;
    expect(floor).toBeGreaterThanOrEqual(1 - TUNING.audio.duckMaxDepth);
  });

  /**
   * The failure this prevents: eight shatter sounds in one frame, eight
   * independent dips of 0.3, and the music multiplied down to 0.06 — ducking
   * silently become a mute button.
   */
  it("coalesces a cluster instead of stacking it", () => {
    const { param, duck } = ducker();
    for (let i = 0; i < 8; i += 1) {
      duck.trigger(0.001 * i, 1);
    }
    const dips = param.of("linearRampToValueAtTime");
    expect(dips.length).toBe(1);
    expect(dips[0]?.value).toBeCloseTo(1 - TUNING.audio.duckDepth, 10);
  });

  it("a louder sound mid-duck deepens it", () => {
    const { param, duck } = ducker();
    duck.trigger(0, 0.2);
    duck.trigger(0.02, 1);

    const dips = param.of("linearRampToValueAtTime");
    expect(dips.length).toBe(2);
    expect(dips[1]?.value).toBeLessThan(dips[0]?.value ?? 1);
  });

  it("re-ducks once the previous dip has released", () => {
    const { param, duck } = ducker();
    duck.trigger(0, 1);
    // Five time constants is effectively fully released.
    duck.trigger(TUNING.audio.duckAttack + RELEASE_TAU * 5, 1);
    expect(param.of("linearRampToValueAtTime").length).toBe(2);
  });

  it("reports the remaining depth decaying over time", () => {
    const { duck } = ducker();
    duck.trigger(0, 1);
    const atAttack = duck.depthAt(TUNING.audio.duckAttack);
    const later = duck.depthAt(TUNING.audio.duckAttack + RELEASE_TAU);

    expect(atAttack).toBeCloseTo(TUNING.audio.duckDepth, 10);
    expect(later).toBeLessThan(atAttack);
    expect(later).toBeGreaterThan(0);
  });

  it("ignores a silent trigger", () => {
    const { param, duck } = ducker();
    duck.trigger(0, 0);
    expect(param.events.length).toBe(0);
  });

  it("reset returns the bus to neutral", () => {
    const { param, duck } = ducker();
    duck.trigger(0, 1);
    duck.reset(1);

    expect(param.last("setValueAtTime")?.value).toBe(1);
    expect(duck.depthAt(1)).toBe(0);
  });
});
