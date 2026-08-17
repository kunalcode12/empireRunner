"use client";

/**
 * Radial speed lines.
 *
 * A ring of thin quads around the camera's forward axis, streaming outward from
 * the vanishing point. Density, length and opacity all scale with `worldSpeed`.
 *
 * ## Invisible at base speed, on purpose
 *
 * At `baseSpeed` 12 u/s the screen must be completely clean — speed lines are a
 * signal that something has changed, and a signal that is always on is not a
 * signal. They begin to appear at `speedLineOnsetSpeed` 17 u/s, which is around
 * where the time curve plus a modest Flow bonus puts a player who is doing well,
 * and reach full strength at `maxSpeed` 34, which is only reachable with a full
 * Flow meter.
 *
 * So the lines are, in effect, a readout of the Flow coupling: the screen gets
 * more aggressive precisely because the player is playing well. That is worth
 * more than the motion cue itself.
 *
 * ## One draw call
 *
 * A single `InstancedMesh` of `speedLineCount` quads. They live in a group
 * parented to the camera, so they need no per-frame world positioning — only
 * their length and opacity change, and both are uniform across the field, so the
 * per-frame work is a scale write per instance.
 *
 * Disabled entirely under reduced motion. They are pure motion with no
 * information the FOV ramp does not already carry.
 */

import { useLayoutEffect, useMemo, useRef } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import { TUNING } from "@/game/config/tuning";
import { GREYBOX } from "../palette";
import { getMotion } from "./reducedMotion";
import { saturate } from "../interpolate";

const F = TUNING.feel;
const ONSET = F.speedLineOnsetSpeed;
const MAX_SPEED = TUNING.speed.maxSpeed;
const COUNT = F.speedLineCount;

const LINE_WIDTH = 0.035;

export interface SpeedLinesHandle {
  /** @param speed u/s — interpolated world speed. */
  update(speed: number): void;
  /** Current opacity. Diagnostic and test hook. */
  readonly intensity: number;
}

export interface SpeedLinesProps {
  handleRef: React.MutableRefObject<SpeedLinesHandle | null>;
}

export function SpeedLines({ handleRef }: SpeedLinesProps): React.ReactElement {
  const camera = useThree((s) => s.camera);
  const groupRef = useRef<THREE.Group>(null);
  const meshRef = useRef<THREE.InstancedMesh>(null);

  const geometry = useMemo(() => new THREE.PlaneGeometry(LINE_WIDTH, 1), []);
  const material = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(GREYBOX.bone),
        transparent: true,
        opacity: 0,
        depthWrite: false,
        depthTest: false,
        side: THREE.DoubleSide,
      }),
    [],
  );

  useLayoutEffect(() => {
    const g = geometry;
    const m = material;
    return () => {
      g.dispose();
      m.dispose();
    };
  }, [geometry, material]);

  /**
   * Fixed radial layout, computed once.
   *
   * Each line gets an angle and a radius. The radii are jittered across the
   * band so the field does not read as a wheel — evenly spaced radii produce a
   * visible ring, which is worse than no effect.
   */
  const layout = useMemo(() => {
    const angles = new Float32Array(COUNT);
    const radii = new Float32Array(COUNT);
    const GOLDEN = 2.399963;
    for (let i = 0; i < COUNT; i += 1) {
      // Golden-angle increment distributes the lines without clumping and
      // without a repeating pattern.
      angles[i] = i * GOLDEN;
      const t = (i * GOLDEN) % 1;
      radii[i] = F.speedLineInnerRadius + t * (F.speedLineOuterRadius - F.speedLineInnerRadius);
    }
    return { angles, radii };
  }, []);

  const scratch = useMemo(
    () => ({
      matrix: new THREE.Matrix4(),
      pos: new THREE.Vector3(),
      quat: new THREE.Quaternion(),
      scale: new THREE.Vector3(1, 1, 1),
      euler: new THREE.Euler(),
      intensity: 0,
    }),
    [],
  );

  // Parented to the camera, so the field travels with the view and never needs
  // world-space placement.
  useLayoutEffect(() => {
    const group = groupRef.current;
    if (group === null) {
      return;
    }
    camera.add(group);
    return () => {
      camera.remove(group);
    };
  }, [camera]);

  useLayoutEffect(() => {
    const handle: SpeedLinesHandle = {
      get intensity() {
        return scratch.intensity;
      },

      update(speed: number): void {
        const mesh = meshRef.current;
        if (mesh === null) {
          return;
        }

        const motion = getMotion();
        const t = saturate((speed - ONSET) / (MAX_SPEED - ONSET));
        const intensity = t * motion.speedLineScale;
        scratch.intensity = intensity;

        material.opacity = intensity * F.speedLineMaxOpacity;
        // Skip the instance rewrite entirely when invisible. At base speed this
        // is every frame, so it is worth the branch.
        if (intensity <= 0) {
          mesh.visible = false;
          return;
        }
        mesh.visible = true;

        const length = F.speedLineMinLength + t * (F.speedLineMaxLength - F.speedLineMinLength);

        for (let i = 0; i < COUNT; i += 1) {
          const angle = layout.angles[i] ?? 0;
          const radius = layout.radii[i] ?? 0;

          // In camera space: x/y on the view plane, pushed out in front.
          const FORWARD = -6;
          scratch.pos.set(Math.cos(angle) * radius, Math.sin(angle) * radius, FORWARD);
          // Each line points at the vanishing point, which for a camera-space
          // radial field is simply its own angle.
          scratch.euler.set(0, 0, angle - Math.PI / 2);
          scratch.quat.setFromEuler(scratch.euler);
          scratch.scale.set(1, length, 1);

          scratch.matrix.compose(scratch.pos, scratch.quat, scratch.scale);
          mesh.setMatrixAt(i, scratch.matrix);
        }

        mesh.instanceMatrix.needsUpdate = true;
      },
    };

    handleRef.current = handle;
    return () => {
      handleRef.current = null;
    };
  }, [handleRef, layout, material, scratch]);

  return (
    <group ref={groupRef} name="speed-lines">
      <instancedMesh
        ref={meshRef}
        args={[geometry, material, COUNT]}
        frustumCulled={false}
        renderOrder={1}
        name="speed-line-instances"
      />
    </group>
  );
}

/** Draw calls the speed-line field costs. */
export const SPEED_LINE_DRAW_CALLS = 1;
