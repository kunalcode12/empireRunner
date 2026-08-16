import { describe, expect, it } from "vitest";
import { TUNING } from "@/game/config/tuning";
import { createRng, forkSeed, RNG_STREAMS } from "@/game/sim/rng";
import {
  ALL_CHUNKS,
  createLevelState,
  difficultyFor,
  fillWindow,
  generateNext,
  MAX_TIER,
  MIN_TIER,
  resetLevelState,
  seamsCompatible,
  TRANSITION_INDEX,
  WINDOW_CHUNKS,
  type LevelState,
} from "@/game/sim/level";

const RECENCY_WINDOW = TUNING.level.recencyWindow;
const HARD_DIFFICULTY = TUNING.level.hardDifficulty;
const MAX_CONSECUTIVE_HARD = TUNING.level.maxConsecutiveHard;

/** Generates `count` chunks from a seed and returns the id sequence. */
function sequence(seed: number, count: number, flow = 0): string[] {
  const state = createLevelState();
  const rng = createRng(forkSeed(seed, RNG_STREAMS.generator));
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    ids.push(generateNext(state, rng, flow).chunk.id);
  }
  return ids;
}

describe("determinism", () => {
  it("produces an identical chunk sequence for the same seed, 100 times", () => {
    const SEED = 0xa11ce;
    const LENGTH = 200;
    const expected = sequence(SEED, LENGTH).join(",");

    const distinct = new Set<string>();
    for (let i = 0; i < 100; i += 1) {
      distinct.add(sequence(SEED, LENGTH).join(","));
    }

    expect(distinct.size).toBe(1);
    expect([...distinct][0]).toBe(expected);
  });

  it("produces different sequences for different seeds", () => {
    expect(sequence(1, 100).join(",")).not.toBe(sequence(2, 100).join(","));
  });

  it("reset restores the sequence exactly", () => {
    const state = createLevelState();
    const rngA = createRng(123);
    const first: string[] = [];
    for (let i = 0; i < 50; i += 1) {
      first.push(generateNext(state, rngA, 0).chunk.id);
    }

    resetLevelState(state);
    const rngB = createRng(123);
    const second: string[] = [];
    for (let i = 0; i < 50; i += 1) {
      second.push(generateNext(state, rngB, 0).chunk.id);
    }

    expect(second).toEqual(first);
  });
});

describe("difficulty banding", () => {
  it("rises with distance", () => {
    expect(difficultyFor(0, 0)).toBe(1);
    expect(difficultyFor(600, 0)).toBe(2);
    expect(difficultyFor(2000, 0)).toBe(3);
    expect(difficultyFor(4000, 0)).toBe(4);
    expect(difficultyFor(6000, 0)).toBe(5);
  });

  it("rises with Flow — the self-escalation loop reaching the generator", () => {
    // A high-Flow player is not just moving faster, they are handed harder
    // track. GAME_BIBLE §4.2 couples Flow to speed; this extends it.
    const atZeroFlow = difficultyFor(600, 0);
    const atFullFlow = difficultyFor(600, TUNING.flow.flowMax);
    expect(atFullFlow).toBeGreaterThan(atZeroFlow);
    expect(atFullFlow - atZeroFlow).toBe(TUNING.level.flowDifficultyBonus);
  });

  it("clamps to the authored tiers", () => {
    // A 100-Flow player at 6,000m must not ask for a tier 6 that does not exist.
    expect(difficultyFor(99999, TUNING.flow.flowMax)).toBeLessThanOrEqual(MAX_TIER);
    expect(difficultyFor(0, 0)).toBeGreaterThanOrEqual(MIN_TIER);
  });
});

describe("recency", () => {
  it(`never repeats a chunk within ${RECENCY_WINDOW} picks`, () => {
    // Checked across many seeds, because a single seed could get lucky.
    for (let seed = 0; seed < 200; seed += 1) {
      const ids = sequence(seed, 120);
      for (let i = 0; i < ids.length; i += 1) {
        const window = ids.slice(Math.max(0, i - RECENCY_WINDOW), i);
        const id = ids[i] ?? "";
        // Transition chunks are exempt: they are inserted by milestone, not
        // selected, and two in a row is the intended behaviour.
        if (id === "transition") {
          continue;
        }
        expect(
          window.filter((w) => w === id).length,
          `seed ${seed}: "${id}" repeated within ${RECENCY_WINDOW} at index ${i}`,
        ).toBe(0);
      }
    }
  });

  it("still rotates through a tier rather than locking onto one chunk", () => {
    const ids = sequence(7, 300).filter((id) => id !== "transition");
    const distinct = new Set(ids);
    // With 32 chunks and a rotating band, a healthy run should touch many.
    expect(distinct.size).toBeGreaterThan(10);
  });
});

