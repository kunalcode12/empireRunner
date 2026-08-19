"use client";

/**
 * Dailies and the weekly contract.
 *
 * ## The three dailies are the same three for everybody
 *
 * `dailyStatuses` derives them from a UTC date seed, so a player in Auckland and
 * a player in Los Angeles see the same set on the same calendar day —
 * `tests/meta/missions.test.ts` asserts that across five timezones including both
 * sides of the date line. This screen says "resets 00:00 UTC" out loud, because a
 * player whose midnight is not UTC midnight will otherwise think it is broken.
 *
 * ## Completion is not signalled by colour
 *
 * A complete mission gets a filled meter, a struck-through label, and the word
 * COMPLETE. The strike-through is the channel that survives any colour vision.
 */

import { useEffect } from "react";
import { dailyStatuses, weeklyStatuses, type MissionStatus } from "@/game/meta";
import { TUNING } from "@/game/config/tuning";
import { Glyph } from "../components/Glyph";
import { Meter } from "../components/Meter";
import { Plate } from "../components/Plate";
import { CurrencyBar, ScreenShell } from "./ScreenShell";
import { Screen, useUiStore } from "../state/uiStore";
import { useMetaStore } from "../state/metaStore";

function MissionRow({ status }: { readonly status: MissionStatus }): React.ReactElement {
  return (
    <Plate as="li" className="axis-mission" flat>
      <div className="axis-mission-head">
        <p className="axis-body axis-mission-label" data-complete={status.complete ? "1" : "0"}>
          {status.label}
        </p>
        {status.complete && <span className="axis-label axis-mission-done">COMPLETE</span>}
      </div>
      <Meter
        value={status.value}
        max={status.target}
        label={`${status.label}: ${Math.floor(status.value)} of ${status.target}`}
      />
      <p className="axis-label axis-mission-progress">
        <span className="axis-num">{Math.floor(status.value).toLocaleString("en-US")}</span>
        {" / "}
        <span className="axis-num">{status.target.toLocaleString("en-US")}</span>
        {!status.complete && (
          <>
            {" · "}
            <span className="axis-num">{Math.ceil(status.shortBy).toLocaleString("en-US")}</span> TO
            GO
          </>
        )}
      </p>
    </Plate>
  );
}

export function MissionsScreen(): React.ReactElement {
  const go = useUiStore((state) => state.go);
  const balances = useMetaStore((state) => state.balances);
  const missions = useMetaStore((state) => state.missions);
  const seeScreen = useMetaStore((state) => state.seeScreen);

  useEffect(() => {
    seeScreen("seenMissions");
  }, [seeScreen]);

  const dailies = dailyStatuses(missions);
  const weekly = weeklyStatuses(missions);
  const dailiesDone = dailies.filter((status) => status.complete).length;

  // Computed here rather than by calling `claimRewards`, which is deliberately
  // not a read: it returns progress with the claims already recorded, so using
  // it for a preview would mean a screen render was the thing that decided a
  // reward had been paid. Settlement claims; this only counts.
  const dailyPending =
    dailies.length > 0 &&
    dailies.every((status) => status.complete) &&
    !dailies.every((status) => missions.claimedDailies.includes(status.id))
      ? TUNING.meta.dailyAllCompleteShards
      : 0;
  let weeklyPending = 0;
  for (const status of weekly) {
    const tier = status.tier ?? 0;
    if (status.complete && !missions.claimedWeeklyTiers.includes(tier)) {
      weeklyPending += TUNING.meta.weeklyTierShards[tier - 1] ?? 0;
    }
  }
  const pendingShards = dailyPending + weeklyPending;

  return (
    <ScreenShell
      title="Missions"
      onBack={() => go(Screen.Title)}
      aside={<CurrencyBar bits={balances.bits} shards={balances.shards} />}
    >
      <section aria-labelledby="daily-heading" className="axis-mission-section">
        <div className="axis-mission-sectionhead">
          <h2 id="daily-heading" className="axis-mission-heading">
            DAILY
          </h2>
          <p className="axis-label">
            <span className="axis-num">{dailiesDone}</span>/
            <span className="axis-num">{dailies.length}</span> · ALL THREE PAY{" "}
            <Glyph name="shard" label="Shards" />
            <span className="axis-num">{TUNING.meta.dailyAllCompleteShards}</span> · RESETS 00:00
            UTC
          </p>
        </div>
        <ul className="axis-mission-list">
          {dailies.map((status) => (
            <MissionRow key={status.id} status={status} />
          ))}
        </ul>
      </section>

      <section aria-labelledby="weekly-heading" className="axis-mission-section">
        <div className="axis-mission-sectionhead">
          <h2 id="weekly-heading" className="axis-mission-heading">
            WEEKLY CONTRACT
          </h2>
          <p className="axis-label">
            TIERS PAY{" "}
            {TUNING.meta.weeklyTierShards.map((shards, index) => (
              <span key={index}>
                {index > 0 ? " / " : ""}
                <span className="axis-num">{shards}</span>
              </span>
            ))}{" "}
            · RESETS MONDAY 00:00 UTC
          </p>
        </div>
        <ul className="axis-mission-list">
          {weekly.map((status) => (
            <MissionRow key={status.id} status={status} />
          ))}
        </ul>
      </section>

      {pendingShards > 0 && (
        <Plate className="axis-mission-pending" ariaLabel="Rewards pending">
          <p className="axis-body">
            <Glyph name="shard" label="Shards" />
            <span className="axis-num">{pendingShards}</span> waiting — paid into your balance at
            the end of your next run.
          </p>
        </Plate>
      )}
    </ScreenShell>
  );
}
