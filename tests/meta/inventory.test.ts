import { describe, expect, it } from "vitest";
import { TUNING } from "@/game/config/tuning";
import {
  BOOSTS,
  BOOST_IDS,
  Boost,
  CosmeticSlot,
  EMPTY_INVENTORY,
  addConsumable,
  boostBitMultiplier,
  consume,
  consumeLoadout,
  countOf,
  equipAvatar,
  equipBoost,
  equipCosmetic,
  loadout,
  ownAvatar,
  ownCosmetic,
  unequipBoost,
  unequipCosmetic,
} from "@/game/meta/inventory";
import { AVATARS, DEFAULT_AVATAR_ID } from "@/game/meta/avatars";

const CAP = TUNING.meta.consumableStackCap;
const SLOTS = TUNING.meta.boostSlots;

/** Gives the inventory `count` of every boost, so equipping is legal. */
function stocked(count = 5) {
  let inventory = EMPTY_INVENTORY;
  for (const id of BOOST_IDS) {
    inventory = addConsumable(inventory, id, count).inventory;
  }
  return inventory;
}

describe("consumables", () => {
  it("stack to 99", () => {
    const { inventory, added } = addConsumable(EMPTY_INVENTORY, Boost.HeadStart, CAP);
    expect(countOf(inventory, Boost.HeadStart)).toBe(CAP);
    expect(added).toBe(CAP);
  });

  /**
   * Charging for an item that evaporates at the cap is small theft that costs
   * far more trust than it earns, so the store is told how many actually landed.
   */
  it("reports how many were actually added when the cap bites", () => {
    const full = addConsumable(EMPTY_INVENTORY, Boost.HeadStart, CAP).inventory;
    const { inventory, added } = addConsumable(full, Boost.HeadStart, 10);
    expect(added).toBe(0);
    expect(countOf(inventory, Boost.HeadStart)).toBe(CAP);

    const nearlyFull = addConsumable(EMPTY_INVENTORY, Boost.HeadStart, CAP - 2).inventory;
    expect(addConsumable(nearlyFull, Boost.HeadStart, 10).added).toBe(2);
  });

  it("ignores a nonsensical quantity", () => {
    expect(addConsumable(EMPTY_INVENTORY, Boost.HeadStart, 0).added).toBe(0);
    expect(addConsumable(EMPTY_INVENTORY, Boost.HeadStart, -5).added).toBe(0);
    expect(addConsumable(EMPTY_INVENTORY, Boost.HeadStart, Number.NaN).added).toBe(0);
  });

  it("consuming refuses rather than going negative", () => {
    const one = addConsumable(EMPTY_INVENTORY, Boost.HeadStart, 1).inventory;
    expect(consume(one, Boost.HeadStart, 2).ok).toBe(false);
    expect(countOf(consume(one, Boost.HeadStart, 2).inventory, Boost.HeadStart)).toBe(1);
  });

  it("removes the key entirely at zero", () => {
    const one = addConsumable(EMPTY_INVENTORY, Boost.HeadStart, 1).inventory;
    const empty = consume(one, Boost.HeadStart, 1).inventory;
    expect(countOf(empty, Boost.HeadStart)).toBe(0);
    expect(Object.keys(empty.consumables)).not.toContain(Boost.HeadStart);
  });

  it("never mutates the inventory it was given", () => {
    const before = addConsumable(EMPTY_INVENTORY, Boost.HeadStart, 3).inventory;
    addConsumable(before, Boost.HeadStart, 5);
    consume(before, Boost.HeadStart, 1);
    expect(countOf(before, Boost.HeadStart)).toBe(3);
  });

  it("returns frozen objects", () => {
    const { inventory } = addConsumable(EMPTY_INVENTORY, Boost.HeadStart, 1);
    expect(Object.isFrozen(inventory)).toBe(true);
    expect(Object.isFrozen(inventory.consumables)).toBe(true);
  });
});

describe("cosmetics", () => {
  it("own then equip; unowned is refused", () => {
    expect(equipCosmetic(EMPTY_INVENTORY, CosmeticSlot.Trail, "trail-ember").ok).toBe(false);

    const owned = ownCosmetic(EMPTY_INVENTORY, "trail-ember");
    const equipped = equipCosmetic(owned, CosmeticSlot.Trail, "trail-ember");
    expect(equipped.ok).toBe(true);
    expect(equipped.inventory.equippedCosmetics.trail).toBe("trail-ember");
  });

  it("never stack — owning twice is a no-op", () => {
    const once = ownCosmetic(EMPTY_INVENTORY, "decal-a");
    const twice = ownCosmetic(once, "decal-a");
    expect(twice.cosmetics.filter((id) => id === "decal-a").length).toBe(1);
    expect(twice).toBe(once);
  });

  it("unequip clears just that slot", () => {
    let inventory = ownCosmetic(EMPTY_INVENTORY, "skin-a");
    inventory = ownCosmetic(inventory, "trail-b");
    inventory = equipCosmetic(inventory, CosmeticSlot.Skin, "skin-a").inventory;
    inventory = equipCosmetic(inventory, CosmeticSlot.Trail, "trail-b").inventory;

    const cleared = unequipCosmetic(inventory, CosmeticSlot.Skin);
    expect(cleared.equippedCosmetics.skin).toBeUndefined();
    expect(cleared.equippedCosmetics.trail).toBe("trail-b");
  });
});

