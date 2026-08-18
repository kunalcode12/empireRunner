import { describe, expect, it } from "vitest";
import { TUNING } from "@/game/config/tuning";
import { foldLedger } from "@/game/meta/economy";
import {
  LATEST_VERSION,
  SAVE_KEY,
  createMemorySaveStorage,
  createSaveManager,
  freshSave,
  migrate,
  parseSave,
  serializeSave,
} from "@/game/meta/save";
import { UpgradeTrack } from "@/game/meta/upgrades";

const AT = Date.UTC(2026, 7, 19, 12, 0, 0);

/**
 * A schema-v1 save: plain balances, a single equipped boost.
 *
 * v1 and v2 never shipped to a player. They exist so the migration chain is
 * exercised by tests today rather than executed for the first time in
 * production, on someone's real save, on the day it matters.
 */
function saveV1(): Record<string, unknown> {
  return {
    version: 1,
    bits: 4_200,
    shards: 7,
    upgrades: { magnetDuration: 2, flowGain: 1, bitValue: 0, shieldCount: 3 },
    inventory: {
      consumables: { headStart: 4 },
      cosmetics: ["trail-ember"],
      avatars: ["ferro", "kestrel"],
      equippedAvatar: "kestrel",
      equippedBoost: "headStart",
    },
    lifetime: { distance: 91_000, runs: 88, bestScore: 41_000, bestDistance: 3_100 },
    onboarding: { seenFirstRun: true, seenRollPrompt: true },
  };
}

describe("migration v1 -> latest", () => {
  it("runs every step of the chain in order", () => {
    const { applied, data } = migrate(saveV1());
    // Both steps, not a jump straight to the current shape. A chain that skips
    // is a chain that has never really been tested.
    expect(applied).toEqual([1, 2]);
    expect(data.version).toBe(LATEST_VERSION);
  });

  it("carries the v1 balance across as an opening-balance transaction", () => {
    const { save } = parseSave(saveV1(), AT);
    expect(foldLedger(save.ledger)).toEqual({ bits: 4_200, shards: 7 });

    // Not a fabricated history — one entry that says exactly what it is.
    expect(save.ledger.entries.length).toBe(1);
    const entry = save.ledger.entries[0];
    expect(entry?.transaction.kind).toBe("opening-balance");
    if (entry?.transaction.kind === "opening-balance") {
      expect(entry.transaction.fromVersion).toBe(1);
    }
  });

  it("turns the single v2 boost into the two-slot loadout", () => {
    const { save } = parseSave(saveV1(), AT);
    expect(save.inventory.equippedBoosts).toEqual(["headStart"]);
  });

  it("keeps everything else the player owned", () => {
    const { save } = parseSave(saveV1(), AT);
    expect(save.upgrades[UpgradeTrack.MagnetDuration]).toBe(2);
    expect(save.upgrades[UpgradeTrack.ShieldCount]).toBe(3);
    expect(save.inventory.consumables.headStart).toBe(4);
    expect(save.inventory.equippedAvatar).toBe("kestrel");
    expect(save.inventory.cosmetics).toContain("trail-ember");
    expect(save.lifetime.distance).toBe(91_000);
    expect(save.onboarding.seenFirstRun).toBe(true);
  });

  it("a zero-balance v1 save migrates to an empty ledger, not a zero entry", () => {
    const empty = { ...saveV1(), bits: 0, shards: 0 };
    const { save } = parseSave(empty, AT);
    expect(save.ledger.entries.length).toBe(0);
  });

  it("stamps the current version on the result", () => {
    expect(parseSave(saveV1(), AT).save.version).toBe(LATEST_VERSION);
    expect(LATEST_VERSION).toBe(TUNING.meta.saveVersion);
  });

  it("is idempotent — migrating a current save changes nothing", () => {
    const current = JSON.parse(serializeSave(freshSave(AT))) as Record<string, unknown>;
    expect(migrate(current).applied).toEqual([]);
  });
});

