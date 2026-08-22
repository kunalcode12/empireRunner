/**
 * The re-simulation queue. "A worker or a queue with a hard CPU budget so a
 * flood of long replays cannot exhaust the request thread."
 *
 * ## Why a queue rather than worker threads
 *
 * `node:worker_threads` is the obvious answer and it is the wrong one here, for
 * a deployment reason rather than a technical one: a worker spawned from a Next
 * route needs its own build output, and the serverless runtimes this deploys to
 * either forbid workers outright or give each invocation a single vCPU — where a
 * worker makes things strictly worse, since it adds startup cost and message
 * copying to buy parallelism the platform will not provide.
 *
 * So it would work on a laptop and fail on deploy, which is the worst kind of
 * infrastructure. The queue below is portable, achieves the same *property* the
 * brief asks for — no flood can exhaust the request thread — and is written
 * behind an interface a worker pool can implement later without any caller
 * changing.
 *
 * ## Three mechanisms, and each one covers a different failure
 *
 *   - **Bounded depth.** Past `maxQueueDepth`, submissions are refused with a
 *     retry-after. An unbounded queue under load does not serve more people; it
 *     serves everybody a timeout, having first held all their sockets open.
 *     Shedding load is the kinder failure and the only stable one.
 *   - **Fixed concurrency.** One at a time by default. Re-simulation is pure CPU,
 *     and a second concurrent job does not make the CPU faster — it makes both
 *     slower and doubles how long the event loop is blocked.
 *   - **A hard per-job budget.** Passed into `verify`'s deadline, so one
 *     pathological replay cannot hold the loop indefinitely. This is the one that
 *     bounds the *tail*, and it is why the p99 in the verify gate is a real
 *     number rather than "however long the worst input took".
 *
 * ## Yielding between jobs is load-bearing
 *
 * Each job is preceded by `setImmediate`. Without it, a queue of 64 replays runs
 * as one uninterrupted 64-job block of synchronous CPU, and every unrelated
 * request — a leaderboard read, a health check — waits behind all of it. The
 * yield hands the event loop back between jobs, so the server stays responsive
 * while validation is saturated. It costs microseconds and it is the difference
 * between "slow submissions" and "the site is down".
 */

import { SERVER_CONFIG } from "../config";
import { validateSubmission, type ValidationRequest, type ValidationResult } from "./validate";

/** What the queue reports about itself. */
export interface QueueStats {
  /** Jobs waiting right now. */
  readonly depth: number;
  /** Jobs executing right now. */
  readonly active: number;
  /** Jobs completed since start. */
  readonly completed: number;
  /** Jobs refused because the queue was full. */
  readonly rejected: number;
  /** ms — median validation time. */
  readonly p50: number;
  /** ms — 99th percentile validation time. */
  readonly p99: number;
  /** ms — the worst single validation. */
  readonly max: number;
}

export interface ValidationQueue {
  /**
   * Enqueues a submission.
   *
   * Resolves with `null` when the queue is full — the caller maps that to a 503
   * with a retry-after. It does not throw, because "we are busy" is an expected
   * operating condition and not an error.
   */
  submit(request: ValidationRequest): Promise<ValidationResult | null>;
  readonly stats: QueueStats;
  reset(): void;
}

interface Job {
  readonly request: ValidationRequest;
  readonly resolve: (result: ValidationResult) => void;
}

/**
 * A reservoir of recent latencies.
 *
 * Bounded, so a long-lived process does not accumulate one number per
 * submission forever. It is the most recent N rather than a sample: percentiles
 * over "the last thousand" answer "how is it behaving now", which is the
 * question an operator is actually asking. A uniform sample over all time
 * answers a question nobody asks and hides a regression that started an hour ago.
 */
const LATENCY_WINDOW = 1024;

export function createValidationQueue(
  run: (request: ValidationRequest) => ValidationResult = validateSubmission,
): ValidationQueue {
  const pending: Job[] = [];
  const latencies: number[] = [];
  let active = 0;
  let completed = 0;
  let rejected = 0;

  function recordLatency(ms: number): void {
    latencies.push(ms);
    if (latencies.length > LATENCY_WINDOW) {
      latencies.shift();
    }
  }

  function percentile(fraction: number): number {
    if (latencies.length === 0) {
      return 0;
    }
    const sorted = [...latencies].sort((a, b) => a - b);
    // Nearest-rank. For p99 over 100 samples this is the 99th value, which is
    // what an operator means by p99 — not an interpolated figure between two
    // observations, neither of which happened.
    const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
    return sorted[Math.max(0, index)] ?? 0;
  }

  function pump(): void {
    if (active >= SERVER_CONFIG.validation.concurrency) {
      return;
    }
    const job = pending.shift();
    if (job === undefined) {
      return;
    }

    active += 1;
    // The yield. See the header — without it the whole queue is one block of
    // synchronous CPU and every unrelated request waits behind all of it.
    setImmediate(() => {
      let result: ValidationResult;
      try {
        result = run(job.request);
      } finally {
        active -= 1;
        completed += 1;
      }
      recordLatency(result.validationMs);
      job.resolve(result);
      pump();
    });
  }

  return {
    async submit(request: ValidationRequest): Promise<ValidationResult | null> {
      if (pending.length >= SERVER_CONFIG.validation.maxQueueDepth) {
        rejected += 1;
        return null;
      }
      return new Promise<ValidationResult>((resolve) => {
        pending.push({ request, resolve });
        pump();
      });
    },

    get stats(): QueueStats {
      return {
        depth: pending.length,
        active,
        completed,
        rejected,
        p50: percentile(0.5),
        p99: percentile(0.99),
        max: latencies.length === 0 ? 0 : Math.max(...latencies),
      };
    },

    reset(): void {
      pending.length = 0;
      latencies.length = 0;
      active = 0;
      completed = 0;
      rejected = 0;
    },
  };
}

/**
 * The process-wide queue.
 *
 * Module-level for the same reason the store and the limiters are: a queue
 * rebuilt per request enforces no limit on anything, which is the one thing a
 * queue is for.
 */
export const validationQueue = createValidationQueue();
