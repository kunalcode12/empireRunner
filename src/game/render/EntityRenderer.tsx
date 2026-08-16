"use client";

/**
 * Every obstacle and pickup, through `InstancedMesh`.
 *
 * ## The budget maths, which is why this is instanced and not a component tree
 *
 * Band 5 runs 18 obstacles per 100m over 240u of live track — about 43 live
 * obstacles, plus up to a few hundred Bits. One mesh each is ~300 draw calls
 * against a budget of **100**. The declarative version (`entities.map(e => <mesh/>)`)
 * is also 300 React elements reconciling every time the set changes.
 *
 * Instanced, the entire entity population is **one draw call per geometry type**
 * — currently five — regardless of whether there are 3 entities on screen or 300.
 * Coins in particular are a single instanced mesh no matter the count, which is
 * the specific case the budget cannot survive any other way.
 *
 * ## Geometry buckets, not entity types
 *
 * Instancing keys on *geometry*, so several entity types share a bucket when they
 * are the same shape at a different scale. `EntityType` has 12 obstacles; they
 * collapse to four boxes and a coin. P07 replaces the grey-box shapes with real
 * ones and may need more buckets — the cost of a bucket is exactly one draw call,
 * so that is a deliberate, countable decision rather than an accident.
 *
 * ## Unused instances are collapsed, not removed
 *
 * `InstancedMesh` has a fixed `count`. Shrinking it per frame would make the draw
 * call count depend on gameplay, so instead every buffer stays at full capacity
 * and unused slots get a zero-scale matrix. A zero-scale instance rasterises no
 * pixels; it costs a matrix write and nothing else.
 */

import { useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { TUNING } from "@/game/config/tuning";
import { EntityType } from "@/game/sim/level/entities";
import type { EntityColumns, SimState } from "@/game/sim/state";
import { OBSTACLE_COLOR, PICKUP_COLOR } from "./palette";

const PRISM_SIZE = TUNING.geometry.prismInnerSize;
const LANE_WIDTH = TUNING.geometry.laneWidth;
const MAX_OBSTACLE_INSTANCES = TUNING.render.maxInstancesPerGeometry;
const MAX_PICKUP_INSTANCES = TUNING.render.maxPickupInstances;
const LOW_BAR_CLEARANCE = TUNING.slide.lowBarClearance;
const HIGH_GATE_CLEARANCE = TUNING.slide.highGateClearance;

const HALF = 0.5;
const QUARTER_TURN = Math.PI / 2;

/** Geometry buckets. One instanced draw call each. */
export const Bucket = {
  /** Single-lane solids: Block, Stack, Piston, Rotor, Kicker, Corner Brace. */
  Block: 0,
  /** Face-spanning low obstacle you jump: High Gate. */
  Gate: 1,
  /** Face-spanning hanging obstacle you slide under: Low Bar. */
  Bar: 2,
  /** Face-spanning full blockers: Full-Face Wall, Shear Ring, Pillar Pair. */
  Wall: 3,
} as const;
export type BucketValue = (typeof Bucket)[keyof typeof Bucket];

export const BUCKET_COUNT = 4;

/** Maps an entity type to its geometry bucket. */
export function bucketFor(type: number): BucketValue {
  switch (type) {
    case EntityType.HighGate:
      return Bucket.Gate;
    case EntityType.LowBar:
      return Bucket.Bar;
    case EntityType.FullFaceWall:
    case EntityType.ShearRing:
    case EntityType.PillarPair:
      return Bucket.Wall;
    default:
      return Bucket.Block;
  }
}

/** Grey-box dimensions per bucket, in world units. P07 replaces these. */
interface BucketShape {
  width: number;
  height: number;
  depth: number;
  /** u — centre height above the face. */
  centreY: number;
}

const FULL_FACE_WIDTH = LANE_WIDTH * TUNING.geometry.laneCount;
const BLOCK_SIZE = 1.0;
const BAR_THICKNESS = 0.35;
const WALL_HEIGHT = PRISM_SIZE * HALF;
const ENTITY_DEPTH = 1.0;

const BUCKET_SHAPES: readonly BucketShape[] = [
  // Block — a single-lane cube sitting on the floor.
  { width: BLOCK_SIZE, height: BLOCK_SIZE, depth: BLOCK_SIZE, centreY: BLOCK_SIZE * HALF },
  // Gate — stands from the floor to `highGateClearance`. Jump it.
  {
    width: FULL_FACE_WIDTH,
    height: HIGH_GATE_CLEARANCE,
    depth: ENTITY_DEPTH,
    centreY: HIGH_GATE_CLEARANCE * HALF,
  },
  // Bar — hangs from `lowBarClearance` upward. Slide under it.
  {
    width: FULL_FACE_WIDTH,
    height: BAR_THICKNESS,
    depth: ENTITY_DEPTH,
    centreY: LOW_BAR_CLEARANCE + BAR_THICKNESS * HALF,
  },
  // Wall — the whole face, floor to ceiling. Roll, or die.
  {
    width: FULL_FACE_WIDTH,
    height: WALL_HEIGHT,
    depth: ENTITY_DEPTH,
    centreY: WALL_HEIGHT * HALF,
  },
];

/** u — lateral centre of a lane, matching `sim/player/facing.ts`. */
function laneCentreX(lane: number): number {
  return (lane - (TUNING.geometry.laneCount - 1) * HALF) * LANE_WIDTH;
}

export interface EntityRendererHandle {
  /**
   * Rewrites every instance matrix from the given sim state.
   *
   * Reads `state.obstacles` and `state.pickups` and writes nothing back. The
   * entity columns are struct-of-arrays, so this is a linear walk over typed
   * arrays with no per-entity object anywhere.
   */
  update(state: SimState): void;
  /** Live instance counts per bucket, plus pickups. Diagnostic and test hook. */
  readonly counts: { readonly buckets: readonly number[]; readonly pickups: number };
}

export interface EntityRendererProps {
  handleRef: React.MutableRefObject<EntityRendererHandle | null>;
}

/**
 * Composes the per-instance transform for one entity into `matrix`.
 *
 * Exported so the headless tests can assert placement without a WebGL context —
 * which matters, because the generator is not wired into the live tick yet and
 * this is otherwise unexercised code.
 */
export function composeEntityMatrix(
  matrix: THREE.Matrix4,
  scratch: {
    position: THREE.Vector3;
    quaternion: THREE.Quaternion;
    scale: THREE.Vector3;
    axis: THREE.Vector3;
  },
  face: number,
  lane: number,
  z: number,
  y: number,
  shape: BucketShape,
): void {
  // Position within the face's own frame: lane across, height up from the floor,
  // and the floor itself half a prism below the tunnel axis.
  scratch.position.set(laneCentreX(lane), -PRISM_SIZE * HALF + shape.centreY + y, -z);

  // Then rotate the whole thing onto its face. Same convention as Tunnel.tsx:
  // face index times a quarter turn about the tunnel axis.
  scratch.quaternion.setFromAxisAngle(scratch.axis, face * QUARTER_TURN);
  scratch.position.applyQuaternion(scratch.quaternion);

  scratch.scale.set(shape.width, shape.height, shape.depth);
  matrix.compose(scratch.position, scratch.quaternion, scratch.scale);
}

/** The zero-scale matrix used to hide an unused instance slot. */
export function hideInstance(matrix: THREE.Matrix4): void {
  matrix.makeScale(0, 0, 0);
}

export function EntityRenderer({ handleRef }: EntityRendererProps): React.ReactElement {
  const obstacleRefs = useRef<(THREE.InstancedMesh | null)[]>([]);
  const pickupRef = useRef<THREE.InstancedMesh | null>(null);

  // A unit box per bucket, scaled per instance. One shared geometry would be
  // enough, but a separate one per bucket keeps the option of giving each a real
  // shape at P07 without restructuring anything here.
  const geometries = useMemo(() => BUCKET_SHAPES.map(() => new THREE.BoxGeometry(1, 1, 1)), []);

  const pickupGeometry = useMemo(() => {
    const COIN_RADIUS = 0.22;
    const COIN_THICKNESS = 0.06;
    const COIN_SEGMENTS = 10;
    const coin = new THREE.CylinderGeometry(
      COIN_RADIUS,
      COIN_RADIUS,
      COIN_THICKNESS,
      COIN_SEGMENTS,
    );
    // Stand it upright, facing down the tunnel.
    coin.rotateX(QUARTER_TURN);
    return coin;
  }, []);

  const obstacleMaterial = useMemo(
    () => new THREE.MeshLambertMaterial({ color: new THREE.Color(OBSTACLE_COLOR) }),
    [],
  );
  const pickupMaterial = useMemo(
    () => new THREE.MeshLambertMaterial({ color: new THREE.Color(PICKUP_COLOR) }),
    [],
  );

  useLayoutEffect(() => {
    const geos = geometries;
    const coin = pickupGeometry;
    const obstacleMat = obstacleMaterial;
    const pickupMat = pickupMaterial;
    return () => {
      for (const geometry of geos) {
        geometry.dispose();
      }
      coin.dispose();
      obstacleMat.dispose();
      pickupMat.dispose();
    };
  }, [geometries, pickupGeometry, obstacleMaterial, pickupMaterial]);

  const scratch = useMemo(
    () => ({
      matrix: new THREE.Matrix4(),
      position: new THREE.Vector3(),
      quaternion: new THREE.Quaternion(),
      scale: new THREE.Vector3(1, 1, 1),
      axis: new THREE.Vector3(0, 0, 1),
      // Per-bucket write cursors, reset each frame.
      cursors: new Int32Array(BUCKET_COUNT),
    }),
    [],
  );

  const counts = useMemo(
    () => ({ buckets: new Array<number>(BUCKET_COUNT).fill(0), pickups: 0 }),
    [],
  );

  useLayoutEffect(() => {
    const handle: EntityRendererHandle = {
      counts,

      update(state: SimState): void {
        scratch.cursors.fill(0);

        writeObstacles(state.obstacles);
        writePickups(state.pickups);
      },
    };

    function writeObstacles(obstacles: EntityColumns): void {
      for (let i = 0; i < obstacles.count; i += 1) {
        if (obstacles.active[i] !== 1) {
          continue;
        }
        const type = obstacles.kind[i] ?? 0;
        const bucket = bucketFor(type);
        const cursor = scratch.cursors[bucket] ?? 0;
        if (cursor >= MAX_OBSTACLE_INSTANCES) {
          continue;
        }

        const shape = BUCKET_SHAPES[bucket];
        if (shape === undefined) {
          continue;
        }

        composeEntityMatrix(
          scratch.matrix,
          scratch,
          obstacles.face[i] ?? 0,
          obstacles.lane[i] ?? 0,
          obstacles.z[i] ?? 0,
          obstacles.y[i] ?? 0,
          shape,
        );

        obstacleRefs.current[bucket]?.setMatrixAt(cursor, scratch.matrix);
        scratch.cursors[bucket] = cursor + 1;
      }

      // Collapse the tail of each buffer and publish the live counts.
      hideInstance(scratch.matrix);
      for (let bucket = 0; bucket < BUCKET_COUNT; bucket += 1) {
        const mesh = obstacleRefs.current[bucket];
        const live = scratch.cursors[bucket] ?? 0;
        counts.buckets[bucket] = live;
        if (!mesh) {
          continue;
        }
        for (let i = live; i < MAX_OBSTACLE_INSTANCES; i += 1) {
          mesh.setMatrixAt(i, scratch.matrix);
        }
        mesh.instanceMatrix.needsUpdate = true;
      }
    }

    function writePickups(pickups: EntityColumns): void {
      const mesh = pickupRef.current;
      let live = 0;

      const shape = BUCKET_SHAPES[Bucket.Block];
      const coinShape: BucketShape = {
        width: 1,
        height: 1,
        depth: 1,
        centreY: shape?.centreY ?? HALF,
      };

      for (let i = 0; i < pickups.count && live < MAX_PICKUP_INSTANCES; i += 1) {
        if (pickups.active[i] !== 1) {
          continue;
        }
        composeEntityMatrix(
          scratch.matrix,
          scratch,
          pickups.face[i] ?? 0,
          pickups.lane[i] ?? 0,
          pickups.z[i] ?? 0,
          pickups.y[i] ?? 0,
          coinShape,
        );
        mesh?.setMatrixAt(live, scratch.matrix);
        live += 1;
      }

      counts.pickups = live;
      if (!mesh) {
        return;
      }
      hideInstance(scratch.matrix);
      for (let i = live; i < MAX_PICKUP_INSTANCES; i += 1) {
        mesh.setMatrixAt(i, scratch.matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
    }

    handleRef.current = handle;
    return () => {
      handleRef.current = null;
    };
  }, [handleRef, scratch, counts]);

  return (
    <group name="entities">
      {BUCKET_SHAPES.map((_, bucket) => (
        <instancedMesh
          key={bucket}
          ref={(mesh) => {
            obstacleRefs.current[bucket] = mesh;
          }}
          args={[geometries[bucket], obstacleMaterial, MAX_OBSTACLE_INSTANCES]}
          castShadow
          receiveShadow
          frustumCulled={false}
          name={`obstacles-bucket-${bucket}`}
        />
      ))}

      <instancedMesh
        ref={pickupRef}
        args={[pickupGeometry, pickupMaterial, MAX_PICKUP_INSTANCES]}
        frustumCulled={false}
        name="pickups"
      />
    </group>
  );
}

/** Draw calls the entity layer costs: one per bucket plus one for pickups. */
export const ENTITY_DRAW_CALLS = BUCKET_COUNT + 1;
