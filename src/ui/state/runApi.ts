/**
 * The browser half of the run lifecycle: ask for a seed, submit the replay.
 *
 * Lives in `src/ui/` because it is DOM-side plumbing with no three.js in it, and
 * it deliberately imports nothing from `@/server` — that module is Node-only
 * (`node:crypto`, the store singleton) and pulling it into a client bundle would
 * be both broken and a disclosure. The contract between the two is the JSON on
 * the wire and nothing else.
 *
 * ## Everything here fails soft
 *
 * A player with no network still gets to play. `startRun` falls back to a local
 * seed and a null token; `submitRun` gives up quietly. The game is
 * client-authoritative until it is submitted (ARCHITECTURE §6) — the only thing
 * lost offline is the leaderboard place, and that is the correct thing to lose.
 *
 * The alternative — blocking the run until the server answers — trades a
 * universal cost (everyone waits) for a rare benefit (a cheat cannot play
 * offline, which they can anyway, because they simply would not submit).
 */

const START_ENDPOINT = "/api/run/start";
const SUBMIT_ENDPOINT = "/api/run/submit";

/** What the server issued, or what we invented when it could not be reached. */
export interface RunStart {
  /** Null when offline. A run with no token cannot be submitted. */
  readonly runToken: string | null;
  readonly seed: number;
  /**
   * Starting Shards, from the SERVER.
   *
   * This must be passed into `createSim({ shards })` verbatim. It is part of the
   * simulated state and therefore part of the replay hash, so a client that
   * starts with its own idea of the number produces a run the server will reject.
   */
  readonly shards: number;
  /** True when the seed came from the server rather than from the fallback. */
  readonly verified: boolean;
}

/**
 * A local seed, for when the server cannot be reached.
 *
 * Deliberately not `Math.random()`: the sim seeds from a uint32 and this keeps
 * the shape identical to the server's, so the offline path exercises exactly the
 * same code as the online one.
 */
function localSeed(): number {
  const MAX_UINT32 = 0xffff_ffff;
  return Math.floor(Math.random() * MAX_UINT32) >>> 0;
}

/** Asks the server for a signed seed. Falls back to a local one. */
export async function startRun(): Promise<RunStart> {
  try {
    const response = await fetch(START_ENDPOINT, {
      method: "POST",
      // The session cookie is how the server knows who is asking.
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    if (!response.ok) {
      return { runToken: null, seed: localSeed(), shards: 0, verified: false };
    }

    const body = (await response.json()) as {
      runToken?: unknown;
      seed?: unknown;
      shards?: unknown;
    };

    if (typeof body.runToken !== "string" || typeof body.seed !== "number") {
      return { runToken: null, seed: localSeed(), shards: 0, verified: false };
    }

    return {
      runToken: body.runToken,
      seed: body.seed >>> 0,
      shards: typeof body.shards === "number" ? body.shards : 0,
      verified: true,
    };
  } catch {
    return { runToken: null, seed: localSeed(), shards: 0, verified: false };
  }
}

/** What came back from a successful submission. */
export interface SubmitResult {
  /** The SERVER's score. May differ from the client's if anything drifted. */
  readonly score: number;
  readonly distance: number;
  readonly ranks: {
    readonly allTime: number | null;
    readonly weekly: number | null;
    readonly daily: number | null;
  };
}

/** base64, without pulling in a dependency for it. */
function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  // Chunked, because `String.fromCharCode(...bytes)` on a 105KB array spreads
  // 105,000 arguments onto the stack and throws.
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Submits a finished replay.
 *
 * Returns null for every failure, including a refusal. The death screen shows
 * the client's own score either way — the server's number is authoritative for
 * the *leaderboard*, and telling a player their run "didn't count" because their
 * wifi dropped would be both wrong and cruel.
 */
export async function submitRun(
  runToken: string,
  replay: Uint8Array,
  elapsedMs: number,
): Promise<SubmitResult | null> {
  try {
    const response = await fetch(SUBMIT_ENDPOINT, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runToken,
        replayBlob: toBase64(replay),
        // Untrusted by the server and only ever used to reject. Sent honestly
        // because there is nothing to gain by lying and a rejection to risk.
        elapsedMs,
      }),
    });

    if (!response.ok) {
      return null;
    }

    const body = (await response.json()) as {
      run?: { score?: unknown; distance?: unknown };
      ranks?: unknown;
    };

    if (typeof body.run?.score !== "number") {
      return null;
    }

    const ranks = (body.ranks ?? {}) as SubmitResult["ranks"];
    return {
      score: body.run.score,
      distance: typeof body.run.distance === "number" ? body.run.distance : 0,
      ranks: {
        allTime: ranks.allTime ?? null,
        weekly: ranks.weekly ?? null,
        daily: ranks.daily ?? null,
      },
    };
  } catch {
    return null;
  }
}
