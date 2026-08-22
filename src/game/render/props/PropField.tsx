"use client";

/**
 * The prop layer — decorative geometry beside the play space.
 *
 * ## Props are INSIDE the prism, in the margin, and that was a correction
 *
 * The first version put the field outside the tunnel wall, on the theory that
 * "outside the play space" meant outside the geometry. Every wall face is an
 * opaque inward-facing plane, so the entire field was hidden behind them: ten
 * draw calls a frame to render nothing at all. Props live in the strip of each
 * face beyond the outer lane — between 3.0u and the corner at 3.6u — where they
 * are visible from inside and still unreachable.
 *
 * ## A prop can never be hit, and that is structural rather than careful
 *
 * The brief: "A prop that reads as an obstacle is a bug that costs players runs."
 * Three independent things make that true here, and none of them is "we were
 * careful":
 *
 *   1. **Placement.** A prop's anchor is offset outward by its own measured
 *      half-extent, so its INNER EDGE lands at `PROP_MIN_LATERAL` — the player's
 *      widest reach plus a clearance. Not its centre: anchoring the centre is
 *      what let a 2u panel reach a metre into the outer lane.
 *      `tests/theme/props.test.ts` asserts the edge, exhaustively over every
 *      side, slot and archetype.
 *   2. **Silhouette.** The archetypes hang, sag, lean and clutter. Every gameplay
 *      obstacle is an upright right prism squarely in a lane. See the header of
 *      `scripts/lib/prop-geometry.mjs`.
 *   3. **Colour.** A prop may never use its theme's accent, which is the colour
 *      obstacles are drawn in. Asserted in `tests/theme/registry.test.ts`.
 *
 * ## Culling is real, not a scale-to-zero
 *
 * Instanced meshes are frustum-culled by their whole bounding volume, and a prop
 * field spans the entire tunnel — so the mesh is always "visible" and three would
 * happily draw 48 instances of which four are on screen. Instead the update pass
 * **packs visible instances into the front of the instance buffer and sets
 * `mesh.count`**, so the GPU is never handed the ones behind the camera or past
 * the cull distance. That is the difference between a culled prop costing nothing
 * and costing a vertex shader invocation.
 *
 * ## Two LODs, swapped by repacking
 *
 * Each prop entry has a `near` and a `far` mesh from the bundle. Every frame an
 * instance is packed into exactly one of them by distance. No cross-fade between
 * LODs — at 46u, in fog, on a flat-shaded silhouette, the swap is genuinely
 * invisible, and a dissolve would cost a transparent pass to hide nothing.
 *
 * ## Placement is deterministic but NOT from the sim RNG
 *
 * Same rule as particles (TUNING §13d): drawing from the sim's seeded stream
 * would advance the generator, so spawning a lantern would change the track
 * layout. Placement uses a local integer hash of the slot index, which is stable
 * across runs and frames without touching the sim.
 */

import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { TUNING } from "@/game/config/tuning";
import type { Theme } from "@/game/config/themes";
import { createScreenPrintMaterial, type ScreenPrintMaterial } from "../materials/screenprint";
import { getQuality, Quality } from "../perf/quality";
import type { ThemeAssets } from "../theme/loader";

const FACE_COUNT = TUNING.geometry.faceCount;
const HALF_PRISM = TUNING.geometry.prismInnerSize / 2;
const QUARTER_TURN = Math.PI / 2;

/**
 * The player's widest possible reach from the tunnel axis, on any face.
 *
 * Outer lane centre plus half the player's width. Symmetric across all 12 play
 * cells, so this one number is the safety boundary after any sequence of rolls.
 */
const PLAYER_MAX_LATERAL =
  (TUNING.geometry.laneWidth * (TUNING.geometry.laneCount - 1)) / 2 +
  TUNING.geometry.playerWidth / 2;

/**
 * The nearest a prop may come to the tunnel centreline, laterally.
 *
 * THE safety guarantee. Every placement is at or beyond this, on both sides,
 * and `tests/theme/props.test.ts` checks it exhaustively rather than by sample.
 */
export const PROP_MIN_LATERAL = PLAYER_MAX_LATERAL + TUNING.props.laneClearance;

/**
 * u — how much further out than the clearance a prop may be pushed.
 *
 * Purely outward, and it does not need a ceiling. A prop that runs past the
 * corner of the prism is simply inside the adjacent wall, and every wall face is
 * an opaque inward-facing plane, so the excess is invisible rather than wrong.
 * Only the INNER edge is a correctness question.
 */
const LATERAL_SPREAD = 0.45;

