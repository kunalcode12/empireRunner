"use client";

/**
 * The death screen — a designed moment, in five beats.
 *
 * ```
 *   ① score counts up
 *   ② personal-best comparison
 *   ③ the mission near-miss — "YOU WERE 594m SHORT"
 *   ④ Bits earned
 *   ⑤ retry, focused
 * ```
 *
 * ## Beat ③ comes before beat ④, and that is the whole design
 *
 * GAME_BIBLE §9.4 calls the near-miss line "a **required** element of the death
 * screen" and says it "does more for D2 retention than any reward in the game".
 * It only does that if it lands while the loss still stings. Putting the Bits
 * first turns the sting into a receipt — the player reads "you earned 310" and
 * the shortfall arrives as an afterthought. Reversing these two is the single
 * easiest way to break this screen, so the order is asserted in
 * `tests/ui/death-sequence.test.ts` rather than left to whoever edits next.
 *
 * ## Any input skips to the end
 *
 * An arcade player retries in under two seconds. A sequence they cannot skip is a
 * churn mechanic, so the first key, tap, click or pad press jumps straight to the
 * final state with RETRY focused. Nothing is lost by skipping — every beat is
 * still on screen, just immediately.
 *
 * ## It settles the run
 *
 * This is the one caller of `settleRun`. P13 built the whole meta layer and
 * deliberately left it unreachable, flagging the wiring for P14; this is that
 * wiring. Settlement runs once, guarded by a ref, because committing a run's
 * rewards twice would double every Bit.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { TUNING } from "@/game/config/tuning";
import { closestUnmet, formatShortfall, type RunSummary } from "@/game/meta";
import { MOTION, easeOutCubic, motionIsReduced } from "../motion";
import { Button } from "../components/Button";
import { Glyph } from "../components/Glyph";
import { Meter } from "../components/Meter";
import { Plate } from "../components/Plate";
import { ScreenShell } from "./ScreenShell";
import { Screen, useUiStore } from "../state/uiStore";
import { useMetaStore } from "../state/metaStore";
import { createLocalLeaderboard } from "../state/leaderboard";

/** How far through the sequence we are. Beats reveal at or below this. */
const BEATS = { score: 1, best: 2, mission: 3, bits: 4, actions: 5 } as const;
const LAST_BEAT = BEATS.actions;

export interface DeathScreenProps {
  /** The finished run. Null while the summary is still being built. */
  readonly summary: RunSummary | null;
}

