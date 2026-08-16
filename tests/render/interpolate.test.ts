import { describe, expect, it } from "vitest";
import { TUNING } from "@/game/config/tuning";
import { createSim } from "@/game/sim/sim";
import { createState, F, Phase } from "@/game/sim/state";
import {
  AnimationState,
  animationForPhase,
  createRenderView,
  damp,
  lerp,
  lerpAngle,
  readInterpolated,
  saturate,
} from "@/game/render/interpolate";

const TICK_RATE = TUNING.sim.tickRate;
const DT = TUNING.sim.fixedDelta;

function idle() {
  return { lateral: 0, roll: 0, jump: false, slide: false, overdrive: false };
}

describe("scalar helpers", () => {
  it("lerp hits both endpoints exactly", () => {
    expect(lerp(2, 8, 0)).toBe(2);
    expect(lerp(2, 8, 1)).toBe(8);
    expect(lerp(2, 8, 0.5)).toBe(5);
  });

  it("saturate clamps", () => {
    expect(saturate(-3)).toBe(0);
    expect(saturate(3)).toBe(1);
    expect(saturate(0.25)).toBe(0.25);
  });
});

describe("lerpAngle takes the shortest path", () => {
  it("wraps rather than unwinding the long way", () => {
    // From +170deg to -170deg is 20deg forward, not 340deg back.
    const from = (170 * Math.PI) / 180;
    const to = (-170 * Math.PI) / 180;
    const mid = lerpAngle(from, to, 0.5);
    // The midpoint should be near +180deg, not near 0.
    expect(Math.abs(Math.abs(mid) - Math.PI)).toBeLessThan(0.1);
  });

  it("REGRESSION: the roll folding back to 0 does not sweep backwards", () => {
    // `stepRoll` zeroes `playerRoll` on the tick a roll completes, so previous
    // holds ~90deg and current holds 0. A naive lerp sweeps the camera through
    // the entire 90deg the wrong way in a single frame, at the exact moment the
    // player is watching the roll land.
    const QUARTER = Math.PI / 2;
    const halfway = lerpAngle(QUARTER, 0, 0.5);
    // Shortest path from 90deg to 0 is 45deg, and critically it must not pass
    // through anything larger than 90deg.
    expect(halfway).toBeCloseTo(QUARTER / 2, 6);
    expect(Math.abs(halfway)).toBeLessThanOrEqual(QUARTER);
  });
});

describe("damp is frame-rate independent", () => {
  /**
   * The property that matters: the same elapsed wall time produces the same
   * result regardless of how many frames it was split across. A naive
   * `lerp(x, target, k)` fails this badly — it converges roughly 2.4x faster at
   * 144Hz than at 60Hz, so the camera is measurably stiffer on better hardware.
   */
  function converge(fps: number, seconds: number, rate: number): number {
    const step = 1 / fps;
    let value = 0;
    for (let i = 0; i < fps * seconds; i += 1) {
      value = damp(value, 1, rate, step);
    }
    return value;
  }

  it("reaches the same value at 30, 60 and 144 fps", () => {
    const RATE = 8;
    const at30 = converge(30, 2, RATE);
    const at60 = converge(60, 2, RATE);
    const at144 = converge(144, 2, RATE);

    expect(at60).toBeCloseTo(at30, 4);
    expect(at144).toBeCloseTo(at60, 4);
  });

  it("a naive per-frame lerp would NOT have", () => {
    // Demonstrates the bug being avoided, so nobody "simplifies" damp away.
    function naive(fps: number, seconds: number, k: number): number {
      let value = 0;
      for (let i = 0; i < fps * seconds; i += 1) {
        value += (1 - value) * k;
      }
      return value;
    }
    expect(naive(144, 0.1, 0.1)).not.toBeCloseTo(naive(60, 0.1, 0.1), 2);
  });

  it("converges toward the target and never overshoots", () => {
    let value = 0;
    for (let i = 0; i < 500; i += 1) {
      value = damp(value, 10, 5, DT);
      expect(value).toBeLessThanOrEqual(10);
    }
    expect(value).toBeCloseTo(10, 3);
  });

  it("a zero or negative rate snaps rather than dividing by zero", () => {
    expect(damp(0, 5, 0, DT)).toBe(5);
    expect(damp(0, 5, -1, DT)).toBe(5);
  });
});

