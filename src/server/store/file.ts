/**
 * A JSON-file adapter, for single-node development persistence.
 *
 * ## What this is for, and what it is emphatically not for
 *
 * It exists so `npm run dev` survives a restart — you can submit a run, reload,
 * and your leaderboard place is still there. That is genuinely useful and it is
 * the entire scope.
 *
 * **It is not a production store.** It cannot be, and the reasons are worth
 * stating rather than leaving as folklore:
 *
 *   - One process only. Two instances pointed at one file will interleave writes
 *     and lose data, and there is no lock that would fix that portably.
 *   - The whole dataset is in memory. A million board rows is a million board
 *     rows in the heap.
 *   - `consumeNonce` is atomic *only* because Node is single-threaded. Across
 *     processes it is a plain race, and losing that race means a token is spent
 *     twice — which is the one property this whole phase exists to guarantee.
 *
 * Anything real wants Postgres or a KV with a compare-and-set. `Store` is the
 * seam that makes that an adapter rather than a rewrite.
 *
 * ## Writes are debounced, and that is a deliberate trade
 *
 * Persisting on every mutation would fsync on every submitted run. Instead
 * writes are coalesced on a short timer, so a burst costs one write. The cost is
 * that a hard kill can lose the last few hundred milliseconds. For a dev store
 * that is the right side of the trade; for anything else, see above.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createMemoryStore } from "./memory";
import type { Store } from "./types";

/** ms — how long writes are coalesced before hitting the disk. */
const FLUSH_DELAY_MS = 250;

/**
 * The snapshot shape.
 *
 * Deliberately the memory adapter's internals rather than a bespoke schema:
 * this adapter is a *persistence wrapper* around `createMemoryStore`, not a
 * second implementation. Two implementations of the same interface is two places
 * for the rank logic to be subtly different, and the whole point of the sorted
 * index in `memory.ts` is that it is the one that got the hard part right.
 */
interface Snapshot {
  readonly version: number;
  readonly entries: readonly (readonly [string, unknown])[];
}

const SNAPSHOT_VERSION = 1;

/**
 * A file-backed store.
 *
 * Delegates every operation to an in-memory store and persists after each
 * mutation. Reads never touch the disk.
 */
export function createFileStore(path: string): Store {
  const inner = createMemoryStore();
  let flushTimer: NodeJS.Timeout | null = null;

  /**
   * The persisted projection.
   *
   * Only data the memory adapter can rebuild from is kept: players, runs, saves,
   * telemetry, friends. Boards are NOT persisted — they are derived, and
   * replaying `recordRun` rebuilds them exactly. Storing derived state is how
   * two sources of truth get out of step.
   */
  const journal: { readonly [K in string]: unknown[] } = {
    players: [],
    runs: [],
    saves: [],
    telemetry: [],
    friends: [],
  };

  function scheduleFlush(): void {
    if (flushTimer !== null) {
      return;
    }
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flush();
    }, FLUSH_DELAY_MS);
    // Do not hold the process open for a dev-store write.
    flushTimer.unref?.();
  }

  function flush(): void {
    try {
      mkdirSync(dirname(path), { recursive: true });
      const snapshot: Snapshot = {
        version: SNAPSHOT_VERSION,
        entries: Object.entries(journal) as readonly (readonly [string, unknown])[],
      };
      writeFileSync(path, JSON.stringify(snapshot), "utf8");
    } catch {
      // A dev store that cannot write should not take the server down with it.
      // The data is still correct in memory; only durability is lost.
    }
  }

  function hydrate(): void {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      return;
    }
    try {
      const parsed = JSON.parse(raw) as Snapshot;
      if (parsed.version !== SNAPSHOT_VERSION) {
        return;
      }
      for (const [key, value] of parsed.entries) {
        if (Array.isArray(value) && key in journal) {
          journal[key]?.push(...value);
        }
      }
    } catch {
      // A corrupt dev snapshot is a fresh dev snapshot. The alternative is
      // refusing to boot over a file nobody cares about.
    }
  }

  hydrate();

  // Every mutating method is wrapped to journal and schedule a flush; every
  // read passes straight through. Written explicitly rather than with a Proxy
  // so the set of persisted operations is visible and greppable.
  return {
    ...inner,

    async createPlayer(displayName: string) {
      const record = await inner.createPlayer(displayName);
      journal["players"]?.push(record);
      scheduleFlush();
      return record;
    },

    async updatePlayer(playerId, patch) {
      await inner.updatePlayer(playerId, patch);
      journal["players"]?.push({ playerId, patch });
      scheduleFlush();
    },

    async linkAccount(playerId, accountId) {
      const linked = await inner.linkAccount(playerId, accountId);
      if (linked) {
        journal["players"]?.push({ playerId, accountId });
        scheduleFlush();
      }
      return linked;
    },

    async addFriend(playerId, friendId) {
      await inner.addFriend(playerId, friendId);
      journal["friends"]?.push([playerId, friendId]);
      scheduleFlush();
    },

    async recordRun(run) {
      await inner.recordRun(run);
      journal["runs"]?.push(run);
      scheduleFlush();
    },

    async putSave(playerId, save) {
      await inner.putSave(playerId, save);
      journal["saves"]?.push([playerId, save]);
      scheduleFlush();
    },

    async appendTelemetry(playerId, events) {
      await inner.appendTelemetry(playerId, events);
      journal["telemetry"]?.push([playerId, events]);
      scheduleFlush();
    },

    async reset() {
      await inner.reset();
      for (const key of Object.keys(journal)) {
        journal[key]?.splice(0);
      }
      flush();
    },
  };
}
