"use client";

/**
 * The roster — eight runners.
 *
 * ## Selection is signalled three ways
 *
 * Accent fill, a double key-line, and a corner notch. GAME_BIBLE §9.1 makes five
 * of the eight challenge unlocks rather than purchases, so this screen is a
 * progress display as much as a picker, and "which one am I on" has to survive
 * being read at a glance by anyone.
 *
 * ## The grid is one tab stop
 *
 * Roving tabindex — Tab enters the grid, arrows move within it, Tab leaves. The
 * alternative is eight tab stops between the back button and the detail panel,
 * which is the most common accessibility failure in a picker like this.
 *
 * ## The silhouettes are drawn, not loaded
 *
 * `AvatarVisual` is a colour pair and a build descriptor, deliberately — P13's
 * note says "descriptors, not asset paths — nothing here 404s". So each tile
 * draws a primitive silhouette from those two colours at the given build. It is
 * honest grey-box art rather than a broken image, and it recolours per runner.
 */

import { useEffect, useRef } from "react";
import { AVATARS, UnlockKind, type Avatar, type AvatarVisual } from "@/game/meta";
import { rovingTabindex } from "../a11y/focus";
import { Button } from "../components/Button";
import { Glyph } from "../components/Glyph";
import { Meter } from "../components/Meter";
import { Plate } from "../components/Plate";
import { CurrencyBar, ScreenShell } from "./ScreenShell";
import { Screen, useUiStore } from "../state/uiStore";
import { useMetaStore } from "../state/metaStore";

const COLUMNS = 4;

/** Build to silhouette proportions. Three shapes, no assets. */
const BUILD: Readonly<Record<AvatarVisual["build"], { w: number; h: number }>> = Object.freeze({
  lean: { w: 26, h: 62 },
  standard: { w: 34, h: 58 },
  heavy: { w: 44, h: 52 },
});

function Silhouette({ visual }: { readonly visual: AvatarVisual }): React.ReactElement {
  const { w, h } = BUILD[visual.build];
  const x = (100 - w) / 2;
  const y = 90 - h;
  return (
    <svg viewBox="0 0 100 100" className="axis-avatar-figure" aria-hidden="true" focusable="false">
      <rect x={x} y={y} width={w} height={h} fill={visual.primary} />
      <rect x={x} y={y} width={w} height={h * 0.28} fill={visual.accent} />
      <rect x={x} y={y} width={w} height={h} fill="none" stroke="var(--axis-ink)" strokeWidth={3} />
    </svg>
  );
}

/** How the unlock condition reads on a tile. */
function unlockLine(avatar: Avatar): string {
  switch (avatar.unlock.kind) {
    case UnlockKind.Default:
      return "DEFAULT";
    case UnlockKind.Bits:
      return `${avatar.unlock.bits.toLocaleString("en-US")} BITS`;
    case UnlockKind.Shards:
      return `${avatar.unlock.shards} SHARDS`;
    default:
      return "CHALLENGE";
  }
}

