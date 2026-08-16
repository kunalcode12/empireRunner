import { describe, expect, it } from "vitest";
import {
  createRng,
  deserializeRng,
  forkRng,
  forkSeed,
  nextBool,
  nextFloat,
  nextInt,
  nextRange,
  nextU32,
  RNG_STREAMS,
  serializeRng,
} from "@/game/sim/rng";

describe("mulberry32 is deterministic", () => {
  it("produces the same sequence for the same seed", () => {
    const a = createRng(12345);
    const b = createRng(12345);
    for (let i = 0; i < 1000; i += 1) {
      expect(nextU32(a)).toBe(nextU32(b));
    }
  });

  it("produces different sequences for different seeds", () => {
    const a = createRng(1);
    const b = createRng(2);
    let differences = 0;
    for (let i = 0; i < 100; i += 1) {
      if (nextU32(a) !== nextU32(b)) {
        differences += 1;
      }
    }
    expect(differences).toBe(100);
  });

  it("accepts seed 0", () => {
    const rng = createRng(0);
    const first = nextU32(rng);
    expect(Number.isInteger(first)).toBe(true);
    expect(first).toBeGreaterThanOrEqual(0);
  });

  it("stays inside uint32 for a long run", () => {
    const rng = createRng(0xdeadbeef);
    for (let i = 0; i < 100_000; i += 1) {
      const v = nextU32(rng);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(0xffffffff);
      expect(Number.isInteger(v)).toBe(true);
    }
  });
});

describe("derived helpers stay in range", () => {
  it("nextFloat is in [0, 1)", () => {
    const rng = createRng(7);
    for (let i = 0; i < 50_000; i += 1) {
      const v = nextFloat(rng);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("nextRange is in [min, max)", () => {
    const rng = createRng(99);
    for (let i = 0; i < 10_000; i += 1) {
      const v = nextRange(rng, -5, 12.5);
      expect(v).toBeGreaterThanOrEqual(-5);
      expect(v).toBeLessThan(12.5);
    }
  });

  it("nextInt is in [min, max) and hits every value", () => {
    const rng = createRng(4242);
    const seen = new Set<number>();
    for (let i = 0; i < 10_000; i += 1) {
      const v = nextInt(rng, 0, 12);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(12);
      expect(Number.isInteger(v)).toBe(true);
      seen.add(v);
    }
    // All 12 prism positions should come up.
    expect(seen.size).toBe(12);
  });

  it("nextInt returns min for an empty range", () => {
    const rng = createRng(1);
    expect(nextInt(rng, 5, 5)).toBe(5);
    expect(nextInt(rng, 5, 3)).toBe(5);
  });

  it("nextBool is not obviously biased", () => {
    const rng = createRng(31337);
    let trues = 0;
    const samples = 100_000;
    for (let i = 0; i < samples; i += 1) {
      if (nextBool(rng)) {
        trues += 1;
      }
    }
    // Within 2% of even. A broken high bit would land at 0% or 100%.
    expect(trues / samples).toBeGreaterThan(0.48);
    expect(trues / samples).toBeLessThan(0.52);
  });

  it("nextFloat spreads across the unit interval", () => {
    const BUCKETS = 10;
    const rng = createRng(2024);
    const counts = new Array<number>(BUCKETS).fill(0);
    const samples = 100_000;
    for (let i = 0; i < samples; i += 1) {
      const bucket = Math.floor(nextFloat(rng) * BUCKETS);
      counts[bucket] = (counts[bucket] ?? 0) + 1;
    }
    const expected = samples / BUCKETS;
    for (const count of counts) {
      expect(count).toBeGreaterThan(expected * 0.9);
      expect(count).toBeLessThan(expected * 1.1);
    }
  });
});

describe("serialization round-trips", () => {
  it("restores the exact position mid-sequence", () => {
    const rng = createRng(555);
    for (let i = 0; i < 137; i += 1) {
      nextU32(rng);
    }

    const saved = serializeRng(rng);
    const expected = [nextU32(rng), nextU32(rng), nextU32(rng)];

    const restored = createRng(0);
    deserializeRng(restored, saved);
    expect([nextU32(restored), nextU32(restored), nextU32(restored)]).toEqual(expected);
  });

  it("serializes to a single uint32", () => {
    const rng = createRng(0xffffffff);
    for (let i = 0; i < 10; i += 1) {
      nextU32(rng);
      const s = serializeRng(rng);
      expect(Number.isInteger(s)).toBe(true);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(0xffffffff);
    }
  });
});

describe("stream forking keeps systems independent", () => {
  it("gives different streams different sequences from the same run seed", () => {
    const RUN_SEED = 777;
    const generator = forkRng(RUN_SEED, RNG_STREAMS.generator);
    const pickup = forkRng(RUN_SEED, RNG_STREAMS.pickup);
    const cosmetic = forkRng(RUN_SEED, RNG_STREAMS.cosmetic);

    const g = nextU32(generator);
    const p = nextU32(pickup);
    const c = nextU32(cosmetic);

    expect(g).not.toBe(p);
    expect(p).not.toBe(c);
    expect(g).not.toBe(c);
  });

  it("is pure — forking does not advance anything", () => {
    const first = forkSeed(1234, RNG_STREAMS.generator);
    const second = forkSeed(1234, RNG_STREAMS.generator);
    expect(first).toBe(second);
  });

  it("THE POINT: draining the cosmetic stream cannot shift the generator", () => {
    // If these shared a stream, spawning one extra particle would change the
    // entire track layout downstream, and a replay recorded with particles on
    // would not validate against a server run with them off.
    const RUN_SEED = 8080;

    const generatorA = forkRng(RUN_SEED, RNG_STREAMS.generator);
    const expected: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      expected.push(nextU32(generatorA));
    }

    const generatorB = forkRng(RUN_SEED, RNG_STREAMS.generator);
    const cosmetic = forkRng(RUN_SEED, RNG_STREAMS.cosmetic);
    const actual: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      // Hammer the cosmetic stream between every generator draw.
      for (let j = 0; j < 50; j += 1) {
        nextU32(cosmetic);
      }
      actual.push(nextU32(generatorB));
    }

    expect(actual).toEqual(expected);
  });

  it("different stream names give different seeds", () => {
    const seeds = new Set([
      forkSeed(1, RNG_STREAMS.generator),
      forkSeed(1, RNG_STREAMS.pickup),
      forkSeed(1, RNG_STREAMS.cosmetic),
    ]);
    expect(seeds.size).toBe(3);
  });

  it("the same stream name on different run seeds diverges", () => {
    const a = forkSeed(1, RNG_STREAMS.generator);
    const b = forkSeed(2, RNG_STREAMS.generator);
    expect(a).not.toBe(b);
  });
});
