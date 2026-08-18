/**
 * Persistence, migrations, and integrity.
 *
 * ## Nothing in this file throws
 *
 * A save that fails to load is a permanent uninstall. Not a bug report — the
 * player opens the game, sees zero Bits and a locked roster after fifty runs,
 * and deletes it. There is no recovery from that and no support channel that
 * helps.
 *
 * So every function here is total. Truncated JSON, a string where a number
 * belongs, a null, an array where an object belongs, a version from the future:
 * all of them produce a **working save**, repaired field by field, with the
 * damage recorded in `repairs` for diagnostics. The worst outcome available is
 * losing one field's value. Losing the file is not on the menu.
 *
 * This is why the validator is hand-written rather than a schema library. A
 * parser that throws on the first bad field is exactly the wrong shape: it
 * discards a save with 49 good fields because the 50th is a string. What is
 * wanted is per-field repair, which is a different algorithm, not a different
 * configuration of the same one.
 *
 * (`zod` is present in `node_modules` but is a *transitive, dev-only*
 * dependency — not declared in `package.json`, `dev: true` in the lockfile.
 * Importing it into `src/` would ship production code depending on a package a
 * production install does not have. CLAUDE.md forbids adding one without asking.)
 *
 * ## The migration chain
 *
 * `v1 → v2 → v3`, applied in order, each step a pure function on plain data.
 *
 * **Neither v1 nor v2 ever shipped to a player.** They are the shapes this file
 * would have had before the ledger and before the two-slot loadout, and they
 * exist so the chain is exercised by tests today rather than executed for the
 * first time in production on the day it matters. Migration code that has never
 * run is migration code that does not work, and the only way to find out is with
 * a player's save.
 */

import { TUNING } from "@/game/config/tuning";
import { EMPTY_LEDGER, type Ledger, type LedgerEntry, type Transaction } from "./economy";
import { DEFAULT_AVATAR_ID, avatarById } from "./avatars";
import {
  BOOST_IDS,
  EMPTY_INVENTORY,
  type BoostId,
  type CosmeticSlotName,
  type Inventory,
} from "./inventory";
import {
  UPGRADE_TRACKS,
  ZERO_UPGRADES,
  type UpgradeLevels,
  type UpgradeTrackName,
} from "./upgrades";
import { emptyMissionProgress, utcDayKey, utcWeekKey, type MissionProgress } from "./missions";
import {
  FRESH_ONBOARDING,
  ZERO_LIFETIME,
  type LifetimeStats,
  type OnboardingFlags,
} from "./progression";

/** The version this build writes. */
export const LATEST_VERSION = TUNING.meta.saveVersion;

const VERSION_1 = 1;
const VERSION_2 = 2;
const VERSION_3 = 3;

const STORAGE_KEY = "axis.save";

/** The current save shape. */
export interface SaveData {
  version: number;
  /** The economy ledger. Balances are folded from it, never stored. */
  ledger: Ledger;
  upgrades: UpgradeLevels;
  inventory: Inventory;
  missions: MissionProgress;
  lifetime: LifetimeStats;
  onboarding: OnboardingFlags;
  /** Avatar ids whose first-time challenge Shard has already been paid. */
  avatarChallengesClaimed: readonly string[];
}