export function DeathScreen({ summary }: DeathScreenProps): React.ReactElement {
  const beginRun = useUiStore((state) => state.beginRun);
  const go = useUiStore((state) => state.go);
  const finishRun = useMetaStore((state) => state.finishRun);
  const settlement = useMetaStore((state) => state.lastSettlement);
  const missions = useMetaStore((state) => state.missions);
  const previousBest = useMetaStore((state) => state.previousBest);

  const [beat, setBeat] = useState(0);
  const [countedScore, setCountedScore] = useState(0);
  const settledRef = useRef(false);
  const retryRef = useRef<HTMLButtonElement | null>(null);

  // ── Settle, exactly once ─────────────────────────────────────────────────
  useEffect(() => {
    if (summary === null || settledRef.current) {
      return;
    }
    settledRef.current = true;
    void finishRun(summary).then(() => {
      // Local-only for now: P12 owns the real submission and its server-side
      // re-simulation. `createLocalLeaderboard` is honest about being a stub and
      // the leaderboard screen says so on screen.
      void createLocalLeaderboard().submit(summary.score, summary.distance);
    });
  }, [summary, finishRun]);

  // ── The sequence ─────────────────────────────────────────────────────────
  const skip = useCallback(() => {
    setBeat(LAST_BEAT);
    if (summary !== null) {
      setCountedScore(summary.score);
    }
  }, [summary]);

  useEffect(() => {
    if (summary === null) {
      return;
    }
    if (motionIsReduced()) {
      // Reduced motion gets the whole screen at once. The sequencing is drama,
      // not information — every number is still here.
      skip();
      return;
    }

    const timers: ReturnType<typeof setTimeout>[] = [];
    for (let step = 1; step <= LAST_BEAT; step += 1) {
      timers.push(
        setTimeout(() => setBeat((current) => Math.max(current, step)), MOTION.deathBeat * step),
      );
    }
    return () => {
      for (const timer of timers) {
        clearTimeout(timer);
      }
    };
  }, [summary, skip]);

  // The count-up. rAF rather than a CSS transition because the odometer is
  // driven by a value, not a style — and because §11.2 forbids "counting up with
  // an easing tween" for the *digits*, which roll mechanically; the underlying
  // number is what eases.
  useEffect(() => {
    if (summary === null || beat < BEATS.score || motionIsReduced()) {
      return;
    }
    const target = summary.score;
    const started = performance.now();
    let frame = requestAnimationFrame(function step(): void {
      const t = Math.min(1, (performance.now() - started) / MOTION.deathCount);
      setCountedScore(Math.round(target * easeOutCubic(t)));
      if (t < 1) {
        frame = requestAnimationFrame(step);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [summary, beat]);

  // ── Skip on any input ────────────────────────────────────────────────────
  useEffect(() => {
    if (beat >= LAST_BEAT) {
      return;
    }
    const onAny = (): void => skip();
    window.addEventListener("keydown", onAny, { once: true });
    window.addEventListener("pointerdown", onAny, { once: true });
    return () => {
      window.removeEventListener("keydown", onAny);
      window.removeEventListener("pointerdown", onAny);
    };
  }, [beat, skip]);

  // Focus lands on RETRY the moment the actions appear, however we got there.
  useEffect(() => {
    if (beat >= BEATS.actions) {
      retryRef.current?.focus();
    }
  }, [beat]);

  if (summary === null) {
    return (
      <ScreenShell title="Run ended" overlay>
        <p className="axis-body">Settling the run…</p>
      </ScreenShell>
    );
  }

  const nearest = closestUnmet(missions);
  const beatsBest = summary.score > previousBest;
  const bestDelta = Math.abs(summary.score - previousBest);

  return (
    <ScreenShell title="Run ended" overlay bare className="axis-death">
      <p className="axis-death-kicker">RUN ENDED</p>

      {/* ① */}
      <div className="axis-death-score" data-shown={beat >= BEATS.score ? "1" : "0"}>
        <p className="axis-num axis-num-hero" aria-label={`Final score ${summary.score}`}>
          {countedScore.toLocaleString("en-US")}
        </p>
      </div>

      {/* ② */}
      <div className="axis-death-best" data-shown={beat >= BEATS.best ? "1" : "0"}>
        <p className="axis-death-bestline" data-beat={beatsBest ? "1" : "0"}>
          {beatsBest
            ? `▲ ${bestDelta.toLocaleString("en-US")} OVER YOUR BEST`
            : `${bestDelta.toLocaleString("en-US")} SHORT OF YOUR BEST`}
        </p>
        <Plate flat className="axis-death-stats">
          <Stat
            label="DISTANCE"
            value={`${Math.floor(summary.distance).toLocaleString("en-US")}m`}
          />
          <Stat label="PEAK FLOW" value={String(Math.round(summary.peakFlow))} />
          <Stat label="OVERDRIVE" value={`×${summary.overdrivesTriggered}`} />
          <Stat label="NEAR MISSES" value={String(summary.nearMisses)} />
        </Plate>
      </div>

      {/* ③ — the retention line. Required by GAME_BIBLE §9.4. */}
      {nearest !== null && (
        <div className="axis-death-mission" data-shown={beat >= BEATS.mission ? "1" : "0"}>
          <Plate className="axis-death-missionplate">
            <p className="axis-label">
              {nearest.tier === undefined ? "DAILY" : `WEEKLY · TIER ${nearest.tier}`}
            </p>
            <p className="axis-body axis-death-missionlabel">{nearest.label}</p>
            <Meter
              value={nearest.value}
              max={nearest.target}
              label={`${Math.floor(nearest.value)} of ${nearest.target}`}
            />
            <p className="axis-death-short">{formatShortfall(nearest)}</p>
          </Plate>
        </div>
      )}

      {/* ④ */}
      <div className="axis-death-bits" data-shown={beat >= BEATS.bits ? "1" : "0"}>
        <p className="axis-death-bitline">
          <Glyph name="bit" label="Bits earned" />
          <span className="axis-num">
            +{(settlement?.bitsAwarded ?? 0).toLocaleString("en-US")}
          </span>
          <span className="axis-label">BITS</span>
        </p>
        {settlement !== null && settlement.shardsAwarded > 0 && (
          <p className="axis-death-bitline axis-death-shards">
            <Glyph name="shard" label="Shards earned" />
            <span className="axis-num">+{settlement.shardsAwarded}</span>
            <span className="axis-label">SHARDS</span>
          </p>
        )}
        {settlement !== null && settlement.shortfalls.length > 0 && (
          // Surfaced, never swallowed. The one case that reaches here today is a
          // Fracture taken with too few Shards — GAME_BIBLE §12 cause 6. The
          // ledger refused the charge and the player is told, rather than
          // wondering where a Shard went.
          <p className="axis-death-shortfall">
            Some rewards could not be applied: {settlement.shortfalls.join(", ")}
          </p>
        )}
      </div>

      {/* ⑤ */}
      <div className="axis-death-actions" data-shown={beat >= BEATS.actions ? "1" : "0"}>
        <Button variant="primary" onClick={() => void beginRun()} buttonRef={retryRef}>
          RETRY
        </Button>
        <Button onClick={() => go(Screen.Shop)}>SHOP</Button>
        <Button onClick={() => go(Screen.Title)}>MENU</Button>
      </div>
    </ScreenShell>
  );
}

function Stat({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}): React.ReactElement {
  return (
    <span className="axis-stat">
      <span className="axis-label">{label}</span>
      <span className="axis-num">{value}</span>
    </span>
  );
}

/** Exported for the sequencing test, which asserts the order without a DOM. */
export const DEATH_BEATS = Object.freeze({
  order: Object.freeze(["score", "best", "mission", "bits", "actions"] as const),
  beats: BEATS,
  intervalMs: MOTION.deathBeat,
  countMs: MOTION.deathCount,
  /** Beat 3 must precede beat 4 — see the header. */
  missionBeforeBits: BEATS.mission < BEATS.bits,
  maxDigits: TUNING.ui.odometerMaxDigits,
});