export function AvatarScreen(): React.ReactElement {
  const go = useUiStore((state) => state.go);
  const balances = useMetaStore((state) => state.balances);
  const inventory = useMetaStore((state) => state.inventory);
  const lifetime = useMetaStore((state) => state.lifetime);
  const selectAvatar = useMetaStore((state) => state.selectAvatar);
  const purchaseAvatar = useMetaStore((state) => state.purchaseAvatar);

  const gridRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const grid = gridRef.current;
    if (grid === null) {
      return;
    }
    const roving = rovingTabindex(grid, COLUMNS);
    return () => roving.release();
  }, []);

  const owned = new Set(inventory.avatars);
  const equipped = inventory.equippedAvatar;
  const selected = AVATARS.find((avatar) => avatar.id === equipped) ?? AVATARS[0];

  return (
    <ScreenShell
      title="Runners"
      onBack={() => go(Screen.Title)}
      aside={<CurrencyBar bits={balances.bits} shards={balances.shards} />}
    >
      <p className="axis-label axis-avatar-count">
        <span className="axis-num">{owned.size}</span> of{" "}
        <span className="axis-num">{AVATARS.length}</span> UNLOCKED
      </p>

      <div ref={gridRef} className="axis-avatar-grid" role="group" aria-label="Runners">
        {AVATARS.map((avatar) => {
          const isOwned = owned.has(avatar.id);
          const isEquipped = avatar.id === equipped;
          return (
            <button
              key={avatar.id}
              type="button"
              data-nav={avatar.id}
              className="axis-avatar-tile"
              data-owned={isOwned ? "1" : "0"}
              data-equipped={isEquipped ? "1" : "0"}
              aria-pressed={isEquipped}
              onClick={() => (isOwned ? selectAvatar(avatar.id) : undefined)}
              aria-label={
                isOwned
                  ? `${avatar.name}. ${avatar.passive.description}${isEquipped ? " Equipped." : ""}`
                  : `${avatar.name}. Locked — ${avatar.unlock.description}`
              }
            >
              <Silhouette visual={avatar.visual} />
              <span className="axis-avatar-name">{avatar.name}</span>
              <span className="axis-label axis-avatar-unlock">
                {isOwned
                  ? avatar.passive.magnitude === 0 && avatar.unlock.kind === UnlockKind.Default
                    ? "—"
                    : "OWNED"
                  : unlockLine(avatar)}
              </span>
              {!isOwned && (
                <span className="axis-avatar-lockmark" aria-hidden="true">
                  <Glyph name="lock" />
                </span>
              )}
            </button>
          );
        })}
      </div>

      {selected !== undefined && (
        <Plate as="section" className="axis-avatar-detail" ariaLabel={`${selected.name} details`}>
          <h2 className="axis-avatar-detailname">{selected.name}</h2>
          <p className="axis-body">{selected.passive.description}</p>
          <p className="axis-body axis-avatar-note">{selected.visual.note}</p>

          {!owned.has(selected.id) && selected.unlock.kind === UnlockKind.Challenge && (
            <Plate flat className="axis-avatar-challenge">
              <p className="axis-label">CHALLENGE</p>
              <p className="axis-body">{selected.unlock.description}</p>
              {/* Deliberately not a live progress bar. `AvatarUnlock.challenge`
                  is a predicate over a FINISHED run, not a running counter —
                  P13's note explains why, and inventing a counter here would be
                  a second source of truth that can desync from the predicate. */}
              <p className="axis-body axis-avatar-hint">Checked at the end of every run.</p>
            </Plate>
          )}

          {!owned.has(selected.id) && selected.unlock.kind !== UnlockKind.Challenge && (
            <Button
              variant="primary"
              disabled={
                balances.bits < selected.unlock.bits || balances.shards < selected.unlock.shards
              }
              onClick={() =>
                void purchaseAvatar(selected.id, selected.unlock.bits, selected.unlock.shards)
              }
            >
              UNLOCK · {unlockLine(selected)}
            </Button>
          )}

          {owned.has(selected.id) && selected.id !== equipped && (
            <Button variant="primary" onClick={() => selectAvatar(selected.id)}>
              EQUIP
            </Button>
          )}
        </Plate>
      )}

      <Plate flat as="section" className="axis-avatar-lifetime" ariaLabel="Lifetime totals">
        <p className="axis-label">LIFETIME</p>
        <Meter
          value={owned.size}
          max={AVATARS.length}
          steps={AVATARS.length}
          label={`${owned.size} of ${AVATARS.length} runners unlocked`}
        />
        <p className="axis-body">
          <span className="axis-num">{lifetime.runs.toLocaleString("en-US")}</span> runs ·{" "}
          <span className="axis-num">{Math.floor(lifetime.distance).toLocaleString("en-US")}</span>m
        </p>
      </Plate>
    </ScreenShell>
  );
}