describe("avatars", () => {
  it("the default is always owned and equipped", () => {
    expect(EMPTY_INVENTORY.avatars).toContain(DEFAULT_AVATAR_ID);
    expect(EMPTY_INVENTORY.equippedAvatar).toBe(DEFAULT_AVATAR_ID);
  });

  it("refuses to equip an unowned avatar", () => {
    expect(equipAvatar(EMPTY_INVENTORY, "kestrel").ok).toBe(false);
  });

  it("refuses to own an avatar that does not exist", () => {
    expect(ownAvatar(EMPTY_INVENTORY, "not-a-runner").avatars).not.toContain("not-a-runner");
  });

  it("owns then equips every real avatar", () => {
    for (const avatar of AVATARS) {
      const owned = ownAvatar(EMPTY_INVENTORY, avatar.id);
      const result = equipAvatar(owned, avatar.id);
      expect(result.ok, avatar.id).toBe(true);
      expect(result.inventory.equippedAvatar).toBe(avatar.id);
    }
  });
});

describe("the loadout — 1 avatar + 2 boosts", () => {
  it("holds exactly two boosts and refuses a third", () => {
    let inventory = stocked();
    expect(equipBoost(inventory, Boost.HeadStart).ok).toBe(true);
    inventory = equipBoost(inventory, Boost.HeadStart).inventory;
    inventory = equipBoost(inventory, Boost.DoubleBits).inventory;

    expect(inventory.equippedBoosts.length).toBe(SLOTS);
    expect(equipBoost(inventory, Boost.FlowPrimer).ok).toBe(false);
    expect(inventory.equippedBoosts.length).toBe(SLOTS);
  });

  it("refuses to equip the same boost twice", () => {
    let inventory = stocked();
    inventory = equipBoost(inventory, Boost.HeadStart).inventory;
    expect(equipBoost(inventory, Boost.HeadStart).ok).toBe(false);
  });

  it("refuses to equip a boost the player does not hold", () => {
    expect(equipBoost(EMPTY_INVENTORY, Boost.HeadStart).ok).toBe(false);
  });

  it("unequip frees a slot without consuming the boost", () => {
    let inventory = stocked();
    inventory = equipBoost(inventory, Boost.HeadStart).inventory;
    const before = countOf(inventory, Boost.HeadStart);

    inventory = unequipBoost(inventory, Boost.HeadStart);
    expect(inventory.equippedBoosts).toEqual([]);
    expect(countOf(inventory, Boost.HeadStart)).toBe(before);
  });

  it("loadout() is valid even if the inventory disagrees with itself", () => {
    const broken = Object.freeze({
      ...EMPTY_INVENTORY,
      equippedAvatar: "a-deleted-runner",
      equippedBoosts: [Boost.HeadStart, Boost.DoubleBits, Boost.FlowPrimer],
    });
    const view = loadout(broken);
    expect(view.avatarId).toBe(DEFAULT_AVATAR_ID);
    expect(view.boosts.length).toBe(SLOTS);
  });

  it("starting a run spends the equipped boosts and clears the loadout", () => {
    let inventory = stocked(2);
    inventory = equipBoost(inventory, Boost.HeadStart).inventory;
    inventory = equipBoost(inventory, Boost.DoubleBits).inventory;

    const { inventory: after, spent } = consumeLoadout(inventory);
    expect(spent).toEqual([Boost.HeadStart, Boost.DoubleBits]);
    expect(after.equippedBoosts).toEqual([]);
    expect(countOf(after, Boost.HeadStart)).toBe(1);
    expect(countOf(after, Boost.DoubleBits)).toBe(1);
  });

  it("skips a boost the player somehow does not hold rather than going negative", () => {
    const inventory = Object.freeze({
      ...EMPTY_INVENTORY,
      equippedBoosts: [Boost.HeadStart],
    });
    const { inventory: after, spent } = consumeLoadout(inventory);
    expect(spent).toEqual([]);
    expect(countOf(after, Boost.HeadStart)).toBe(0);
  });

  it("the 2x Bits boost is the only one that multiplies Bits", () => {
    expect(boostBitMultiplier([])).toBe(1);
    expect(boostBitMultiplier([Boost.HeadStart])).toBe(1);
    expect(boostBitMultiplier([Boost.DoubleBits])).toBe(TUNING.economy.doubleBitsMultiplier);
  });
});

describe("boost definitions", () => {
  it("price every boost from tuning, per GAME_BIBLE §9.2", () => {
    expect(BOOSTS[Boost.HeadStart].cost).toBe(TUNING.economy.boostCost.headStart);
    expect(BOOSTS[Boost.DoubleBits].cost).toBe(TUNING.economy.boostCost.doubleBits);
    expect(BOOSTS[Boost.FlowPrimer].cost).toBe(TUNING.economy.boostCost.flowPrimer);
  });

  it("there are exactly three, all labelled", () => {
    expect(BOOST_IDS.length).toBe(3);
    for (const id of BOOST_IDS) {
      expect(BOOSTS[id].label.length).toBeGreaterThan(0);
      expect(BOOSTS[id].description.length).toBeGreaterThan(0);
    }
  });
});
