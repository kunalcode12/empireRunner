import { describe, expect, it } from "vitest";
import { TUNING } from "@/game/config/tuning";
import { AnimationState } from "@/game/render/interpolate";
import {
  blendDuration,
  blending,
  createBlend,
  setState,
  stepBlend,
} from "@/game/render/animation/blend";
import { blendPose, copyPose, createPose, PROPORTIONS } from "@/game/render/animation/rig";
import {
  crashClip,
  fallClip,
  idleClip,
  jumpClip,
  landClip,
  runClip,
  slideClip,
  stumbleClip,
} from "@/game/render/animation/clips";
import {
  applyProcedural,
  createProcedural,
  nearestHazardX,
} from "@/game/render/animation/procedural";
import { setMotion } from "@/game/render/feel/reducedMotion";
import { EntityType } from "@/game/sim/level/entities";
import { createState } from "@/game/sim/state";

const A = TUNING.animation;
const FRAME = 1 / 60;

describe("the run cycle never skates", () => {
  /**
   * The property: one stride of animation covers exactly one stride of ground,
   * at ANY speed. Driving the phase from distance makes this true by
   * construction, which is the whole reason it is done that way.
   */
  it("advances one full cycle per strideLength of distance", () => {
    const phaseAt = (distance: number): number => (distance / A.strideLength) % 1;

    expect(phaseAt(0)).toBeCloseTo(0, 10);
    expect(phaseAt(A.strideLength)).toBeCloseTo(0, 10);
    expect(phaseAt(A.strideLength * HALF_CYCLE)).toBeCloseTo(0.5, 10);
  });

  it("covers the same ground per cycle at 12 u/s and at 34 u/s", () => {
    // A time-driven cycle would need its rate matched by hand and would drift.
    const slow = TUNING.speed.baseSpeed;
    const fast = TUNING.speed.maxSpeed;

    function distancePerCycle(speed: number): number {
      let distance = 0;
      let phase = 0;
      let previous = 0;
      // Step until the phase wraps once.
      for (let i = 0; i < 100000; i += 1) {
        distance += speed * FRAME;
        phase = (distance / A.strideLength) % 1;
        if (phase < previous) {
          return distance;
        }
        previous = phase;
      }
      return distance;
    }

    // The wrap is detected one frame late, so each measurement overshoots by
    // up to a frame of travel. That bound is the real property: at 34 u/s a
    // frame is 0.567u, and the cycle length must not depend on speed by more
    // than that sampling artefact.
    for (const speed of [slow, fast]) {
      const measured = distancePerCycle(speed);
      const overshoot = measured - A.strideLength;
      expect(overshoot, `at ${speed} u/s`).toBeGreaterThanOrEqual(0);
      expect(overshoot, `at ${speed} u/s`).toBeLessThanOrEqual(speed * FRAME);
    }
  });

  it("puts the legs in counter-phase", () => {
    // Both legs swinging together is a hop, not a run.
    for (let phase = 0; phase < 1; phase += 0.05) {
      const pose = runClip(phase);
      expect(Math.sign(pose.legLeft) === Math.sign(pose.legRight) && pose.legLeft !== 0).toBe(
        false,
      );
    }
  });

  it("counter-swings the arms against the legs", () => {
    const pose = runClip(0.25);
    expect(Math.sign(pose.armLeft)).not.toBe(Math.sign(pose.legLeft));
  });

  it("never bends a knee backwards", () => {
    for (let phase = 0; phase < 1; phase += 0.02) {
      const pose = runClip(phase);
      expect(pose.kneeLeft).toBeGreaterThanOrEqual(0);
      expect(pose.kneeRight).toBeGreaterThanOrEqual(0);
    }
  });

  it("bobs twice per stride, once per push-off", () => {
    let crossings = 0;
    let previous = runClip(0).rootY;
    const STEPS = 400;
    for (let i = 1; i <= STEPS; i += 1) {
      const y = runClip(i / STEPS).rootY;
      if (Math.sign(y) !== Math.sign(previous) && previous !== 0) {
        crossings += 1;
      }
      previous = y;
    }
    // Two full bounces means four zero crossings.
    expect(crossings).toBe(4);
  });

  it("is continuous across the wrap", () => {
    const before = runClip(0.999);
    const after = runClip(0.001);
    expect(Math.abs(after.legLeft - before.legLeft)).toBeLessThan(0.05);
  });
});

