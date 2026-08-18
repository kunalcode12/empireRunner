/**
 * Consumables, cosmetics, and the one loadout. GAME_BIBLE §9.3.
 *
 * ## Everything here is a pure function over a frozen object
 *
 * No method mutates. Every operation takes an inventory and returns a new one,
 * and the returned object is frozen. That is not ceremony: the inventory is
 * read by the store screen, the loadout screen, the run launcher and the save
 * writer, and the moment one of them can mutate a shared reference, a bug in
 * the store screen becomes a corrupted save.
 *
 * ## The loadout cannot be made invalid
 *
 * Exactly 1 avatar and 2 boosts — §9.3. There is no code path that produces a
 * loadout with three boosts or an unowned avatar, because `equipBoost` and
 * `equipAvatar` are the only ways in and both validate. A `LoadoutView` returned
 * from here is safe to hand straight to the run launcher without re-checking.
 *
 * **No loadout slots are ever sold.** §9.3 names this as the most common way the
 * genre turns a clean meta into a spreadsheet, so the slot counts are read from
 * tuning and there is no function to change them.
 */

import { TUNING } from "@/game/config/tuning";
import { DEFAULT_AVATAR_ID, avatarById } from "./avatars";

const STACK_CAP = TUNING.meta.consumableStackCap;
const BOOST_SLOTS = TUNING.meta.boostSlots;

/** The three pre-run boosts. GAME_BIBLE §9.2. */
export const Boost = {
  HeadStart: "headStart",
  DoubleBits: "doubleBits",
  FlowPrimer: "flowPrimer",
} as const;
export type BoostId = (typeof Boost)[keyof typeof Boost];

export const BOOST_IDS: readonly BoostId[] = Object.freeze([
  Boost.HeadStart,
  Boost.DoubleBits,
  Boost.FlowPrimer,
]);

export interface BoostDefinition {
  readonly id: BoostId;
  readonly label: string;
  readonly cost: number;
  readonly description: string;
}

export const BOOSTS: Readonly<Record<BoostId, BoostDefinition>> = Object.freeze({
  [Boost.HeadStart]: Object.freeze({
    id: Boost.HeadStart,
    label: "Head Start",
    cost: TUNING.economy.boostCost.headStart,
    description: `Begin at ${TUNING.economy.headStartMetres}m, world speed already ramped to match`,
  }),
  [Boost.DoubleBits]: Object.freeze({
    id: Boost.DoubleBits,
    label: "2x Bits",
    cost: TUNING.economy.boostCost.doubleBits,
    description: "Doubles the Bits earned this run",
  }),
  [Boost.FlowPrimer]: Object.freeze({
    id: Boost.FlowPrimer,
    label: "Flow Primer",
    cost: TUNING.economy.boostCost.flowPrimer,
    description: `Start at ${TUNING.economy.flowPrimerFlow} Flow`,
  }),
});

/** Cosmetics equip and never stack. GAME_BIBLE §9.3. */
export const CosmeticSlot = {
  Skin: "skin",
  Trail: "trail",
  Decal: "decal",
} as const;
export type CosmeticSlotName = (typeof CosmeticSlot)[keyof typeof CosmeticSlot];

export interface Inventory {
  /** Owned consumable counts, capped at `consumableStackCap`. */
  readonly consumables: Readonly<Record<string, number>>;
  /** Owned cosmetic ids. */
  readonly cosmetics: readonly string[];
  /** Equipped cosmetic per slot. A slot may be empty. */
  readonly equippedCosmetics: Readonly<Partial<Record<CosmeticSlotName, string>>>;
  /** Owned avatar ids. Always contains the default. */
  readonly avatars: readonly string[];
  /** The equipped avatar. */
  readonly equippedAvatar: string;
  /** Equipped boosts, at most `boostSlots`. Order is the slot order. */
  readonly equippedBoosts: readonly BoostId[];
}

export const EMPTY_INVENTORY: Inventory = Object.freeze({
  consumables: Object.freeze({}),
  cosmetics: Object.freeze([]),
  equippedCosmetics: Object.freeze({}),
  avatars: Object.freeze([DEFAULT_AVATAR_ID]),
  equippedAvatar: DEFAULT_AVATAR_ID,
  equippedBoosts: Object.freeze([]),
});

function freezeInventory(inventory: Inventory): Inventory {
  return Object.freeze({
    consumables: Object.freeze({ ...inventory.consumables }),
    cosmetics: Object.freeze([...inventory.cosmetics]),
    equippedCosmetics: Object.freeze({ ...inventory.equippedCosmetics }),
    avatars: Object.freeze([...inventory.avatars]),
    equippedAvatar: inventory.equippedAvatar,
    equippedBoosts: Object.freeze([...inventory.equippedBoosts]),
  });
}

/** How many of a consumable are held. */
export function countOf(inventory: Inventory, id: string): number {
  return inventory.consumables[id] ?? 0;
}

/**
 * Adds consumables, clamped to the stack cap.
 *
 * Returns how many were actually added, so the store can refuse to charge for
 * the overflow rather than silently taking Bits for items the player cannot
 * hold. Charging for an item that evaporates at the cap is the kind of small
 * theft that costs far more trust than it earns.
 */
export function addConsumable(
  inventory: Inventory,
  id: string,
  quantity: number,
): { inventory: Inventory; added: number } {
  if (quantity <= 0 || !Number.isFinite(quantity)) {
    return { inventory, added: 0 };
  }
  const current = countOf(inventory, id);
  const next = Math.min(STACK_CAP, current + Math.trunc(quantity));
  const added = next - current;
  if (added === 0) {
    return { inventory, added: 0 };
  }
  return {
    inventory: freezeInventory({
      ...inventory,
      consumables: { ...inventory.consumables, [id]: next },
    }),
    added,
  };
}

