/**
 * Shared route plumbing, so route files stay thin enough to read at a glance.
 *
 * ## Every route does the same four things in the same order
 *
 * Read the client address, check the IP rate limit, resolve the session, parse
 * the body. Duplicated across eight route files, that is eight places for the
 * order to be subtly different — and the order matters: rate-limiting *after*
 * parsing means a flood still pays the parse cost, and resolving a session
 * *before* the IP check means a flood still mints identities.
 *
 * ## Body size is capped before parsing, which is the only place it helps
 *
 * `await request.json()` on a 2GB body buffers 2GB first and then tells you it
 * was too big. The `Content-Length` check below happens before a byte is read.
 * It is not airtight — a chunked request without the header slips past it — so
 * the parsed result is length-checked too, but it turns the common case from a
 * memory spike into a rejection.
 */

import { SERVER_CONFIG } from "./config";
import { refuse, ok, statusFor, Reason, type Refusal, type Result } from "./errors";
import { resolveSession, SESSION_COOKIE, type ResolvedSession } from "./identity";
import { ipLimiter } from "./ratelimit";
import { getStore } from "./store";
import type { Store } from "./store/types";

/**
 * The caller's address.
 *
 * `x-forwarded-for` is a client-settable header, so this is only trustworthy
 * behind a proxy that overwrites it — which is every real deployment and is not
 * `next dev`. The consequence is worth naming: **per-IP rate limiting is
 * defeatable locally**, and depends on the edge being configured to strip
 * inbound forwarding headers. That is a deployment note, not something this
 * function can fix.
 *
 * The leftmost entry is taken, which is the original client per the spec, and
 * the value is truncated so a header full of commas cannot become a memory
 * amplification through the rate limiter's key map.
 */
export function clientAddress(request: Request): string {
  const MAX_KEY_LENGTH = 64;
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded !== null && forwarded !== "") {
    const first = forwarded.split(",")[0]?.trim() ?? "";
    if (first !== "") {
      return first.slice(0, MAX_KEY_LENGTH);
    }
  }
  return request.headers.get("x-real-ip")?.slice(0, MAX_KEY_LENGTH) ?? "unknown";
}

/** Reads one cookie without a parser dependency. */
export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie");
  if (header === null) {
    return undefined;
  }
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) {
      continue;
    }
    if (part.slice(0, separator).trim() === name) {
      return decodeURIComponent(part.slice(separator + 1).trim());
    }
  }
  return undefined;
}

/** Everything a route needs, resolved once. */
export interface RequestContext {
  readonly address: string;
  readonly session: ResolvedSession;
  readonly store: Store;
}

/**
 * Resolves the context, applying the per-IP limit first.
 *
 * Returns a `Refusal` rather than throwing so the route's control flow stays a
 * plain `if`.
 */
export async function contextFor(request: Request): Promise<Result<RequestContext>> {
  const address = clientAddress(request);

  const verdict = ipLimiter.take(address);
  if (!verdict.allowed) {
    return refuse(Reason.RateLimited, "Too many requests.", verdict.retryAfterSeconds);
  }

  const store = getStore();
  const session = await resolveSession(readCookie(request, SESSION_COOKIE), store);
  return ok({ address, session, store });
}

/** Parses a JSON body, capped. */
export async function readJson<T>(request: Request): Promise<Result<T>> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number.parseInt(declared, 10);
    if (Number.isFinite(length) && length > SERVER_CONFIG.maxBodyBytes) {
      return refuse(Reason.BadRequest, "Request body is too large.");
    }
  }

  let text: string;
  try {
    text = await request.text();
  } catch {
    return refuse(Reason.BadRequest, "Could not read the request body.");
  }

  // The backstop for a chunked request with no Content-Length.
  if (text.length > SERVER_CONFIG.maxBodyBytes) {
    return refuse(Reason.BadRequest, "Request body is too large.");
  }

  try {
    return ok(JSON.parse(text) as T);
  } catch {
    return refuse(Reason.BadRequest, "Request body is not valid JSON.");
  }
}

/** Turns a refusal into a response, with the right status and headers. */
export function refusalResponse(refusal: Refusal): Response {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (refusal.retryAfterSeconds !== undefined) {
    headers["retry-after"] = String(refusal.retryAfterSeconds);
  }
  return new Response(
    JSON.stringify({ ok: false, reason: refusal.reason, message: refusal.message }),
    { status: statusFor(refusal.reason), headers },
  );
}

/**
 * A success response, attaching the session cookie when one was just minted.
 *
 * `httpOnly` so script cannot read it, `sameSite=lax` so it survives a normal
 * navigation but is not sent on cross-site POSTs, and `secure` outside
 * development because a session token on plain HTTP is a session token in
 * everybody's logs.
 */
export function jsonResponse(body: unknown, session: ResolvedSession, status = 200): Response {
  const headers: Record<string, string> = { "content-type": "application/json" };

  if (session.token !== null && session.expiresAt !== null) {
    const maxAge = Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000));
    const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
    headers["set-cookie"] =
      `${SESSION_COOKIE}=${encodeURIComponent(session.token)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`;
  }

  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * Wraps a handler so an unexpected throw becomes a 500 rather than a stack
 * trace on the wire.
 *
 * The error is logged server-side and deliberately not echoed: an exception
 * message can carry a file path, a query, or a fragment of somebody else's data.
 */
export function guarded(handler: (request: Request) => Promise<Response>) {
  return async function handle(request: Request): Promise<Response> {
    try {
      return await handler(request);
    } catch (error) {
      console.error("[axis] unhandled route error", error);
      return refusalResponse(refuse(Reason.Internal, "Something went wrong."));
    }
  };
}
