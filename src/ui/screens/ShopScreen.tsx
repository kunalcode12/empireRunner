"use client";

/**
 * The shop — upgrades, boosts, cosmetics.
 *
 * ## Not one price is written in this file
 *
 * Every cost comes from `upgradeCost` and every effect from `effectValue`, which
 * are the functions `tests/meta/upgrades.test.ts` snapshots. GAME_BIBLE §8.2's
 * table had two arithmetic slips that survived until P13 recomputed it; the only
 * defence against that recurring is to have exactly one source, and a UI that
 * restates a price is a second one.
 *
 * ## Tabs are a real tablist
 *
 * `role="tablist"` with arrow-key movement, `aria-selected`, and panels wired by
 * `aria-controls`. The active tab is distinguished by fill **and** by being 4px
 * taller, because a tab identified only by colour is unusable to a player who
 * cannot separate the accent from the plate.
 */

import { useEffect, useRef, useState } from "react";
import {
  BOOSTS,
  BOOST_IDS,
  UPGRADES,
  UPGRADE_TRACKS,
  countOf,
  effectValue,
  fullClearCost,
  upgradeCost,
  type BoostId,
  type UpgradeTrackName,
} from "@/game/meta";
import { TUNING } from "@/game/config/tuning";
import { Button } from "../components/Button";
import { Glyph } from "../components/Glyph";
import { Plate } from "../components/Plate";
import { TierPips } from "../components/TierPips";
import { CurrencyBar, ScreenShell } from "./ScreenShell";
import { Screen, useUiStore } from "../state/uiStore";
import { useMetaStore } from "../state/metaStore";

const TABS = [
  { id: "upgrades", label: "UPGRADES" },
  { id: "boosts", label: "BOOSTS" },
  { id: "cosmetics", label: "COSMETICS" },
] as const;
type TabId = (typeof TABS)[number]["id"];

/** How a track's effect reads to a player. The unit is not in the data table. */
function formatEffect(track: UpgradeTrackName, tier: number): string {
  const value = effectValue(track, tier);
  const definition = UPGRADES[track];
  if (definition.stepped) {
    return `${value} shield${value === 1 ? "" : "s"}`;
  }
  if (track === "bitValue") {
    return `${value.toFixed(2)}×`;
  }
  return value.toFixed(2);
}

