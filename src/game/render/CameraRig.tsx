"use client";

/**
 * The camera.
 *
 * Four behaviours, each doing a specific job. None of them is decoration.
 *
 * ## 1. A follow spring, stiffer laterally than vertically
 *
 * Lateral lag is what makes a runner feel like it is sliding on ice — a lane
 * change has to read as decisive, so `cameraFollowLateral` is the stiffest axis.
 * Vertical is deliberately softer: letting a jump arc slightly out of frame
 * before the camera catches up is what gives the jump weight. Gluing the camera
 * to the apex removes all sense of leaving the ground.
 *
 * Both use exponential damping (`interpolate.damp`), so the feel is identical at
 * 60Hz and 144Hz. A per-frame `lerp(x, target, 0.2)` would make the camera
 * measurably stiffer on better hardware.
 *
 * ## 2. FOV scaling with speed — most of the sensation of speed
 *
 * At this art direction there is no motion blur, no particle streaking and no
 * texture detail rushing past. FOV widening is very nearly the only cue carrying
 * velocity, which is why `cameraSpeedFovBoost` was raised to +20 at P05 (62 -> 82
 * at `maxSpeed`), outside TUNING.md's original 0-15 range.
 *
 * That is a real trade and worth stating: FOV pumping is a documented nausea
 * risk. It needs the reduced-motion kill switch at P15 and a playtest before it
 * is treated as settled.
 *
 * ## 3. Roll that leans INTO the turn and settles
 *
 * The camera does not rigidly track the world's 90-degree rotation. Rigid
 * tracking reads as the screen flipping — the world stays visually still and the
 * player's frame of reference lurches, which is both confusing and the worst
 * case for motion sickness.
 *
 * Instead the camera follows the roll at `rollCameraLerp` and adds a lean
 * proportional to the roll's angular velocity, which decays after the roll
 * finishes. The camera arrives slightly late and overshoots slightly, so the
 * roll reads as something the player did rather than something that happened.
 *
 * ## 4. Damped look-ahead on lane input
 *
 * A small offset toward the lane the player is moving to, so the destination is
 * on screen a beat before they arrive. Heavily damped: it is a hint, not a pan,
 * and an aggressive version fights the lane tween and induces a visible wobble.
 */

import { useLayoutEffect, useMemo } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import { TUNING } from "@/game/config/tuning";
import { damp, lerpAngle, saturate } from "./interpolate";

const DISTANCE = TUNING.camera.cameraDistance;
const HEIGHT = TUNING.camera.cameraHeight;
const FOV_BASE = TUNING.camera.cameraFov;
const FOV_BOOST = TUNING.camera.cameraSpeedFovBoost;
const FOLLOW_LATERAL = TUNING.camera.cameraFollowLateral;
const FOLLOW_VERTICAL = TUNING.camera.cameraFollowVertical;
const FOLLOW_DEPTH = TUNING.camera.cameraFollowDepth;
const LOOK_AHEAD = TUNING.camera.cameraLookAhead;
const LOOK_AHEAD_DAMPING = TUNING.camera.cameraLookAheadDamping;
const ROLL_RATE = TUNING.camera.cameraRollRate;
const ROLL_LEAN = TUNING.camera.cameraRollLean;
const ROLL_SETTLE = TUNING.camera.cameraRollSettle;
const BASE_SPEED = TUNING.speed.baseSpeed;
const MAX_SPEED = TUNING.speed.maxSpeed;
const PRISM_SIZE = TUNING.geometry.prismInnerSize;

const HALF = 0.5;
const QUARTER_TURN = Math.PI / 2;
const DEGREES_IN_HALF_TURN = 180;
const DEG_TO_RAD = Math.PI / DEGREES_IN_HALF_TURN;

export interface CameraRigHandle {
  /**
   * Places the camera for this frame.
   *
   * @param x        u — interpolated player lateral offset.
   * @param y        u — interpolated player height.
   * @param roll     rad — interpolated world roll.
   * @param face     0..3 — current floor face.
   * @param speed    u/s — interpolated world speed, for FOV.
   * @param laneBias -1..1 — lane input direction, for look-ahead.
   * @param dt       s — real frame delta.
   */
  update(
    x: number,
    y: number,
    roll: number,
    face: number,
    speed: number,
    laneBias: number,
    dt: number,
  ): void;
  /** Current FOV. Diagnostic and test hook. */
  readonly fov: number;
}

export interface CameraRigProps {
  handleRef: React.MutableRefObject<CameraRigHandle | null>;
}