const HALF_CYCLE = 0.5;

describe("clips are distinguishable", () => {
  it("every state produces a different silhouette", () => {
    // Clips return a SHARED scratch (see the warning in clips.ts), so each
    // result must be copied before the next call or all seven are the same
    // object. This test is how that trap was found.
    const poses = [
      runClip(0),
      jumpClip(),
      fallClip(),
      landClip(),
      slideClip(),
      crashClip(),
      idleClip(0),
    ].map(() => createPose());

    const sources = [runClip, jumpClip, fallClip, landClip, slideClip, crashClip, idleClip];
    sources.forEach((clip, i) => {
      const target = poses[i];
      if (target !== undefined) {
        copyPose(target, clip(0));
      }
    });
    const signatures = poses.map(
      (p) => `${p.torsoPitch.toFixed(3)}:${p.rootY.toFixed(3)}:${p.kneeLeft.toFixed(3)}`,
    );
    expect(new Set(signatures).size).toBe(signatures.length);
  });

  it("the slide is the lowest pose", () => {
    // It has to be: the collider collapses to 0.70u and the visual must agree.
    const slide = slideClip().rootY;
    const run = runClip(0).rootY;
    const jump = jumpClip().rootY;
    expect(slide).toBeLessThan(run);
    expect(slide).toBeLessThan(jump);
  });

  it("the jump tucks and the fall reaches — opposite leg directions", () => {
    const jumpLeg = jumpClip().legLeft;
    const fallLeg = fallClip().legLeft;
    expect(jumpLeg).toBeGreaterThan(0);
    expect(fallLeg).toBeLessThan(0);
  });

  it("the stumble actually moves", () => {
    // Copied, because clips share one scratch.
    const a = createPose();
    copyPose(a, stumbleClip(0));
    const b = createPose();
    copyPose(b, stumbleClip(0.2));
    expect(a.armLeft).not.toBeCloseTo(b.armLeft, 3);
  });
});

describe("cross-fades are per pair, not global", () => {
  it("run to jump is the fastest of the movement transitions", () => {
    const runJump = blendDuration(AnimationState.Running, AnimationState.Jumping);
    const jumpFall = blendDuration(AnimationState.Jumping, AnimationState.Falling);
    const landRun = blendDuration(AnimationState.Falling, AnimationState.Running);

    expect(runJump).toBeCloseTo(A.blendRunToJump, 10);
    expect(jumpFall).toBeCloseTo(A.blendJumpToFall, 10);
    expect(landRun).toBeCloseTo(A.blendLandToRun, 10);

    // The three prompt-specified values, and their intended ordering.
    expect(runJump).toBe(0.06);
    expect(jumpFall).toBe(0.12);
    expect(landRun).toBe(0.1);
    expect(runJump).toBeLessThan(landRun);
    expect(landRun).toBeLessThan(jumpFall);
  });

  it("a crash is near-instant from anywhere", () => {
    for (const from of Object.values(AnimationState)) {
      expect(blendDuration(from, AnimationState.Crashed)).toBe(A.blendToCrash);
    }
  });

  it("falls back to the default for unlisted pairs", () => {
    expect(blendDuration(AnimationState.Rolling, AnimationState.Stumbling)).toBe(A.blendDefault);
  });

  it("actually interpolates over the stated duration", () => {
    const blend = createBlend();
    const target = jumpClip();

    setState(blend, AnimationState.Jumping);
    expect(blending(blend)).toBe(true);

    const frames = Math.ceil(A.blendDefault / FRAME);
    for (let i = 0; i < frames; i += 1) {
      stepBlend(blend, target, FRAME);
    }
    expect(blending(blend)).toBe(false);
    expect(blend.out.kneeLeft).toBeCloseTo(target.kneeLeft, 6);
  });

  it("blends from where the body IS, not from the old clip's ideal", () => {
    // Matters when a transition is interrupted: blending from the stale ideal
    // pops, blending from the live output stays continuous.
    const blend = createBlend();
    setState(blend, AnimationState.Jumping);
    stepBlend(blend, jumpClip(), FRAME);
    const midway = blend.out.kneeLeft;

    setState(blend, AnimationState.Falling);
    expect(blend.from.kneeLeft).toBeCloseTo(midway, 10);
  });

  it("re-entering the same state does not restart the fade", () => {
    const blend = createBlend();
    setState(blend, AnimationState.Jumping);
    stepBlend(blend, jumpClip(), FRAME);
    const elapsed = blend.elapsed;
    setState(blend, AnimationState.Jumping);
    expect(blend.elapsed).toBe(elapsed);
  });
});