export function ShopScreen(): React.ReactElement {
  const go = useUiStore((state) => state.go);
  const balances = useMetaStore((state) => state.balances);
  const upgrades = useMetaStore((state) => state.upgrades);
  const inventory = useMetaStore((state) => state.inventory);
  const buyUpgrade = useMetaStore((state) => state.buyUpgrade);
  const buyBoost = useMetaStore((state) => state.buyBoost);
  const seeScreen = useMetaStore((state) => state.seeScreen);

  const [tab, setTab] = useState<TabId>("upgrades");
  const tabsRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    seeScreen("seenStore");
  }, [seeScreen]);

  // Arrow keys move between tabs — WAI-ARIA's tablist pattern, and the same
  // events the gamepad navigator synthesises, so the pad gets it for free.
  function onTabKeyDown(event: React.KeyboardEvent): void {
    const index = TABS.findIndex((entry) => entry.id === tab);
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      const delta = event.key === "ArrowRight" ? 1 : -1;
      const next = TABS[(index + delta + TABS.length) % TABS.length];
      if (next !== undefined) {
        setTab(next.id);
        tabsRef.current?.querySelectorAll("button")[TABS.indexOf(next)]?.focus();
      }
    }
  }

  return (
    <ScreenShell
      title="Shop"
      onBack={() => go(Screen.Title)}
      aside={<CurrencyBar bits={balances.bits} shards={balances.shards} />}
    >
      <div
        ref={tabsRef}
        className="axis-tabs"
        role="tablist"
        aria-label="Shop sections"
        onKeyDown={onTabKeyDown}
      >
        {TABS.map((entry) => (
          <Button
            key={entry.id}
            role="tab"
            selected={tab === entry.id}
            notTabbable={tab !== entry.id}
            ariaControls={`panel-${entry.id}`}
            onClick={() => setTab(entry.id)}
            className="axis-tab"
          >
            {entry.label}
          </Button>
        ))}
      </div>

      {tab === "upgrades" && (
        <div id="panel-upgrades" role="tabpanel" aria-label="Upgrades" className="axis-shop-list">
          {UPGRADE_TRACKS.map((track) => {
            const tier = upgrades[track] ?? 0;
            const maxed = tier >= TUNING.economy.upgradeMaxTier;
            const cost = maxed ? 0 : upgradeCost(track, tier + 1);
            const affordable = !maxed && balances.bits >= cost;
            return (
              <Plate key={track} as="section" className="axis-shop-row">
                <div className="axis-shop-rowhead">
                  <h2 className="axis-shop-name">{UPGRADES[track].label}</h2>
                  <TierPips tier={tier} label={UPGRADES[track].label} />
                </div>
                <p className="axis-body axis-shop-effect">
                  <span className="axis-num">{formatEffect(track, tier)}</span>
                  {!maxed && (
                    <>
                      <span aria-hidden="true"> → </span>
                      <span className="axis-num axis-shop-next">
                        {formatEffect(track, tier + 1)}
                      </span>
                      <span className="axis-sr-only"> improves to </span>
                    </>
                  )}
                </p>
                {maxed ? (
                  <p className="axis-shop-owned">— OWNED —</p>
                ) : (
                  <Button
                    variant={affordable ? "primary" : "secondary"}
                    disabled={!affordable}
                    onClick={() => void buyUpgrade(track)}
                    ariaLabel={`Buy tier ${tier + 1} of ${UPGRADES[track].label} for ${cost} Bits`}
                  >
                    <span>T{tier + 1}</span>
                    <Glyph name="bit" />
                    <span className="axis-num">{cost.toLocaleString("en-US")}</span>
                  </Button>
                )}
              </Plate>
            );
          })}
          <p className="axis-label axis-shop-total">
            FULL CLEAR <span className="axis-num">{fullClearCost().toLocaleString("en-US")}</span>{" "}
            BITS
          </p>
        </div>
      )}

      {tab === "boosts" && (
        <div id="panel-boosts" role="tabpanel" aria-label="Boosts" className="axis-shop-list">
          {BOOST_IDS.map((id: BoostId) => {
            const definition = BOOSTS[id];
            const held = countOf(inventory, id);
            const atCap = held >= TUNING.meta.consumableStackCap;
            const affordable = balances.bits >= definition.cost && !atCap;
            return (
              <Plate key={id} as="section" className="axis-shop-row">
                <div className="axis-shop-rowhead">
                  <h2 className="axis-shop-name">{definition.label}</h2>
                  <span className="axis-label">
                    HELD <span className="axis-num">{held}</span>
                  </span>
                </div>
                <p className="axis-body">{definition.description}</p>
                <Button
                  variant={affordable ? "primary" : "secondary"}
                  disabled={!affordable}
                  onClick={() => void buyBoost(id, 1)}
                  ariaLabel={
                    atCap
                      ? `${definition.label} is at the stack cap of ${TUNING.meta.consumableStackCap}`
                      : `Buy one ${definition.label} for ${definition.cost} Bits`
                  }
                >
                  <Glyph name="bit" />
                  <span className="axis-num">{definition.cost.toLocaleString("en-US")}</span>
                </Button>
              </Plate>
            );
          })}
        </div>
      )}

      {tab === "cosmetics" && (
        <div id="panel-cosmetics" role="tabpanel" aria-label="Cosmetics" className="axis-shop-list">
          {/* Honest rather than padded with placeholders. Skins, trails and
              decals are authored art, and there is none in this repository —
              GAME_BIBLE §9.3 lists the slots, P10 makes the assets. Inventing
              six fake ones would test nothing and mislead the next reader. */}
          <Plate as="section" className="axis-shop-empty">
            <h2 className="axis-shop-name">Nothing here yet</h2>
            <p className="axis-body">
              Skins, trail colourways and tunnel decals arrive with the art pass. The inventory, the
              slots and the equip flow are already built — see LOADOUT.
            </p>
          </Plate>
        </div>
      )}
    </ScreenShell>
  );
}
