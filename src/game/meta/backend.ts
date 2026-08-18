/**
 * `EconomyBackend` — the seam every currency read and write goes through.
 *
 * ## Why this exists before there is anything to swap in
 *
 * Nothing in gameplay or UI may touch a balance directly. They call this
 * interface. Today the only implementation reads and writes the local save; a
 * remote or on-chain one can replace it without a single line changing anywhere
 * else.
 *
 * The value is not hypothetical portability — that is the weakest argument for
 * an interface and usually a wrong one. It is that currency is the thing most
 * likely to grow requirements later (server authority, receipt validation,
 * cross-device sync, refunds), and every one of those is a change to *where a
 * balance lives*, not to what the game does with it. Putting the boundary in now
 * costs one file; putting it in after forty call sites read `save.bits` costs a
 * rewrite.
 *
 * ## Async even though local storage is not
 *
 * Every method returns a `Promise`. The local implementation resolves
 * immediately and gains nothing from it. This is deliberate: an interface whose
 * shape only a synchronous implementation can satisfy is not an abstraction, it
 * is a comment. A remote backend cannot be synchronous, so if callers are
 * allowed to write `backend.getBalances().bits` today, the swap this file exists
 * for is impossible tomorrow — and it would be discovered at the worst moment,
 * with the network code already written.
 *
 * ## Transactions in, balances out
 *
 * The interface accepts `Transaction` values and returns folded balances. It
 * never accepts a balance to set. A backend that could be told "the player has
 * 5,000 Bits" is a backend a modified client can lie to; one that accepts only
 * described, evidenced changes can validate each of them.
 */

import {
  appendTransaction,
  foldLedger,
  EMPTY_LEDGER,
  LedgerRejection,
  type Balances,
  type Ledger,
  type LedgerRejectionValue,
  type Transaction,
} from "./economy";

/** The result of asking a backend to record a transaction. */
export interface CommitResult {
  readonly ok: boolean;
  readonly balances: Balances;
  readonly rejection: LedgerRejectionValue;
}

export interface EconomyBackend {
  /** Current balances. */
  getBalances(): Promise<Balances>;

  /**
   * Records a transaction and returns the resulting balances.
   *
   * Refusals — an overdraft, a malformed amount — come back as `ok: false` with
   * a reason. A backend must never throw for a refusal; an unaffordable
   * purchase is an expected outcome, not an exceptional one.
   */
  commit(transaction: Transaction): Promise<CommitResult>;

  /**
   * The full ledger, newest last.
   *
   * A remote backend may return only a recent window rather than the whole
   * history; callers must not assume `foldLedger(getLedger())` equals
   * `getBalances()`. Use `getBalances()` for balances — that is what it is for.
   */
  getLedger(): Promise<Ledger>;

  /** Pushes local state to wherever the backend keeps it. A no-op locally. */
  flush(): Promise<void>;
}

/** How a local backend reaches its storage. Injected, so tests need no DOM. */
export interface LedgerStore {
  read(): Ledger;
  write(ledger: Ledger): void;
}

/** An in-memory store. The default when no save file is wired up yet. */
export function createMemoryLedgerStore(initial: Ledger = EMPTY_LEDGER): LedgerStore {
  let ledger = initial;
  return {
    read: () => ledger,
    write: (next) => {
      ledger = next;
    },
  };
}

export interface LocalBackendOptions {
  store?: LedgerStore;
  /** Injected so ledger timestamps are deterministic in tests. */
  now?: () => number;
}

/**
 * The local implementation. Reads and writes a ledger through a store.
 *
 * Synchronous underneath, `Promise`-shaped on the surface, for the reason in the
 * header. The resolved values are frozen, so a caller cannot mutate a balance it
 * was handed and have it stick.
 */
export function createLocalEconomyBackend(options: LocalBackendOptions = {}): EconomyBackend {
  const store = options.store ?? createMemoryLedgerStore();
  const now = options.now ?? Date.now;

  return {
    async getBalances(): Promise<Balances> {
      return foldLedger(store.read());
    },

    async commit(transaction: Transaction): Promise<CommitResult> {
      const result = appendTransaction(store.read(), transaction, now());
      if (result.ok) {
        store.write(result.ledger);
      }
      return {
        ok: result.ok,
        balances: result.balances,
        rejection: result.rejection,
      };
    },

    async getLedger(): Promise<Ledger> {
      return store.read();
    },

    async flush(): Promise<void> {
      // Nothing to do: `commit` already wrote through. A remote backend would
      // batch here.
    },
  };
}

/**
 * A backend that refuses everything, for tests and for a hard offline state.
 *
 * Returns zeroes and rejects every commit rather than throwing, so a UI wired to
 * it degrades to "you cannot buy anything right now" instead of crashing.
 */
export function createNullEconomyBackend(): EconomyBackend {
  const zero: Balances = Object.freeze({ bits: 0, shards: 0 });
  return {
    async getBalances() {
      return zero;
    },
    async commit() {
      return { ok: false, balances: zero, rejection: LedgerRejection.InsufficientBits };
    },
    async getLedger() {
      return EMPTY_LEDGER;
    },
    async flush() {
      // Nothing to flush.
    },
  };
}
