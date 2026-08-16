import { describe, expect, it } from "vitest";
import {
  acquire,
  acquireIndex,
  createIndexPool,
  createPool,
  hasCapacity,
  peek,
  PoolExhaustedError,
  PoolReleaseError,
  releaseIndex,
  resetIndexPool,
  resetPool,
} from "@/game/sim/pool";

describe("IndexPool", () => {
  it("hands out every index exactly once", () => {
    const pool = createIndexPool("test", 8);
    const seen = new Set<number>();
    for (let i = 0; i < 8; i += 1) {
      seen.add(acquireIndex(pool));
    }
    expect(seen.size).toBe(8);
    expect([...seen].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("hands out index 0 first, so ordering is readable in test output", () => {
    const pool = createIndexPool("test", 4);
    expect(acquireIndex(pool)).toBe(0);
    expect(acquireIndex(pool)).toBe(1);
  });

  it("recycles released indices", () => {
    const pool = createIndexPool("test", 4);
    const a = acquireIndex(pool);
    acquireIndex(pool);
    releaseIndex(pool, a);
    expect(acquireIndex(pool)).toBe(a);
  });

  it("tracks live count and its peak", () => {
    const pool = createIndexPool("test", 10);
    const held: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      held.push(acquireIndex(pool));
    }
    expect(pool.liveCount).toBe(7);
    expect(pool.peakLiveCount).toBe(7);

    for (const index of held) {
      releaseIndex(pool, index);
    }
    expect(pool.liveCount).toBe(0);
    // Peak is a sizing diagnostic and survives release.
    expect(pool.peakLiveCount).toBe(7);
  });

  it("reports capacity ahead of time", () => {
    const pool = createIndexPool("test", 3);
    expect(hasCapacity(pool, 3)).toBe(true);
    expect(hasCapacity(pool, 4)).toBe(false);
    acquireIndex(pool);
    expect(hasCapacity(pool, 3)).toBe(false);
    expect(hasCapacity(pool, 2)).toBe(true);
  });

  it("resets everything back to free", () => {
    const pool = createIndexPool("test", 5);
    for (let i = 0; i < 5; i += 1) {
      acquireIndex(pool);
    }
    resetIndexPool(pool);
    expect(pool.liveCount).toBe(0);
    expect(pool.freeCount).toBe(5);
    expect(acquireIndex(pool)).toBe(0);
  });
});

describe("capacity is a hard ceiling, not a hint", () => {
  it("THROWS past capacity rather than growing", () => {
    // Growing IS the allocation law (d) forbids. Refusing converts a silent
    // frame-time regression into a loud, located failure.
    const pool = createIndexPool("obstacles", 3);
    acquireIndex(pool);
    acquireIndex(pool);
    acquireIndex(pool);
    expect(() => acquireIndex(pool)).toThrow(PoolExhaustedError);
  });

  it("names the pool and points at the fix", () => {
    const pool = createIndexPool("obstacles", 1);
    acquireIndex(pool);
    expect(() => acquireIndex(pool)).toThrow(/obstacles/);
    expect(() => acquireIndex(pool)).toThrow(/TUNING\.pools/);
    expect(() => acquireIndex(pool)).toThrow(/law d/);
  });

  it("does not corrupt the pool when it refuses", () => {
    const pool = createIndexPool("test", 2);
    const a = acquireIndex(pool);
    acquireIndex(pool);
    expect(() => acquireIndex(pool)).toThrow(PoolExhaustedError);

    releaseIndex(pool, a);
    expect(pool.liveCount).toBe(1);
    expect(acquireIndex(pool)).toBe(a);
  });
});

describe("release is guarded", () => {
  it("rejects a double release", () => {
    // Otherwise the free list would hand the same slot to two entities.
    const pool = createIndexPool("test", 4);
    const index = acquireIndex(pool);
    releaseIndex(pool, index);
    expect(() => releaseIndex(pool, index)).toThrow(PoolReleaseError);
  });

  it("rejects an index that was never acquired", () => {
    const pool = createIndexPool("test", 4);
    expect(() => releaseIndex(pool, 2)).toThrow(PoolReleaseError);
  });

  it("rejects an out-of-range index", () => {
    const pool = createIndexPool("test", 4);
    expect(() => releaseIndex(pool, -1)).toThrow(PoolReleaseError);
    expect(() => releaseIndex(pool, 4)).toThrow(PoolReleaseError);
  });
});

describe("object Pool", () => {
  interface Scratch {
    x: number;
    y: number;
  }

  function makeScratch(): Scratch {
    return { x: 0, y: 0 };
  }

  it("pre-warms every instance at construction", () => {
    let constructed = 0;
    createPool("scratch", 16, () => {
      constructed += 1;
      return makeScratch();
    });
    expect(constructed).toBe(16);
  });

  it("never calls the factory again after construction", () => {
    // This is the property that makes acquire allocation-free.
    let constructed = 0;
    const pool = createPool("scratch", 4, () => {
      constructed += 1;
      return makeScratch();
    });
    const atStart = constructed;

    for (let i = 0; i < 4; i += 1) {
      acquire(pool);
    }
    expect(constructed).toBe(atStart);
  });

  it("hands back the same instances, so identity is stable", () => {
    const pool = createPool<Scratch>("scratch", 3, makeScratch);
    const first = acquire(pool);
    resetPool(pool);
    expect(acquire(pool)).toBe(first);
  });

  it("passes the slot index to the factory", () => {
    const pool = createPool("indexed", 4, (i) => ({ x: i, y: 0 }));
    expect(peek(pool, 0)?.x).toBe(0);
    expect(peek(pool, 3)?.x).toBe(3);
  });

  it("throws past capacity", () => {
    const pool = createPool<Scratch>("scratch", 2, makeScratch);
    acquire(pool);
    acquire(pool);
    expect(() => acquire(pool)).toThrow(PoolExhaustedError);
  });
});