describe("the breather rule", () => {
  it(`never allows more than ${MAX_CONSECUTIVE_HARD} consecutive hard chunks`, () => {
    for (let seed = 0; seed < 200; seed += 1) {
      const state = createLevelState();
      const rng = createRng(forkSeed(seed, RNG_STREAMS.generator));
      let run = 0;
      for (let i = 0; i < 200; i += 1) {
        // Full Flow so the generator is pushed as hard as it can be.
        const placed = generateNext(state, rng, TUNING.flow.flowMax);
        if (placed.chunk.difficulty >= HARD_DIFFICULTY) {
          run += 1;
          expect(
            run,
            `seed ${seed}: ${run} hard chunks in a row at index ${i}`,
          ).toBeLessThanOrEqual(MAX_CONSECUTIVE_HARD);
        } else {
          run = 0;
        }
      }
    }
  });
});

describe("seams", () => {
  it("never places two chunks whose seams conflict", () => {
    for (let seed = 0; seed < 500; seed += 1) {
      const state = createLevelState();
      const rng = createRng(forkSeed(seed, RNG_STREAMS.generator));
      let previous = generateNext(state, rng, 0).chunk;

      for (let i = 1; i < 100; i += 1) {
        const next = generateNext(state, rng, TUNING.flow.flowMax).chunk;
        expect(
          seamsCompatible(previous.exitConstraint, next.entryConstraint),
          `seed ${seed}: "${previous.id}" -> "${next.id}" is an unsurvivable seam at index ${i}`,
        ).toBe(true);
        previous = next;
      }
    }
  });
});

describe("theme transitions", () => {
  it("inserts obstacle-free track at every milestone", () => {
    const state = createLevelState();
    const rng = createRng(99);
    const placed: { id: string; distance: number }[] = [];
    // Far enough to cross all three milestones.
    while (state.nextDistance < 6000) {
      const p = generateNext(state, rng, 0);
      placed.push({ id: p.chunk.id, distance: p.startDistance });
    }

    for (const milestone of TUNING.level.themeMilestones) {
      const around = placed.filter(
        (p) => p.distance >= milestone - TUNING.spawn.chunkLength && p.distance < milestone + 150,
      );
      expect(
        around.some((p) => p.id === "transition"),
        `no transition chunk near milestone ${milestone}m`,
      ).toBe(true);
    }
  });

  it("makes the transition long enough to be a real breath", () => {
    const state = createLevelState();
    const rng = createRng(5);
    let transitions = 0;
    let sawRun = false;
    while (state.nextDistance < 2000) {
      const p = generateNext(state, rng, 0);
      if (p.chunk.id === "transition") {
        transitions += 1;
        sawRun = true;
      } else if (sawRun) {
        break;
      }
    }
    const expectedChunks = Math.round(TUNING.level.transitionLength / TUNING.spawn.chunkLength);
    expect(transitions).toBe(expectedChunks);
  });
});

describe("the rolling window", () => {
  it("keeps exactly windowChunks live once warmed", () => {
    const state = createLevelState();
    const rng = createRng(11);
    fillWindow(state, rng, 0, 0);
    expect(state.count).toBe(WINDOW_CHUNKS);
  });

  it("recycles rather than growing as the player advances", () => {
    const state = createLevelState();
    const rng = createRng(12);
    fillWindow(state, rng, 0, 0);
    const slots = state.window;

    for (let distance = 0; distance < 5000; distance += TUNING.spawn.chunkLength) {
      fillWindow(state, rng, 0, distance);
      expect(state.count).toBeLessThanOrEqual(WINDOW_CHUNKS);
      expect(state.window).toBe(slots);
      expect(state.window.length).toBe(WINDOW_CHUNKS);
    }

    expect(state.ordinal).toBeGreaterThan(200);
  });

  it("gives every emitted chunk a unique, monotonic ordinal", () => {
    const state = createLevelState();
    const rng = createRng(13);
    let last = -1;
    for (let i = 0; i < 500; i += 1) {
      const p = generateNext(state, rng, 0);
      expect(p.ordinal).toBe(last + 1);
      last = p.ordinal;
    }
  });
});

