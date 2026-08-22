/**
 * Signing, comparison and encoding. The only file that touches `node:crypto`.
 *
 * ## Nothing here is invented
 *
 * HMAC-SHA256 from the standard library, `timingSafeEqual` from the standard
 * library, `randomBytes` from the standard library. There is no bespoke
 * primitive in this file and there should never be one — a hand-rolled MAC is
 * the single most reliable way to turn a working auth system into a broken one,
 * and the failure is silent.
 *
 * What this file DOES own is the shape: a signed payload is
 * `base64url(json) + "." + base64url(mac)`, the MAC covers the encoded payload
 * rather than the raw object, and verification is constant-time. Those three
 * choices are where signing schemes usually go wrong.
 *
 * ## The MAC covers the ENCODED payload, not the object
 *
 * Signing `JSON.stringify(payload)` and then re-stringifying on the way out
 * makes the signature depend on key order, which depends on the engine. Signing
 * the exact bytes that travel means verification compares the exact bytes that
 * arrived, and no serialiser sits between the two.
 *
 * ## Why `timingSafeEqual` and not `===`
 *
 * String comparison short-circuits on the first differing byte, so the time it
 * takes leaks how many leading bytes were right. That is enough to forge a MAC
 * one byte at a time given enough attempts, and a public submit endpoint offers
 * exactly that. It is a small function to get right and a very bad one to skip.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The signing key.
 *
 * Read once at module load. A process that starts without one is a process
 * whose tokens anybody can mint, so the fallback is loud and random rather than
 * quiet and fixed: a hardcoded development default that someone forgets to
 * override in production is worse than no default at all, because it *works*.
 *
 * Random-per-boot means dev and test always function, and any environment that
 * runs more than one instance discovers the problem immediately — tokens issued
 * by one process are rejected by another — instead of shipping a known key.
 */
function loadSecret(): Buffer {
  const fromEnv = process.env["AXIS_SIGNING_SECRET"];
  const MIN_SECRET_BYTES = 32;

  if (fromEnv !== undefined && fromEnv.length >= MIN_SECRET_BYTES) {
    return Buffer.from(fromEnv, "utf8");
  }

  if (fromEnv !== undefined && fromEnv.length > 0) {
    throw new Error(
      `AXIS_SIGNING_SECRET is ${fromEnv.length} characters; at least ${MIN_SECRET_BYTES} are required.`,
    );
  }

  return randomBytes(MIN_SECRET_BYTES);
}

const SECRET = loadSecret();

/** True when the process is running on a throwaway per-boot key. */
export const usingEphemeralSecret = process.env["AXIS_SIGNING_SECRET"] === undefined;

/** base64url, no padding. The token alphabet — URL and cookie safe. */
export function encodeBase64Url(bytes: Uint8Array | string): string {
  const buffer = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : Buffer.from(bytes);
  return buffer.toString("base64url");
}

/** Decodes base64url to bytes. Returns null on anything malformed. */
export function decodeBase64Url(value: string): Buffer | null {
  // Buffer.from is famously permissive — it ignores invalid characters rather
  // than failing — so the shape is checked first. Otherwise "!!!!" decodes to an
  // empty buffer and reads as a valid empty payload.
  if (!/^[A-Za-z0-9_-]*$/.test(value)) {
    return null;
  }
  try {
    return Buffer.from(value, "base64url");
  } catch {
    return null;
  }
}

/** HMAC-SHA256 of an encoded payload, as base64url. */
function mac(encodedPayload: string): string {
  return createHmac("sha256", SECRET).update(encodedPayload).digest("base64url");
}

/**
 * Signs a JSON-serialisable payload.
 *
 * The result is `payload.signature`, both base64url. This is a signed envelope,
 * **not** encryption: the payload is readable by anyone holding the token. That
 * is intentional and the payloads are chosen accordingly — a seed, an expiry, a
 * nonce. Nothing in a token is a secret; the guarantee is that it cannot be
 * *changed*.
 */
export function sign(payload: unknown): string {
  const encoded = encodeBase64Url(JSON.stringify(payload));
  return `${encoded}.${mac(encoded)}`;
}

/**
 * Verifies and decodes a signed envelope.
 *
 * Returns `null` for every failure — bad shape, bad signature, unparseable
 * payload — and deliberately does not say which. A caller that could
 * distinguish "signature wrong" from "payload malformed" would leak that
 * distinction onward to an attacker, and no legitimate client benefits from
 * knowing.
 */
export function verifySigned<T>(token: string): T | null {
  const separator = token.lastIndexOf(".");
  if (separator <= 0 || separator === token.length - 1) {
    return null;
  }

  const encoded = token.slice(0, separator);
  const provided = token.slice(separator + 1);
  const expected = mac(encoded);

  const providedBytes = Buffer.from(provided, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  // `timingSafeEqual` throws on a length mismatch rather than returning false,
  // and the lengths are public information anyway (the MAC is fixed width).
  if (providedBytes.length !== expectedBytes.length) {
    return null;
  }
  if (!timingSafeEqual(providedBytes, expectedBytes)) {
    return null;
  }

  const decoded = decodeBase64Url(encoded);
  if (decoded === null) {
    return null;
  }

  try {
    return JSON.parse(decoded.toString("utf8")) as T;
  } catch {
    return null;
  }
}

/** A cryptographically random identifier, base64url. */
export function randomId(byteLength = 16): string {
  return randomBytes(byteLength).toString("base64url");
}

/**
 * A random uint32 for use as a run seed.
 *
 * `randomBytes`, not `Math.random`. The seed decides the entire generated track,
 * so a predictable one lets a player compute the layout ahead of time and defeats
 * the point of the server issuing it at all.
 */
export function randomSeed(): number {
  return randomBytes(4).readUInt32LE(0);
}
