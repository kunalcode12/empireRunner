"use client";

/**
 * Meta state — Bits, Shards, upgrades, inventory, missions, progression.
 *
 * docs/ARCHITECTURE.md §3.1: "Meta state (Bits, Shards, upgrades, inventory) →
 * zustand, persisted via `meta/save.ts`. Changes at run boundaries." This is that
 * store, and the "changes at run boundaries" clause is the load-bearing part —
 * nothing here is written during a run, so subscribing to it from a screen cannot
 * cost frame time.
 *
 * ## Every balance read goes through the backend
 *
 * P13 built `EconomyBackend` so a remote or on-chain implementation could be
 * swapped in without touching gameplay or UI, and every method returns a promise
 * even though the local one is synchronous. That only holds if callers actually
 * await it, so this store owns the one backend instance and exposes async
 * actions. **A screen never folds a ledger.** `balances` below is a cached
 * projection the backend last returned, for rendering only.
 *
 * ## The ledger is the save, and the save is the ledger
 *
 * `LedgerStore` and `SaveManager` are wired to the same `SaveData`, so committing
 * a transaction and persisting progress are one write rather than two that can
 * disagree.
 */

import { create } from "zustand";
import {
  BOOSTS,
  EMPTY_INVENTORY,
  EMPTY_LEDGER,
  ZERO_BALANCES,
  ZERO_LIFETIME,
  ZERO_UPGRADES,
  createLocalEconomyBackend,
  createSaveManager,
  emptyMissionProgress,
  equipAvatar,
  equipBoost,
  freshSave,
  rollPeriods,
  settleRun,
  unequipBoost,
  withTier,
  type Balances,
  type BoostId,
  type EconomyBackend,
  type Inventory,
  type Ledger,
  type LifetimeStats,
  type MissionProgress,
  type OnboardingFlags,
  type RunSettlement,
  type RunSummary,
  type SaveData,
  type SaveManager,
  type UpgradeLevels,
  type UpgradeTrackName,
  FRESH_ONBOARDING,
  addConsumable,
  markSeen,
  ownAvatar,
  upgradeCost,
} from "@/game/meta";

/** The store's shape. Everything readable is a plain value; actions are async. */
export interface MetaState {
  /** True once the save has been read from storage. Screens gate on it. */
  ready: boolean;
  /** Fields the save validator had to repair. Surfaced in Settings, not hidden. */
  repairs: readonly string[];

  balances: Balances;
  ledger: Ledger;
  upgrades: UpgradeLevels;
  inventory: Inventory;
  missions: MissionProgress;
  lifetime: LifetimeStats;
  onboarding: OnboardingFlags;
  avatarChallengesClaimed: readonly string[];

  /** The most recent settlement, for the death screen. */
  lastSettlement: RunSettlement | null;
  /** The summary that produced it. */
  lastRun: RunSummary | null;
  /** Best score ever, from lifetime stats. Read before a settlement overwrites it. */
  previousBest: number;

  hydrate(): void;
  buyUpgrade(track: UpgradeTrackName): Promise<boolean>;
  buyBoost(boost: BoostId, quantity: number): Promise<boolean>;
  selectAvatar(id: string): void;
  toggleBoost(boost: BoostId): void;
  purchaseAvatar(id: string, bits: number, shards: number): Promise<boolean>;
  finishRun(summary: RunSummary): Promise<RunSettlement>;
  seeScreen(flag: keyof OnboardingFlags): void;
}

/**
 * Module-level, not in the store.
 *
 * A zustand store can be recreated by fast refresh; a save manager holding a
 * localStorage handle should not be, or two managers race each other's writes.
 */
let manager: SaveManager | null = null;
let backend: EconomyBackend | null = null;

function ensureManager(): SaveManager {
  if (manager === null) {
    manager = createSaveManager();
  }
  return manager;
}

function ensureBackend(save: SaveData): EconomyBackend {
  if (backend === null) {
    backend = createLocalEconomyBackend({
      store: {
        read: () => ensureManager().current.ledger,
        write: (ledger: Ledger) => {
          const current = ensureManager().current;
          ensureManager().update({ ...current, ledger });
        },
      },
    });
  }
  // Referenced so a caller cannot forget the save is the source of truth.
  void save;
  return backend;
}

/** Pulls every field off a `SaveData` into the store's flat shape. */
function project(save: SaveData, balances: Balances): Partial<MetaState> {
  return {
    balances,
    ledger: save.ledger,
    upgrades: save.upgrades,
    inventory: save.inventory,
    missions: save.missions,
    lifetime: save.lifetime,
    onboarding: save.onboarding,
    avatarChallengesClaimed: save.avatarChallengesClaimed,
  };
}

