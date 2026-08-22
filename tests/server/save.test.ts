/**
 * Cloud save reconciliation. "Conflict resolution must be tested, not assumed."
 *
 * The headline case is the one that ruins a player's relationship with a game
 * permanently: they earn 8,000 Bits on a phone, open a tablet that has been
 * asleep for a week, and the stale save syncs up and takes the Bits away. It is
 * unrecoverable and unprovable, and it is what last-write-wins alone produces.
 */

import { describe, expect, it } from "vitest";
import { isCloudSave, reconcile, type CloudSave } from "@/server";

function save(
  updatedAt: number,
  currencies: Record<string, number>,
  payload: Record<string, unknown> = {},
): CloudSave {
  return { version: 3, updatedAt, currencies, payload };
}

describe("monotonic currency", () => {
  it("NEVER lets a sync reduce a balance", () => {
    const stored = save(2000, { bits: 8000, shards: 9 });
    const staleDevice = save(1000, { bits: 120, shards: 0 });

    const { merged, protectedCurrencies } = reconcile(stored, staleDevice);

    expect(merged.currencies["bits"]).toBe(8000);
    expect(merged.currencies["shards"]).toBe(9);
    // Recorded, not just applied — a silent protection is indistinguishable from
    // a bug when somebody asks why the numbers differ.
    expect([...protectedCurrencies].sort()).toEqual(["bits", "shards"]);
  });

  it("protects the balance even when the incoming save is NEWER", () => {
    // This is the case that matters and the one a naive implementation gets
    // wrong: newest wins for preferences, but a currency is a count of what was
    // earned and "newest" is not "correct".
    const stored = save(1000, { bits: 8000 });
    const newerButPoorer = save(9999, { bits: 5 });

    const { merged, tookRemotePayload } = reconcile(stored, newerButPoorer);

    expect(merged.currencies["bits"]).toBe(8000);
    // The payload still follows last-write-wins.
    expect(tookRemotePayload).toBe(true);
  });

  it("takes a genuine increase", () => {
    const stored = save(1000, { bits: 100 });
    const earned = save(2000, { bits: 900 });
    expect(reconcile(stored, earned).merged.currencies["bits"]).toBe(900);
  });

  it("uses max rather than sum, so two devices cannot print currency", () => {
    // Summing looks fairer and duplicates money: two devices each holding the
    // same earned 5,000 would sync to 10,000.
    const stored = save(1000, { bits: 5000 });
    const other = save(2000, { bits: 5000 });
    expect(reconcile(stored, other).merged.currencies["bits"]).toBe(5000);
  });

  it("protects a currency this server has never seen", () => {
    // The union-of-keys rule. A currency added by a newer client is protected on
    // the day it arrives, with no change to this file.
    const stored = save(1000, { bits: 100, cores: 42 });
    const older = save(500, { bits: 100 });

    const { merged } = reconcile(stored, older);
    expect(merged.currencies["cores"]).toBe(42);
  });

  it("carries through a currency only the client has", () => {
    const stored = save(1000, { bits: 100 });
    const incoming = save(2000, { bits: 100, prisms: 7 });
    expect(reconcile(stored, incoming).merged.currencies["prisms"]).toBe(7);
  });

  it("treats a missing currency as zero rather than as a deletion", () => {
    const stored = save(1000, { bits: 500 });
    const incoming = save(2000, {});
    expect(reconcile(stored, incoming).merged.currencies["bits"]).toBe(500);
  });
});

describe("last-write-wins for the payload", () => {
  it("takes the newer payload", () => {
    const stored = save(1000, { bits: 10 }, { equippedAvatar: "ferro" });
    const incoming = save(2000, { bits: 10 }, { equippedAvatar: "kestrel" });

    const { merged, tookRemotePayload } = reconcile(stored, incoming);
    expect(merged.payload["equippedAvatar"]).toBe("kestrel");
    expect(tookRemotePayload).toBe(true);
  });

  it("keeps the stored payload when the incoming one is older", () => {
    const stored = save(2000, { bits: 10 }, { equippedAvatar: "ferro" });
    const incoming = save(1000, { bits: 10 }, { equippedAvatar: "kestrel" });

    const { merged, tookRemotePayload } = reconcile(stored, incoming);
    expect(merged.payload["equippedAvatar"]).toBe("ferro");
    expect(tookRemotePayload).toBe(false);
  });

  it("settles rather than flapping on an identical timestamp", () => {
    // A retry re-sends the same `updatedAt`. `>=` makes that idempotent; `>`
    // would leave two equally-old versions alternating.
    const stored = save(1000, { bits: 10 }, { a: 1 });
    const retry = save(1000, { bits: 10 }, { a: 2 });
    expect(reconcile(stored, retry).merged.payload["a"]).toBe(2);
    expect(reconcile(stored, retry).merged.payload["a"]).toBe(2);
  });

  it("never downgrades the schema version", () => {
    const stored = save(1000, { bits: 10 });
    const older: CloudSave = { version: 2, updatedAt: 5000, currencies: { bits: 10 }, payload: {} };
    expect(reconcile(stored, older).merged.version).toBe(3);
  });
});

describe("first sync", () => {
  it("accepts the client's save wholesale when there is nothing stored", () => {
    const incoming = save(1000, { bits: 50 }, { equippedAvatar: "ferro" });
    const { merged, protectedCurrencies } = reconcile(null, incoming);
    expect(merged).toEqual(incoming);
    expect(protectedCurrencies).toHaveLength(0);
  });
});

describe("validation", () => {
  it("accepts a well-formed save", () => {
    expect(isCloudSave(save(1, { bits: 0 }))).toBe(true);
  });

  it("rejects a NaN currency", () => {
    // A stored NaN is unrecoverable: every future `Math.max` against it is NaN
    // and every comparison is false, so the balance is permanently poisoned.
    expect(
      isCloudSave({ version: 1, updatedAt: 1, currencies: { bits: Number.NaN }, payload: {} }),
    ).toBe(false);
  });

  it("rejects an Infinity currency", () => {
    expect(
      isCloudSave({
        version: 1,
        updatedAt: 1,
        currencies: { bits: Number.POSITIVE_INFINITY },
        payload: {},
      }),
    ).toBe(false);
  });

  it("rejects a negative currency", () => {
    expect(isCloudSave({ version: 1, updatedAt: 1, currencies: { bits: -5 }, payload: {} })).toBe(
      false,
    );
  });

  it("rejects a string currency", () => {
    expect(
      isCloudSave({ version: 1, updatedAt: 1, currencies: { bits: "9999" }, payload: {} }),
    ).toBe(false);
  });

  it("rejects arrays where objects are required", () => {
    expect(isCloudSave({ version: 1, updatedAt: 1, currencies: [], payload: {} })).toBe(false);
    expect(isCloudSave({ version: 1, updatedAt: 1, currencies: {}, payload: [] })).toBe(false);
  });

  it("rejects junk", () => {
    expect(isCloudSave(null)).toBe(false);
    expect(isCloudSave("save")).toBe(false);
    expect(isCloudSave({})).toBe(false);
  });
});
