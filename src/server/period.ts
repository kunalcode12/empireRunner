/**
 * Which day and which week a run counted toward.
 *
 * ## This file re-exports rather than reimplements, on purpose
 *
 * `game/meta/missions.ts` already computes `utcDayKey` and `utcWeekKey`, and
 * they already carry the two decisions that matter: the day is UTC so dailies
 * are global rather than per-timezone, and the week starts Monday 00:00 UTC per
 * GAME_BIBLE §9.4 — with the Sunday off-by-one handled, since `getUTCDay()`
 * returns 0 for Sunday and a naive `-1` gives Sunday its own one-day week.
 *
 * Writing a second copy here would work on the day it was written and drift
 * afterwards. The failure mode is precise and nasty: a player's daily mission
 * would roll over at a different instant from the daily leaderboard, so on some
 * days a run would count toward a mission and land on the previous day's board.
 * Nobody would report that as a bug; they would just quietly stop trusting the
 * numbers.
 *
 * This is the same reasoning the layering law applies to sim constants, and it
 * is why `src/server/**` is permitted to import `@/game/meta`.
 *
 * ## The board period is stamped at SUBMISSION, not at run start
 *
 * A run that begins at 23:59 UTC and ends at 00:02 counts toward the new day.
 * The alternative — stamping at token issue — sounds fairer and is worse: it
 * lets a player hold an unspent token across the rollover and submit into
 * whichever day is emptier. Submission time is the one instant the server
 * observes directly and the client cannot influence.
 */

import { utcDayKey, utcWeekKey } from "@/game/meta";

export { utcDayKey, utcWeekKey };

/** The period key an all-time board is stored under. Constant by definition. */
export const ALL_TIME_PERIOD = "all";

/** Both period keys for one instant. */
export interface PeriodKeys {
  readonly dayKey: string;
  readonly weekKey: string;
}

export function periodKeysFor(at: number): PeriodKeys {
  return { dayKey: utcDayKey(at), weekKey: utcWeekKey(at) };
}
