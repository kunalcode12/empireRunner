/**
 * `POST /api/telemetry` — anonymous balance events.
 *
 * Item 6. Consent-gated, no PII, and both of those are properties of the code
 * rather than promises about it:
 *
 *   - Consent is checked in `server/telemetry.ts`, not here, so no future route
 *     can reach the store without passing it.
 *   - Every accepted field is a NUMBER from a closed allowlist. There is nowhere
 *     in an event to put a string, so there is nowhere to put an email, a name,
 *     a device fingerprint or a file path.
 *
 * `docs/PRIVACY.md` describes exactly this. If the two disagree, the code is
 * wrong — a privacy note that does not match the implementation is a promise
 * being broken in writing.
 */

import {
  contextFor,
  guarded,
  jsonResponse,
  readJson,
  recordEvents,
  refusalResponse,
} from "@/server";

export const dynamic = "force-dynamic";

interface TelemetryBody {
  readonly events?: unknown;
}

export const POST = guarded(async (request: Request): Promise<Response> => {
  const context = await contextFor(request);
  if (!context.ok) {
    return refusalResponse(context);
  }
  const { session, store } = context.value;

  const body = await readJson<TelemetryBody>(request);
  if (!body.ok) {
    return refusalResponse(body);
  }

  const events = Array.isArray(body.value.events) ? body.value.events : [];
  const result = await recordEvents(
    session.player.playerId,
    session.player.telemetryConsent,
    events,
    store,
  );

  if (!result.ok) {
    return refusalResponse(result);
  }

  return jsonResponse({ ok: true, ...result.value }, session);
});
