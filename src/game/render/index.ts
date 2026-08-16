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
export { PLAYER_DRAW_CALLS } from "./PlayerRig";

export { seedWorldFromGenerator, devSeedingEnabled, type DevSeedOptions } from "./devSeed";

/**
 * The scene's draw calls, flat regardless of how many entities are live.
 *
 * ```
 *   colour pass   4 tunnel faces + 4 obstacle buckets + 1 pickups + 1 player = 10
 *   shadow pass   4 obstacle buckets + 1 player                              =  5
 *                                                                    total    15
 * ```
 *
 * **The shadow pass is the half that is easy to forget.** A shadow map is a
 * second render of every *caster* from the light's point of view, so enabling
 * `castShadow` on a mesh costs two draw calls, not one. The first count of this
 * was 10 and the measured figure came back 15 — the difference is exactly the
 * five casters. Worth stating plainly, because the instinct when adding geometry
 * is to count it once.
 *
 * The tunnel only receives shadow and never casts it, which is why it does not
 * appear in the second row. On LOW the shadow pass is off entirely and the
 * scene costs 10.
 *
 * Against a budget of 100 desktop / 50 mobile, that leaves 85 and 35 for
 * everything P07 through P14 adds. Measured, not estimated:
 * `tests/e2e/perf.spec.ts`.
 */
export const EXPECTED_DRAW_CALLS_COLOUR = 10;
export const EXPECTED_SHADOW_CASTERS = 5;
export const EXPECTED_DRAW_CALLS = EXPECTED_DRAW_CALLS_COLOUR + EXPECTED_SHADOW_CASTERS;
