/**
 * Public surface of the render layer.
 *
 * Consumers are `src/app/**` and `src/ui/**`, and they get the canvas and
 * nothing else useful. The rigs, the loop and the interpolation are internals:
 * exporting them would invite a HUD component to reach in and read a transform,
 * which is how a render layer starts driving gameplay.
 *
 * Everything under here may import `three` and `@react-three/*`. Nothing under
 * `src/game/sim/**` may import anything from this folder — enforced by
 * eslint.config.mjs and proved by `tests/sim/layering.test.ts`.
 */

export { GameCanvas, type GameCanvasProps } from "./GameCanvas";

export {
  Quality,
  QUALITY_TIERS,
  getQuality,
  parseQualityOverride,
  readDeviceProfile,
  resetQuality,
  resolveQuality,
  setQuality,
  type DeviceProfile,
  type QualitySettings,
  type QualityTier,
} from "./perf/quality";

export { createEventDrain, type DrainedEvent, type EventDrain, type EventListener } from "./events";

export {
  AnimationState,
  animationForPhase,
  createRenderView,
  damp,
  lerp,
  lerpAngle,
  readInterpolated,
  saturate,
  type AnimationStateValue,
  type RenderView,
} from "./interpolate";

export { fovForSpeed } from "./CameraRig";
export { TUNNEL_DRAW_CALLS } from "./Tunnel";
export { ENTITY_DRAW_CALLS, Bucket, BUCKET_COUNT, bucketFor } from "./EntityRenderer";
export { RUNNER_DRAW_CALLS } from "./animation/RunnerRig";
export { SPEED_LINE_DRAW_CALLS } from "./feel/SpeedLines";
export { PARTICLE_DRAW_CALLS } from "./vfx/ParticleSystem";

/**
 * The scene's draw calls, flat regardless of how many entities or particles are
 * live. **Measured**, not estimated: `tests/e2e/perf.spec.ts`.
 *
 * ```
 *   colour pass   4 tunnel faces + 4 obstacle buckets + 1 pickups + 1 runner = 10
 *   particles     1 instanced quad system, whatever the live count            =  1
 *   shadow pass   4 obstacle buckets + 1 runner                               =  5
 *                                                                     total    16
 * ```
 *
 * Two things worth knowing:
 *
 *   - **The shadow pass is the half that is easy to forget.** A shadow map is a
 *     second render of every *caster*, so `castShadow` costs two draw calls, not
 *     one. The first count of this was 10 and the measured figure came back 15.
 *   - **Speed lines are not in the total.** The field is one more instanced mesh,
 *     but it sets `visible = false` below `speedLineOnsetSpeed`, so it costs
 *     nothing at base speed and 1 call once the player is moving fast. Peak is
 *     therefore 17, not 16.
 *
 * The eleven-part runner and the whole particle system are one call each — that
 * is what instancing buys, and it is why the budget still has ~83 spare for
 * post-FX, Overdrive presentation and the Fracture debris.
 */
export const EXPECTED_DRAW_CALLS_COLOUR = 11;
export const EXPECTED_SHADOW_CASTERS = 5;
export const EXPECTED_DRAW_CALLS = EXPECTED_DRAW_CALLS_COLOUR + EXPECTED_SHADOW_CASTERS;
/** With the speed-line field visible, at speed. */
export const EXPECTED_DRAW_CALLS_AT_SPEED = EXPECTED_DRAW_CALLS + 1;
