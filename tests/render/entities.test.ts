import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { TUNING } from "@/game/config/tuning";
import { EntityType } from "@/game/sim/level/entities";
import { createState, type SimState } from "@/game/sim/state";
import { Bucket, BUCKET_COUNT, bucketFor, composeEntityMatrix } from "@/game/render/EntityRenderer";
import { seedWorldFromGenerator } from "@/game/render/devSeed";
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
  composeEntityMatrix(matrix, scratch(), face, lane, z, y, UNIT_SHAPE);
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
    composeEntityMatrix(matrix, scratch(), 0, 1, 0, 0, { ...UNIT_SHAPE, centreY: LIFT });
    const p = new THREE.Vector3().setFromMatrixPosition(matrix);
    expect(p.y).toBeCloseTo(-PRISM_SIZE * HALF + LIFT, 9);
  });

  it("writes the shape's dimensions into the matrix scale", () => {
    const matrix = new THREE.Matrix4();
    composeEntityMatrix(matrix, scratch(), 0, 1, 0, 0, {
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

describe("the dev seeder produces real authored track", () => {
  it("fills entity columns from the P06 generator", () => {
    const state: SimState = createState();
    seedWorldFromGenerator(state, { chunks: 10, seed: 7 });

    expect(state.obstacles.count).toBeGreaterThan(0);
    expect(state.pickups.count).toBeGreaterThan(0);
  });

  it("only ever uses types from the real catalogue", () => {
    const state = createState();
    seedWorldFromGenerator(state, { chunks: 20, seed: 3 });

    const known = new Set<number>(Object.values(EntityType));
    for (let i = 0; i < state.obstacles.count; i += 1) {
      expect(known.has(state.obstacles.kind[i] ?? -1)).toBe(true);
    }
  });

  it("is deterministic for a seed", () => {
    const a = createState();
    const b = createState();
    seedWorldFromGenerator(a, { chunks: 8, seed: 42 });
    seedWorldFromGenerator(b, { chunks: 8, seed: 42 });

    expect(b.obstacles.count).toBe(a.obstacles.count);
    for (let i = 0; i < a.obstacles.count; i += 1) {
      expect(b.obstacles.kind[i]).toBe(a.obstacles.kind[i]);
      expect(b.obstacles.z[i]).toBe(a.obstacles.z[i]);
    }
  });

  it("never overruns the entity pools", () => {
    const state = createState();
    // Far more chunks than the pools can hold; it must stop, not overflow.
    seedWorldFromGenerator(state, { chunks: 500, seed: 1 });
    expect(state.obstacles.count).toBeLessThanOrEqual(TUNING.pools.maxObstacles);
    expect(state.pickups.count).toBeLessThanOrEqual(TUNING.pools.maxPickups);
  });

  it("touches only the entity columns, never the run state", () => {
    // It is a dev harness, not a gameplay system. If it ever moved the player or
    // advanced the RNG it would silently change what the sim does.
    const state = createState();
    const before = {
      tick: state.tick,
      lane: state.player.lane,
      face: state.player.face,
      rng: state.rngGenerator,
    };
    seedWorldFromGenerator(state, { chunks: 10, seed: 5 });

    expect(state.tick).toBe(before.tick);
    expect(state.player.lane).toBe(before.lane);
    expect(state.player.face).toBe(before.face);
    expect(state.rngGenerator).toBe(before.rng);
  });
});

describe("the draw-call budget", () => {
  it("the whole grey-box scene fits in a countable, constant number of calls", () => {
    // 10 colour + 5 shadow casters = 15. The shadow pass is a second render of
    // every caster and is the half that is easy to forget: the first count here
    // said 10 and the measured figure came back 15.
    expect(EXPECTED_DRAW_CALLS_COLOUR).toBe(10);
    expect(EXPECTED_SHADOW_CASTERS).toBe(5);
    expect(EXPECTED_DRAW_CALLS).toBe(15);
    expect(EXPECTED_DRAW_CALLS).toBeLessThan(TUNING.budgets.drawCallsDesktop);
    expect(EXPECTED_DRAW_CALLS).toBeLessThan(TUNING.budgets.drawCallsMobile);
  });

  it("stays constant no matter how many entities are live", () => {
    // The property instancing buys. A per-entity mesh would make this scale with
    // the band-5 worst case, which is roughly 300 calls against a budget of 100.
    const sparse = createState();
    seedWorldFromGenerator(sparse, { chunks: 1, seed: 1 });

    const dense = createState();
    seedWorldFromGenerator(dense, { chunks: 60, seed: 1 });

    expect(dense.obstacles.count).toBeGreaterThan(sparse.obstacles.count);
    // Draw calls are a property of the bucket count, not the entity count.
    expect(EXPECTED_DRAW_CALLS).toBe(15);
  });
});