/** A brand-new save. */
export function freshSave(at: number = Date.now()): SaveData {
  return {
    version: LATEST_VERSION,
    ledger: EMPTY_LEDGER,
    upgrades: ZERO_UPGRADES,
    inventory: EMPTY_INVENTORY,
    missions: emptyMissionProgress(at),
    lifetime: ZERO_LIFETIME,
    onboarding: FRESH_ONBOARDING,
    avatarChallengesClaimed: Object.freeze([]),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Primitive coercion. Every one of these is total.
// ─────────────────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown, fallback: number, min = Number.NEGATIVE_INFINITY): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return value < min ? min : value;
}

function int(value: unknown, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const raw = num(value, fallback);
  const truncated = Math.trunc(raw);
  return truncated < min ? min : truncated > max ? max : truncated;
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function str(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function strArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

// ─────────────────────────────────────────────────────────────────────────────
// Field validators
// ─────────────────────────────────────────────────────────────────────────────

/** Records what had to be repaired, so a corrupt save is diagnosable. */
type Repairs = string[];

function parseTransaction(value: unknown): Transaction | null {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return null;
  }
  const kind = value.kind;
  switch (kind) {
    case "run-reward":
      return {
        kind,
        fromPickups: int(value.fromPickups, 0),
        fromDistance: int(value.fromDistance, 0),
        shards: int(value.shards, 0),
        seed: int(value.seed, 0),
      };
    case "daily-complete":
      return { kind, day: str(value.day, ""), shards: int(value.shards, 0) };
    case "weekly-tier":
      return {
        kind,
        week: str(value.week, ""),
        tier: int(value.tier, 1, 1, TUNING.meta.weeklyTierCount),
        shards: int(value.shards, 0),
      };
    case "avatar-challenge":
      return { kind, avatarId: str(value.avatarId, ""), shards: int(value.shards, 0) };
    case "purchase":
      return {
        kind,
        bits: int(value.bits, 0),
        shards: int(value.shards, 0),
        receipt: str(value.receipt, ""),
      };
    case "opening-balance":
      return {
        kind,
        bits: int(value.bits, 0),
        shards: int(value.shards, 0),
        fromVersion: int(value.fromVersion, VERSION_1),
      };
    case "fracture":
      return {
        kind,
        index: int(value.index, 1, 1),
        shards: int(value.shards, 0),
        seed: int(value.seed, 0),
      };
    case "upgrade":
      return {
        kind,
        track: str(value.track, ""),
        tier: int(value.tier, 1, 1, TUNING.economy.upgradeMaxTier),
        bits: int(value.bits, 0),
      };
    case "boost":
      return {
        kind,
        boostId: str(value.boostId, ""),
        quantity: int(value.quantity, 1, 1),
        bits: int(value.bits, 0),
      };
    case "avatar-unlock":
      return {
        kind,
        avatarId: str(value.avatarId, ""),
        bits: int(value.bits, 0),
        shards: int(value.shards, 0),
      };
    case "cosmetic":
      return { kind, cosmeticId: str(value.cosmeticId, ""), shards: int(value.shards, 0) };
    default:
      // An unknown transaction kind. Dropped rather than guessed at — a
      // transaction whose effect cannot be computed must not contribute to a
      // balance.
      return null;
  }
}

function parseLedger(value: unknown, repairs: Repairs): Ledger {
  if (!isRecord(value) || !Array.isArray(value.entries)) {
    repairs.push("ledger");
    return EMPTY_LEDGER;
  }

  const entries: LedgerEntry[] = [];
  let dropped = 0;
  for (const raw of value.entries) {
    if (!isRecord(raw)) {
      dropped += 1;
      continue;
    }
    const transaction = parseTransaction(raw.transaction);
    if (transaction === null) {
      dropped += 1;
      continue;
    }
    entries.push(
      Object.freeze({
        sequence: int(raw.sequence, entries.length),
        at: int(raw.at, 0),
        transaction,
      }),
    );
  }
  if (dropped > 0) {
    repairs.push(`ledger.entries(${dropped} dropped)`);
  }

  // Re-derive `nextSequence` rather than trusting it. A stored value lower than
  // the entry count would make the next append collide with an existing
  // sequence, which silently breaks ordering forever.
  const maxSequence = entries.reduce((max, entry) => Math.max(max, entry.sequence), -1);
  return Object.freeze({
    entries: Object.freeze(entries),
    nextSequence: Math.max(int(value.nextSequence, 0), maxSequence + 1),
  });
}

function parseUpgrades(value: unknown, repairs: Repairs): UpgradeLevels {
  if (!isRecord(value)) {
    repairs.push("upgrades");
    return ZERO_UPGRADES;
  }
  const levels: Record<string, number> = {};
  for (const track of UPGRADE_TRACKS) {
    const raw = value[track];
    const tier = int(raw, 0, 0, TUNING.economy.upgradeMaxTier);
    if (typeof raw !== "number" || tier !== raw) {
      repairs.push(`upgrades.${track}`);
    }
    levels[track] = tier;
  }
  return Object.freeze(levels) as UpgradeLevels;
}

function parseInventory(value: unknown, repairs: Repairs): Inventory {
  if (!isRecord(value)) {
    repairs.push("inventory");
    return EMPTY_INVENTORY;
  }

  const consumables: Record<string, number> = {};
  if (isRecord(value.consumables)) {
    for (const [id, raw] of Object.entries(value.consumables)) {
      const count = int(raw, 0, 0, TUNING.meta.consumableStackCap);
      if (count > 0) {
        consumables[id] = count;
      }
    }
  } else if (value.consumables !== undefined) {
    repairs.push("inventory.consumables");
  }

  // Only avatars that exist. A save naming a deleted avatar must not leave the
  // player equipped to nothing.
  const avatars = strArray(value.avatars).filter((id) => avatarById(id) !== undefined);
  if (!avatars.includes(DEFAULT_AVATAR_ID)) {
    avatars.unshift(DEFAULT_AVATAR_ID);
  }

  const requestedAvatar = str(value.equippedAvatar, DEFAULT_AVATAR_ID);
  const equippedAvatar = avatars.includes(requestedAvatar) ? requestedAvatar : DEFAULT_AVATAR_ID;
  if (equippedAvatar !== requestedAvatar) {
    repairs.push("inventory.equippedAvatar");
  }

  const equippedCosmetics: Partial<Record<CosmeticSlotName, string>> = {};
  const cosmetics = strArray(value.cosmetics);
  if (isRecord(value.equippedCosmetics)) {
    for (const [slot, raw] of Object.entries(value.equippedCosmetics)) {
      if (typeof raw === "string" && cosmetics.includes(raw)) {
        equippedCosmetics[slot as CosmeticSlotName] = raw;
      }
    }
  }

  // Known boosts only, deduplicated, and never more than the slot count. This
  // is the one place the "no loadout slots are ever sold" rule is enforced
  // against a hostile file.
  const boosts = strArray(value.equippedBoosts)
    .filter((id): id is BoostId => (BOOST_IDS as readonly string[]).includes(id))
    .filter((id, index, all) => all.indexOf(id) === index)
    .slice(0, TUNING.meta.boostSlots);

  return Object.freeze({
    consumables: Object.freeze(consumables),
    cosmetics: Object.freeze(cosmetics),
    equippedCosmetics: Object.freeze(equippedCosmetics),
    avatars: Object.freeze(avatars),
    equippedAvatar,
    equippedBoosts: Object.freeze(boosts),
  });
}

function parseMissions(value: unknown, repairs: Repairs, at: number): MissionProgress {
  if (!isRecord(value)) {
    repairs.push("missions");
    return emptyMissionProgress(at);
  }
  const values: Record<string, number> = {};
  if (isRecord(value.values)) {
    for (const [id, raw] of Object.entries(value.values)) {
      values[id] = num(raw, 0, 0);
    }
  }
  return Object.freeze({
    values: Object.freeze(values),
    dayKey: str(value.dayKey, utcDayKey(at)),
    weekKey: str(value.weekKey, utcWeekKey(at)),
    claimedDailies: Object.freeze(strArray(value.claimedDailies)),
    claimedWeeklyTiers: Object.freeze(
      Array.isArray(value.claimedWeeklyTiers)
        ? value.claimedWeeklyTiers
            .filter((tier): tier is number => typeof tier === "number" && Number.isFinite(tier))
            .map((tier) => Math.trunc(tier))
        : [],
    ),
  });
}

function parseLifetime(value: unknown, repairs: Repairs): LifetimeStats {
  if (!isRecord(value)) {
    repairs.push("lifetime");
    return ZERO_LIFETIME;
  }
  return Object.freeze({
    distance: num(value.distance, 0, 0),
    runs: int(value.runs, 0),
    bestScore: int(value.bestScore, 0),
    bestDistance: num(value.bestDistance, 0, 0),
    bitsCollected: int(value.bitsCollected, 0),
    nearMisses: int(value.nearMisses, 0),
    overdrives: int(value.overdrives, 0),
    fracturesSurvived: int(value.fracturesSurvived, 0),
  });
}

function parseOnboarding(value: unknown): OnboardingFlags {
  if (!isRecord(value)) {
    return FRESH_ONBOARDING;
  }
  return Object.freeze({
    seenFirstRun: bool(value.seenFirstRun),
    seenRollPrompt: bool(value.seenRollPrompt),
    seenFlowPrompt: bool(value.seenFlowPrompt),
    seenFracturePrompt: bool(value.seenFracturePrompt),
    seenStore: bool(value.seenStore),
    seenMissions: bool(value.seenMissions),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Migrations
// ─────────────────────────────────────────────────────────────────────────────

/** One step of the chain. Plain data in, plain data out. */
type Migration = (data: Record<string, unknown>) => Record<string, unknown>;

/**
 * v1 → v2: plain balances become a ledger.
 *
 * v1 stored `bits` and `shards` as numbers. The ledger cannot invent the history
 * that produced them, and pretending otherwise would put fabricated entries in
 * an audit trail — so the whole balance is carried across as a single
 * `opening-balance` transaction that says exactly what it is.
 */
const migrateV1toV2: Migration = (data) => {
  const bits = int(data.bits, 0);
  const shards = int(data.shards, 0);
  const opening: Transaction = {
    kind: "opening-balance",
    bits,
    shards,
    fromVersion: VERSION_1,
  };
  const next: Record<string, unknown> = { ...data, version: VERSION_2 };
  delete next.bits;
  delete next.shards;
  next.ledger =
    bits === 0 && shards === 0
      ? EMPTY_LEDGER
      : {
          entries: [{ sequence: 0, at: 0, transaction: opening }],
          nextSequence: 1,
        };
  return next;
};

/**
 * v2 → v3: one equipped boost becomes the two-slot loadout.
 *
 * GAME_BIBLE §9.3 settled on 2 boosts + 1 avatar. The single `equippedBoost`
 * becomes a one-element array rather than being dropped: the player equipped it
 * on purpose and should find it still equipped.
 */
const migrateV2toV3: Migration = (data) => {
  const next: Record<string, unknown> = { ...data, version: VERSION_3 };
  if (isRecord(data.inventory)) {
    const inventory: Record<string, unknown> = { ...data.inventory };
    const single = inventory.equippedBoost;
    delete inventory.equippedBoost;
    if (!Array.isArray(inventory.equippedBoosts)) {
      inventory.equippedBoosts = typeof single === "string" ? [single] : [];
    }
    next.inventory = inventory;
  }
  return next;
};

/** The chain, keyed by the version each step upgrades FROM. */
const MIGRATIONS: Readonly<Record<number, Migration>> = Object.freeze({
  [VERSION_1]: migrateV1toV2,
  [VERSION_2]: migrateV2toV3,
});

/**
 * Runs the chain from whatever version the data claims up to the latest.
 *
 * Bounded by the number of known migrations, so a file claiming version 0 or a
 * corrupt version cannot spin. Returns the steps applied, for the test that
 * asserts a v1 file really does pass through **both** migrations rather than
 * jumping straight to the current shape.
 */
export function migrate(raw: Record<string, unknown>): {
  data: Record<string, unknown>;
  applied: number[];
} {
  let data = raw;
  const applied: number[] = [];
  let version = int(data.version, VERSION_1, 0);
  let guard = 0;
  const maxSteps = Object.keys(MIGRATIONS).length + 1;

  while (version < LATEST_VERSION && guard < maxSteps) {
    const step = MIGRATIONS[version];
    if (step === undefined) {
      break;
    }
    data = step(data);
    applied.push(version);
    version = int(data.version, version + 1, 0);
    guard += 1;
  }
  return { data, applied };
}

// ─────────────────────────────────────────────────────────────────────────────
// Parse
// ─────────────────────────────────────────────────────────────────────────────

export interface ParsedSave {
  readonly save: SaveData;
  /** Field paths that had to be repaired. Empty means the file was clean. */
  readonly repairs: readonly string[];
  /** True when nothing usable was found and a fresh save was substituted. */
  readonly recovered: boolean;
  /** The version the file claimed, before migration. */
  readonly fromVersion: number;
}

/**
 * Turns anything at all into a working save.
 *
 * Handles the three cases the corruption test covers:
 *
 *   - **Truncated JSON** — `JSON.parse` throws, caught, fresh save.
 *   - **Wrong types** — every field coerced independently, so a string `bits`
 *     costs the player their Bits and nothing else.
 *   - **A version from the future** — the file was written by a newer build.
 *     There is no forward migration, so the current schema is applied
 *     best-effort: every field this build understands is kept, everything else
 *     is ignored. Wiping the save instead would punish the player for using two
 *     devices, and the fields a newer build added are exactly the fields this
 *     build has no use for anyway.
 */
export function parseSave(input: unknown, at: number = Date.now()): ParsedSave {
  const repairs: Repairs = [];

  let raw: unknown = input;
  if (typeof input === "string") {
    try {
      raw = JSON.parse(input);
    } catch {
      return {
        save: freshSave(at),
        repairs: Object.freeze(["json"]),
        recovered: true,
        fromVersion: 0,
      };
    }
  }

  if (!isRecord(raw)) {
    return {
      save: freshSave(at),
      repairs: Object.freeze(["root"]),
      recovered: true,
      fromVersion: 0,
    };
  }

  const fromVersion = int(raw.version, VERSION_1, 0);
  if (fromVersion > LATEST_VERSION) {
    repairs.push(`version(future:${fromVersion})`);
  }

  const { data } = migrate(raw);

  const save: SaveData = {
    version: LATEST_VERSION,
    ledger: parseLedger(data.ledger, repairs),
    upgrades: parseUpgrades(data.upgrades, repairs),
    inventory: parseInventory(data.inventory, repairs),
    missions: parseMissions(data.missions, repairs, at),
    lifetime: parseLifetime(data.lifetime, repairs),
    onboarding: parseOnboarding(data.onboarding),
    avatarChallengesClaimed: Object.freeze(strArray(data.avatarChallengesClaimed)),
  };

  return {
    save,
    repairs: Object.freeze(repairs),
    recovered: false,
    fromVersion,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Storage
// ─────────────────────────────────────────────────────────────────────────────

/** The storage surface. Injected, so this module runs under Node. */
export interface SaveStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** An in-memory store. SSR, Node tests, and blocked-storage fallback. */
export function createMemorySaveStorage(initial?: string): SaveStorage {
  const map = new Map<string, string>();
  if (initial !== undefined) {
    map.set(STORAGE_KEY, initial);
  }
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

/**
 * Resolves the default storage.
 *
 * The access itself is guarded, not just the read: `localStorage` throws on
 * *access* in a sandboxed iframe and in Safari's private mode with cookies
 * blocked.
 */
export function defaultSaveStorage(): SaveStorage {
  try {
    if (typeof localStorage !== "undefined") {
      return localStorage;
    }
  } catch {
    // Denied. Fall through to memory.
  }
  return createMemorySaveStorage();
}

/** Optional remote sync. Nothing in this file requires one. */
export interface RemoteSyncAdapter {
  /** Fetches the remote save, or null if there is none. Must not throw. */
  pull(): Promise<unknown | null>;
  /** Pushes the local save. Must not throw. */
  push(save: SaveData): Promise<void>;
}

export interface SaveManagerOptions {
  storage?: SaveStorage;
  remote?: RemoteSyncAdapter;
  now?: () => number;
}

export interface SaveManager {
  /** The in-memory save. Always valid. */
  readonly current: SaveData;
  /** What had to be repaired on the last load. */
  readonly repairs: readonly string[];
  /** Replaces the save and writes it through. */
  update(next: SaveData): void;
  /** Re-reads from storage, repairing as needed. */
  load(): SaveData;
  /** Writes the current save. Never throws. */
  persist(): void;
  /**
   * Pulls from the remote and takes it if it is further along.
   *
   * "Further along" is more lifetime distance, which is monotonic and cannot be
   * gamed by playing offline. Comparing timestamps instead would let a device
   * with a wrong clock overwrite real progress — and device clocks are wrong
   * often enough that this is a real failure, not a theoretical one.
   */
  sync(): Promise<boolean>;
}

export function createSaveManager(options: SaveManagerOptions = {}): SaveManager {
  const storage = options.storage ?? defaultSaveStorage();
  const now = options.now ?? Date.now;

  let current = freshSave(now());
  let repairs: readonly string[] = [];

  function load(): SaveData {
    let text: string | null = null;
    try {
      text = storage.getItem(STORAGE_KEY);
    } catch {
      text = null;
    }
    if (text === null) {
      current = freshSave(now());
      repairs = Object.freeze([]);
      return current;
    }
    const parsed = parseSave(text, now());
    current = parsed.save;
    repairs = parsed.repairs;
    return current;
  }

  function persist(): void {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(current));
    } catch {
      // Storage full or blocked. The run still happened; losing the write is
      // survivable, and throwing here would take the death screen down with it.
    }
  }

  load();

  return {
    get current() {
      return current;
    },
    get repairs() {
      return repairs;
    },
    load,
    persist,

    update(next: SaveData): void {
      current = { ...next, version: LATEST_VERSION };
      persist();
    },

    async sync(): Promise<boolean> {
      if (options.remote === undefined) {
        return false;
      }
      let remote: unknown | null = null;
      try {
        remote = await options.remote.pull();
      } catch {
        return false;
      }
      if (remote === null) {
        try {
          await options.remote.push(current);
        } catch {
          // Push failed; the local save is untouched and authoritative.
        }
        return false;
      }

      const parsed = parseSave(remote, now());
      if (parsed.save.lifetime.distance > current.lifetime.distance) {
        current = parsed.save;
        repairs = parsed.repairs;
        persist();
        return true;
      }

      try {
        await options.remote.push(current);
      } catch {
        // As above.
      }
      return false;
    },
  };
}

/** Serialises a save. Exposed for tests and for an export-save button. */
export function serializeSave(save: SaveData): string {
  return JSON.stringify(save);
}

/** The storage key, so tooling and tests do not restate it. */
export const SAVE_KEY = STORAGE_KEY;

/** Track names, re-exported so a caller validating a save needs one import. */
export type { UpgradeTrackName };
