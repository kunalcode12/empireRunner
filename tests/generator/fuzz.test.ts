import { describe, expect, it } from "vitest";
import { TUNING } from "@/game/config/tuning";
import { createRng, forkSeed, RNG_STREAMS } from "@/game/sim/rng";
import {
  createLevelState,
  generateNext,
  MAX_TIER,
  seamsCompatible,
  type Chunk,
} from "@/game/sim/level";

/**
 * The fuzz gate.
 *
 * 10,000 runs at 10,000 distinct seeds. The assertion that matters is that no
 * unsurvivable seam ever appears — a pair of chunks that are each fine and lethal
 * together. That is the failure mode a hand-authored pool cannot be inspected
 * for, because it is quadratic in the number of chunks.
 *
 * The histogram is printed rather than asserted. Its job is to let a human
 * eyeball the difficulty curve and notice things a threshold never would: a tier
 * that never gets selected, a band that arrives too early, a Flow coupling that
 * pins everyone at tier 5 by minute two.
 */

const RUNS = 10_000;
/** 250 x 24u = 6,000m — far enough to cross every difficulty band AND every
 *  theme milestone, so the histogram shows the whole curve rather than its
 *  first fifth. */
const CHUNKS_PER_RUN = 250;
const CHUNK_LENGTH = TUNING.spawn.chunkLength;
const HARD_DIFFICULTY = TUNING.level.hardDifficulty;
const MAX_CONSECUTIVE_HARD = TUNING.level.maxConsecutiveHard;

/** Distance buckets for the histogram, in metres. */
const BUCKET_SIZE = 500;
const BUCKET_COUNT = Math.ceil((CHUNKS_PER_RUN * CHUNK_LENGTH) / BUCKET_SIZE);

/** Renders the difficulty-over-distance histogram. */
function renderHistogram(counts: Float64Array, totals: Float64Array): string {
  const BAR_WIDTH = 40;
  const lines: string[] = [];
  lines.push("");
  lines.push("=== DIFFICULTY OVER DISTANCE ===");
  lines.push(
    `${RUNS.toLocaleString()} runs x ${CHUNKS_PER_RUN} chunks (${CHUNKS_PER_RUN * CHUNK_LENGTH}m), flow rising 0->100 across each run`,
  );
  lines.push("transition chunks excluded — they are difficulty 1 by convention");
  lines.push("");
  lines.push("  distance      mean tier  distribution (tier 1..5 share)");
  lines.push("  " + "-".repeat(66));

  for (let b = 0; b < BUCKET_COUNT; b += 1) {
    const total = totals[b] ?? 0;
    if (total === 0) {
      continue;
    }
    const mean = (counts[b] ?? 0) / total;

    // Per-tier shares for this bucket, rendered as a stacked bar.
    let bar = "";
    for (let tier = 1; tier <= MAX_TIER; tier += 1) {
      const share = (tierCounts[b * (MAX_TIER + 1) + tier] ?? 0) / total;
      const width = Math.round(share * BAR_WIDTH);
      bar += String(tier).repeat(width);
    }

    const from = String(b * BUCKET_SIZE).padStart(5);
    const to = String((b + 1) * BUCKET_SIZE).padStart(5);
    lines.push(`  ${from}-${to}m   ${mean.toFixed(2).padStart(6)}     ${bar}`);
  }

  lines.push("");
  lines.push("  key: each character is a chunk selected at that tier");
  lines.push("");
  return lines.join("\n");
}

/** Per-bucket, per-tier counts. Module scope so the renderer can read it. */
const tierCounts = new Float64Array(BUCKET_COUNT * (MAX_TIER + 1));

