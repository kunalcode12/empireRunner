/**
 * Leaderboards: paging, ranking, period rollover, and the friends board.
 *
 * The interesting assertions are the ones about *stability*. A leaderboard whose
 * ordering is not total lets the same entry appear on two pages, or on neither,
 * and the bug only shows up when two players tie — which on a scoring system with
 * integer scores happens constantly.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { readBoard, readRanks, parseScope, type RunRecord, type Store } from "@/server";
import { periodKeysFor } from "@/server";
import { freshStore } from "./helpers";

let store: Store;

beforeEach(() => {
  store = freshStore();
});

const NOW = Date.UTC(2026, 7, 20, 12, 0, 0);

/** Records a run for a fresh player and returns their id. */
async function seedRun(name: string, score: number, at = NOW): Promise<string> {
  const player = await store.createPlayer(name);
  const periods = periodKeysFor(at);
  const run: RunRecord = {
    runId: `run-${name}-${score}-${at}`,
    playerId: player.playerId,
    score,
    distance: score / 10,
    seed: 1,
    tickCount: 600,
    submittedAt: at,
    dayKey: periods.dayKey,
    weekKey: periods.weekKey,
  };
  await store.recordRun(run);
  return player.playerId;
}

describe("board ordering and paging", () => {
  it("orders by score descending", async () => {
    await seedRun("low", 100);
    await seedRun("high", 900);
    const mid = await seedRun("mid", 500);

    const view = await readBoard({ scope: "all-time", playerId: mid, now: NOW }, store);
    expect(view.ok).toBe(true);
    if (!view.ok) return;

    expect(view.value.entries.map((entry) => entry.score)).toEqual([900, 500, 100]);
    expect(view.value.playerRank).toBe(2);
  });

  it("breaks ties by submission time, so ordering is TOTAL", async () => {
    // Without a tie-break the comparator is unstable and pagination breaks: the
    // same entry can appear on page 1 and page 2, or on neither.
    const first = await seedRun("first", 500, NOW);
    await seedRun("second", 500, NOW + 1000);
    await seedRun("third", 500, NOW + 2000);

    const view = await readBoard({ scope: "all-time", playerId: first, now: NOW }, store);
    if (!view.ok) throw new Error("board read failed");

    // Earliest submission of an equal score ranks higher — they got there first.
    expect(view.value.entries.map((entry) => entry.displayName)).toEqual([
      "first",
      "second",
      "third",
    ]);
    expect(view.value.playerRank).toBe(1);
  });

  it("pages without repeating or dropping an entry", async () => {
    const COUNT = 25;
    let me = "";
    for (let i = 0; i < COUNT; i += 1) {
      const id = await seedRun(`p${i}`, i * 10, NOW + i);
      if (i === 0) me = id;
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;

    do {
      const view = await readBoard(
        { scope: "all-time", playerId: me, cursor, limit: 7, now: NOW },
        store,
      );
      if (!view.ok) throw new Error("board read failed");
      seen.push(...view.value.entries.map((entry) => entry.runId));
      cursor = view.value.nextCursor ?? undefined;
      pages += 1;
    } while (cursor !== undefined && pages < 20);

    expect(seen).toHaveLength(COUNT);
    expect(new Set(seen).size, "an entry appeared on two pages").toBe(COUNT);
  });

  it("refuses a forged cursor", async () => {
    const me = await seedRun("me", 100);
    const view = await readBoard(
      { scope: "all-time", playerId: me, cursor: "eyJvIjo5OTk5OTl9.forged", now: NOW },
      store,
    );
    // An unsigned cursor is a query parameter, and a query parameter is a thing
    // a client edits into a table scan.
    expect(view.ok).toBe(false);
  });

  it("refuses a cursor issued for a different board", async () => {
    const me = await seedRun("me", 100);
    const daily = await readBoard({ scope: "daily", playerId: me, limit: 1, now: NOW }, store);
    if (!daily.ok || daily.value.nextCursor === null) {
      // Only one entry, so there is no next page — seed another and retry.
      await seedRun("other", 200);
    }
    const first = await readBoard({ scope: "daily", playerId: me, limit: 1, now: NOW }, store);
    if (!first.ok || first.value.nextCursor === null) throw new Error("expected a cursor");

    const crossed = await readBoard(
      { scope: "all-time", playerId: me, cursor: first.value.nextCursor, now: NOW },
      store,
    );
    expect(crossed.ok).toBe(false);
  });

  it("clamps an absurd page size", async () => {
    for (let i = 0; i < 5; i += 1) {
      await seedRun(`p${i}`, i);
    }
    const me = await seedRun("me", 999);
    const view = await readBoard(
      { scope: "all-time", playerId: me, limit: 1_000_000, now: NOW },
      store,
    );
    if (!view.ok) throw new Error("board read failed");
    expect(view.value.entries.length).toBeLessThanOrEqual(100);
  });
});

describe("one entry per player", () => {
  it("keeps a player's BEST run, not every run", async () => {
    const player = await store.createPlayer("repeat");
    const periods = periodKeysFor(NOW);

    for (const score of [100, 900, 400]) {
      await store.recordRun({
        runId: `run-${score}`,
        playerId: player.playerId,
        score,
        distance: score / 10,
        seed: 1,
        tickCount: 600,
        submittedAt: NOW + score,
        dayKey: periods.dayKey,
        weekKey: periods.weekKey,
      });
    }

    const view = await readBoard({ scope: "all-time", playerId: player.playerId, now: NOW }, store);
    if (!view.ok) throw new Error("board read failed");

    // Otherwise the top ten is one person's ten best runs, which is technically
    // a leaderboard and useless as one.
    expect(view.value.total).toBe(1);
    expect(view.value.entries[0]?.score).toBe(900);
  });
});

describe("period boards", () => {
  it("separates days and weeks", async () => {
    const me = await seedRun("today", 500, NOW);
    // Eight days earlier: a different day AND a different week.
    const WEEK_AND_A_DAY = 8 * 24 * 60 * 60 * 1000;
    await seedRun("last week", 900, NOW - WEEK_AND_A_DAY);

    const daily = await readBoard({ scope: "daily", playerId: me, now: NOW }, store);
    const weekly = await readBoard({ scope: "weekly", playerId: me, now: NOW }, store);
    const allTime = await readBoard({ scope: "all-time", playerId: me, now: NOW }, store);

    if (!daily.ok || !weekly.ok || !allTime.ok) throw new Error("board read failed");

    expect(daily.value.total).toBe(1);
    expect(weekly.value.total).toBe(1);
    // The all-time board keeps both, which is what makes it all-time.
    expect(allTime.value.total).toBe(2);
  });

  it("uses the same UTC rollover the missions use", async () => {
    // Not a re-implementation: `server/period.ts` re-exports the meta helpers, so
    // a player's daily mission and the daily board roll over at one instant.
    const { utcDayKey, utcWeekKey } = await import("@/game/meta");
    const keys = periodKeysFor(NOW);
    expect(keys.dayKey).toBe(utcDayKey(NOW));
    expect(keys.weekKey).toBe(utcWeekKey(NOW));
  });
});

describe("rank lookup", () => {
  it("reports a rank on every board at once", async () => {
    const me = await seedRun("me", 500);
    await seedRun("better", 900);

    const ranks = await readRanks(me, store, NOW);
    expect(ranks.allTime).toBe(2);
    expect(ranks.weekly).toBe(2);
    expect(ranks.daily).toBe(2);
  });

  it("returns null for a player with no entry", async () => {
    const stranger = await store.createPlayer("never played");
    const ranks = await readRanks(stranger.playerId, store, NOW);
    expect(ranks.allTime).toBeNull();
  });

  it("stays correct across many entries", async () => {
    // The rank lookup is a binary search over a maintained sorted index, not a
    // scan. This checks it agrees with the obvious O(n) answer.
    const COUNT = 200;
    let me = "";
    for (let i = 0; i < COUNT; i += 1) {
      const id = await seedRun(`p${i}`, i, NOW + i);
      if (i === 137) me = id;
    }
    // Scores 0..199 descending: score 137 sits at rank 200 - 137 = 63.
    const ranks = await readRanks(me, store, NOW);
    expect(ranks.allTime).toBe(COUNT - 137);
  });
});

describe("friends board", () => {
  it("includes the player and their friends, and nobody else", async () => {
    const me = await seedRun("me", 500);
    const friend = await seedRun("friend", 700);
    await seedRun("stranger", 9999);

    await store.addFriend(me, friend);

    const view = await readBoard({ scope: "friends", playerId: me, now: NOW }, store);
    if (!view.ok) throw new Error("board read failed");

    expect(view.value.entries.map((entry) => entry.displayName).sort()).toEqual(["friend", "me"]);
    // A board you are absent from cannot answer the only question anyone asks it.
    expect(view.value.playerRank).toBe(2);
  });

  it("is mutual", async () => {
    const me = await seedRun("me", 500);
    const friend = await seedRun("friend", 700);
    await store.addFriend(me, friend);

    // A one-way list means two players comparing boards see different boards.
    const theirs = await readBoard({ scope: "friends", playerId: friend, now: NOW }, store);
    if (!theirs.ok) throw new Error("board read failed");
    expect(theirs.value.entries).toHaveLength(2);
  });

  it("shows a friendless player only themselves", async () => {
    const me = await seedRun("me", 500);
    const view = await readBoard({ scope: "friends", playerId: me, now: NOW }, store);
    if (!view.ok) throw new Error("board read failed");
    expect(view.value.entries).toHaveLength(1);
    expect(view.value.playerRank).toBe(1);
  });
});

describe("scope parsing", () => {
  it("accepts the four scopes and defaults to all-time", () => {
    expect(parseScope(null)).toBe("all-time");
    expect(parseScope("")).toBe("all-time");
    expect(parseScope("weekly")).toBe("weekly");
    expect(parseScope("daily")).toBe("daily");
    expect(parseScope("friends")).toBe("friends");
  });

  it("rejects anything else", () => {
    expect(parseScope("all-time; DROP TABLE")).toBeNull();
    expect(parseScope("monthly")).toBeNull();
  });
});
