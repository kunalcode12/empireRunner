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
 * The scene's total draw calls, counted rather than measured.
 *
 * 4 tunnel faces + 4 obstacle buckets + 1 pickup mesh + 1 player = 10, flat,
 * regardless of how many entities are live. Against a budget of 100 that leaves
 * 90 for everything P07 through P14 adds — which is the point of counting it
 * here rather than discovering it later.
 */
export const EXPECTED_DRAW_CALLS = 10;