describe("readInterpolated", () => {
  it("returns previous at alpha 0 and current at alpha 1", () => {
    const previous = createState();
    const current = createState();
    previous.f[F.playerX] = 1;
    current.f[F.playerX] = 3;
    previous.f[F.distance] = 100;
    current.f[F.distance] = 200;

    const view = createRenderView();

    readInterpolated(view, previous, current, 0);
    expect(view.x).toBe(1);
    expect(view.distance).toBe(100);

    readInterpolated(view, previous, current, 1);
    expect(view.x).toBe(3);
    expect(view.distance).toBe(200);
  });

  it("blends at the midpoint", () => {
    const previous = createState();
    const current = createState();
    previous.f[F.playerY] = 0;
    current.f[F.playerY] = 2;

    const view = readInterpolated(createRenderView(), previous, current, 0.5);
    expect(view.y).toBe(1);
  });

  it("clamps an out-of-range alpha rather than extrapolating", () => {
    const previous = createState();
    const current = createState();
    previous.f[F.playerX] = 0;
    current.f[F.playerX] = 1;

    expect(readInterpolated(createRenderView(), previous, current, 2).x).toBe(1);
    expect(readInterpolated(createRenderView(), previous, current, -1).x).toBe(0);
  });

  it("takes discrete values from current, not blended", () => {
    // Blending a lane index would put the player between lanes; blending a phase
    // would produce a phase that does not exist.
    const previous = createState();
    const current = createState();
    previous.player.lane = 0;
    current.player.lane = 2;
    previous.player.phase = Phase.Running;
    current.player.phase = Phase.Jumping;

    const view = readInterpolated(createRenderView(), previous, current, 0.5);
    expect(view.lane).toBe(2);
    expect(view.phase).toBe(Phase.Jumping);
  });

  it("allocates nothing — the view is reused", () => {
    const previous = createState();
    const current = createState();
    const view = createRenderView();
    expect(readInterpolated(view, previous, current, 0.5)).toBe(view);
  });
});

describe("interpolation is what removes the stutter", () => {
  /**
   * The concrete failure this exists to prevent. At `maxSpeed` the world moves
   * 0.567u per tick. On a 144Hz display that is 2.4 frames per tick, so drawing
   * raw `current` holds still for two frames then jumps — a visible judder at
   * the speed the game is most demanding.
   */
  it("produces strictly monotonic distance across sub-tick frames", () => {
    const sim = createSim(1);
    for (let i = 0; i < TICK_RATE * 30; i += 1) {
      sim.tick(idle());
    }

    const view = createRenderView();
    const samples: number[] = [];
    const SUB_FRAMES = 10;
    for (let i = 0; i <= SUB_FRAMES; i += 1) {
      readInterpolated(view, sim.getPrevious(), sim.getState(), i / SUB_FRAMES);
      samples.push(view.distance);
    }

    for (let i = 1; i < samples.length; i += 1) {
      expect(samples[i] ?? 0).toBeGreaterThan(samples[i - 1] ?? 0);
    }
  });

  it("spans exactly one tick of motion between alpha 0 and 1", () => {
    const sim = createSim(2);
    for (let i = 0; i < 600; i += 1) {
      sim.tick(idle());
    }

    const view = createRenderView();
    const atZero = readInterpolated(view, sim.getPrevious(), sim.getState(), 0).distance;
    const atOne = readInterpolated(view, sim.getPrevious(), sim.getState(), 1).distance;

    const expected = (sim.getState().f[F.worldSpeed] ?? 0) * DT;
    expect(atOne - atZero).toBeCloseTo(expected, 9);
  });
});

describe("animation state", () => {
  it("maps every phase to a distinct state", () => {
    const seen = new Set<string>();
    for (const phase of Object.values(Phase)) {
      seen.add(animationForPhase(phase));
    }
    expect(seen.size).toBe(Object.keys(Phase).length);
  });

  it("falls back to running for an unknown phase", () => {
    expect(animationForPhase(99)).toBe(AnimationState.Running);
  });

  it("is derived from the sim, not invented", () => {
    expect(animationForPhase(Phase.Sliding)).toBe(AnimationState.Sliding);
    expect(animationForPhase(Phase.Crashed)).toBe(AnimationState.Crashed);
  });
});
