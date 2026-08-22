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
 *
 * ## Themed at P10
 *
 * The materials come from `materials/screenprint.ts` and carry the active
 * theme's fill, ink, halftone, seams and animated surface term. A crossfade
 * blends the parameters in place rather than swapping materials, because
 * swapping would recompile a shader mid-transition — which is exactly the frame
 * hitch the transition budget exists to catch.
 */

import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { TUNING } from "@/game/config/tuning";
import type { Theme } from "@/game/config/themes";
import {
  blendScreenPrint,
  createScreenPrintMaterial,
  updateScreenPrint,
  type ScreenPrintMaterial,
} from "./materials/screenprint";
import { getQuality } from "./perf/quality";

const FACE_COUNT = TUNING.geometry.faceCount;
const PRISM_SIZE = TUNING.geometry.prismInnerSize;
const SEGMENT_LENGTH = TUNING.render.tunnelSegmentLength;
const RECYCLE_BEHIND = TUNING.render.tunnelRecycleBehind;

const HALF = 0.5;
const QUARTER_TURN = Math.PI / 2;
/** Face 0 is the floor — the one surface that receives the player's shadow. */
const FLOOR_FACE = 0;

export interface TunnelHandle {
  /** The group whose rotation carries the world roll. */
  group: THREE.Group | null;
  /**
   * Scrolls the tunnel to `distance` and applies `roll`.
   *
   * Called from `useGameLoop` every frame with interpolated values. Never reads
   * sim state itself — it is handed presentation values and nothing else.
   */
  update(distance: number, roll: number, time: number): void;
  /**
   * Blends the surface toward another theme.
   *
   * `t` of 0 is entirely `from`, 1 entirely `to`. Called every frame of a
   * transition and once at the end with `t = 1`, so the resting state is always
   * exactly the destination rather than 0.999 of it.
   */
  blend(from: Theme, to: Theme, t: number): void;
}

export interface TunnelProps {
  handleRef: React.MutableRefObject<TunnelHandle | null>;
  /** The theme the tunnel is built for. Changing it rebuilds the materials. */
  theme: Theme;
}

/**
 * Builds the tunnel and exposes an imperative update handle.
 *
 * Imperative rather than reactive on purpose: this runs 60–144 times a second
 * and a React re-render per frame is roughly two orders of magnitude too slow
 * (docs/ARCHITECTURE.md §3.1). The component renders once and the loop mutates
 * the instance matrices directly.
 */
export function Tunnel({ handleRef, theme }: TunnelProps): React.ReactElement {
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

  /**
   * Floor is lit; the three walls are flat.
   *
   * ## Why the walls are unlit, decided from a captured frame
   *
   * With Lambert on every face, gunmetal #2b2b2f on a VERTICAL surface rendered
   * at roughly #101010 — a wall normal catches almost nothing from an overhead
   * key, and raising the hemisphere fill barely moved it because the albedo is
   * genuinely that dark. The tunnel walls read as black, which is both the
   * GAME_BIBLE §11.3 ban ("backgrounds darker than the darkest colour in the
   * active theme's palette") and a legibility problem: the prism stopped reading
   * as a four-sided space at all.
   *
   * An unlit face renders its palette colour exactly, with no shading term, so a
   * wall can never be darker than the swatch it was given. That is also §11.1
   * verbatim — "every surface is one flat colour", "no gradient ramps".
   *
   * The FLOOR stays lit for one reason: an unlit material cannot receive
   * shadows, and the player's contact shadow is the only depth cue the geometry
   * has. Every theme's floor colour is chosen light enough to survive shading.
   */
  const materials = useMemo(() => {
    return Array.from({ length: FACE_COUNT }, (_unused, face) => {
      const lit = face === FLOOR_FACE;
      const color = lit ? theme.surface.floor : theme.surface.wall;
      return createScreenPrintMaterial(color, theme.surface, lit);
    });
  }, [theme]);

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
      fromColor: new THREE.Color(),
      toColor: new THREE.Color(),
    }),
    [],
  );

  useEffect(() => {
    const handle: TunnelHandle = {
      group: groupRef.current,

      update(distance: number, roll: number, time: number): void {
        const group = groupRef.current;
        if (group !== null) {
          group.rotation.z = roll;
        }

        for (const material of materials) {
          updateScreenPrint(material, time, distance);
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

          scratch.quaternion.setFromAxisAngle(scratch.axis, face * QUARTER_TURN);

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

      blend(from: Theme, to: Theme, t: number): void {
        for (let face = 0; face < FACE_COUNT; face += 1) {
          const material = materials[face];
          if (material === undefined) {
            continue;
          }
          const lit = face === FLOOR_FACE;
          scratch.fromColor.set(lit ? from.surface.floor : from.surface.wall);
          scratch.toColor.set(lit ? to.surface.floor : to.surface.wall);
          blendScreenPrint(
            material,
            from.surface,
            to.surface,
            scratch.fromColor,
            scratch.toColor,
            t,
          );
        }
      },
    };

    handleRef.current = handle;
    // Prime it so the first rendered frame is already in position rather than
    // showing every instance stacked at the origin.
    handle.update(0, 0, 0);

    return () => {
      handleRef.current = null;
    };
  }, [handleRef, scratch, segmentCount, materials]);

  return (
    <group ref={groupRef} name="tunnel-roll">
      {materials.map((material, face) => (
        <instancedMesh
          key={face}
          ref={(mesh) => {
            meshRefs.current[face] = mesh;
          }}
          args={[geometry, material, segmentCount]}
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

/** Materials the tunnel builds. Exported so the director can size its blends. */
export type TunnelMaterials = readonly ScreenPrintMaterial[];