describe("pose blending", () => {
  it("hits both endpoints exactly", () => {
    const a = createPose();
    copyPose(a, runClip(0));
    const b = createPose();
    copyPose(b, jumpClip());
    const out = createPose();

    blendPose(out, a, b, 0);
    expect(out.kneeLeft).toBeCloseTo(a.kneeLeft, 10);

    blendPose(out, a, b, 1);
    expect(out.kneeLeft).toBeCloseTo(b.kneeLeft, 10);
  });

  it("clamps out-of-range t", () => {
    const a = createPose();
    copyPose(a, runClip(0));
    const b = createPose();
    copyPose(b, jumpClip());
    const out = createPose();
    blendPose(out, a, b, 5);
    expect(out.kneeLeft).toBeCloseTo(b.kneeLeft, 10);
  });
});

describe("the procedural layer", () => {
  it("banks INTO a lane change, not away from it", () => {
    // A runner cutting left drops their left shoulder, like a motorcycle.
    const state = createProcedural();
    const pose = createPose();
    for (let i = 0; i < 60; i += 1) {
      pose.torsoRoll = 0;
      applyProcedural(state, pose, {
        laneBias: 1,
        worldRoll: 0,
        playerX: 0,
        hazardX: Number.NaN,
        dt: FRAME,
      });
    }
    expect(pose.torsoRoll).toBeLessThan(0);
  });

  it("counter-rotates the torso only while the roll is TURNING", () => {
    const state = createProcedural();
    const pose = createPose();

    // A roll in progress: the world angle is changing.
    let roll = 0;
    for (let i = 0; i < 10; i += 1) {
      roll += 0.15;
      pose.torsoYaw = 0;
      applyProcedural(state, pose, {
        laneBias: 0,
        worldRoll: roll,
        playerX: 0,
        hazardX: Number.NaN,
        dt: FRAME,
      });
    }
    const during = Math.abs(pose.torsoYaw);
    expect(during).toBeGreaterThan(0.01);

    // Roll complete: the angle stops changing, so the twist unwinds.
    for (let i = 0; i < 120; i += 1) {
      pose.torsoYaw = 0;
      applyProcedural(state, pose, {
        laneBias: 0,
        worldRoll: roll,
        playerX: 0,
        hazardX: Number.NaN,
        dt: FRAME,
      });
    }
    expect(Math.abs(pose.torsoYaw)).toBeLessThan(during * 0.1);
  });

  it("turns the head toward a hazard and centres it when there is none", () => {
    const state = createProcedural();
    const pose = createPose();

    for (let i = 0; i < 90; i += 1) {
      pose.headYaw = 0;
      applyProcedural(state, pose, {
        laneBias: 0,
        worldRoll: 0,
        playerX: 0,
        hazardX: TUNING.geometry.laneWidth * 2,
        dt: FRAME,
      });
    }
    expect(pose.headYaw).toBeGreaterThan(0.05);

    for (let i = 0; i < 180; i += 1) {
      pose.headYaw = 0;
      applyProcedural(state, pose, {
        laneBias: 0,
        worldRoll: 0,
        playerX: 0,
        hazardX: Number.NaN,
        dt: FRAME,
      });
    }
    expect(Math.abs(pose.headYaw)).toBeLessThan(0.02);
  });

  it("head tracking survives reduced motion at half strength", () => {
    // It points at the hazard, so it is information, not decoration.
    function settle(reduced: boolean): number {
      setMotion(reduced);
      const state = createProcedural();
      const pose = createPose();
      for (let i = 0; i < 200; i += 1) {
        pose.headYaw = 0;
        applyProcedural(state, pose, {
          laneBias: 0,
          worldRoll: 0,
          playerX: 0,
          hazardX: TUNING.geometry.laneWidth * 3,
          dt: FRAME,
        });
      }
      return Math.abs(pose.headYaw);
    }

    const full = settle(false);
    const reduced = settle(true);
    setMotion(false);

    expect(reduced).toBeGreaterThan(0);
    expect(reduced).toBeLessThan(full);
  });

  it("is additive, so a clip's own roll survives", () => {
    const state = createProcedural();
    const pose = createPose();
    pose.torsoRoll = 0.5;
    applyProcedural(state, pose, {
      laneBias: 0,
      worldRoll: 0,
      playerX: 0,
      hazardX: Number.NaN,
      dt: FRAME,
    });
    expect(pose.torsoRoll).toBeCloseTo(0.5, 6);
  });
});

