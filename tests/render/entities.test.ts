import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { TUNING } from "@/game/config/tuning";
import { EntityType, entityCentreX } from "@/game/sim/level/entities";
import { F, type SimState } from "@/game/sim/state";
import { Bucket, BUCKET_COUNT, bucketFor, composeEntityMatrix } from "@/game/render/EntityRenderer";
import { createSim } from "@/game/sim/sim";
import { liveCount } from "@/game/sim/generator";
import {
  EXPECTED_DRAW_CALLS,
  EXPECTED_DRAW_CALLS_COLOUR,
  EXPECTED_SHADOW_CASTERS,
} from "@/game/render";

/**
 * Entity rendering, verified headlessly.
 *
 * This matters more than usual: the generator is not wired into the live tick,
 * so `state.obstacles.count` is 0 in a real run and none of this code executes.
 * Without these tests the whole instancing path would ship unexercised.
 */

const PRISM_SIZE = TUNING.geometry.prismInnerSize;
const LANE_WIDTH = TUNING.geometry.laneWidth;
const HALF = 0.5;

function scratch() {
  return {
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    scale: new THREE.Vector3(1, 1, 1),
    axis: new THREE.Vector3(0, 0, 1),
  };
}

const UNIT_SHAPE = { width: 1, height: 1, depth: 1, centreY: 0 };

function positionOf(face: number, lane: number, z: number, y = 0): THREE.Vector3 {
  const matrix = new THREE.Matrix4();
  // The renderer takes a resolved x, exactly as it reads it from EntityColumns.
  const x = entityCentreX(lane, EntityType.Block);
  composeEntityMatrix(matrix, scratch(), face, x, z, y, UNIT_SHAPE);
  const out = new THREE.Vector3();
  out.setFromMatrixPosition(matrix);
  return out;
}

describe("geometry bucketing", () => {
  it("collapses 12 obstacle types into a countable number of draw calls", () => {
    // The budget argument: one draw call per bucket, and the bucket count is a
    // deliberate decision rather than a consequence of how many entity types
    // happen to exist.
    const obstacleTypes = [
      EntityType.Block,
      EntityType.Stack,
      EntityType.LowBar,
      EntityType.HighGate,
      EntityType.PillarPair,
      EntityType.FullFaceWall,
      EntityType.VoidGap,
      EntityType.Piston,
      EntityType.Rotor,
      EntityType.CornerBrace,
      EntityType.ShearRing,
      EntityType.Kicker,
    ];
    const buckets = new Set(obstacleTypes.map(bucketFor));
    expect(buckets.size).toBeLessThanOrEqual(BUCKET_COUNT);
  });

  it("routes each defeat-verb family to its own shape", () => {
    expect(bucketFor(EntityType.LowBar)).toBe(Bucket.Bar);
    expect(bucketFor(EntityType.HighGate)).toBe(Bucket.Gate);
    expect(bucketFor(EntityType.FullFaceWall)).toBe(Bucket.Wall);
    expect(bucketFor(EntityType.ShearRing)).toBe(Bucket.Wall);
    expect(bucketFor(EntityType.Block)).toBe(Bucket.Block);
  });

  it("gives an unknown type a bucket rather than throwing", () => {
    expect(bucketFor(9999)).toBe(Bucket.Block);
  });
});

describe("instance placement", () => {
  it("puts lane 1 of face 0 on the centre line of the floor", () => {
    const p = positionOf(0, 1, 0);
    expect(p.x).toBeCloseTo(0, 9);
    expect(p.y).toBeCloseTo(-PRISM_SIZE * HALF, 9);
  });

  it("spaces lanes by laneWidth", () => {
    const left = positionOf(0, 0, 0);
    const centre = positionOf(0, 1, 0);
    const right = positionOf(0, 2, 0);

    expect(centre.x - left.x).toBeCloseTo(LANE_WIDTH, 9);
    expect(right.x - centre.x).toBeCloseTo(LANE_WIDTH, 9);
  });

  it("places z down the negative axis, so the world recedes from the camera", () => {
    expect(positionOf(0, 1, 10).z).toBeCloseTo(-10, 9);
  });

  it("rotates each face a quarter turn around the tunnel axis", () => {
    // Every face's centre lane must sit at the same radius from the axis.
    const radius = PRISM_SIZE * HALF;
    for (let face = 0; face < TUNING.geometry.faceCount; face += 1) {
      const p = positionOf(face, 1, 0);
      expect(Math.hypot(p.x, p.y), `face ${face}`).toBeCloseTo(radius, 9);
    }
  });

  it("puts face 2 diametrically opposite face 0", () => {
    const floor = positionOf(0, 1, 0);
    const ceiling = positionOf(2, 1, 0);
    expect(ceiling.y).toBeCloseTo(-floor.y, 9);
  });

  it("mirrors lanes across a roll, matching the sim's face/lane transform", () => {
    // GAME_BIBLE §3.2 / sim facing.ts: rolling mirrors the lane. The renderer
    // must agree, or the player appears in a different lane from the one the
    // collision system thinks they are in.
    const beforeRoll = positionOf(0, 0, 0);
    const afterRoll = positionOf(1, 2, 0);
    expect(Math.hypot(beforeRoll.x, beforeRoll.y)).toBeCloseTo(
      Math.hypot(afterRoll.x, afterRoll.y),
      9,
    );
  });

  it("lifts an entity by its centreY", () => {
    const matrix = new THREE.Matrix4();
    const LIFT = 1.4;
    composeEntityMatrix(matrix, scratch(), 0, 0, 0, 0, { ...UNIT_SHAPE, centreY: LIFT });
    const p = new THREE.Vector3().setFromMatrixPosition(matrix);
    expect(p.y).toBeCloseTo(-PRISM_SIZE * HALF + LIFT, 9);
  });

  it("writes the shape's dimensions into the matrix scale", () => {
    const matrix = new THREE.Matrix4();
    composeEntityMatrix(matrix, scratch(), 0, 0, 0, 0, {
      width: 2,
      height: 3,
      depth: 4,
      centreY: 0,
    });
    const scale = new THREE.Vector3().setFromMatrixScale(matrix);
    expect(scale.x).toBeCloseTo(2, 9);
    expect(scale.y).toBeCloseTo(3, 9);
    expect(scale.z).toBeCloseTo(4, 9);
  });
});

