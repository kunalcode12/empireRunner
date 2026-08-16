/**
 * Public surface of the deterministic simulation.
 *
 * Consumers — the render bridge (P05), the audio graph (P11), the replay
 * endpoint (P12) — import from here rather than reaching into individual files.
 *
 * Everything below runs headless under Node. Nothing in this subtree imports
 * react, three, @react-three/*, zustand, or the DOM; eslint.config.mjs fails the
 * build if it ever does, and tests/sim/layering.test.ts proves the rule fires.
 */

export { createSim, INITIAL_WORLD_SPEED, type Sim } from "./sim";

export {
  addF,
  copyState,
  createState,
  F,
  FLOAT_SLOTS,
  getF,
  resetState,
  RunStatus,
  setF,
  Verb,
  type EntityColumns,
  type FloatSlot,
  type PlayerState,
  type RngSeeds,
  type RunStatusValue,
  type SimState,
  type VerbValue,
} from "./state";

export {
  clearIntent,
  copyIntent,
  createIntent,
  IDLE_INTENT,
  Lateral,
  Roll,
  sanitizeIntent,
  type Intent,
  type LateralValue,
  type RollValue,
} from "./intent";

export { advance, createClock, resetClock, resync, type Clock } from "./clock";

export {
  accountForDropped,
  clampCursor,
  createEventRing,
  emit,
  eventPayloadAt,
  eventTickAt,
  eventTypeAt,
  oldestReadable,
  resetEventRing,
  SimEvent,
  type EventRing,
  type SimEventValue,
} from "./events";

export {
  createRng,
  deserializeRng,
  forkRng,
  forkSeed,
  nextBool,
  nextFloat,
  nextInt,
  nextRange,
  nextU32,
  RNG_STREAMS,
  RNG_U32_MAX,
  serializeRng,
  type RngState,
  type RngStreamName,
} from "./rng";

export {
  acquire,
  acquireIndex,
  acquireWithIndex,
  createIndexPool,
  createPool,
  hasCapacity,
  peek,
  PoolExhaustedError,
  PoolReleaseError,
  release,
  releaseIndex,
  resetIndexPool,
  resetPool,
  type IndexPool,
  type Pool,
} from "./pool";

export { formatHash, hashState } from "./hash";

export {
  createRecorder,
  packIntent,
  parseReplay,
  record,
  ReplayRejection,
  resetRecorder,
  serializeReplay,
  unpackIntent,
  verify,
  type ParseResult,
  type Recorder,
  type ReplayHeader,
  type ReplayRejectionValue,
  type VerifyResult,
} from "./replay";