describe("corrupted-save recovery", () => {
  /**
   * All three cases the prompt names. A save that fails to load is a permanent
   * uninstall: the player opens the game, sees zero Bits after fifty runs, and
   * deletes it. There is no recovery from that.
   */

  it("case 1 — truncated JSON recovers to a working save", () => {
    const truncated = serializeSave(freshSave(AT)).slice(0, 40);
    const parsed = parseSave(truncated, AT);

    expect(parsed.recovered).toBe(true);
    expect(parsed.repairs).toContain("json");
    expect(parsed.save.version).toBe(LATEST_VERSION);
    expect(foldLedger(parsed.save.ledger)).toEqual({ bits: 0, shards: 0 });
    expect(parsed.save.inventory.equippedAvatar).toBe("ferro");
  });

  it("case 2 — wrong types are repaired field by field", () => {
    const hostile = {
      version: LATEST_VERSION,
      ledger: "not a ledger",
      upgrades: { magnetDuration: "three", flowGain: null, bitValue: 99, shieldCount: -4 },
      inventory: {
        consumables: { headStart: "many", flowPrimer: 500 },
        cosmetics: "not an array",
        avatars: [42, "kestrel", "does-not-exist"],
        equippedAvatar: "does-not-exist",
        equippedBoosts: ["headStart", "headStart", "nope", "doubleBits", "flowPrimer"],
      },
      missions: [],
      lifetime: { distance: "far", runs: 1.9, bestScore: null },
      onboarding: "yes",
      avatarChallengesClaimed: [1, "vane"],
    };

    const parsed = parseSave(hostile, AT);
    const save = parsed.save;

    // A bad field costs that field, and nothing else.
    expect(parsed.recovered).toBe(false);
    expect(save.upgrades[UpgradeTrack.MagnetDuration]).toBe(0);
    expect(save.upgrades[UpgradeTrack.BitValue]).toBe(TUNING.economy.upgradeMaxTier);
    expect(save.upgrades[UpgradeTrack.ShieldCount]).toBe(0);

    // The stack cap is enforced against a hostile file.
    expect(save.inventory.consumables.flowPrimer).toBe(TUNING.meta.consumableStackCap);
    expect(save.inventory.consumables.headStart).toBeUndefined();

    // Unknown avatars are dropped and the default is always present.
    expect(save.inventory.avatars).toContain("ferro");
    expect(save.inventory.avatars).not.toContain("does-not-exist");
    expect(save.inventory.equippedAvatar).toBe("ferro");

    // "No loadout slots are ever sold" — enforced even here. Deduplicated,
    // filtered to known boosts, and truncated to the slot count.
    expect(save.inventory.equippedBoosts.length).toBeLessThanOrEqual(TUNING.meta.boostSlots);
    expect(save.inventory.equippedBoosts).not.toContain("nope");
    expect(new Set(save.inventory.equippedBoosts).size).toBe(save.inventory.equippedBoosts.length);

    expect(save.lifetime.distance).toBe(0);
    expect(save.lifetime.runs).toBe(1);
    expect(save.onboarding.seenFirstRun).toBe(false);
    expect(save.avatarChallengesClaimed).toEqual(["vane"]);
    expect(parsed.repairs.length).toBeGreaterThan(0);
  });

  it("case 3 — a version from the future keeps what this build understands", () => {
    const future = {
      ...JSON.parse(serializeSave(freshSave(AT))),
      version: LATEST_VERSION + 5,
      lifetime: { distance: 12_345, runs: 30, bestScore: 900, bestDistance: 800 },
      somethingNewerBuildsAdded: { nested: true },
    };

    const parsed = parseSave(future, AT);

    expect(parsed.fromVersion).toBe(LATEST_VERSION + 5);
    expect(parsed.repairs.some((r) => r.startsWith("version(future"))).toBe(true);
    // Wiping instead would punish a player for using two devices.
    expect(parsed.save.lifetime.distance).toBe(12_345);
    expect(parsed.save.lifetime.runs).toBe(30);
    expect(parsed.save.version).toBe(LATEST_VERSION);
  });

  it("survives every shape of garbage without throwing", () => {
    const garbage: unknown[] = [
      null,
      undefined,
      "",
      "[]",
      "null",
      "{}",
      "[1,2,3]",
      42,
      [],
      { version: "banana" },
      { version: -1, ledger: { entries: [null, 1, "x"] } },
      '{"version":1,"bits":',
    ];
    for (const input of garbage) {
      expect(() => parseSave(input, AT), `threw on ${JSON.stringify(input)}`).not.toThrow();
      const parsed = parseSave(input, AT);
      expect(parsed.save.version).toBe(LATEST_VERSION);
      expect(parsed.save.inventory.equippedAvatar).toBe("ferro");
    }
  });

  it("drops unrecognisable ledger entries rather than the whole ledger", () => {
    const partly = {
      version: LATEST_VERSION,
      ledger: {
        entries: [
          {
            sequence: 0,
            at: 0,
            transaction: { kind: "purchase", bits: 100, shards: 0, receipt: "r" },
          },
          { sequence: 1, at: 0, transaction: { kind: "an-unknown-kind", bits: 999 } },
          "not an entry",
          {
            sequence: 2,
            at: 0,
            transaction: { kind: "purchase", bits: 50, shards: 1, receipt: "r2" },
          },
        ],
        nextSequence: 0,
      },
    };
    const { save, repairs } = parseSave(partly, AT);

    expect(foldLedger(save.ledger)).toEqual({ bits: 150, shards: 1 });
    expect(repairs.some((r) => r.startsWith("ledger.entries"))).toBe(true);
    // nextSequence is re-derived, never trusted: a stored value below the entry
    // count would make the next append collide and break ordering forever.
    expect(save.ledger.nextSequence).toBeGreaterThan(
      Math.max(...save.ledger.entries.map((e) => e.sequence)),
    );
  });

  it("a clean save reports no repairs at all", () => {
    const clean = serializeSave(freshSave(AT));
    expect(parseSave(clean, AT).repairs).toEqual([]);
  });
});