describe("10,000-run fuzz", () => {
  it("never produces an unsurvivable seam, and reports the difficulty curve", () => {
    const bucketDifficultySum = new Float64Array(BUCKET_COUNT);
    const bucketTotals = new Float64Array(BUCKET_COUNT);
    tierCounts.fill(0);

    let seamViolations = 0;
    let breatherViolations = 0;
    let firstFailure = "";
    let totalChunks = 0;
    let transitions = 0;

    const state = createLevelState();

    for (let seed = 0; seed < RUNS; seed += 1) {
      // Reset rather than recreate: proves reset is complete AND keeps the fuzz
      // from allocating 10,000 level states.
      state.head = 0;
      state.count = 0;
      state.nextDistance = 0;
      state.ordinal = 0;
      state.recent.fill(-1);
      state.recentCount = 0;
      state.consecutiveHard = 0;
      state.nextMilestone = 0;
      state.transitionRemaining = 0;
      state.lastExitCells = (1 << 12) - 1;
      state.lastExitGrounded = true;

      const rng = createRng(forkSeed(seed, RNG_STREAMS.generator));
      let previous: Chunk | null = null;
      let hardRun = 0;

      for (let i = 0; i < CHUNKS_PER_RUN; i += 1) {
        // Flow rises through the run, so the fuzz exercises the Flow coupling
        // rather than only the distance bands.
        const flow = Math.min(TUNING.flow.flowMax, (i / CHUNKS_PER_RUN) * TUNING.flow.flowMax);
        const placed = generateNext(state, rng, flow);
        const chunk = placed.chunk;
        totalChunks += 1;

        if (chunk.id === "transition") {
          transitions += 1;
        }

        if (previous !== null && !seamsCompatible(previous.exitConstraint, chunk.entryConstraint)) {
          seamViolations += 1;
          if (firstFailure === "") {
            firstFailure = `seed ${seed}, index ${i}: "${previous.id}" -> "${chunk.id}"`;
          }
        }

        if (chunk.difficulty >= HARD_DIFFICULTY) {
          hardRun += 1;
          if (hardRun > MAX_CONSECUTIVE_HARD) {
            breatherViolations += 1;
            if (firstFailure === "") {
              firstFailure = `seed ${seed}, index ${i}: ${hardRun} hard chunks in a row`;
            }
          }
        } else {
          hardRun = 0;
        }

        // Transition chunks are excluded from the curve. They carry difficulty
        // 1 by convention, and counting them would show a phantom dip at every
        // theme milestone that has nothing to do with the banding.
        if (chunk.id !== "transition") {
          const bucket = Math.min(BUCKET_COUNT - 1, Math.floor(placed.startDistance / BUCKET_SIZE));
          bucketDifficultySum[bucket] = (bucketDifficultySum[bucket] ?? 0) + chunk.difficulty;
          bucketTotals[bucket] = (bucketTotals[bucket] ?? 0) + 1;
          const tierSlot = bucket * (MAX_TIER + 1) + chunk.difficulty;
          tierCounts[tierSlot] = (tierCounts[tierSlot] ?? 0) + 1;
        }

        previous = chunk;
      }
    }

    console.log(renderHistogram(bucketDifficultySum, bucketTotals));
    console.log(
      `  chunks generated : ${totalChunks.toLocaleString()}\n` +
        `  transitions      : ${transitions.toLocaleString()}\n` +
        `  seam violations  : ${seamViolations}\n` +
        `  breather breaches: ${breatherViolations}\n` +
        (firstFailure === "" ? "" : `  first failure    : ${firstFailure}\n`),
    );

    expect(seamViolations, firstFailure).toBe(0);
    expect(breatherViolations, firstFailure).toBe(0);
    expect(totalChunks).toBe(RUNS * CHUNKS_PER_RUN);
  });

  it("keeps the fuzz itself allocation-stable", () => {
    // If the fuzz leaked, 600,000 chunk selections would be obvious.
    const state = createLevelState();
    const rng = createRng(1);
    for (let i = 0; i < 20_000; i += 1) {
      generateNext(state, rng, 0);
    }
    expect(state.window.length).toBe(TUNING.level.windowChunks);
  });
});
