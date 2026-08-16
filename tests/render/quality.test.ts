import { describe, expect, it } from "vitest";
import { TUNING } from "@/game/config/tuning";
import {
  Quality,
  QUALITY_TIERS,
  parseQualityOverride,
  resolveQuality,
  type DeviceProfile,
} from "@/game/render/perf/quality";
import { fovForSpeed } from "@/game/render/CameraRig";
import { createEventDrain } from "@/game/render/events";
import { createEventRing, emit, SimEvent } from "@/game/sim/events";

function profile(partial: Partial<DeviceProfile> = {}): DeviceProfile {
  return { deviceMemory: 8, cores: 8, coarsePointer: false, override: null, ...partial };
}

describe("quality detection", () => {
  it("an explicit override always wins", () => {
    expect(resolveQuality(profile({ override: Quality.Low, deviceMemory: 64, cores: 32 }))).toBe(
      Quality.Low,
    );
    expect(resolveQuality(profile({ override: Quality.High, coarsePointer: true }))).toBe(
      Quality.High,
    );
  });

  it("a touchscreen drops to LOW", () => {
    expect(resolveQuality(profile({ coarsePointer: true }))).toBe(Quality.Low);
  });

  it("weak memory or few cores drops to LOW", () => {
    expect(resolveQuality(profile({ deviceMemory: 2 }))).toBe(Quality.Low);
    expect(resolveQuality(profile({ cores: 2 }))).toBe(Quality.Low);
  });

  it("strong hardware with a fine pointer gets HIGH", () => {
    expect(resolveQuality(profile({ deviceMemory: 16, cores: 12 }))).toBe(Quality.High);
  });

  it("errs toward MEDIUM when the signals are missing", () => {
    // deviceMemory is Chromium-only, so Safari and Firefox report 0. Guessing
    // HIGH there would give a weak Mac a 20fps first impression.
    expect(resolveQuality(profile({ deviceMemory: 0, cores: 8 }))).toBe(Quality.Medium);
    expect(resolveQuality(profile({ deviceMemory: 0, cores: 0 }))).toBe(Quality.Medium);
  });

  it("parses the URL override case-insensitively and ignores junk", () => {
    expect(parseQualityOverride("low")).toBe(Quality.Low);
    expect(parseQualityOverride("HIGH")).toBe(Quality.High);
    expect(parseQualityOverride("ultra")).toBeNull();
    expect(parseQualityOverride(null)).toBeNull();
    expect(parseQualityOverride(undefined)).toBeNull();
  });
});

describe("quality tiers", () => {
  it("LOW turns shadows off entirely", () => {
    const low = QUALITY_TIERS[Quality.Low];
    expect(low.shadows).toBe(false);
    expect(low.shadowMapSize).toBe(0);
  });

  it("shadow map size increases with tier", () => {
    expect(QUALITY_TIERS[Quality.Medium].shadowMapSize).toBeLessThan(
      QUALITY_TIERS[Quality.High].shadowMapSize,
    );
  });

  it("every tier respects the locked pixel ratio cap", () => {
    for (const tier of Object.values(QUALITY_TIERS)) {
      expect(tier.pixelRatioCap).toBeLessThanOrEqual(TUNING.camera.pixelRatioCap);
    }
  });

  it("LOW and MEDIUM are held to the mobile draw-call budget", () => {
    expect(QUALITY_TIERS[Quality.Low].drawCallBudget).toBe(TUNING.budgets.drawCallsMobile);
    expect(QUALITY_TIERS[Quality.Medium].drawCallBudget).toBe(TUNING.budgets.drawCallsMobile);
    expect(QUALITY_TIERS[Quality.High].drawCallBudget).toBe(TUNING.budgets.drawCallsDesktop);
  });

  it("LOW submits less tunnel geometry", () => {
    expect(QUALITY_TIERS[Quality.Low].tunnelSegments).toBeLessThan(
      QUALITY_TIERS[Quality.High].tunnelSegments,
    );
  });
});