/**
 * The base yaw every prop is laid on the face with.
 *
 * A quarter turn, so the archetype's own width runs ALONG the tunnel rather than
 * across it. This is how wall furniture actually sits — a sign, a rug, a rack of
 * pipe on a corridor wall is wide in the direction you walk, not across it — and
 * without it a 2u panel needs 2u of lateral room in a margin band that is 1.05u
 * wide. The first version had no base yaw and every panel drove a metre into the
 * outer lane.
 */
const BASE_YAW = QUARTER_TURN;

/**
 * Salts for the placement hash.
 *
 * One stable draw per decision, each from a different salt, so a slot's depth
 * cannot correlate with whether it is present or which prop it is — correlated
 * draws are what make procedural placement look like a pattern.
 *
 * The two multipliers are coprime primes: they turn `(side, slot)` into a key
 * with no collisions across the field, which a pair like 1000/8000 would not.
 */
const SALT = {
  side: 1013,
  slot: 7919,
  present: 0x5f3a,
  archetype: 0x1234,
  depth: 0x77,
  lateral: 0xa5,
  yaw: 0xbb,
} as const;

const HALF = 0.5;
/** rad — how far a prop may be hung crooked. Not a full circle: see the note
 *  at the placement site. */
const YAW_JITTER = 0.5;

/**
 * The murmur3 finalizer's published constants.
 *
 * Named rather than inlined because they are not tunables — changing one does
 * not make the field look different in a controllable way, it makes the hash a
 * different and probably worse hash. They are quoted from the algorithm.
 */
const MIX = {
  /** The golden-ratio constant, as used by murmur/xxHash seeding. */
  golden: 0x9e3779b9,
  first: 0x85ebca6b,
  second: 0xc2b2ae35,
  shiftA: 13,
  shiftB: 16,
  /** 2^32 — turns the uint32 into a 0..1 fraction. */
  range: 4294967296,
} as const;

/**
 * A stable 32-bit hash. Integer ops only, so it is identical on every engine.
 *
 * Deliberately the same mixing the sim's RNG uses, minus the state: placement
 * must be reproducible frame to frame, not sequential. `Math.imul` is exactly
 * specified by ECMA-262, which is why the field looks the same in every browser
 * without being part of the replay.
 */
function hash(n: number): number {
  let x = Math.imul(n ^ MIX.golden, MIX.first);
  x = Math.imul(x ^ (x >>> MIX.shiftA), MIX.second);
  return ((x ^ (x >>> MIX.shiftB)) >>> 0) / MIX.range;
}

/** How many props a quality tier keeps per side. */
function slotsPerSide(): number {
  const tier = getQuality().tier;
  if (tier === Quality.Low) {
    return TUNING.props.maxPerSideLow;
  }
  if (tier === Quality.Medium) {
    return TUNING.props.maxPerSideMedium;
  }
  return TUNING.props.maxPerSideHigh;
}

/** One prop entry's pair of instanced meshes. */
interface PropBucket {
  readonly near: THREE.InstancedMesh;
  readonly far: THREE.InstancedMesh;
  readonly material: ScreenPrintMaterial;
  /** Index into `theme.props`. */
  readonly index: number;
  /**
   * u — how far this archetype reaches laterally from its own origin, measured
   * from the geometry rather than assumed from `size`.
   *
   * The anchor is offset outward by exactly this, which is what makes "a prop is
   * never inside a lane" a property of the placement rather than of the numbers
   * somebody chose for the archetype. A theme can ship a 6u prop and it still
   * cannot reach the player; it just sinks further into the wall.
   */
  readonly halfExtent: number;
  /** Cumulative weight, for slot assignment. */
  readonly weightFrom: number;
  readonly weightTo: number;
}

export interface PropFieldHandle {
  /**
   * Repacks and draws the field.
   *
   * @param distance  world scroll, in metres
   * @param roll      world roll, in radians
   * @param strength  0..1 — how much of this theme's furniture is present. The
   *                  crossfade drives it; below 1 the field thins out rather
   *                  than fading, because a translucent prop is a sorting
   *                  problem in exchange for nothing.
   * @param time      render seconds, for the material's animated term
   */
  update(distance: number, roll: number, strength: number, time: number): void;
  /** Draw calls this field contributed on the last update. Diagnostic. */
  readonly drawCalls: number;
  /** Instances actually submitted on the last update. Diagnostic. */
  readonly visible: number;
}

export interface PropFieldProps {
  readonly theme: Theme;
  readonly assets: ThemeAssets | null;
  readonly handleRef: React.MutableRefObject<PropFieldHandle | null>;
}

