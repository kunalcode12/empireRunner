"use client";

/**
 * The loadout — 1 avatar, 2 boosts, and what is in the drawer.
 *
 * ## There is no way to buy a slot, and that is deliberate
 *
 * GAME_BIBLE §9.3: "No loadout slots are sold. Selling loadout slots is the most
 * common way this genre turns a clean meta into a spreadsheet." So the slot count
 * is read from `TUNING.meta.boostSlots`, there is no control that changes it, and
 * `meta/save.ts`'s validator truncates a hostile save file down to it. Three
 * layers agreeing on one rule.
 *
 * ## Empty slots are buttons, not gaps
 *
 * An empty boost slot renders as a labelled "+ EQUIP" target rather than a dashed
 * outline, because a dashed outline is decoration a keyboard cannot reach and a
 * screen reader does not mention.
 */

import { TUNING } from "@/game/config/tuning";
import {
  BOOSTS,
  BOOST_IDS,
  CosmeticSlot,
  avatarById,
  countOf,
  type BoostId,
  type CosmeticSlotName,
} from "@/game/meta";
import { Button } from "../components/Button";
import { Glyph } from "../components/Glyph";
import { Plate } from "../components/Plate";
import { CurrencyBar, ScreenShell } from "./ScreenShell";
import { Screen, useUiStore } from "../state/uiStore";
import { useMetaStore } from "../state/metaStore";

const COSMETIC_SLOTS: readonly { slot: CosmeticSlotName; label: string }[] = [
  { slot: CosmeticSlot.Skin, label: "SKIN" },
  { slot: CosmeticSlot.Trail, label: "TRAIL" },
  { slot: CosmeticSlot.Decal, label: "DECAL" },
];

export function InventoryScreen(): React.ReactElement {
  const go = useUiStore((state) => state.go);
  const balances = useMetaStore((state) => state.balances);
  const inventory = useMetaStore((state) => state.inventory);
  const toggleBoost = useMetaStore((state) => state.toggleBoost);

  const avatar = avatarById(inventory.equippedAvatar);
  const equipped = inventory.equippedBoosts;
  const emptySlots = Math.max(0, TUNING.meta.boostSlots - equipped.length);

  return (
    <ScreenShell
      title="Loadout"
      onBack={() => go(Screen.Title)}
      aside={<CurrencyBar bits={balances.bits} shards={balances.shards} />}
    >
      <div className="axis-loadout">
        <section className="axis-loadout-avatar" aria-label="Equipped runner">
          <p className="axis-label">
            AVATAR ×<span className="axis-num">{TUNING.meta.avatarSlots}</span>
          </p>
          <Plate className="axis-loadout-avatarplate">
            <h2 className="axis-loadout-name">{avatar?.name ?? "—"}</h2>
            <p className="axis-body">{avatar?.passive.description ?? "No runner equipped."}</p>
            <Button onClick={() => go(Screen.Avatars)}>CHANGE</Button>
          </Plate>
        </section>

        <section className="axis-loadout-boosts" aria-label="Equipped boosts">
          <p className="axis-label">
            BOOSTS ×<span className="axis-num">{TUNING.meta.boostSlots}</span>
          </p>
          <div className="axis-loadout-slots">
            {equipped.map((id) => (
              <Plate key={id} className="axis-loadout-slot">
                <h3 className="axis-loadout-name">{BOOSTS[id].label}</h3>
                <p className="axis-body">{BOOSTS[id].description}</p>
                <p className="axis-label">
                  HELD <span className="axis-num">{countOf(inventory, id)}</span>
                </p>
                <Button onClick={() => toggleBoost(id)} ariaLabel={`Unequip ${BOOSTS[id].label}`}>
                  UNEQUIP
                </Button>
              </Plate>
            ))}
            {Array.from({ length: emptySlots }, (_unused, index) => (
              <Plate key={`empty-${index}`} flat className="axis-loadout-slot axis-loadout-empty">
                <p className="axis-label">EMPTY SLOT</p>
                <p className="axis-body">Equip a boost from below.</p>
              </Plate>
            ))}
          </div>
        </section>
      </div>

      <section className="axis-loadout-drawer" aria-label="Consumables">
        <p className="axis-label">
          CONSUMABLES · STACK CAP <span className="axis-num">{TUNING.meta.consumableStackCap}</span>
        </p>
        <div className="axis-loadout-grid">
          {BOOST_IDS.map((id: BoostId) => {
            const held = countOf(inventory, id);
            const isEquipped = equipped.includes(id);
            const canEquip = held > 0 && !isEquipped && equipped.length < TUNING.meta.boostSlots;
            return (
              <Plate key={id} as="section" className="axis-loadout-item">
                <div className="axis-loadout-itemhead">
                  <h3 className="axis-loadout-name">{BOOSTS[id].label}</h3>
                  <span className="axis-num axis-loadout-count">×{held}</span>
                </div>
                <p className="axis-body">{BOOSTS[id].description}</p>
                {held === 0 ? (
                  <Button onClick={() => go(Screen.Shop)} ariaLabel={`Buy ${BOOSTS[id].label}`}>
                    <Glyph name="bit" />
                    <span className="axis-num">{BOOSTS[id].cost.toLocaleString("en-US")}</span>
                  </Button>
                ) : (
                  <Button
                    variant={isEquipped ? "secondary" : "primary"}
                    disabled={!canEquip && !isEquipped}
                    onClick={() => toggleBoost(id)}
                  >
                    {isEquipped ? "UNEQUIP" : "EQUIP"}
                  </Button>
                )}
              </Plate>
            );
          })}
        </div>
      </section>

      <section className="axis-loadout-drawer" aria-label="Cosmetics">
        <p className="axis-label">COSMETICS</p>
        <div className="axis-loadout-grid">
          {COSMETIC_SLOTS.map(({ slot, label }) => {
            const worn = inventory.equippedCosmetics[slot];
            return (
              <Plate key={slot} flat as="section" className="axis-loadout-item">
                <h3 className="axis-loadout-name">{label}</h3>
                <p className="axis-body">{worn ?? "None owned yet."}</p>
              </Plate>
            );
          })}
        </div>
      </section>
    </ScreenShell>
  );
}
