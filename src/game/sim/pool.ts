/**
 * Pre-warmed object pools — docs/ARCHITECTURE.md §2d.
 *
 * Law (d) is zero heap allocation inside the tick. A GC pause during a run does
 * not read as a frame drop; it reads as input lag, and it lands during the dense
 * high-Flow sections where it hurts most.
 *
 * Two flavours:
 *   - `Pool<T>`     pre-warms N objects and hands out references. For scratch
 *                   vectors and anything that genuinely needs to be an object.
 *   - `IndexPool`   a free list over integer indices into the typed-array columns
 *                   in state.ts. This is the real zero-allocation path and what
 *                   entities use.
 *
 * ## On the "throws if the tick allocates" check
 *
 * Be clear about what is and is not possible here. JavaScript exposes no hook
 * that fires on allocation, so no in-process guard can detect an arbitrary `{}`
 * inside the tick. What these pools CAN do — and do — is refuse to grow:
 * `acquire()` past capacity throws instead of allocating a new instance, because
 * growing the pool IS the allocation law (d) forbids. That converts a silent
 * frame-time regression into a loud, located failure.
 *
 * The general case is covered by measurement instead, in
 * `tests/sim/allocation.test.ts`, which asserts total heap delta across 10,000
 * ticks stays under `TUNING.budgets.heapDeltaBytes`.
 */

/** Thrown when a pool is asked for more than it reserved. */
export class PoolExhaustedError extends Error {
  constructor(name: string, capacity: number) {
    super(
      `Pool "${name}" exhausted at capacity ${capacity}. Growing it would allocate inside ` +
        `the tick, which docs/ARCHITECTURE.md §2d (law d) forbids. Either raise the capacity ` +
        `in TUNING.pools — sized from the band-5 worst case — or find the leaked release().`,
    );
    this.name = "PoolExhaustedError";
  }
}

/** Thrown when a released index is not one this pool handed out. */
export class PoolReleaseError extends Error {
  constructor(name: string, detail: string) {
    super(`Pool "${name}" release error: ${detail}`);
    this.name = "PoolReleaseError";
  }
}

/**
 * A free list over `[0, capacity)`.
 *
 * `acquire` pops an index, `release` pushes it back. Both are O(1) and neither
 * allocates. The backing store is a single `Int32Array` sized at construction.
 */
export interface IndexPool {
  readonly name: string;
  readonly capacity: number;
  /** How many indices are currently checked out. */
  liveCount: number;
  /** High-water mark of `liveCount` over the pool's lifetime. Sizing diagnostic. */
  peakLiveCount: number;
  /** Free indices, valid in `[0, freeCount)`. */
  readonly free: Int32Array;
  /** Number of valid entries in `free`. */
  freeCount: number;
  /** 1 if the index is checked out. Guards double-release. */
  readonly checkedOut: Uint8Array;
}

export function createIndexPool(name: string, capacity: number): IndexPool {
  const free = new Int32Array(capacity);
  // Fill descending so the first acquire returns 0, which keeps entity ordering
  // (and therefore iteration order, and therefore float accumulation order)
  // stable and readable in test output.
  for (let i = 0; i < capacity; i += 1) {
    free[i] = capacity - 1 - i;
  }
  return {
    name,
    capacity,
    liveCount: 0,
    peakLiveCount: 0,
    free,
    freeCount: capacity,
    checkedOut: new Uint8Array(capacity),
  };
}

/**
 * Takes an index from the pool.
 *
 * @throws PoolExhaustedError if the pool is empty. It does not grow — see the
 *         module header for why that is the correct behaviour rather than a
 *         limitation.
 */
export function acquireIndex(pool: IndexPool): number {
  if (pool.freeCount <= 0) {
    throw new PoolExhaustedError(pool.name, pool.capacity);
  }
  pool.freeCount -= 1;
  const index = pool.free[pool.freeCount] ?? 0;
  pool.checkedOut[index] = 1;
  pool.liveCount += 1;
  if (pool.liveCount > pool.peakLiveCount) {
    pool.peakLiveCount = pool.liveCount;
  }
  return index;
}

/**
 * Returns an index to the pool.
 *
 * @throws PoolReleaseError on a double release or an out-of-range index. Both
 *         are bugs that would otherwise corrupt the free list silently and
 *         hand the same slot to two entities.
 */
export function releaseIndex(pool: IndexPool, index: number): void {
  if (index < 0 || index >= pool.capacity) {
    throw new PoolReleaseError(pool.name, `index ${index} is outside [0, ${pool.capacity})`);
  }
  if (pool.checkedOut[index] !== 1) {
    throw new PoolReleaseError(pool.name, `index ${index} was released twice or never acquired`);
  }
  pool.checkedOut[index] = 0;
  pool.free[pool.freeCount] = index;
  pool.freeCount += 1;
  pool.liveCount -= 1;
}

/** Returns every index to the pool. Allocates nothing. */
export function resetIndexPool(pool: IndexPool): void {
  for (let i = 0; i < pool.capacity; i += 1) {
    pool.free[i] = pool.capacity - 1 - i;
  }
  pool.freeCount = pool.capacity;
  pool.liveCount = 0;
  pool.checkedOut.fill(0);
}

/** True if the pool can satisfy `n` more acquires. */
export function hasCapacity(pool: IndexPool, n: number): boolean {
  return pool.freeCount >= n;
}

/**
 * A pool of pre-warmed objects.
 *
 * The factory runs `capacity` times at construction and never again. `acquire`
 * hands back an existing instance; it never calls the factory, so it never
 * allocates.
 */
export interface Pool<T> {
  readonly name: string;
  readonly capacity: number;
  readonly items: readonly T[];
  readonly indices: IndexPool;
}

export function createPool<T>(name: string, capacity: number, factory: (i: number) => T): Pool<T> {
  const items: T[] = new Array<T>(capacity);
  for (let i = 0; i < capacity; i += 1) {
    items[i] = factory(i);
  }
  return {
    name,
    capacity,
    items,
    indices: createIndexPool(name, capacity),
  };
}

/**
 * Takes a pre-warmed instance from the pool.
 *
 * @throws PoolExhaustedError past capacity. It will not construct a new one.
 */
export function acquire<T>(pool: Pool<T>): T {
  const index = acquireIndex(pool.indices);
  const item = pool.items[index];
  if (item === undefined) {
    throw new PoolExhaustedError(pool.name, pool.capacity);
  }
  return item;
}

/** Takes an instance and also reports which slot it came from. */
export function acquireWithIndex<T>(pool: Pool<T>): number {
  return acquireIndex(pool.indices);
}

/** Returns a slot to the pool. */
export function release<T>(pool: Pool<T>, index: number): void {
  releaseIndex(pool.indices, index);
}

/** Reads a slot without acquiring it. */
export function peek<T>(pool: Pool<T>, index: number): T | undefined {
  return pool.items[index];
}

/** Returns every slot to the pool. Instances are reused as-is, not recreated. */
export function resetPool<T>(pool: Pool<T>): void {
  resetIndexPool(pool.indices);
}
