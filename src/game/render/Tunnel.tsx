"use client";

/**
 * The four-face prism tunnel.
 *
 * ## Law (b): this is a treadmill
 *
 * The player never moves down the tunnel. Segments translate toward `-Z` past a
 * near-stationary player and recycle to the front when they fall behind the
 * camera. `distanceTravelled` is an accumulated scalar in the sim, never a
 * transform, which is what keeps float precision intact over a 20-minute run —
 * a player parked at `z = 20000` has visible vertex jitter, and that is the
 * classic endless-runner bug this law exists to prevent.
 *
 * ## Draw calls: four, not four-per-segment
 *
 * The obvious build is one mesh per face per segment, which at 24 segments is 96
 * draw calls and blows the entire 100-call budget on the tunnel alone. Instead
 * each face is a single `InstancedMesh` of `segmentCount` instances, so the whole
 * tunnel is **4 draw calls** at any segment count. Recycling then costs one
 * matrix write per instance rather than a scene-graph reparent.
 *
 * ## The roll is one group, not per-object
 *
 * The entire tunnel — all four faces — is parented to a single group whose
 * z-rotation is driven by the interpolated world roll. Rotating the faces
 * individually would need four correct rotations per frame and would let them
 * drift out of alignment by a float epsilon, which shows up as hairline seams at
 * the corners.
 */

import { useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { TUNING } from "@/game/config/tuning";
import { FACE_COLORS } from "./palette";
import { getQuality } from "./perf/quality";

const FACE_COUNT = TUNING.geometry.faceCount;
const PRISM_SIZE = TUNING.geometry.prismInnerSize;
const SEGMENT_LENGTH = TUNING.render.tunnelSegmentLength;
const RECYCLE_BEHIND = TUNING.render.tunnelRecycleBehind;

const HALF = 0.5;
const QUARTER_TURN = Math.PI / 2;

/**
 * One face's placement within the prism cross-section.
 *
 * Face 0 is the floor and the others follow the sim's convention that rolling
 * `+1` steps to the next face index. Each is a plane rotated to face inward and
 * pushed out to the prism wall.
 */
interface FacePlacement {
  /** rad — rotation about the tunnel axis. */
  roll: number;
}

const FACE_PLACEMENTS: readonly FacePlacement[] = Array.from(
  { length: FACE_COUNT },
  (_unused, face) => ({ roll: face * QUARTER_TURN }),
);

export interface TunnelHandle {
  /** The group whose rotation carries the world roll. */
  group: THREE.Group | null;
  /**
   * Scrolls the tunnel to `distance` and applies `roll`.
   *
   * Called from `useGameLoop` every frame with interpolated values. Never reads
   * sim state itself — it is handed presentation values and nothing else.
   */
  update(distance: number, roll: number): void;
}

export interface TunnelProps {
  handleRef: React.MutableRefObject<TunnelHandle | null>;
}

/**
 * Builds the tunnel and exposes an imperative update handle.
 *
 * Imperative rather than reactive on purpose: this runs 60–144 times a second
 * and a React re-render per frame is roughly two orders of magnitude too slow
 * (docs/ARCHITECTURE.md §3.1). The component renders once and the loop mutates
 * the instance matrices directly.
 */
export function Tunnel({ handleRef }: TunnelProps): React.ReactElement {
  const groupRef = useRef<THREE.Group>(null);
  const meshRefs = useRef<(THREE.InstancedMesh | null)[]>([]);

  const segmentCount = getQuality().tunnelSegments;

  // One plane, shared by all four instanced meshes. Sized to the prism's inner
  // face: `prismInnerSize` across and one segment deep.
  const geometry = useMemo(() => {
    const plane = new THREE.PlaneGeometry(PRISM_SIZE, SEGMENT_LENGTH);
    // A PlaneGeometry faces +Z; the tunnel needs it lying in the XZ plane facing
    // up, which is the floor's orientation before the per-face roll is applied.
    plane.rotateX(-QUARTER_TURN);
    return plane;
  }, []);

  const materials = useMemo(
    () =>
      FACE_COLORS.map(
        (color) =>
          new THREE.MeshLambertMaterial({
            color: new THREE.Color(color),
            side: THREE.FrontSide,
          }),
      ),
    [],
  );

  useLayoutEffect(() => {
    const geo = geometry;
    const mats = materials;
    return () => {
      geo.dispose();
      for (const material of mats) {
        material.dispose();
      }
    };
  }, [geometry, materials]);

  // Scratch objects, reused every frame. Composing a matrix allocates three
  // objects if you are not careful, and this runs `4 * segmentCount` times.
  const scratch = useMemo(
    () => ({
      matrix: new THREE.Matrix4(),
      position: new THREE.Vector3(),
      quaternion: new THREE.Quaternion(),
      scale: new THREE.Vector3(1, 1, 1),
      axis: new THREE.Vector3(0, 0, 1),
    }),
    [],
  );

  useLayoutEffect(() => {
    const handle: TunnelHandle = {
      group: groupRef.current,

      update(distance: number, roll: number): void {
        const group = groupRef.current;
        if (group !== null) {
          group.rotation.z = roll;
        }

        // Where the tunnel has scrolled to, wrapped into one segment. Wrapping
        // rather than accumulating is what keeps the coordinates small forever.
        const scroll = distance % SEGMENT_LENGTH;
        const span = segmentCount * SEGMENT_LENGTH;

        for (let face = 0; face < FACE_COUNT; face += 1) {
          const mesh = meshRefs.current[face];
          if (!mesh) {
            continue;
          }

          const placement = FACE_PLACEMENTS[face] ?? FACE_PLACEMENTS[0];
          scratch.quaternion.setFromAxisAngle(scratch.axis, placement?.roll ?? 0);

          for (let i = 0; i < segmentCount; i += 1) {
            // Segment i sits i lengths ahead, minus the scroll, then wrapped so
            // anything that falls behind the camera reappears at the far end.
            let z = i * SEGMENT_LENGTH - scroll - RECYCLE_BEHIND;
            if (z < -RECYCLE_BEHIND) {
              z += span;
            }

            // The face plane starts as the floor at y = 0 and is pushed to the
            // wall by half the prism, then rotated into place by the quaternion.
            scratch.position.set(0, -PRISM_SIZE * HALF, -z);
            scratch.position.applyQuaternion(scratch.quaternion);

            scratch.matrix.compose(scratch.position, scratch.quaternion, scratch.scale);
            mesh.setMatrixAt(i, scratch.matrix);
          }

          mesh.instanceMatrix.needsUpdate = true;
        }
      },
    };

    handleRef.current = handle;
    // Prime it so the first rendered frame is already in position rather than
    // showing every instance stacked at the origin.
    handle.update(0, 0);

    return () => {
      handleRef.current = null;
    };
  }, [handleRef, scratch, segmentCount]);

  return (
    <group ref={groupRef} name="tunnel-roll">
      {FACE_COLORS.map((_, face) => (
        <instancedMesh
          key={face}
          ref={(mesh) => {
            meshRefs.current[face] = mesh;
          }}
          args={[geometry, materials[face], segmentCount]}
          receiveShadow
          frustumCulled={false}
          name={`tunnel-face-${face}`}
        />
      ))}
    </group>
  );
}

/** Draw calls the tunnel costs: one per face, independent of segment count. */
export const TUNNEL_DRAW_CALLS = FACE_COUNT;
