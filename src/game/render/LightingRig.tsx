"use client";

/**
 * Lighting — one key light, one fill, and a very tight shadow frustum.
 *
 * ## Why the shadow camera is small
 *
 * The obvious mistake is sizing the shadow frustum to the visible tunnel — 288u
 * of geometry. A 1024px map spread over 288u gives roughly 3.5 texels per unit,
 * and the player's 0.7u-wide capsule casts a shadow two texels across. It reads
 * as a grey smudge, and it costs exactly as much to render as a good one.
 *
 * Sized instead to `shadowFrustumHalfSize` 22u — a little more than the player
 * can meaningfully see — the same map gives ~23 texels per unit and the shadow
 * has a hard edge. GAME_BIBLE §11.1 wants shadow to be "a single flat darker
 * colour from the palette, with a hard edge. Not a blur", so resolution here is
 * doing art-direction work, not just performance work.
 *
 * The frustum follows the player rather than the world origin, because the
 * player is the only thing casting a shadow anyone looks at.
 *
 * ## Shadows are the first thing cut
 *
 * `shadowMapLow` is 0 and the LOW tier turns shadow casting off entirely. A
 * shadow pass is a second full render of every caster; on a phone that is the
 * difference between 60 and 40fps, and at this flat-colour art direction it is
 * also the least missed effect. The hemisphere fill stays, so unlit faces never
 * go to flat black — GAME_BIBLE §11.3 bans backgrounds darker than the theme's
 * darkest colour, and an unlit face is exactly that.
 *
 * ## No baked vertex colour yet, deliberately
 *
 * The prompt asks to bake what we can into vertex colour or emissive. At P05
 * every surface is a flat untextured primitive lit by one directional light, so
 * there is nothing to bake that the material is not already doing for free —
 * baking now would just be pre-computing a constant. It becomes real at P10 when
 * the screen-print materials arrive and ambient occlusion would otherwise want a
 * second pass. Emissive is banned outside Overdrive by §11.3 regardless.
 */

import { useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { TUNING } from "@/game/config/tuning";
import { GREYBOX } from "./palette";
import { getQuality } from "./perf/quality";

const HALF_SIZE = TUNING.render.shadowFrustumHalfSize;
const FRUSTUM_DEPTH = TUNING.render.shadowFrustumDepth;
const HEMI_INTENSITY = TUNING.render.hemisphereIntensity;
const KEY_INTENSITY = TUNING.render.directionalIntensity;
const PRISM_SIZE = TUNING.geometry.prismInnerSize;

const HALF = 0.5;
/** u — where the key light sits relative to the player, in the face's frame. */
const KEY_OFFSET = { x: -8, y: 14, z: 6 } as const;
/** Pulls the shadow camera's near plane in so the frustum is not mostly empty. */
const SHADOW_NEAR = 0.5;
/** u — nudges shadows off the surface. Small: the geometry is thin and flat. */
const SHADOW_BIAS = -0.0008;

export interface LightingRigHandle {
  /** Moves the key light's shadow frustum to track the player. */
  update(x: number, y: number, face: number): void;
}

export interface LightingRigProps {
  handleRef: React.MutableRefObject<LightingRigHandle | null>;
}

export function LightingRig({ handleRef }: LightingRigProps): React.ReactElement {
  const keyRef = useRef<THREE.DirectionalLight>(null);
  const targetRef = useRef<THREE.Object3D>(null);

  const quality = getQuality();
  const shadowsOn = quality.shadows && quality.shadowMapSize > 0;

  const scratch = useMemo(
    () => ({
      position: new THREE.Vector3(),
      target: new THREE.Vector3(),
      quaternion: new THREE.Quaternion(),
      axis: new THREE.Vector3(0, 0, 1),
    }),
    [],
  );

  useLayoutEffect(() => {
    const light = keyRef.current;
    const target = targetRef.current;

    // Bound here rather than through a `target` prop: reading `targetRef.current`
    // during render is a genuine correctness hazard (the ref is null on the first
    // pass), and React's `react-hooks/refs` rule is right to reject it.
    if (light !== null && target !== null) {
      light.target = target;
    }

    if (light === null || !shadowsOn) {
      return;
    }
    // Sized once. Resizing a shadow camera per frame reallocates the render
    // target on some drivers, which is a guaranteed hitch mid-run.
    const shadowCamera = light.shadow.camera;
    shadowCamera.left = -HALF_SIZE;
    shadowCamera.right = HALF_SIZE;
    shadowCamera.top = HALF_SIZE;
    shadowCamera.bottom = -HALF_SIZE;
    shadowCamera.near = SHADOW_NEAR;
    shadowCamera.far = FRUSTUM_DEPTH;
    shadowCamera.updateProjectionMatrix();
    light.shadow.bias = SHADOW_BIAS;
  }, [shadowsOn]);

  useLayoutEffect(() => {
    const handle: LightingRigHandle = {
      update(x, y, face): void {
        const light = keyRef.current;
        const target = targetRef.current;
        if (light === null || target === null) {
          return;
        }

        const quat = scratch.quaternion.setFromAxisAngle(scratch.axis, (face * Math.PI) / 2);

        scratch.target.set(x, -PRISM_SIZE * HALF + y, 0);
        scratch.target.applyQuaternion(quat);
        target.position.copy(scratch.target);

        scratch.position.set(
          x + KEY_OFFSET.x,
          -PRISM_SIZE * HALF + y + KEY_OFFSET.y,
          KEY_OFFSET.z,
        );
        scratch.position.applyQuaternion(quat);
        light.position.copy(scratch.position);

        target.updateMatrixWorld();
      },
    };

    handleRef.current = handle;
    return () => {
      handleRef.current = null;
    };
  }, [handleRef, scratch]);

  return (
    <group name="lighting">
      {/* Fill. Sky is bone, ground is gunmetal, so faces pointing away from the
          key light take a palette colour rather than going black. */}
      <hemisphereLight
        args={[new THREE.Color(GREYBOX.bone), new THREE.Color(GREYBOX.gunmetal), HEMI_INTENSITY]}
      />

      <object3D ref={targetRef} name="key-light-target" />

      <directionalLight
        ref={keyRef}
        intensity={KEY_INTENSITY}
        color={new THREE.Color(GREYBOX.bone)}
        castShadow={shadowsOn}
        shadow-mapSize-width={quality.shadowMapSize || 1}
        shadow-mapSize-height={quality.shadowMapSize || 1}
        name="key-light"
      />
    </group>
  );
}
