import { describe, expect, it } from "vitest";
import { TUNING } from "@/game/config/tuning";
import { cueTime, measureLatency } from "@/game/audio/latency";

describe("latency probe", () => {
  it("prefers outputLatency, which is the full-path estimate", () => {
    const probe = measureLatency({ baseLatency: 0.005, outputLatency: 0.04 });
    expect(probe.effective).toBe(0.04);
    expect(probe.estimated).toBe(true);
  });

  /**
   * `outputLatency` reads 0 before the first render quantum and on platforms
   * that decline to estimate. Treating that as "zero latency" rather than
   * "unknown" would report a better figure than baseLatency proves.
   */
  it("falls back to baseLatency when outputLatency is 0", () => {
    const probe = measureLatency({ baseLatency: 0.011, outputLatency: 0 });
    expect(probe.effective).toBe(0.011);
    expect(probe.estimated).toBe(false);
  });

  it("reports zero rather than throwing when there is no context", () => {
    expect(measureLatency(null).effective).toBe(0);
    expect(measureLatency(undefined).effective).toBe(0);
  });

  it("ignores non-finite values from a hostile implementation", () => {
    expect(measureLatency({ baseLatency: Number.NaN, outputLatency: -1 }).effective).toBe(0);
  });
});

describe("cue scheduling", () => {
  it("always leads by at least scheduleAhead", () => {
    expect(cueTime(10, 0)).toBeCloseTo(10 + TUNING.audio.scheduleAhead, 10);
  });

  it("a positive offset delays the cue", () => {
    expect(cueTime(10, 0.1)).toBeCloseTo(10 + TUNING.audio.scheduleAhead + 0.1, 10);
  });

  /**
   * The honest limit. A negative offset can only give back the scheduling lead;
   * it cannot schedule sound in the past, so it clamps at `now`. `latency.ts`
   * says so in prose and this pins it.
   */
  it("a negative offset clamps at now and never goes into the past", () => {
    expect(cueTime(10, -1)).toBe(10);
    expect(cueTime(10, TUNING.audio.latencyOffsetMin)).toBeGreaterThanOrEqual(10);
  });

  it("clamps an out-of-range offset before using it", () => {
    const absurd = cueTime(0, 500);
    expect(absurd).toBeCloseTo(TUNING.audio.scheduleAhead + TUNING.audio.latencyOffsetMax, 10);
  });
});
