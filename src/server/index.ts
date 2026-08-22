/**
 * The server layer's public surface.
 *
 * `src/app/api/**` imports from here and from nowhere deeper. That keeps every
 * route file a thin adapter — parse, call, map — and means the whole trust
 * boundary can be tested without an HTTP server, which is why the P12 suite runs
 * in milliseconds rather than needing a listening port.
 */

export { SERVER_CONFIG } from "./config";
export { randomId, randomSeed, sign, verifySigned, usingEphemeralSecret } from "./crypto";
export { Reason, statusFor, ok, refuse, type Refusal, type Result } from "./errors";

export {
  addFriendByCode,
  issueSession,
  readSession,
  resolveSession,
  sanitiseDisplayName,
  upgradeToAccount,
  SESSION_COOKIE,
  type ResolvedSession,
} from "./identity";

export {
  parseScope,
  periodFor,
  readBoard,
  readRanks,
  type BoardQuery,
  type LeaderboardView,
  type RankSummary,
} from "./leaderboard";

export { ALL_TIME_PERIOD, periodKeysFor, utcDayKey, utcWeekKey, type PeriodKeys } from "./period";

export {
  createRateLimiter,
  identityLimiter,
  ipLimiter,
  resetAllLimiters,
  submitLimiter,
  type RateLimiter,
  type RateLimitVerdict,
} from "./ratelimit";

export { isCloudSave, reconcile, type ReconcileReport } from "./save";
export { newRunId, submitRun, type SubmitOutcome, type SubmitRequest } from "./submit";
export {
  consumeRunToken,
  issueRunToken,
  peekRunToken,
  type IssuedRunToken,
  type RunTokenPayload,
} from "./token";

export {
  ALLOWED_FIELDS,
  recordEvents,
  sanitiseEvent,
  TelemetryKind,
  type RawTelemetryEvent,
  type TelemetryKindValue,
} from "./telemetry";

export {
  analyseDensity,
  checkWallClock,
  ImplausibleReason,
  type DensityReport,
  type ImplausibleReasonValue,
} from "./validation/density";

export {
  createValidationQueue,
  validationQueue,
  type QueueStats,
  type ValidationQueue,
} from "./validation/queue";

export {
  MAX_REPLAY_BYTES,
  validateSubmission,
  Verdict,
  type ValidationRequest,
  type ValidationResult,
  type VerdictValue,
} from "./validation/validate";

export {
  clientAddress,
  contextFor,
  guarded,
  jsonResponse,
  readCookie,
  readJson,
  refusalResponse,
  type RequestContext,
} from "./http";

export { createFileStore, createMemoryStore, getStore, setStore } from "./store";
export {
  BoardScope,
  type BoardEntry,
  type BoardPage,
  type BoardScopeValue,
  type CloudSave,
  type PlayerRecord,
  type RunRecord,
  type Store,
  type TelemetryEvent,
} from "./store/types";
