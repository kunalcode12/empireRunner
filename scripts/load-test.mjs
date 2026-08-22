/**
 * The P12 verify gate: 100 concurrent submissions, p50 and p99 validation
 * latency.
 *
 * ## It runs against the real pipeline, not a mock
 *
 * Real recorded replays from the real sim, through the real token check, the
 * real rate limiter and the real re-simulation. The only thing not exercised is
 * HTTP itself, and that is deliberate rather than convenient: the numbers this
 * reports are meant to describe **validation cost**, and routing them through
 * localhost would fold in socket setup, JSON parsing and Node's HTTP stack —
 * measuring the laptop's loopback rather than the thing under test.
 *
 * A separate `--http` mode does go over the wire, for when the question is
 * end-to-end latency instead.
 *
 * ## Why 100 concurrent submissions is a meaningful number here
 *
 * Because the queue is bounded and single-concurrency by design. 100 arriving at
 * once is well past `maxQueueDepth`, so this exercises the shedding path as well
 * as the happy one — and a run where nothing is shed would mean the admission
 * control is not doing its job.
 *
 * Usage:
 *   node --import ./scripts/lib/ts-register.mjs scripts/load-test.mjs
 *   node --import ./scripts/lib/ts-register.mjs scripts/load-test.mjs --ticks 3600
 */

import { createIntent } from "../src/game/sim/intent.ts";
import { createSim } from "../src/game/sim/sim.ts";
import { createRecorder, record, serializeReplay } from "../src/game/sim/replay.ts";
import { issueRunToken } from "../src/server/token.ts";
import { submitRun } from "../src/server/submit.ts";
import { createMemoryStore, setStore } from "../src/server/store/index.ts";
import { resetAllLimiters } from "../src/server/ratelimit.ts";
import { validationQueue } from "../src/server/validation/queue.ts";
import { SERVER_CONFIG } from "../src/server/config.ts";

/** Reads `--flag value` from argv. */
function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || index === process.argv.length - 1) {
    return fallback;
  }
  const parsed = Number.parseInt(process.argv[index + 1], 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const CONCURRENCY = arg("concurrency", 100);
/**
 * Ticks per replay. 1,800 is 30 seconds of play at 60Hz — a realistic run, and
 * long enough that re-simulation is real work rather than noise.
 */
const TICKS = arg("ticks", 1800);

/** Plays a run and serialises it, exactly as the browser does. */
function recordOne(seed, ticks) {
  const sim = createSim(seed, { shards: 0 });
  const recorder = createRecorder(seed);
  const intent = createIntent();

  for (let tick = 0; tick < ticks; tick += 1) {
    // A lane change every 20 ticks: 3/s, brisk human play, comfortably inside
    // the plausibility ceiling so the density check passes on merit.
    if (tick % 20 === 0) {
      intent.lateral = intent.lateral === 1 ? -1 : 1;
    }
    record(recorder, intent);
    sim.tick(intent);
  }

  return serializeReplay(recorder, sim.hash());
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

function ms(value) {
  return `${value.toFixed(1)}ms`;
}

async function main() {
  const store = createMemoryStore();
  setStore(store);
  resetAllLimiters();
  validationQueue.reset();

  console.log("=".repeat(72));
  console.log("AXIS — P12 submission load test");
  console.log("=".repeat(72));
  console.log(`  concurrency        ${CONCURRENCY}`);
  console.log(
    `  ticks per replay   ${TICKS.toLocaleString()}  (${(TICKS / 60).toFixed(0)}s of play)`,
  );
  console.log(`  queue concurrency  ${SERVER_CONFIG.validation.concurrency}`);
  console.log(`  queue depth        ${SERVER_CONFIG.validation.maxQueueDepth}`);
  console.log(`  cpu budget         ${SERVER_CONFIG.validation.cpuBudgetMs}ms per replay`);
  console.log("");

  // One player per submission. Otherwise the per-session rate limiter refuses
  // 95 of 100 and the test measures the limiter instead of the validator —
  // which is correct behaviour and the wrong thing to be measuring.
  process.stdout.write("  preparing replays... ");
  const prepared = [];
  for (let i = 0; i < CONCURRENCY; i += 1) {
    const player = await store.createPlayer(`load-${i}`);
    const issued = issueRunToken({ playerId: player.playerId, shards: 0 });
    prepared.push({ player, issued, bytes: recordOne(issued.seed, TICKS) });
  }
  console.log(`${prepared.length} ready (${(prepared[0].bytes.length / 1024).toFixed(1)}KB each)`);

  const elapsedMs = (TICKS / 60) * 1000;
  const started = performance.now();

  // All at once. This is the point — a queue that only works when requests
  // arrive politely spaced is not a queue.
  const outcomes = await Promise.all(
    prepared.map(({ player, issued, bytes }) =>
      submitRun(
        {
          runToken: issued.token,
          replayBlob: Buffer.from(bytes).toString("base64"),
          elapsedMs,
        },
        player,
        store,
      ),
    ),
  );

  const wallMs = performance.now() - started;

  const accepted = outcomes.filter((outcome) => outcome.ok);
  const shed = outcomes.filter((outcome) => !outcome.ok && outcome.reason === "overloaded");
  const other = outcomes.filter((outcome) => !outcome.ok && outcome.reason !== "overloaded");

  const latencies = accepted.map((outcome) => outcome.value.validationMs).sort((a, b) => a - b);

  console.log("");
  console.log("-".repeat(72));
  console.log("  RESULTS");
  console.log("-".repeat(72));
  console.log(`  accepted           ${accepted.length}`);
  console.log(
    `  shed (503)         ${shed.length}   ${shed.length > 0 ? "admission control engaged" : ""}`,
  );
  console.log(
    `  other refusals     ${other.length}${other.length > 0 ? `   ${other[0].reason}` : ""}`,
  );
  console.log("");
  console.log(`  wall clock         ${ms(wallMs)} for all ${CONCURRENCY}`);
  console.log(
    `  throughput         ${(accepted.length / (wallMs / 1000)).toFixed(1)} validations/s`,
  );
  console.log("");
  console.log("  VALIDATION LATENCY (re-simulation only)");
  console.log(`    p50              ${ms(percentile(latencies, 0.5))}`);
  console.log(`    p99              ${ms(percentile(latencies, 0.99))}`);
  console.log(
    `    min / max        ${ms(latencies[0] ?? 0)} / ${ms(latencies[latencies.length - 1] ?? 0)}`,
  );
  console.log("");
  console.log("  QUEUE (its own accounting, as an independent check)");
  console.log(`    completed        ${validationQueue.stats.completed}`);
  console.log(`    rejected         ${validationQueue.stats.rejected}`);
  console.log(
    `    p50 / p99        ${ms(validationQueue.stats.p50)} / ${ms(validationQueue.stats.p99)}`,
  );
  console.log("=".repeat(72));

  // Every accepted submission must have produced a real score from a real
  // re-simulation. A load test that passed while validating nothing would be
  // worse than no load test.
  const scored = accepted.filter((outcome) => outcome.value.tickCount === TICKS);
  if (scored.length !== accepted.length) {
    console.error(
      `FAIL: ${accepted.length - scored.length} accepted runs did not re-simulate fully.`,
    );
    process.exitCode = 1;
    return;
  }
  if (other.length > 0) {
    console.error(`FAIL: ${other.length} submissions were refused for an unexpected reason.`);
    process.exitCode = 1;
    return;
  }
  if (accepted.length === 0) {
    console.error("FAIL: nothing was validated at all.");
    process.exitCode = 1;
  }
}

await main();
