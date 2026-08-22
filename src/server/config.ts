/**
 * Server tunables. Infrastructure numbers only.
 *
 * ## Why these are not in `game/config/tuning.ts`
 *
 * CLAUDE.md is explicit that every **gameplay** number lives in `tuning.ts`, and
 * that rule is doing real work — it is what stops a magic `0.55` appearing in
 * three files and drifting. None of the values below are gameplay. A token TTL
 * does not change how the game feels; it changes how long a tab can sit idle
 * before its seed goes stale. Putting them in `tuning.ts` would dilute the one
 * file a designer is supposed to be able to read end to end.
 *
 * The dividing line is sharp and worth stating: **if changing the number changes
 * what happens in a run, it belongs in `tuning.ts`.** The input-density ceiling
 * is the interesting case — it is a claim about human hands, derived from the
 * input tuning, so it lives there and is imported here. Everything in this file
 * is about the machine.
 *
 * ## Everything is overridable by environment, nothing requires it
 *
 * Defaults are chosen so `npm run dev` and the test suite work with no
 * environment at all. Production overrides what it needs. A missing variable is
 * never a crash; a missing *secret* is a loud warning, because that one is not
 * safe to default silently.
 */

/** Reads a positive integer from the environment, or returns the default. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;

export const SERVER_CONFIG = Object.freeze({
  /**
   * ms — how long a run token stays valid after being issued.
   *
   * Long enough that a player can read the menu, get a phone call, come back and
   * still start; short enough that a farmed batch of seeds goes stale before it
   * is useful. Fifteen minutes. The attack it bounds is "request 10,000 seeds,
   * play them all offline at leisure, submit only the lucky ones" — the TTL
   * turns that from a stockpile into a 15-minute window, and the per-session
   * rate limit turns the window into a trickle.
   */
  runTokenTtlMs: envInt("AXIS_RUN_TOKEN_TTL_MS", 15 * SECONDS_PER_MINUTE * MS_PER_SECOND),

  /**
   * ms — how long a spent token's nonce is remembered.
   *
   * Must exceed `runTokenTtlMs`, or a token could outlive the memory of it
   * having been used and become replayable again. Double it, so clock skew
   * between issue and submit cannot open the gap.
   */
  nonceRetentionMs: envInt("AXIS_NONCE_RETENTION_MS", 30 * SECONDS_PER_MINUTE * MS_PER_SECOND),

  /** ms — how long an identity session cookie is good for. 90 days. */
  sessionTtlMs: envInt(
    "AXIS_SESSION_TTL_MS",
    90 * 24 * SECONDS_PER_MINUTE * SECONDS_PER_MINUTE * MS_PER_SECOND,
  ),

  /**
   * bytes — the largest request body any endpoint will read.
   *
   * A 30-minute replay is `headerBytes + maxTicks` = 108,020 bytes raw, and the
   * transport is base64, so ~144KB. 256KB leaves headroom for the JSON envelope
   * without letting an attacker stream gigabytes into the parser. The cap is
   * enforced BEFORE parsing, which is the only place it helps.
   */
  maxBodyBytes: envInt("AXIS_MAX_BODY_BYTES", 256 * 1024),

  /** Submissions allowed per session, and how fast the bucket refills. */
  submitRateLimit: Object.freeze({
    /** Burst capacity. A player finishing three runs quickly is normal. */
    capacity: envInt("AXIS_SUBMIT_BURST", 5),
    /**
     * ms — time to earn one more submission.
     *
     * The shortest survivable run is a few seconds, but a *submittable* one has
     * to clear the minimum tick count, so 20s per token is generous for a human
     * and ruinous for a script.
     */
    refillMs: envInt("AXIS_SUBMIT_REFILL_MS", 20 * MS_PER_SECOND),
  }),

  /**
   * Per-IP limits, applied IN ADDITION to the per-session ones.
   *
   * Both must pass. Per-session alone is defeated by requesting a new identity
   * per submission — which costs an attacker nothing — so the IP bucket is the
   * one that actually bounds a flood. It is deliberately loose enough not to
   * punish a shared NAT: a school or an office behind one address should be able
   * to play.
   */
  ipRateLimit: Object.freeze({
    capacity: envInt("AXIS_IP_BURST", 60),
    refillMs: envInt("AXIS_IP_REFILL_MS", 2 * MS_PER_SECOND),
  }),

  /** New identities allowed per IP, so the session bucket cannot be farmed. */
  identityRateLimit: Object.freeze({
    capacity: envInt("AXIS_IDENTITY_BURST", 10),
    refillMs: envInt("AXIS_IDENTITY_REFILL_MS", 60 * MS_PER_SECOND),
  }),

  /** The re-simulation queue. See `validation/queue.ts` for the reasoning. */
  validation: Object.freeze({
    /**
     * How many replays re-simulate at once.
     *
     * One. Re-simulation is pure CPU on the main thread, and a second concurrent
     * job does not make the CPU faster — it makes both jobs slower and doubles
     * the time the event loop is blocked. Concurrency here buys latency variance,
     * not throughput. Raise it only alongside real worker threads.
     */
    concurrency: envInt("AXIS_VALIDATION_CONCURRENCY", 1),

    /**
     * How many jobs may wait.
     *
     * Past this, submissions are REJECTED with a retry-after rather than queued.
     * An unbounded queue under load does not serve more people; it serves
     * everybody a timeout, having first held every one of their sockets open.
     * Shedding load is the kinder failure.
     */
    maxQueueDepth: envInt("AXIS_VALIDATION_QUEUE_DEPTH", 64),

    /**
     * ms — the hard CPU budget for ONE re-simulation.
     *
     * A 30-minute replay is 108,000 ticks, and P02 measured a tick at well under
     * 2ms — but the budget is not derived from that, deliberately. It is a
     * ceiling on how long one submission may hold the loop regardless of why,
     * including a future tick that got slower without anybody noticing.
     */
    cpuBudgetMs: envInt("AXIS_VALIDATION_CPU_BUDGET_MS", 2000),

    /**
     * How many ticks to run between deadline checks.
     *
     * Checking the clock every tick would cost more than the tick. 4,096 ticks
     * is ~68 seconds of game time and a small fraction of the budget, so the
     * deadline is honoured to within a rounding error of it.
     */
    deadlineCheckInterval: envInt("AXIS_VALIDATION_DEADLINE_INTERVAL", 4096),
  }),

  /** Leaderboard paging. */
  leaderboard: Object.freeze({
    defaultPageSize: envInt("AXIS_LB_PAGE_SIZE", 25),
    /** Hard ceiling, so `?limit=100000` cannot turn a page into a table scan. */
    maxPageSize: envInt("AXIS_LB_MAX_PAGE_SIZE", 100),
    /** Entries kept per board. Beyond this the tail is pruned on write. */
    maxEntriesPerBoard: envInt("AXIS_LB_MAX_ENTRIES", 10_000),
  }),

  /** Telemetry. */
  telemetry: Object.freeze({
    /** Events accepted in one batch. */
    maxBatchSize: envInt("AXIS_TELEMETRY_BATCH", 50),
    /** Rows retained per player. Telemetry is for balance work, not history. */
    maxEventsPerSession: envInt("AXIS_TELEMETRY_PER_SESSION", 500),
  }),
});

export type ServerConfig = typeof SERVER_CONFIG;
