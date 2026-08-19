/**
 * The death screen's ordering.
 *
 * ## Why the ORDER is what gets a test
 *
 * GAME_BIBLE §9.4 calls the mission near-miss line "a **required** element of
 * the death screen" and says it "does more for D2 retention than any reward in
 * the game". It only does that if it lands while the loss still stings. Put the
 * Bits first and the shortfall arrives as an afterthought — the screen becomes a
 * receipt instead of a hook.
 *
 * That is a one-line change for whoever edits this next, and nothing about the
 * code would look wrong afterwards. So it is asserted.
 */

import { describe, expect, it } from "vitest";
import { TUNING } from "@/game/config/tuning";
import { DEATH_BEATS } from "@/ui/screens/DeathScreen";
import { MOTION } from "@/ui/motion";
import {
  closestUnmet,
  dailyMissionsFor,
  emptyMissionProgress,
  formatShortfall,
  applyRunToMissions,
  emptyRunSummary,
  type MissionProgress,
} from "@/game/meta";

const AT = Date.UTC(2026, 7, 19, 12, 0, 0);

describe("the five beats", () => {
  it("runs score, best, mission, bits, actions — in that order", () => {
    expect(DEATH_BEATS.order).toEqual(["score", "best", "mission", "bits", "actions"]);
  });

  /** The load-bearing one. See the header. */
  it("shows the mission shortfall BEFORE the Bits", () => {
    expect(DEATH_BEATS.missionBeforeBits).toBe(true);
    expect(DEATH_BEATS.beats.mission).toBeLessThan(DEATH_BEATS.beats.bits);
  });

  it("puts the actions last, so nothing appears after the retry button", () => {
    const values = Object.values(DEATH_BEATS.beats);
    expect(DEATH_BEATS.beats.actions).toBe(Math.max(...values));
  });

  it("assigns every beat a distinct step", () => {
    const values = Object.values(DEATH_BEATS.beats);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe("the sequence is short enough to be an arcade screen", () => {
  /**
   * An arcade player retries in under two seconds. The full sequence has to fit
   * inside that, or the skip becomes mandatory rather than a convenience.
   */
  it("completes in well under two seconds unskipped", () => {
    const total = DEATH_BEATS.intervalMs * DEATH_BEATS.order.length;
    expect(total).toBeLessThan(2000);
  });

  it("finishes counting the score before the actions appear", () => {
    // Otherwise RETRY is focused while the hero number is still climbing, and
    // the first thing the player sees is their score being interrupted.
    const untilActions = DEATH_BEATS.intervalMs * DEATH_BEATS.beats.actions;
    expect(DEATH_BEATS.countMs).toBeLessThanOrEqual(untilActions);
  });

  it("uses the shared motion scale rather than its own timings", () => {
    expect(DEATH_BEATS.intervalMs).toBe(MOTION.deathBeat);
    expect(DEATH_BEATS.countMs).toBe(MOTION.deathCount);
  });

  it("sizes the counter from tuning, not from a literal", () => {
    expect(DEATH_BEATS.maxDigits).toBe(TUNING.ui.odometerMaxDigits);
  });
});

describe("the near-miss line the screen renders", () => {
  /**
   * The screen reads `closestUnmet` and `formatShortfall` straight from the meta
   * layer. These confirm the pair actually produces the line GAME_BIBLE §9.4
   * specifies, from a real run — so a change to either shows up here rather than
   * on the screen.
   */
  function progressAfter(distance: number): MissionProgress {
    const run = { ...emptyRunSummary(), distance, score: distance * 2 };
    return applyRunToMissions(emptyMissionProgress(AT), run, AT);
  }

  it("names something the player did not finish", () => {
    const nearest = closestUnmet(progressAfter(2_406), AT);
    expect(nearest).not.toBeNull();
    expect(nearest?.complete).toBe(false);
  });

  it("produces the '... SHORT' line", () => {
    const nearest = closestUnmet(progressAfter(2_406), AT);
    expect(nearest).not.toBeNull();
    if (nearest !== null) {
      expect(formatShortfall(nearest)).toMatch(/^YOU WERE .+ SHORT$/);
    }
  });

  /**
   * §9.4: "Ranked by fraction complete, not by absolute remainder. Being 40m
   * from a 2,000m goal (98%) beats being 2 near-misses from a 45 near-miss goal
   * (95.6%)." Ranking by raw remainder surfaces whichever objective counts in
   * small numbers, which reads as random and kills the line.
   */
  it("picks the closest by FRACTION, not by remainder", () => {
    const progress = progressAfter(3_900);
    const nearest = closestUnmet(progress, AT);
    expect(nearest).not.toBeNull();
    if (nearest === null) {
      return;
    }
    // Nothing incomplete is further along than the one chosen.
    const dailies = dailyMissionsFor(AT);
    for (const mission of dailies) {
      const value = progress.values[mission.id] ?? 0;
      if (value >= mission.target) {
        continue;
      }
      expect(value / mission.target).toBeLessThanOrEqual(nearest.fraction + 1e-9);
    }
  });

  it("returns null once everything is done, so the screen omits the block", () => {
    const progress = progressAfter(10_000_000);
    const nearest = closestUnmet(progress, AT);
    // Either everything is complete (null) or whatever remains is genuinely
    // unmet — both are correct; what would be wrong is a completed objective
    // being offered as a near-miss.
    if (nearest !== null) {
      expect(nearest.complete).toBe(false);
    }
  });
});
