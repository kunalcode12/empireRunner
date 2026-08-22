/**
 * Telemetry: consent, and the "no PII" claim in `docs/PRIVACY.md`.
 *
 * The privacy note makes a promise to players. These tests are what keep it
 * true — a privacy document that does not match the code is worse than none,
 * because it is a promise being broken in writing.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { ALLOWED_FIELDS, recordEvents, sanitiseEvent, TelemetryKind, type Store } from "@/server";
import { freshStore } from "./helpers";

let store: Store;
const NOW = 1_700_000_000_000;

beforeEach(() => {
  store = freshStore();
});

describe("consent gating", () => {
  it("refuses without consent", async () => {
    const player = await store.createPlayer("no consent");
    const result = await recordEvents(
      player.playerId,
      false,
      [{ kind: TelemetryKind.RunEnd, values: { distance: 100 } }],
      store,
      NOW,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("consent-required");
    }
    expect(await store.readTelemetry(player.playerId)).toHaveLength(0);
  });

  it("accepts with consent", async () => {
    const player = await store.createPlayer("consenting");
    const result = await recordEvents(
      player.playerId,
      true,
      [{ kind: TelemetryKind.RunEnd, values: { distance: 100, flow: 42 } }],
      store,
      NOW,
    );

    expect(result.ok).toBe(true);
    expect(await store.readTelemetry(player.playerId)).toHaveLength(1);
  });

  it("refuses rather than silently discarding", async () => {
    // A client that believes it is sending telemetry and is not should be told.
    // Silent discard is how a consent bug survives to production.
    const player = await store.createPlayer("x");
    const result = await recordEvents(player.playerId, false, [], store, NOW);
    expect(result.ok).toBe(false);
  });
});

describe("no PII is structural, not a policy", () => {
  it("drops every non-numeric field", async () => {
    const event = sanitiseEvent(
      {
        kind: TelemetryKind.RunEnd,
        values: {
          distance: 500,
          // None of these are in the allowlist, and none of them are numbers.
          email: "player@example.com",
          displayName: "Real Name",
          userAgent: "Mozilla/5.0",
          stack: "/Users/someone/axis/src/game/sim.ts:42",
          ip: "203.0.113.7",
        },
      },
      NOW,
    );

    expect(event).not.toBeNull();
    expect(Object.keys(event?.values ?? {})).toEqual(["distance"]);
    // Every stored value is a number, so there is nowhere to put text at all.
    for (const value of Object.values(event?.values ?? {})) {
      expect(typeof value).toBe("number");
    }
  });

  it("drops an allowlisted field carrying a string", async () => {
    // "42" is a string that looks like a number, and it is still a place
    // somebody could put text.
    const event = sanitiseEvent({ kind: TelemetryKind.RunEnd, values: { distance: "42" } }, NOW);
    expect(event?.values["distance"]).toBeUndefined();
  });

  it("drops non-finite numbers", () => {
    const event = sanitiseEvent(
      {
        kind: TelemetryKind.RunEnd,
        values: { distance: Number.NaN, flow: Number.POSITIVE_INFINITY },
      },
      NOW,
    );
    expect(Object.keys(event?.values ?? {})).toHaveLength(0);
  });

  it("rejects an unknown event kind entirely", () => {
    // An open vocabulary is how a "temporary" debug event with a URL in it ends
    // up in a telemetry table forever.
    expect(sanitiseEvent({ kind: "debug-dump", values: { anything: 1 } }, NOW)).toBeNull();
    expect(sanitiseEvent({ kind: 42, values: {} }, NOW)).toBeNull();
    expect(sanitiseEvent({}, NOW)).toBeNull();
  });

  it("uses the SERVER's timestamp, never the client's", () => {
    const event = sanitiseEvent(
      // A client-supplied timestamp is untrusted, unnecessary, and a
      // fingerprinting vector — clock skew is surprisingly identifying.
      { kind: TelemetryKind.SessionStart, values: { at: 12345 } },
      NOW,
    );
    expect(event?.at).toBe(NOW);
  });

  it("covers exactly the six signals the brief names", () => {
    const kinds = Object.keys(ALLOWED_FIELDS);
    expect(kinds).toContain(TelemetryKind.RunEnd);
    expect(kinds).toContain(TelemetryKind.Overdrive);
    expect(kinds).toContain(TelemetryKind.Fracture);
    expect(kinds).toContain(TelemetryKind.SessionStart);
    expect(kinds).toContain(TelemetryKind.SessionEnd);

    // distance at death, obstacle that killed, Flow at death
    expect(ALLOWED_FIELDS[TelemetryKind.RunEnd]).toContain("distance");
    expect(ALLOWED_FIELDS[TelemetryKind.RunEnd]).toContain("killedBy");
    expect(ALLOWED_FIELDS[TelemetryKind.RunEnd]).toContain("flow");
    // Fracture success rate
    expect(ALLOWED_FIELDS[TelemetryKind.Fracture]).toContain("survived");
    // session length
    expect(ALLOWED_FIELDS[TelemetryKind.SessionEnd]).toContain("durationSeconds");
  });

  it("allows no string field anywhere in the vocabulary", () => {
    // The structural guarantee, asserted against the table itself: if a future
    // field is added that could hold text, this is where it is caught.
    for (const [kind, fields] of Object.entries(ALLOWED_FIELDS)) {
      const event = sanitiseEvent(
        { kind, values: Object.fromEntries(fields.map((f) => [f, "text"])) },
        NOW,
      );
      expect(Object.keys(event?.values ?? {}), `${kind} accepted a string`).toHaveLength(0);
    }
  });
});

describe("batching", () => {
  it("refuses an oversized batch", async () => {
    const player = await store.createPlayer("spammer");
    const huge = Array.from({ length: 500 }, () => ({
      kind: TelemetryKind.RunEnd,
      values: { distance: 1 },
    }));

    const result = await recordEvents(player.playerId, true, huge, store, NOW);
    expect(result.ok).toBe(false);
  });

  it("reports how many were dropped", async () => {
    const player = await store.createPlayer("mixed");
    const result = await recordEvents(
      player.playerId,
      true,
      [
        { kind: TelemetryKind.RunEnd, values: { distance: 1 } },
        { kind: "unknown", values: {} },
        { kind: TelemetryKind.Overdrive, values: { distance: 2 } },
      ],
      store,
      NOW,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.accepted).toBe(2);
      expect(result.value.dropped).toBe(1);
    }
  });

  it("bounds retention per player", async () => {
    const player = await store.createPlayer("prolific");
    const BATCH = 40;
    // Telemetry is for balance work, not history.
    for (let i = 0; i < 20; i += 1) {
      await recordEvents(
        player.playerId,
        true,
        Array.from({ length: BATCH }, () => ({
          kind: TelemetryKind.RunEnd,
          values: { distance: i },
        })),
        store,
        NOW,
      );
    }
    const stored = await store.readTelemetry(player.playerId);
    expect(stored.length).toBeLessThanOrEqual(500);
  });
});