describe("hazard selection", () => {
  function addObstacle(
    state: ReturnType<typeof createState>,
    kind: number,
    face: number,
    x: number,
    z: number,
  ): void {
    const i = state.obstacles.count;
    state.obstacles.active[i] = 1;
    state.obstacles.kind[i] = kind;
    state.obstacles.face[i] = face;
    state.obstacles.x[i] = x;
    state.obstacles.z[i] = z;
    state.obstacles.count = i + 1;
  }

  it("picks the nearest fatal obstacle ahead on the player's own face", () => {
    const state = createState();
    addObstacle(state, EntityType.Stack, 0, 5, 15);
    addObstacle(state, EntityType.Stack, 0, -3, 6);
    expect(nearestHazardX(state.obstacles, 0)).toBe(-3);
  });

  it("ignores other faces", () => {
    const state = createState();
    addObstacle(state, EntityType.Stack, 1, 9, 4);
    expect(Number.isNaN(nearestHazardX(state.obstacles, 0))).toBe(true);
  });

  it("ignores things already behind the player", () => {
    const state = createState();
    addObstacle(state, EntityType.Stack, 0, 4, -3);
    expect(Number.isNaN(nearestHazardX(state.obstacles, 0))).toBe(true);
  });

  it("ignores non-fatal entities — a Kicker is not something to look at", () => {
    const state = createState();
    addObstacle(state, EntityType.Kicker, 0, 4, 5);
    expect(Number.isNaN(nearestHazardX(state.obstacles, 0))).toBe(true);
  });

  it("ignores anything past the tracking range", () => {
    const state = createState();
    addObstacle(state, EntityType.Stack, 0, 4, A.headTrackRange + 10);
    expect(Number.isNaN(nearestHazardX(state.obstacles, 0))).toBe(true);
  });
});

describe("proportions are honest about the hitbox", () => {
  it("the rig is exactly playerHeightStand tall", () => {
    expect(PROPORTIONS.totalHeight).toBe(TUNING.geometry.playerHeightStand);
  });

  it("limb lengths reach the ground from the hip", () => {
    // hip height must equal thigh + shin, or the feet float or clip.
    expect(PROPORTIONS.upperLimb + PROPORTIONS.lowerLimb).toBeCloseTo(PROPORTIONS.hipHeight, 6);
  });
});