describe("the save manager", () => {
  it("round-trips through storage", () => {
    const storage = createMemorySaveStorage();
    const manager = createSaveManager({ storage, now: () => AT });

    manager.update({
      ...manager.current,
      lifetime: { ...manager.current.lifetime, distance: 5_000, runs: 3 },
    });

    const reloaded = createSaveManager({ storage, now: () => AT });
    expect(reloaded.current.lifetime.distance).toBe(5_000);
    expect(reloaded.current.lifetime.runs).toBe(3);
  });

  it("starts fresh when storage is empty", () => {
    const manager = createSaveManager({ storage: createMemorySaveStorage(), now: () => AT });
    expect(manager.current.lifetime.runs).toBe(0);
    expect(manager.repairs).toEqual([]);
  });

  it("recovers rather than crashing on a corrupt file", () => {
    const storage = createMemorySaveStorage("{{{ not json");
    const manager = createSaveManager({ storage, now: () => AT });
    expect(manager.current.version).toBe(LATEST_VERSION);
    expect(manager.repairs).toContain("json");
  });

  it("survives a storage that throws on every operation", () => {
    const hostile = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("full");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(() => createSaveManager({ storage: hostile, now: () => AT })).not.toThrow();
    const manager = createSaveManager({ storage: hostile, now: () => AT });
    expect(() => manager.persist()).not.toThrow();
    expect(manager.current.version).toBe(LATEST_VERSION);
  });

  it("uses the documented storage key", () => {
    const storage = createMemorySaveStorage();
    const manager = createSaveManager({ storage, now: () => AT });
    manager.persist();
    expect(storage.getItem(SAVE_KEY)).not.toBeNull();
  });
});

describe("remote sync", () => {
  const remoteSave = (distance: number) => ({
    ...JSON.parse(serializeSave(freshSave(AT))),
    lifetime: { distance, runs: 10, bestScore: 0, bestDistance: 0 },
  });

  it("takes the remote save when it is further along", async () => {
    const storage = createMemorySaveStorage();
    const manager = createSaveManager({
      storage,
      now: () => AT,
      remote: {
        pull: async () => remoteSave(50_000),
        push: async () => undefined,
      },
    });

    expect(await manager.sync()).toBe(true);
    expect(manager.current.lifetime.distance).toBe(50_000);
  });

  /**
   * Compared by lifetime distance, which is monotonic, rather than by
   * timestamp. Device clocks are wrong often enough that a timestamp comparison
   * would let a misconfigured phone overwrite real progress.
   */
  it("keeps the local save when it is further along, and pushes it", async () => {
    const storage = createMemorySaveStorage();
    let pushed = false;
    const manager = createSaveManager({
      storage,
      now: () => AT,
      remote: {
        pull: async () => remoteSave(10),
        push: async () => {
          pushed = true;
        },
      },
    });
    manager.update({
      ...manager.current,
      lifetime: { ...manager.current.lifetime, distance: 90_000 },
    });

    expect(await manager.sync()).toBe(false);
    expect(manager.current.lifetime.distance).toBe(90_000);
    expect(pushed).toBe(true);
  });

  it("a failing remote never takes the local save down", async () => {
    const manager = createSaveManager({
      storage: createMemorySaveStorage(),
      now: () => AT,
      remote: {
        pull: async () => {
          throw new Error("offline");
        },
        push: async () => {
          throw new Error("offline");
        },
      },
    });
    await expect(manager.sync()).resolves.toBe(false);
    expect(manager.current.version).toBe(LATEST_VERSION);
  });

  it("pushes when the remote has nothing", async () => {
    let pushed = false;
    const manager = createSaveManager({
      storage: createMemorySaveStorage(),
      now: () => AT,
      remote: {
        pull: async () => null,
        push: async () => {
          pushed = true;
        },
      },
    });
    expect(await manager.sync()).toBe(false);
    expect(pushed).toBe(true);
  });

  it("does nothing when no remote is configured", async () => {
    const manager = createSaveManager({ storage: createMemorySaveStorage(), now: () => AT });
    expect(await manager.sync()).toBe(false);
  });

  it("repairs a corrupt remote save rather than adopting garbage", async () => {
    const manager = createSaveManager({
      storage: createMemorySaveStorage(),
      now: () => AT,
      remote: {
        pull: async () => ({ version: 1, bits: "lots", lifetime: { distance: 999_999 } }),
        push: async () => undefined,
      },
    });
    expect(await manager.sync()).toBe(true);
    expect(manager.current.lifetime.distance).toBe(999_999);
    expect(foldLedger(manager.current.ledger)).toEqual({ bits: 0, shards: 0 });
  });
});