export function CameraRig({ handleRef }: CameraRigProps): null {
  const camera = useThree((s) => s.camera);

  const scratch = useMemo(
    () => ({
      /** Damped follow position, in the face's local frame. */
      followX: 0,
      followY: 0,
      followZ: 0,
      /** Damped look-ahead offset. */
      lookAhead: 0,
      /** The camera's own roll, chasing the world's. */
      roll: 0,
      /** Previous world roll, for angular velocity. */
      lastRoll: 0,
      /** Decaying lean, in radians. */
      lean: 0,
      fov: FOV_BASE as number,
      position: new THREE.Vector3(),
      target: new THREE.Vector3(),
      quaternion: new THREE.Quaternion(),
      axis: new THREE.Vector3(0, 0, 1),
      up: new THREE.Vector3(0, 1, 0),
    }),
    [],
  );

  useLayoutEffect(() => {
    const handle: CameraRigHandle = {
      get fov() {
        return scratch.fov;
      },

      update(x, y, roll, face, speed, laneBias, dt): void {
        if (!(camera instanceof THREE.PerspectiveCamera)) {
          return;
        }

        // ── 1. Follow spring ────────────────────────────────────────────────
        scratch.followX = damp(scratch.followX, x, FOLLOW_LATERAL, dt);
        scratch.followY = damp(scratch.followY, y, FOLLOW_VERTICAL, dt);
        scratch.followZ = damp(scratch.followZ, 0, FOLLOW_DEPTH, dt);

        // ── 4. Look-ahead ───────────────────────────────────────────────────
        scratch.lookAhead = damp(
          scratch.lookAhead,
          laneBias * LOOK_AHEAD,
          LOOK_AHEAD_DAMPING,
          dt,
        );

        // ── 3. Roll lean ────────────────────────────────────────────────────
        // Angular velocity of the WORLD roll drives the lean. During a roll it
        // is large and the camera leans into it; once the roll completes it is
        // zero and the lean decays, which is the "settle".
        const rollDelta = dt > 0 ? lerpAngle(scratch.lastRoll, roll, 1) - scratch.lastRoll : 0;
        scratch.lastRoll = roll;
        const angularVelocity = dt > 0 ? rollDelta / dt : 0;

        const leanTarget = Math.tanh(angularVelocity) * ROLL_LEAN * DEG_TO_RAD;
        scratch.lean = damp(scratch.lean, leanTarget, ROLL_SETTLE, dt);

        // The camera's own roll lags the world's, then adds the lean on top.
        scratch.roll = lerpAngle(scratch.roll, roll, saturate(1 - Math.exp(-ROLL_RATE * dt)));

        // ── 2. FOV from speed ───────────────────────────────────────────────
        const speedT = saturate((speed - BASE_SPEED) / (MAX_SPEED - BASE_SPEED));
        scratch.fov = FOV_BASE + FOV_BOOST * speedT;
        if (camera.fov !== scratch.fov) {
          camera.fov = scratch.fov;
          camera.updateProjectionMatrix();
        }

        // ── Assemble ────────────────────────────────────────────────────────
        // Build in the face's local frame, then rotate onto the current face —
        // the same convention Tunnel, EntityRenderer and PlayerRig use.
        const faceQuat = scratch.quaternion.setFromAxisAngle(scratch.axis, face * QUARTER_TURN);

        scratch.position.set(
          scratch.followX + scratch.lookAhead,
          -PRISM_SIZE * HALF + scratch.followY + HEIGHT,
          DISTANCE + scratch.followZ,
        );
        scratch.position.applyQuaternion(faceQuat);

        scratch.target.set(
          scratch.followX + scratch.lookAhead,
          -PRISM_SIZE * HALF + scratch.followY,
          0,
        );
        scratch.target.applyQuaternion(faceQuat);

        camera.position.copy(scratch.position);

        // `up` carries the world roll plus the lean. Rotating up rather than the
        // camera itself keeps `lookAt` doing the work and avoids composing two
        // rotations that can disagree.
        scratch.up.set(0, 1, 0).applyAxisAngle(scratch.axis, -scratch.roll - scratch.lean);
        camera.up.copy(scratch.up);
        camera.lookAt(scratch.target);
      },
    };

    handleRef.current = handle;
    return () => {
      handleRef.current = null;
    };
  }, [camera, handleRef, scratch]);

  return null;
}

/** The FOV at a given world speed. Exported so tests can assert the curve. */
export function fovForSpeed(speed: number): number {
  const t = saturate((speed - BASE_SPEED) / (MAX_SPEED - BASE_SPEED));
  return FOV_BASE + FOV_BOOST * t;
}
