/**
 * Store selection, and the one shared instance the routes use.
 *
 * ## Why a module-level singleton rather than a per-request store
 *
 * Because the memory adapter IS the state. A store constructed per request would
 * forget every nonce between issuing a token and spending it, which is not a
 * subtle failure — nothing would work at all.
 *
 * The consequence is worth being explicit about: in serverless deployment, each
 * cold instance gets its own memory store, so nonces and boards do not agree
 * across instances. That is not a bug in this file; it is the reason a real
 * deployment needs a shared adapter, and it is recorded in PROGRESS.md rather
 * than left for somebody to discover in production.
 *
 * ## Tests get their own
 *
 * `setStore` exists so a test can install a fresh memory store per case without
 * reaching into module state. It is not exported to routes and nothing in
 * `src/app/` may call it.
 */

import { createFileStore } from "./file";
import { createMemoryStore } from "./memory";
import type { Store } from "./types";

let instance: Store | null = null;

/** Builds the adapter named by the environment. Memory unless told otherwise. */
function build(): Store {
  const path = process.env["AXIS_STORE_FILE"];
  if (path !== undefined && path !== "") {
    return createFileStore(path);
  }
  return createMemoryStore();
}

/** The process-wide store. */
export function getStore(): Store {
  if (instance === null) {
    instance = build();
  }
  return instance;
}

/** Replaces the store. Tests only. */
export function setStore(store: Store | null): void {
  instance = store;
}

export { createFileStore, createMemoryStore };
export type { Store };
export * from "./types";
