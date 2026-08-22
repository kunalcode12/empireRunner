"use client";

/**
 * The runner, built from primitives and driven by a `Pose`.
 *
 * Replaces the P05 capsule. Same handle interface — `update(x, y, z, face,
 * state, dt)` — so `useGameLoop` did not change to accommodate it, which was the
 * point of putting that boundary in at P05.
 *
 * ## Draw calls: one, not eleven
 *
 * The body is eleven primitives (torso, head, two upper arms, two forearms, two
 * thighs, two shins, plus the root). Eleven meshes is eleven draw calls against
 * a budget of 100, which is a tenth of the entire budget on the character.
 *
 * So the whole runner is a **single `InstancedMesh`** of unit boxes: one draw
 * call, with per-part transforms written into the instance buffer every frame.
 * A box is the wrong primitive for a limb aesthetically, but it is the right one
 * for instancing, and at this silhouette size the difference is invisible.
 *
 * ## Why the joints are composed by hand
 *
 * Each part's matrix is built by walking the chain — root, then hips, then
 * thigh, then shin — composing a translate and a rotate at each step. Using
 * nested `Object3D`s would be more readable and would cost eleven scene-graph
 * nodes plus eleven world-matrix updates per frame, and would not be instanced.
 * The chain here is short enough to write out.
 */

import { useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { TUNING } from "@/game/config/tuning";
import { AnimationState, type AnimationStateValue } from "../interpolate";
import { ENTITY_TINT } from "../theme/tints";
import { createSquash, horizontalScale, land, stepSquash, verticalScale } from "../feel/squash";
import { createBlend, setState, stepBlend } from "./blend";
import {
  celebrateClip,
  crashClip,
  fallClip,
  fracturingClip,
  idleClip,
  jumpClip,
  landClip,
  rollClip,
  runClip,
  slideClip,
  stumbleClip,
} from "./clips";
import { applyProcedural, createProcedural, type ProceduralState } from "./procedural";
import { createPose, PROPORTIONS as P, type Pose } from "./rig";

const PRISM_SIZE = TUNING.geometry.prismInnerSize;
const STRIDE = TUNING.animation.strideLength;
const HALF = 0.5;
const QUARTER_TURN = Math.PI / 2;
/** Where on the torso the shoulders sit, as a fraction of its length. */
const SHOULDER_HEIGHT_FRACTION = 0.85;

/** Body parts, in instance-buffer order. */
const PART_COUNT = 11;
const Part = {
  Torso: 0,
  Head: 1,
  ArmUpperL: 2,
  ArmLowerL: 3,
  ArmUpperR: 4,
  ArmLowerR: 5,
  LegUpperL: 6,
  LegLowerL: 7,
  LegUpperR: 8,
  LegLowerR: 9,
  Pelvis: 10,
} as const;

export interface RunnerRigHandle {
  update(
    x: number,
    y: number,
    z: number,
    face: number,
    state: AnimationStateValue,
    dt: number,
  ): void;
  /** Feeds the frame's live sim-derived values to the procedural layer. */
  setContext(context: RunnerContext): void;
  /** Registers a landing, for the squash. */
  onLand(impactSpeed: number): void;
  /** Emits nothing itself; reports where the feet are, for dust. */
  readonly footContact: { x: number; y: number; z: number; stepped: boolean };
}

export interface RunnerContext {
  /** m — interpolated distance, which drives the run cycle phase. */
  distance: number;
  /** -1..1 — lateral intent. */
  laneBias: number;
  /** rad — interpolated world roll. */
  worldRoll: number;
  /** u — lateral offset of the nearest hazard, or NaN. */
  hazardX: number;
  /** u/s — vertical velocity, for the airborne stretch. */
  verticalSpeed: number;
}

export interface RunnerRigProps {
  handleRef: React.MutableRefObject<RunnerRigHandle | null>;
}

/** Maps an animation state to its clip's pose for this frame. */
function evaluateClip(
  state: AnimationStateValue,
  phase: number,
  elapsed: number,
  grounded: boolean,
): Pose {
  switch (state) {
    case AnimationState.Running:
      // The landing beat is a sub-state of Running: for a short window after
      // touchdown the run clip would look wrong, so the land pose covers it.
      return grounded ? runClip(phase) : landClip();
    case AnimationState.Jumping:
      return jumpClip();
    case AnimationState.Falling:
      return fallClip();
    case AnimationState.Sliding:
      return slideClip();
    case AnimationState.Rolling:
      return rollClip(phase);
    case AnimationState.Stumbling:
      return stumbleClip(elapsed);
    case AnimationState.Crashed:
      return crashClip();
    case AnimationState.Fracturing:
      return fracturingClip();
    default:
      return idleClip(elapsed);
  }
}

export function RunnerRig({ handleRef }: RunnerRigProps): React.ReactElement {
  const rootRef = useRef<THREE.Group>(null);
  const meshRef = useRef<THREE.InstancedMesh>(null);

  const geometry = useMemo(() => new THREE.BoxGeometry(1, 1, 1), []);
  const material = useMemo(() => new THREE.MeshLambertMaterial({ color: ENTITY_TINT.player }), []);

  useLayoutEffect(() => {
    const g = geometry;
    const m = material;
    return () => {
      g.dispose();
      m.dispose();
    };
  }, [geometry, material]);

  const rig = useMemo(
    () => ({
      blend: createBlend(),
      procedural: createProcedural() as ProceduralState,
      squash: createSquash(),
      pose: createPose(),
      elapsed: 0,
      lastPhase: 0,
      context: {
        distance: 0,
        laneBias: 0,
        worldRoll: 0,
        hazardX: Number.NaN,
        verticalSpeed: 0,
      } as RunnerContext,
      footContact: { x: 0, y: 0, z: 0, stepped: false },
      // Scratch matrices. Composing eleven transforms per frame with fresh
      // objects would be 33 allocations a frame at 144Hz.
      matrix: new THREE.Matrix4(),
      parent: new THREE.Matrix4(),
      local: new THREE.Matrix4(),
      quat: new THREE.Quaternion(),
      pos: new THREE.Vector3(),
      scale: new THREE.Vector3(1, 1, 1),
      euler: new THREE.Euler(),
      axisX: new THREE.Vector3(1, 0, 0),
      axisY: new THREE.Vector3(0, 1, 0),
      axisZ: new THREE.Vector3(0, 0, 1),
      faceQuat: new THREE.Quaternion(),
      facePos: new THREE.Vector3(),
    }),
    [],
  );

  useLayoutEffect(() => {
    /** Writes one part's world matrix into the instance buffer. */
    function writePart(
      index: number,
      parent: THREE.Matrix4,
      offsetX: number,
      offsetY: number,
      offsetZ: number,
      rotX: number,
      rotZ: number,
      sizeX: number,
      sizeY: number,
      sizeZ: number,
      pivotToCentre: number,
    ): THREE.Matrix4 {
      const mesh = meshRef.current;

      // Joint frame: translate to the joint, then rotate about it.
      rig.euler.set(rotX, 0, rotZ);
      rig.quat.setFromEuler(rig.euler);
      rig.pos.set(offsetX, offsetY, offsetZ);
      rig.scale.set(1, 1, 1);
      rig.local.compose(rig.pos, rig.quat, rig.scale);
      rig.local.premultiply(parent);

      // The visible box hangs BELOW the joint (a thigh extends down from a hip),
      // so its centre is offset along the joint's own -Y before scaling.
      rig.pos.set(0, pivotToCentre, 0);
      rig.quat.identity();
      rig.scale.set(sizeX, sizeY, sizeZ);
      rig.matrix.compose(rig.pos, rig.quat, rig.scale);
      rig.matrix.premultiply(rig.local);

      mesh?.setMatrixAt(index, rig.matrix);
      // Return the JOINT frame, not the box frame, so children chain from the
      // joint rather than from the middle of the parent's box.
      return rig.local;
    }

    const chainScratch = new THREE.Matrix4();

    const handle: RunnerRigHandle = {
      footContact: rig.footContact,

      setContext(context: RunnerContext): void {
        rig.context.distance = context.distance;
        rig.context.laneBias = context.laneBias;
        rig.context.worldRoll = context.worldRoll;
        rig.context.hazardX = context.hazardX;
        rig.context.verticalSpeed = context.verticalSpeed;
      },

      onLand(impactSpeed: number): void {
        land(rig.squash, impactSpeed);
      },

      update(x, y, z, face, state, dt): void {
        const root = rootRef.current;
        const mesh = meshRef.current;
        if (root === null || mesh === null) {
          return;
        }

        rig.elapsed += dt;

        // ── Root placement, same face convention as everything else ─────────
        rig.facePos.set(x, -PRISM_SIZE * HALF + y, -z);
        rig.faceQuat.setFromAxisAngle(rig.axisZ, face * QUARTER_TURN);
        rig.facePos.applyQuaternion(rig.faceQuat);
        root.position.copy(rig.facePos);
        root.quaternion.copy(rig.faceQuat);

        // ── Clip, blend, procedural ─────────────────────────────────────────
        // Phase from DISTANCE, so the feet never skate. See clips.ts.
        const phase = (rig.context.distance / STRIDE) % 1;
        const grounded = state !== AnimationState.Jumping && state !== AnimationState.Falling;

        setState(rig.blend, state);
        const clip = evaluateClip(state, phase, rig.elapsed, grounded);
        const blended = stepBlend(rig.blend, clip, dt);

        // Copy out before the procedural layer mutates it, so the blend's own
        // `from` snapshot on the next transition is the clean clip result.
        rig.pose.rootY = blended.rootY;
        rig.pose.torsoPitch = blended.torsoPitch;
        rig.pose.torsoRoll = blended.torsoRoll;
        rig.pose.torsoYaw = blended.torsoYaw;
        rig.pose.torsoCrouch = blended.torsoCrouch;
        rig.pose.headPitch = blended.headPitch;
        rig.pose.headYaw = blended.headYaw;
        rig.pose.armLeft = blended.armLeft;
        rig.pose.armRight = blended.armRight;
        rig.pose.elbowLeft = blended.elbowLeft;
        rig.pose.elbowRight = blended.elbowRight;
        rig.pose.legLeft = blended.legLeft;
        rig.pose.legRight = blended.legRight;
        rig.pose.kneeLeft = blended.kneeLeft;
        rig.pose.kneeRight = blended.kneeRight;

        applyProcedural(rig.procedural, rig.pose, {
          laneBias: rig.context.laneBias,
          worldRoll: rig.context.worldRoll,
          playerX: x,
          hazardX: rig.context.hazardX,
          dt,
        });

        stepSquash(rig.squash, dt);
        const sy = verticalScale(rig.squash);
        const sxz = horizontalScale(rig.squash);

        // ── Footfall detection, for dust ────────────────────────────────────
        // Two contacts per stride, at the phase points where each leg is
        // planted. Crossing either boundary this frame is a step.
        const HALF_STRIDE = 0.5;
        const stepped =
          grounded &&
          (Math.floor(phase / HALF_STRIDE) !== Math.floor(rig.lastPhase / HALF_STRIDE) ||
            phase < rig.lastPhase);
        rig.lastPhase = phase;
        rig.footContact.stepped = stepped;
        rig.footContact.x = rig.facePos.x;
        rig.footContact.y = rig.facePos.y;
        rig.footContact.z = rig.facePos.z;

        // ── Build the eleven parts ──────────────────────────────────────────
        const pose = rig.pose;
        const pelvisY = P.hipHeight + pose.rootY;

        // Pelvis: the root joint everything hangs off.
        rig.euler.set(0, pose.torsoYaw, pose.torsoRoll);
        rig.quat.setFromEuler(rig.euler);
        rig.pos.set(0, pelvisY, 0);
        rig.scale.set(sxz, sy, sxz);
        chainScratch.compose(rig.pos, rig.quat, rig.scale);

        writePart(
          Part.Pelvis,
          chainScratch,
          0,
          0,
          0,
          0,
          0,
          P.hipWidth * 2,
          P.limbThickness,
          P.torsoDepth,
          0,
        );

        // Torso, pitched forward from the pelvis.
        const torso = writePart(
          Part.Torso,
          chainScratch,
          0,
          0,
          0,
          pose.torsoPitch,
          0,
          P.torsoWidth,
          P.torsoLength * (1 - pose.torsoCrouch * HALF),
          P.torsoDepth,
          P.torsoLength * (1 - pose.torsoCrouch * HALF) * HALF,
        );
        const torsoFrame = chainScratch.copy(torso);

        // Head, on top of the torso.
        writePart(
          Part.Head,
          torsoFrame,
          0,
          P.torsoLength,
          0,
          pose.headPitch,
          0,
          P.headRadius * 2,
          P.headRadius * 2,
          P.headRadius * 2,
          P.headRadius,
        );

        // Arms. Shoulder is at the top of the torso, offset laterally.
        const shoulderY = P.torsoLength * SHOULDER_HEIGHT_FRACTION;
        const armL = writePart(
          Part.ArmUpperL,
          torsoFrame,
          -P.shoulderWidth,
          shoulderY,
          0,
          pose.armLeft,
          0,
          P.limbThickness,
          P.upperLimb,
          P.limbThickness,
          -P.upperLimb * HALF,
        );
        writePart(
          Part.ArmLowerL,
          armL,
          0,
          -P.upperLimb,
          0,
          pose.elbowLeft,
          0,
          P.limbThickness,
          P.lowerLimb,
          P.limbThickness,
          -P.lowerLimb * HALF,
        );

        const armR = writePart(
          Part.ArmUpperR,
          torsoFrame,
          P.shoulderWidth,
          shoulderY,
          0,
          pose.armRight,
          0,
          P.limbThickness,
          P.upperLimb,
          P.limbThickness,
          -P.upperLimb * HALF,
        );
        writePart(
          Part.ArmLowerR,
          armR,
          0,
          -P.upperLimb,
          0,
          pose.elbowRight,
          0,
          P.limbThickness,
          P.lowerLimb,
          P.limbThickness,
          -P.lowerLimb * HALF,
        );

        // Legs hang from the pelvis, not the torso — otherwise a forward torso
        // pitch would swing the legs backward with it.
        rig.euler.set(0, pose.torsoYaw, pose.torsoRoll);
        rig.quat.setFromEuler(rig.euler);
        rig.pos.set(0, pelvisY, 0);
        rig.scale.set(sxz, sy, sxz);
        const pelvisFrame = new THREE.Matrix4().compose(rig.pos, rig.quat, rig.scale);

        const legL = writePart(
          Part.LegUpperL,
          pelvisFrame,
          -P.hipWidth,
          0,
          0,
          pose.legLeft,
          0,
          P.limbThickness,
          P.upperLimb,
          P.limbThickness,
          -P.upperLimb * HALF,
        );
        writePart(
          Part.LegLowerL,
          legL,
          0,
          -P.upperLimb,
          0,
          -pose.kneeLeft,
          0,
          P.limbThickness,
          P.lowerLimb,
          P.limbThickness,
          -P.lowerLimb * HALF,
        );

        const legR = writePart(
          Part.LegUpperR,
          pelvisFrame,
          P.hipWidth,
          0,
          0,
          pose.legRight,
          0,
          P.limbThickness,
          P.upperLimb,
          P.limbThickness,
          -P.upperLimb * HALF,
        );
        writePart(
          Part.LegLowerR,
          legR,
          0,
          -P.upperLimb,
          0,
          -pose.kneeRight,
          0,
          P.limbThickness,
          P.lowerLimb,
          P.limbThickness,
          -P.lowerLimb * HALF,
        );

        mesh.instanceMatrix.needsUpdate = true;
      },
    };

    handleRef.current = handle;
    return () => {
      handleRef.current = null;
    };
  }, [handleRef, rig]);

  return (
    <group ref={rootRef} name="runner">
      <instancedMesh
        ref={meshRef}
        args={[geometry, material, PART_COUNT]}
        castShadow
        frustumCulled={false}
        name="runner-parts"
      />
    </group>
  );
}

/** Draw calls the runner costs: one, whatever it is made of. */
export const RUNNER_DRAW_CALLS = 1;

export { celebrateClip };
