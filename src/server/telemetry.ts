/**
 * Telemetry. Item 6: "anonymous run events for balance work. Consent-gated, no
 * PII, documented in a privacy note."
 *
 * The privacy note is `docs/PRIVACY.md`, and it describes exactly this file. If
 * the two ever disagree, this file is wrong — a privacy document that does not
 * match the code is worse than none, because it is a promise being broken in
 * writing.
 *
 * ## No PII is a property of the SHAPE, not of the discipline
 *
 * Every accepted field is a **number**, from a **closed vocabulary**. There is
 * nowhere in a telemetry event to put a string, so there is nowhere to put an
 * email address, a display name, a device fingerprint or a stack trace with a
 * file path in it. That is a much stronger guarantee than "we agreed not to send
 * those", because it survives the next person who adds a field in a hurry.
 *
 * The one identifier attached is the anonymous `playerId`, which is needed to
 * bound per-player retention and to distinguish "one player died 500 times" from
 * "500 players died once" — a distinction the entire point of balance telemetry
 * rests on. It is not linked to a person unless that player later chooses to
 * upgrade to an account.
 *
 * ## Consent is checked here, not at the route
 *
 * A consent check in a route handler is a consent check somebody can forget to
 * copy into the next route handler. `recordEvents` refuses without it, so every
 * path into telemetry is gated by construction.
 *
 * ## Timestamps are the server's
 *
 * A client-supplied timestamp is both untrusted and unnecessary, and it is a
 * fingerprinting vector — clock skew is surprisingly identifying. The server
 * stamps arrival time and drops whatever the client claimed.
 */

import { SERVER_CONFIG } from "./config";
import { refuse, ok, Reason, type Result } from "./errors";
import type { Store, TelemetryEvent } from "./store/types";

/**
 * The closed vocabulary of event kinds.
 *
 * Exactly the six the brief names, and nothing else is accepted. An unknown kind
 * is dropped rather than stored: an open vocabulary is how a "temporary" debug
 * event with a URL in it ends up in a telemetry table forever.
 */
export const TelemetryKind = {
  /** A run ended. Carries distance, the killing obstacle, Flow at death. */
  RunEnd: "run-end",
  /** Overdrive was entered. Rate is derived from this against `RunEnd`. */
  Overdrive: "overdrive",
  /** A Fracture was attempted, and whether it was survived. */
  Fracture: "fracture",
  /** A play session started. Session length is derived from this. */
  SessionStart: "session-start",
  /** A play session ended. */
  SessionEnd: "session-end",
} as const;
export type TelemetryKindValue = (typeof TelemetryKind)[keyof typeof TelemetryKind];

/**
 * The numeric fields each kind may carry.
 *
 * Anything not listed is dropped. This is the allowlist that makes "no PII" a
 * structural property rather than a policy.
 */
const ALLOWED_FIELDS: Readonly<Record<TelemetryKindValue, readonly string[]>> = Object.freeze({
  [TelemetryKind.RunEnd]: Object.freeze([
    /** m — how far they got. The headline balance number. */
    "distance",
    /** Entity id from `config/entities.ts`. Which obstacle killed them. */
    "killedBy",
    /** 0-100 — Flow at the moment of death. */
    "flow",
    /** Server-authoritative score is stored on the run; this is the client's
     *  own, useful only for spotting desync between the two populations. */
    "score",
    /** How long the run lasted, in ticks. */
    "ticks",
    /** Which theme they died in. Ordinal. */
    "theme",
  ]),
  [TelemetryKind.Overdrive]: Object.freeze(["distance", "flow", "durationTicks"]),
  [TelemetryKind.Fracture]: Object.freeze([
    "distance",
    /** 1 survived, 0 not. Fracture success rate is the mean of this. */
    "survived",
    /** Which verb was required. */
    "verb",
    /** How many Fractures had already been used this run. */
    "index",
  ]),
  [TelemetryKind.SessionStart]: Object.freeze([]),
  [TelemetryKind.SessionEnd]: Object.freeze([
    /** s — session length. The retention number. */
    "durationSeconds",
    /** How many runs were played. */
    "runs",
  ]),
});

/** A client-submitted event, before it has been believed. */
export interface RawTelemetryEvent {
  readonly kind?: unknown;
  readonly values?: unknown;
}

function isKnownKind(value: unknown): value is TelemetryKindValue {
  return typeof value === "string" && value in ALLOWED_FIELDS;
}

/**
 * Strips one event down to its allowlisted numeric fields.
 *
 * Returns null for anything with an unknown kind. Never throws: this runs on
 * arbitrary client input, and an exception here would turn a malformed batch
 * into a 500.
 */
export function sanitiseEvent(raw: RawTelemetryEvent, at: number): TelemetryEvent | null {
  if (!isKnownKind(raw.kind)) {
    return null;
  }
  const allowed = ALLOWED_FIELDS[raw.kind];
  const values: Record<string, number> = {};

  if (typeof raw.values === "object" && raw.values !== null && !Array.isArray(raw.values)) {
    const source = raw.values as Record<string, unknown>;
    for (const field of allowed) {
      const value = source[field];
      // Numbers only, finite only. A string that looks like a number is still a
      // string and is still a place someone could put text.
      if (typeof value === "number" && Number.isFinite(value)) {
        values[field] = value;
      }
    }
  }

  // The SERVER's clock. See the header.
  return { kind: raw.kind, at, values };
}

/**
 * Accepts a batch of events for a consenting player.
 *
 * Refuses outright without consent — it does not silently discard, because a
 * client that believes it is sending telemetry and is not should be told, and a
 * client that has not asked for consent should fail loudly in development.
 */
export async function recordEvents(
  playerId: string,
  consent: boolean,
  raw: readonly RawTelemetryEvent[],
  store: Store,
  now: number = Date.now(),
): Promise<Result<{ accepted: number; dropped: number }>> {
  if (!consent) {
    return refuse(Reason.ConsentRequired, "Telemetry consent has not been given.");
  }

  if (raw.length > SERVER_CONFIG.telemetry.maxBatchSize) {
    return refuse(Reason.BadRequest, "Telemetry batch is too large.");
  }

  const events: TelemetryEvent[] = [];
  for (const candidate of raw) {
    const clean = sanitiseEvent(candidate, now);
    if (clean !== null) {
      events.push(clean);
    }
  }

  if (events.length > 0) {
    await store.appendTelemetry(playerId, events);
  }

  return ok({ accepted: events.length, dropped: raw.length - events.length });
}

/** The allowlist, exported so the privacy note's claims can be tested. */
export { ALLOWED_FIELDS };