export const useMetaStore = create<MetaState>()((set, get) => ({
  ready: false,
  repairs: [],
  balances: ZERO_BALANCES,
  ledger: EMPTY_LEDGER,
  upgrades: ZERO_UPGRADES,
  inventory: EMPTY_INVENTORY,
  missions: emptyMissionProgress(Date.now()),
  lifetime: ZERO_LIFETIME,
  onboarding: FRESH_ONBOARDING,
  avatarChallengesClaimed: [],
  lastSettlement: null,
  lastRun: null,
  previousBest: 0,

  hydrate(): void {
    if (get().ready) {
      return;
    }
    const save = ensureManager().load();
    // Dailies and the weekly contract roll over on their own UTC schedule, so
    // this has to happen on load rather than only after a run — a player who
    // opens the game at 00:01 must see today's three, not yesterday's.
    const rolled = rollPeriods(save.missions, Date.now());
    if (rolled !== save.missions) {
      ensureManager().update({ ...save, missions: rolled });
    }
    const current = ensureManager().current;
    void ensureBackend(current)
      .getBalances()
      .then((balances) => {
        set({
          ...project(current, balances),
          ready: true,
          repairs: ensureManager().repairs,
          previousBest: current.lifetime.bestScore,
        });
      });
  },

  async buyUpgrade(track: UpgradeTrackName): Promise<boolean> {
    const state = get();
    const tier = (state.upgrades[track] ?? 0) + 1;
    const cost = upgradeCost(track, tier);
    if (cost <= 0) {
      return false;
    }
    const result = await ensureBackend(ensureManager().current).commit({
      kind: "upgrade",
      track,
      tier,
      bits: cost,
    });
    if (!result.ok) {
      return false;
    }
    const save = ensureManager().current;
    const upgrades = withTier(save.upgrades, track, tier);
    ensureManager().update({ ...save, upgrades });
    set({ upgrades, balances: result.balances, ledger: ensureManager().current.ledger });
    return true;
  },

  async buyBoost(boost: BoostId, quantity: number): Promise<boolean> {
    const save = ensureManager().current;
    // The inventory is computed FIRST so the cap is known before the charge.
    // `addConsumable` reports how many actually landed, and charging for items
    // that evaporated at the 99 cap is exactly the bug TUNING §17.1 names.
    const added = addConsumable(save.inventory, boost, quantity);
    if (added.added === 0) {
      return false;
    }
    const unitCost = BOOSTS[boost].cost;
    const result = await ensureBackend(save).commit({
      kind: "boost",
      boostId: boost,
      quantity: added.added,
      bits: unitCost * added.added,
    });
    if (!result.ok) {
      return false;
    }
    ensureManager().update({ ...save, inventory: added.inventory });
    set({ inventory: added.inventory, balances: result.balances });
    return true;
  },

  selectAvatar(id: string): void {
    const save = ensureManager().current;
    // `equipAvatar` refuses an unowned or unknown id rather than throwing, and
    // returns the inventory unchanged. Persisting that is harmless, so there is
    // no branch here — the refusal IS the no-op.
    const { inventory } = equipAvatar(save.inventory, id);
    ensureManager().update({ ...save, inventory });
    set({ inventory });
  },

  toggleBoost(boost: BoostId): void {
    const save = ensureManager().current;
    const equipped = save.inventory.equippedBoosts.includes(boost);
    const inventory = equipped
      ? unequipBoost(save.inventory, boost)
      : equipBoost(save.inventory, boost).inventory;
    ensureManager().update({ ...save, inventory });
    set({ inventory });
  },

  async purchaseAvatar(id: string, bits: number, shards: number): Promise<boolean> {
    const save = ensureManager().current;
    const result = await ensureBackend(save).commit({
      kind: "avatar-unlock",
      avatarId: id,
      bits,
      shards,
    });
    if (!result.ok) {
      return false;
    }
    const inventory = ownAvatar(save.inventory, id);
    ensureManager().update({ ...save, inventory });
    set({ inventory, balances: result.balances });
    return true;
  },

  async finishRun(summary: RunSummary): Promise<RunSettlement> {
    const save = ensureManager().current;
    // Captured before settling, because the settlement overwrites it and the
    // death screen's "over your best" line needs the value from before.
    const previousBest = save.lifetime.bestScore;

    const settlement = await settleRun(ensureBackend(save), {
      run: summary,
      upgrades: save.upgrades,
      avatarId: save.inventory.equippedAvatar,
      boosts: save.inventory.equippedBoosts,
      missions: save.missions,
      lifetime: save.lifetime,
      avatarChallengesClaimed: save.avatarChallengesClaimed,
      ownedAvatars: save.inventory.avatars,
    });

    const after = ensureManager().current;
    ensureManager().update({
      ...after,
      missions: settlement.missions,
      lifetime: settlement.lifetime,
      avatarChallengesClaimed: settlement.avatarChallengesClaimed,
    });

    set({
      ...project(ensureManager().current, settlement.balances),
      lastSettlement: settlement,
      lastRun: summary,
      previousBest,
    });
    return settlement;
  },

  seeScreen(flag: keyof OnboardingFlags): void {
    const save = ensureManager().current;
    const onboarding = markSeen(save.onboarding, flag);
    if (onboarding === save.onboarding) {
      return;
    }
    ensureManager().update({ ...save, onboarding });
    set({ onboarding });
  },
}));

/** Tests only: drops the module-level singletons so each case starts clean. */
export function resetMetaSingletons(): void {
  manager = null;
  backend = null;
  useMetaStore.setState({ ...freshSave(0), ready: false } as unknown as Partial<MetaState>);
}