describe("the speed to FOV curve", () => {
  it("is the base FOV at baseSpeed", () => {
    expect(fovForSpeed(TUNING.speed.baseSpeed)).toBeCloseTo(TUNING.camera.cameraFov, 9);
  });

  it("reaches 82 degrees at maxSpeed", () => {
    // Raised from the documented 70 at P05 with explicit approval — FOV widening
    // is most of what carries speed at a flat-shaded art direction. TUNING.md §13
    // was widened to match rather than the value silently exceeding its range.
    expect(fovForSpeed(TUNING.speed.maxSpeed)).toBeCloseTo(82, 9);
  });

  it("clamps below baseSpeed and above maxSpeed", () => {
    expect(fovForSpeed(0)).toBeCloseTo(TUNING.camera.cameraFov, 9);
    expect(fovForSpeed(1000)).toBeCloseTo(82, 9);
  });

  it("is monotonic", () => {
    let previous = -Infinity;
    for (let speed = 0; speed <= 40; speed += 0.5) {
      const fov = fovForSpeed(speed);
      expect(fov).toBeGreaterThanOrEqual(previous);
      previous = fov;
    }
  });
});

describe("the event drain", () => {
  it("delivers each event exactly once", () => {
    const ring = createEventRing();
    const drain = createEventDrain();
    const seen: number[] = [];
    drain.subscribe((e) => seen.push(e.type));

    emit(ring, SimEvent.Jump, 1);
    emit(ring, SimEvent.Land, 2);
    drain.drain(ring);
    drain.drain(ring);

    expect(seen).toEqual([SimEvent.Jump, SimEvent.Land]);
  });

  it("carries the payload through", () => {
    const ring = createEventRing();
    const drain = createEventDrain();
    let captured = { p0: 0, p1: 0 };
    drain.subscribe((e) => {
      captured = { p0: e.payload0, p1: e.payload1 };
    });

    emit(ring, SimEvent.RollEnd, 5, 2, 1, -1);
    drain.drain(ring);

    expect(captured.p0).toBe(2);
    expect(captured.p1).toBe(1);
  });

  it("supports several independent consumers", () => {
    // Render and audio drain at different rates; neither may consume the other's
    // events. This is why the ring holds no cursor of its own.
    const ring = createEventRing();
    const render = createEventDrain();
    const audio = createEventDrain();
    let renderCount = 0;
    let audioCount = 0;
    render.subscribe(() => (renderCount += 1));
    audio.subscribe(() => (audioCount += 1));

    emit(ring, SimEvent.Coin, 1);
    render.drain(ring);
    emit(ring, SimEvent.Coin, 2);
    render.drain(ring);
    audio.drain(ring);

    expect(renderCount).toBe(2);
    expect(audioCount).toBe(2);
  });

  it("reports events lost to a slow consumer rather than hiding them", () => {
    const ring = createEventRing();
    const drain = createEventDrain();
    drain.subscribe(() => undefined);

    for (let i = 0; i < TUNING.pools.maxEvents * 2; i += 1) {
      emit(ring, SimEvent.Coin, i);
    }
    drain.drain(ring);

    expect(drain.missed).toBeGreaterThan(0);
  });

  it("unsubscribe stops delivery", () => {
    const ring = createEventRing();
    const drain = createEventDrain();
    let count = 0;
    const off = drain.subscribe(() => (count += 1));

    emit(ring, SimEvent.Jump, 1);
    drain.drain(ring);
    off();
    emit(ring, SimEvent.Jump, 2);
    drain.drain(ring);

    expect(count).toBe(1);
  });

  it("reset rewinds the cursor", () => {
    const ring = createEventRing();
    const drain = createEventDrain();
    let count = 0;
    drain.subscribe(() => (count += 1));

    emit(ring, SimEvent.Jump, 1);
    drain.drain(ring);
    expect(count).toBe(1);

    drain.reset();
    drain.drain(ring);
    expect(count).toBe(2);
  });
});