describe("fillWindow is bounded", () => {
  it("REGRESSION: a huge forward jump does not emit an unbounded burst", () => {
    // This loop runs inside the tick once P07 wires the generator in. Driven by a
    // caller-supplied distance, an unbounded version emits thousands of chunks in
    // one frame on a large jump — the Head Start boost skips 300m — which is the
    // same spiral the clock's maxTicksPerFrame guard exists to prevent.
    const state = createLevelState();
    const rng = createRng(77);
    const emitted = fillWindow(state, rng, 0, 1_000_000);
    expect(emitted).toBeLessThanOrEqual(WINDOW_CHUNKS + 1);
  });

  it("REGRESSION: a non-finite distance does not hang", () => {
    const state = createLevelState();
    const rng = createRng(78);
    expect(fillWindow(state, rng, 0, Number.NaN)).toBeLessThanOrEqual(WINDOW_CHUNKS + 1);
    expect(fillWindow(state, rng, 0, Number.POSITIVE_INFINITY)).toBeLessThanOrEqual(
      WINDOW_CHUNKS + 1,
    );
  });

  it("still keeps up with normal play, called every tick", () => {
    // The bound must not starve the window in the case that actually matters.
    const state = createLevelState();
    const rng = createRng(79);
    let distance = 0;
    const perTick = TUNING.speed.maxSpeed * TUNING.sim.fixedDelta;
    for (let i = 0; i < 20_000; i += 1) {
      distance += perTick;
      fillWindow(state, rng, 0, distance);
      expect(state.nextDistance).toBeGreaterThanOrEqual(distance);
    }
  });
});

describe("allocation", () => {
  it("generating 1,000 chunks allocates nothing beyond the initial pool", () => {
    const state = createLevelState();
    const rng = createRng(0xbeef);

    // Warm: let V8 settle and let the window fill.
    for (let i = 0; i < 5000; i += 1) {
      generateNext(state, rng, 0);
    }

    const gc = (globalThis as { gc?: () => void }).gc;
    const collect = (): void => {
      if (gc) {
        gc();
        gc();
        gc();
      }
    };

    collect();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 1000; i += 1) {
      generateNext(state, rng, 0);
    }
    collect();
    const retained = process.memoryUsage().heapUsed - before;

    console.log(
      `[level] 1,000 chunks generated | retained ${retained} bytes ` +
        `(${(retained / 1000).toFixed(2)} B/chunk) | forced GC: ${gc ? "yes" : "no"}`,
    );

    expect(retained).toBeLessThan(TUNING.budgets.heapDeltaBytes);
  });

  it("reuses the same PlacedChunk objects", () => {
    const state = createLevelState();
    const rng = createRng(1);
    fillWindow(state, rng, 0, 0);
    const identities = state.window.slice();

    for (let i = 0; i < 1000; i += 1) {
      generateNext(state, rng, 0);
    }

    for (let i = 0; i < identities.length; i += 1) {
      expect(state.window[i]).toBe(identities[i]);
    }
  });
});

describe("selection never stalls", () => {
  it("always returns a chunk, even under maximum constraint pressure", () => {
    // Full Flow (hardest tier) plus the breather rule plus recency plus seams is
    // the worst case the selector faces. It must still emit something.
    const state = createLevelState();
    const rng = createRng(0xdead);
    for (let i = 0; i < 2000; i += 1) {
      const placed = generateNext(state, rng, TUNING.flow.flowMax);
      expect(placed.chunk).toBeDefined();
      expect(placed.chunk.id.length).toBeGreaterThan(0);
    }
  });

  it("falls back to the transition chunk rather than throwing", () => {
    const state: LevelState = createLevelState();
    // An impossible exit: no cell is safe, so nothing can follow it.
    state.lastExitCells = 0;
    const rng = createRng(1);
    const placed = generateNext(state, rng, 0);
    expect(placed.chunkIndex).toBe(TRANSITION_INDEX);
  });
});

describe("every emitted chunk comes from the authored pool", () => {
  it("never invents geometry", () => {
    const known = new Set(ALL_CHUNKS.map((c) => c.id));
    known.add("transition");
    for (const id of sequence(42, 500, 50)) {
      expect(known.has(id), `unknown chunk "${id}"`).toBe(true);
    }
  });
});
