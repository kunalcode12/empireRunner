"use client";

/**
 * The title.
 *
 * ## The menu is inside the game world
 *
 * There is a live 3D diorama behind this — the runner idling in the tunnel with
 * the camera slowly orbiting — and this screen is deliberately built so you can
 * see it. No scrim, no blurred backdrop, no full-bleed plate. The wordmark and
 * the menu column sit on the left third and the tunnel is visible past them.
 *
 * The token ground is the same key-line black as the 3D scene background
 * (`render/palette.ts`), which is why the DOM does not read as a layer over the
 * world so much as part of it.
 *
 * ## Screens unlock as the player meets them
 *
 * `progression.isUnlocked` gates the store at 2 runs, missions at 3, the loadout
 * at 4 — GAME_BIBLE §9.5. Locked entries are rendered, disabled, with a padlock
 * and the requirement stated. Hiding them entirely means a returning player
 * cannot see what is coming; showing them enabled and failing on click is worse.
 */

import { Unlockable, isUnlocked, levelProgress, type UnlockableName } from "@/game/meta";
import { Button } from "../components/Button";
import { Glyph } from "../components/Glyph";
import { Meter } from "../components/Meter";
import { ScreenShell } from "./ScreenShell";
import { Screen, useUiStore, type ScreenName } from "../state/uiStore";
import { useMetaStore } from "../state/metaStore";

interface MenuEntry {
  readonly label: string;
  readonly screen: ScreenName;
  readonly gate: UnlockableName | null;
  readonly requirement: string;
}

const MENU: readonly MenuEntry[] = [
  { label: "LOADOUT", screen: Screen.Inventory, gate: Unlockable.Loadout, requirement: "4 runs" },
  { label: "RUNNERS", screen: Screen.Avatars, gate: Unlockable.Loadout, requirement: "4 runs" },
  { label: "SHOP", screen: Screen.Shop, gate: Unlockable.Store, requirement: "2 runs" },
  { label: "MISSIONS", screen: Screen.Missions, gate: Unlockable.Missions, requirement: "3 runs" },
  { label: "LEADERBOARD", screen: Screen.Leaderboard, gate: null, requirement: "" },
  { label: "SETTINGS", screen: Screen.Settings, gate: null, requirement: "" },
];

export function TitleScreen(): React.ReactElement {
  const go = useUiStore((state) => state.go);
  const startRun = useUiStore((state) => state.startRun);
  const balances = useMetaStore((state) => state.balances);
  const lifetime = useMetaStore((state) => state.lifetime);

  const level = levelProgress(lifetime.distance);

  return (
    <ScreenShell title="AXIS" bare className="axis-title">
      <div className="axis-title-column">
        {/* The wordmark is a heading in the visual hierarchy but not in the
            document one — ScreenShell already owns the h1, and two h1s on a
            screen is an axe violation and a genuine navigation problem. */}
        <p className="axis-wordmark" aria-hidden="true">
          AXIS
        </p>
        <p className="axis-tagline">
          Four faces. Twelve positions. Roll the world to find the floor.
        </p>

        <nav className="axis-title-menu" aria-label="Main menu">
          <Button
            variant="primary"
            block
            autoFocus
            onClick={() => startRun()}
            className="axis-title-run"
          >
            RUN
          </Button>

          {MENU.map((entry) => {
            const locked = entry.gate !== null && !isUnlocked(entry.gate, lifetime);
            return (
              <Button
                key={entry.screen}
                block
                disabled={locked}
                onClick={() => go(entry.screen)}
                ariaLabel={locked ? `${entry.label}. Locked — ${entry.requirement}.` : undefined}
              >
                <span>{entry.label}</span>
                {locked && (
                  <span className="axis-title-lock">
                    <Glyph name="lock" />
                    <span className="axis-label">{entry.requirement}</span>
                  </span>
                )}
              </Button>
            );
          })}
        </nav>
      </div>

      <footer className="axis-title-foot">
        <p className="axis-currency">
          <span className="axis-currency-item">
            <Glyph name="bit" label="Bits" />
            <span className="axis-num">{balances.bits.toLocaleString("en-US")}</span>
          </span>
          <span className="axis-currency-item">
            <Glyph name="shard" label="Shards" />
            <span className="axis-num">{balances.shards.toLocaleString("en-US")}</span>
          </span>
        </p>

        <div className="axis-title-level">
          <p className="axis-label">
            LEVEL <span className="axis-num">{level.level}</span>
          </p>
          <Meter
            value={level.fraction}
            max={1}
            steps={12}
            label={
              level.maxed
                ? `Level ${level.level}, the maximum`
                : `Level ${level.level}, ${Math.round(level.remaining)} metres to the next`
            }
          />
        </div>
      </footer>
    </ScreenShell>
  );
}