export function PropField({ theme, assets, handleRef }: PropFieldProps): React.ReactElement {
  const groupRef = useRef<THREE.Group>(null);
  const bucketsRef = useRef<PropBucket[]>([]);
  const statsRef = useRef({ drawCalls: 0, visible: 0 });

  const perSide = slotsPerSide();
  const capacity = perSide * FACE_COUNT;

  const scratch = useMemo(
    () => ({
      matrix: new THREE.Matrix4(),
      position: new THREE.Vector3(),
      quaternion: new THREE.Quaternion(),
      spin: new THREE.Quaternion(),
      scale: new THREE.Vector3(1, 1, 1),
      axis: new THREE.Vector3(0, 0, 1),
      up: new THREE.Vector3(0, 1, 0),
      base: new THREE.Color(),
      fog: new THREE.Color(),
    }),
    [],
  );

  // Rebuilt whenever the theme or its assets change. Both are stable for the
  // life of a theme, so this runs at most once per transition.
  useEffect(() => {
    const group = groupRef.current;
    if (group === null || assets === null) {
      return;
    }

    const buckets: PropBucket[] = [];
    let cumulative = 0;
    const totalWeight = theme.props.reduce((sum, prop) => sum + Math.max(0, prop.weight), 0) || 1;

    theme.props.forEach((prop, index) => {
      const near = assets.meshes.get(`${index}-${prop.archetype}-near`);
      const far = assets.meshes.get(`${index}-${prop.archetype}-far`);
      if (near === undefined || far === undefined) {
        // The bundle and the registry disagree. Skipping is the right failure:
        // a theme missing one prop is still that theme, and the alternative is
        // a run that ends on a missing mesh.
        return;
      }

      // Props are unlit. They sit past the fog's midpoint most of the time and a
      // lighting term on a flat silhouette only muddies the shape — §11.1 wants
      // the flat colour, and `emissive` gives it exactly.
      const material = createScreenPrintMaterial(prop.color, theme.surface, false);

      const nearMesh = new THREE.InstancedMesh(near, material, capacity);
      const farMesh = new THREE.InstancedMesh(far, material, capacity);
      for (const mesh of [nearMesh, farMesh]) {
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        // The field is repacked every frame and its bounds are the whole tunnel,
        // so three's own culling can only ever be wrong. `count` is the cull.
        mesh.frustumCulled = false;
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        mesh.count = 0;
        mesh.name = `prop-${theme.slug}-${index}`;
        group.add(mesh);
      }

      // Measured, not derived from `size`. After `BASE_YAW` the geometry's local
      // Z is what points laterally, so that is the half-extent that matters.
      near.computeBoundingBox();
      const box = near.boundingBox;
      const halfExtent = box === null ? 0 : Math.max(Math.abs(box.min.z), Math.abs(box.max.z));

      const from = cumulative / totalWeight;
      cumulative += Math.max(0, prop.weight);
      buckets.push({
        near: nearMesh,
        far: farMesh,
        material,
        index,
        halfExtent,
        weightFrom: from,
        weightTo: cumulative / totalWeight,
      });
    });

    bucketsRef.current = buckets;

    return () => {
      for (const bucket of buckets) {
        group.remove(bucket.near);
        group.remove(bucket.far);
        bucket.near.dispose();
        bucket.far.dispose();
        bucket.material.dispose();
      }
      bucketsRef.current = [];
    };
  }, [theme, assets, capacity]);

  useEffect(() => {
    const handle: PropFieldHandle = {
      get drawCalls() {
        return statsRef.current.drawCalls;
      },
      get visible() {
        return statsRef.current.visible;
      },

      update(distance: number, roll: number, strength: number, time: number): void {
        const group = groupRef.current;
        const buckets = bucketsRef.current;
        if (group === null || buckets.length === 0) {
          statsRef.current.drawCalls = 0;
          statsRef.current.visible = 0;
          return;
        }

        group.rotation.z = roll;

        const spacing = TUNING.props.slotSpacing;
        const span = perSide * spacing;
        const scroll = distance % span;
        const cull = TUNING.props.cullDistance;
        const lod = TUNING.props.lodDistance;
        const clampedStrength = strength < 0 ? 0 : strength > 1 ? 1 : strength;

        // Reset every bucket's write cursor. Packing is what makes `count` a
        // real cull, so it starts from zero every frame.
        const nearCount = new Array<number>(buckets.length).fill(0);
        const farCount = new Array<number>(buckets.length).fill(0);

        scratch.fog.set(theme.fog.color);

        for (let side = 0; side < FACE_COUNT; side += 1) {
          scratch.quaternion.setFromAxisAngle(scratch.axis, side * QUARTER_TURN);

          for (let slot = 0; slot < perSide; slot += 1) {
            const key = side * SALT.side + slot * SALT.slot;

            // Thinning, not fading. A slot is present when its stable random
            // draw is under the current strength, so the set empties in a
            // scattered way rather than from one end.
            if (hash(key ^ SALT.present) > clampedStrength) {
              continue;
            }

            const jitterZ = (hash(key) - HALF) * 2 * TUNING.props.slotJitter;
            let z = slot * spacing - scroll + jitterZ;
            if (z < -spacing) {
              z += span;
            }
            if (z > cull || z < -spacing) {
              continue;
            }

            const bucket = pickBucket(buckets, hash(key ^ SALT.archetype));
            if (bucket === null) {
              continue;
            }
            const bucketIndex = buckets.indexOf(bucket);

            // Lateral: in the margin band on ONE side of the face, never across
            // the middle. `(side + slot) % 2` picks which edge, so a face is
            // furnished along both its corners rather than only one.
            const lateral = propLateral(side, slot, bucket.halfExtent);

            // Fixed to the face plane. The archetype's own geometry grows inward
            // from there, bounded by `TUNING.props.depth`.
            const radius = HALF_PRISM;

            scratch.position.set(lateral, -radius, -z);
            scratch.position.applyQuaternion(scratch.quaternion);

            // The base yaw, plus a SMALL jitter — not a full circle.
            //
            // The first version spun each prop anywhere in 2π, which turned wall
            // panels side-on and left them sticking into the tunnel like flags.
            // A prop is bolted to a surface; it can be hung crooked, it cannot be
            // hung backwards. ±0.25 rad is crooked.
            const yaw = BASE_YAW + (hash(key ^ SALT.yaw) - HALF) * YAW_JITTER;
            scratch.spin.setFromAxisAngle(scratch.up, yaw);
            scratch.quaternion.multiply(scratch.spin);
            scratch.matrix.compose(scratch.position, scratch.quaternion, scratch.scale);
            // Undo the spin so the next slot on this side starts from the face
            // rotation rather than accumulating.
            scratch.quaternion.setFromAxisAngle(scratch.axis, side * QUARTER_TURN);

            const useFar = z > lod;
            const mesh = useFar ? bucket.far : bucket.near;
            const counts = useFar ? farCount : nearCount;
            const cursor = counts[bucketIndex] ?? 0;
            if (cursor >= capacity) {
              continue;
            }
            mesh.setMatrixAt(cursor, scratch.matrix);
            counts[bucketIndex] = cursor + 1;
          }
        }

        let drawCalls = 0;
        let visible = 0;
        for (let i = 0; i < buckets.length; i += 1) {
          const bucket = buckets[i];
          if (bucket === undefined) {
            continue;
          }
          const near = nearCount[i] ?? 0;
          const far = farCount[i] ?? 0;
          bucket.near.count = near;
          bucket.far.count = far;
          bucket.near.instanceMatrix.needsUpdate = true;
          bucket.far.instanceMatrix.needsUpdate = true;

          // A bucket with no instances costs no draw call — three skips a mesh
          // whose count is zero.
          if (near > 0) {
            drawCalls += 1;
          }
          if (far > 0) {
            drawCalls += 1;
          }
          visible += near + far;

          bucket.material.axisUniforms.uTime.value = time;
          bucket.material.axisUniforms.uScroll.value = distance;
        }

        statsRef.current.drawCalls = drawCalls;
        statsRef.current.visible = visible;
      },
    };

    handleRef.current = handle;
    return () => {
      handleRef.current = null;
    };
  }, [handleRef, perSide, capacity, scratch, theme]);

  return <group ref={groupRef} name={`props-${theme.slug}`} />;
}