/** Consumes one or more. Refuses rather than going negative. */
export function consume(
  inventory: Inventory,
  id: string,
  quantity = 1,
): { inventory: Inventory; ok: boolean } {
  const current = countOf(inventory, id);
  const want = Math.max(1, Math.trunc(quantity));
  if (current < want) {
    return { inventory, ok: false };
  }
  const next = { ...inventory.consumables };
  const remaining = current - want;
  if (remaining === 0) {
    delete next[id];
  } else {
    next[id] = remaining;
  }
  return {
    inventory: freezeInventory({ ...inventory, consumables: next }),
    ok: true,
  };
}

/** Grants a cosmetic. Idempotent. */
export function ownCosmetic(inventory: Inventory, id: string): Inventory {
  if (inventory.cosmetics.includes(id)) {
    return inventory;
  }
  return freezeInventory({ ...inventory, cosmetics: [...inventory.cosmetics, id] });
}

/** Equips an owned cosmetic into a slot. Unowned cosmetics are refused. */
export function equipCosmetic(
  inventory: Inventory,
  slot: CosmeticSlotName,
  id: string,
): { inventory: Inventory; ok: boolean } {
  if (!inventory.cosmetics.includes(id)) {
    return { inventory, ok: false };
  }
  return {
    inventory: freezeInventory({
      ...inventory,
      equippedCosmetics: { ...inventory.equippedCosmetics, [slot]: id },
    }),
    ok: true,
  };
}

/** Clears a cosmetic slot. */
export function unequipCosmetic(inventory: Inventory, slot: CosmeticSlotName): Inventory {
  const next = { ...inventory.equippedCosmetics };
  delete next[slot];
  return freezeInventory({ ...inventory, equippedCosmetics: next });
}

/** Grants an avatar. Idempotent. */
export function ownAvatar(inventory: Inventory, id: string): Inventory {
  if (inventory.avatars.includes(id) || avatarById(id) === undefined) {
    return inventory;
  }
  return freezeInventory({ ...inventory, avatars: [...inventory.avatars, id] });
}

/** Equips an owned avatar. Unowned or unknown avatars are refused. */
export function equipAvatar(
  inventory: Inventory,
  id: string,
): { inventory: Inventory; ok: boolean } {
  if (!inventory.avatars.includes(id) || avatarById(id) === undefined) {
    return { inventory, ok: false };
  }
  return { inventory: freezeInventory({ ...inventory, equippedAvatar: id }), ok: true };
}

/**
 * Equips a boost into the next free slot.
 *
 * Refuses when the slots are full, when the boost is already equipped, or when
 * none are held. Swapping is the caller's job — two explicit calls, so the UI
 * cannot accidentally drop a boost it did not mean to.
 */
export function equipBoost(
  inventory: Inventory,
  id: BoostId,
): { inventory: Inventory; ok: boolean } {
  if (inventory.equippedBoosts.length >= BOOST_SLOTS) {
    return { inventory, ok: false };
  }
  if (inventory.equippedBoosts.includes(id)) {
    return { inventory, ok: false };
  }
  if (countOf(inventory, id) <= 0) {
    return { inventory, ok: false };
  }
  return {
    inventory: freezeInventory({
      ...inventory,
      equippedBoosts: [...inventory.equippedBoosts, id],
    }),
    ok: true,
  };
}

/** Removes a boost from the loadout. Does not consume it. */
export function unequipBoost(inventory: Inventory, id: BoostId): Inventory {
  if (!inventory.equippedBoosts.includes(id)) {
    return inventory;
  }
  return freezeInventory({
    ...inventory,
    equippedBoosts: inventory.equippedBoosts.filter((boost) => boost !== id),
  });
}

/** What the run launcher needs. Guaranteed valid by construction. */
export interface LoadoutView {
  readonly avatarId: string;
  readonly boosts: readonly BoostId[];
  readonly cosmetics: Readonly<Partial<Record<CosmeticSlotName, string>>>;
}

/** The current loadout, repaired if the inventory somehow disagrees with itself. */
export function loadout(inventory: Inventory): LoadoutView {
  const avatarId = inventory.avatars.includes(inventory.equippedAvatar)
    ? inventory.equippedAvatar
    : DEFAULT_AVATAR_ID;
  return Object.freeze({
    avatarId,
    boosts: Object.freeze(inventory.equippedBoosts.slice(0, BOOST_SLOTS)),
    cosmetics: inventory.equippedCosmetics,
  });
}

/**
 * Spends the equipped boosts at run start and clears the loadout.
 *
 * Boosts are consumables: equipping is a promise, starting the run is the
 * payment. Any boost the player somehow does not hold is skipped rather than
 * going negative.
 */
export function consumeLoadout(inventory: Inventory): {
  inventory: Inventory;
  spent: readonly BoostId[];
} {
  let next = inventory;
  const spent: BoostId[] = [];
  for (const boost of inventory.equippedBoosts) {
    const result = consume(next, boost, 1);
    if (result.ok) {
      next = result.inventory;
      spent.push(boost);
    }
  }
  return {
    inventory: freezeInventory({ ...next, equippedBoosts: [] }),
    spent: Object.freeze(spent),
  };
}

/** The `bitsEarned` boost multiplier for a loadout. */
export function boostBitMultiplier(boosts: readonly BoostId[]): number {
  return boosts.includes(Boost.DoubleBits) ? TUNING.economy.doubleBitsMultiplier : 1;
}
