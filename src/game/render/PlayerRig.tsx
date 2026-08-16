"use client";

/**
 * The runner — a grey-box capsule.
 *
 * ## This file's interface is the point, not its contents
 *
 * The capsule is throwaway. What is not throwaway is the boundary: `PlayerRig`
 * takes an interpolated transform and an `animationState`, and exposes nothing
 * else. P07 swaps a rigged model in behind that boundary without touching a
 * single caller.
 *
 * So the rules that make the swap cheap are:
 *
 *   - Nothing outside this file knows the player is a capsule, how tall it is,
 *     or how many meshes it has.
 *   - This file never reads `SimState`. It is handed presentation values. If it
 *     read sim state it would need to know about phases, timers and the roll,
 *     and the model swap would become a rewrite.
 *   - `animationState` is a string union derived from the sim's `Phase`, not an
 *     invented parallel vocabulary. An animation graph at P07 binds to values
 *     that already exist in the simulation.
 *
 * ## Why the collider dimensions come from tuning
 *
 * The capsule is sized from `playerWidth` / `playerHeightStand` / `playerHeightSlide`
 * so the grey-box is visually honest about the hitbox. A placeholder that is
 * visibly bigger or smaller than the real collider teaches everyone the wrong
 * thing about the game's fairness for a whole phase.
 */

import { useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { TUNING } from "@/game/config/tuning";
import { AnimationState, damp, type AnimationStateValue } from "./interpolate";
import { PLAYER_COLOR } from "./palette";

const WIDTH = TUNING.geometry.playerWidth;
const HEIGHT_STAND = TUNING.geometry.playerHeightStand;
const HEIGHT_SLIDE = TUNING.geometry.playerHeightSlide;
const PRISM_SIZE = TUNING.geometry.prismInnerSize;

const HALF = 0.5;
const QUARTER_TURN = Math.PI / 2;
/** 1/s — how fast the capsule squashes into and out of the slide pose. */
const POSE_DAMP_RATE = 18;
const RADIAL_SEGMENTS = 8;
const CAP_SEGMENTS = 4;

export interface PlayerRigHandle {
  /**
   * Places the runner for this frame.
   *
   * @param x     u — lateral offset within the current face, interpolated.
   * @param y     u — height above the face, interpolated.
   * @param z     u — position along the tunnel, interpolated.
   * @param face  0..3 — which face is the floor.
   * @param state the animation state, derived from the sim `Phase`.
   * @param dt    s — real frame delta, for pose damping.
   */
  update(
    x: number,
    y: number,
    z: number,
    face: number,
    state: AnimationStateValue,
    dt: number,
  ): void;
  /** The root object, so the camera can follow it without re-deriving anything. */
  readonly object: THREE.Object3D | null;
}

export interface PlayerRigProps {
  handleRef: React.MutableRefObject<PlayerRigHandle | null>;
}

export function PlayerRig({ handleRef }: PlayerRigProps): React.ReactElement {
  const rootRef = useRef<THREE.Group>(null);
  const bodyRef = useRef<THREE.Mesh>(null);

  const geometry = useMemo(
    () =>
      new THREE.CapsuleGeometry(
        WIDTH * HALF,
        Math.max(HEIGHT_STAND - WIDTH, 0),
        CAP_SEGMENTS,
        RADIAL_SEGMENTS,
      ),
    [],
  );

  const material = useMemo(
    () => new THREE.MeshLambertMaterial({ color: new THREE.Color(PLAYER_COLOR) }),
    [],
  );

  useLayoutEffect(() => {
    const geo = geometry;
    const mat = material;
    return () => {
      geo.dispose();
      mat.dispose();
    };
  }, [geometry, material]);

  // Current pose height, damped toward the target so the slide squash is not a
  // one-frame snap. Held in a ref rather than state — this changes every frame.
  const poseRef = useRef<{ height: number }>({ height: HEIGHT_STAND });

  useLayoutEffect(() => {
    const axis = new THREE.Vector3(0, 0, 1);
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();

    const handle: PlayerRigHandle = {
      get object() {
        return rootRef.current;
      },

      update(x, y, z, face, state, dt): void {
        const root = rootRef.current;
        const body = bodyRef.current;
        if (root === null) {
          return;
        }

        // Same face convention as Tunnel and EntityRenderer: position in the
        // face's own frame, then rotate onto the face.
        position.set(x, -PRISM_SIZE * HALF + y, -z);
        quaternion.setFromAxisAngle(axis, face * QUARTER_TURN);
        position.applyQuaternion(quaternion);

        root.position.copy(position);
        root.quaternion.copy(quaternion);

        if (body === null) {
          return;
        }

        // The only thing `animationState` drives in the grey-box: the slide
        // squash. P07 replaces this branch with a real animation graph.
        const targetHeight = state === AnimationState.Sliding ? HEIGHT_SLIDE : HEIGHT_STAND;
        poseRef.current.height = damp(poseRef.current.height, targetHeight, POSE_DAMP_RATE, dt);

        const scaleY = poseRef.current.height / HEIGHT_STAND;
        body.scale.set(1, scaleY, 1);
        // Keep the feet planted while the body squashes.
        body.position.y = (HEIGHT_STAND * HALF) * scaleY;
      },
    };

    handleRef.current = handle;
    return () => {
      handleRef.current = null;
    };
  }, [handleRef]);

  return (
    <group ref={rootRef} name="player">
      <mesh
        ref={bodyRef}
        geometry={geometry}
        material={material}
        castShadow
        position={[0, HEIGHT_STAND * HALF, 0]}
        name="player-body"
      />
    </group>
  );
}

/** Draw calls the player costs. */
export const PLAYER_DRAW_CALLS = 1;