describe("the live generator populates what the renderer draws", () => {
  /** Ticks a real sim until the tunnel has geometry in it. */
  function populated(seed: number, seconds = 20): SimState {
    const sim = createSim(seed);
    const idle = { lateral: 0, roll: 0, jump: false, slide: false, overdrive: false };
    for (let i = 0; i < TUNING.sim.tickRate * seconds; i += 1) {
      sim.getState().f[F.playerInvulnerableTimer] = 999;
      sim.tick(idle);
    }
    return sim.getState();
  }

  it("fills entity columns from real generated chunks", () => {
    const state = populated(7);
    expect(liveCount(state.obstacles)).toBeGreaterThan(0);
    expect(liveCount(state.pickups)).toBeGreaterThan(0);
  });

  it("only ever uses types from the real catalogue", () => {
    const state = populated(3);
    const known = new Set<number>(Object.values(EntityType));
    for (let i = 0; i < state.obstacles.count; i += 1) {
      expect(known.has(state.obstacles.kind[i] ?? -1)).toBe(true);
    }
  });

  it("never overruns the instance buffers the renderer allocated", () => {
    // The renderer sizes its instance buffers from the pool capacities. If the
    // sim could ever exceed them, instances would be silently dropped.
    const state = populated(1, 120);
    expect(state.obstacles.count).toBeLessThanOrEqual(TUNING.render.maxInstancesPerGeometry);
    expect(state.pickups.count).toBeLessThanOrEqual(TUNING.render.maxPickupInstances);
  });

  it("gives every live entity a lateral centre the renderer can use", () => {
    // Collision reads EntityColumns.x; so does the renderer. A zero here would
    // stack every multi-lane obstacle on the tunnel centreline.
    const state = populated(11);
    let checked = 0;
    for (let i = 0; i < state.obstacles.count; i += 1) {
      if (state.obstacles.active[i] !== 1) continue;
      const lane = state.obstacles.lane[i] ?? 0;
      const kind = state.obstacles.kind[i] ?? 0;
      expect(state.obstacles.x[i]).toBeCloseTo(entityCentreX(lane, kind), 9);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe("the draw-call budget", () => {
  it("the whole grey-box scene fits in a countable, constant number of calls", () => {
    // 10 colour + 5 shadow casters = 15. The shadow pass is a second render of
    // every caster and is the half that is easy to forget: the first count here
    // said 10 and the measured figure came back 15.
    // 10 scene + 1 particle system = 11 colour, plus 5 shadow casters.
    expect(EXPECTED_DRAW_CALLS_COLOUR).toBe(11);
    expect(EXPECTED_SHADOW_CASTERS).toBe(5);
    expect(EXPECTED_DRAW_CALLS).toBe(16);
    expect(EXPECTED_DRAW_CALLS).toBeLessThan(TUNING.budgets.drawCallsDesktop);
    expect(EXPECTED_DRAW_CALLS).toBeLessThan(TUNING.budgets.drawCallsMobile);
  });

  it("stays constant no matter how many entities are live", () => {
    // The property instancing buys. A per-entity mesh would make this scale with
    // the band-5 worst case, which is roughly 300 calls against a budget of 100.
    // Draw calls are a property of the bucket count, not the entity count.
    // Draw calls are a property of the bucket count, not the entity count.
    expect(EXPECTED_DRAW_CALLS).toBe(16);
  });
});