/** Picks a prop entry by weight from a 0..1 draw. */
function pickBucket(buckets: readonly PropBucket[], draw: number): PropBucket | null {
  for (const bucket of buckets) {
    if (draw >= bucket.weightFrom && draw < bucket.weightTo) {
      return bucket;
    }
  }
  return buckets[buckets.length - 1] ?? null;
}

/**
 * Where a prop slot's ORIGIN lands laterally on its face, as pure arithmetic.
 *
 * The anchor is pushed outward by the archetype's own half-extent, so the prop's
 * inner edge — not its centre — is what sits at `PROP_MIN_LATERAL`. That is the
 * whole safety argument, and it holds for any `halfExtent` a theme can produce,
 * including one larger than the tunnel.
 *
 * Exported so `tests/theme/props.test.ts` can assert the guarantee across every
 * side, slot and archetype without a renderer — the claim "a prop is never in a
 * lane" is only worth anything if it is checked exhaustively rather than sampled.
 */
export function propLateral(side: number, slot: number, halfExtent: number): number {
  const key = side * SALT.side + slot * SALT.slot;
  const magnitude = PROP_MIN_LATERAL + halfExtent + hash(key ^ SALT.lateral) * LATERAL_SPREAD;
  return (side + slot) % 2 === 0 ? magnitude : -magnitude;
}

/** The player's widest reach, exported for the same test. */
export { PLAYER_MAX_LATERAL };
