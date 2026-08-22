/**
 * Registers the TypeScript resolution hook in the current process.
 *
 * Split from `ts-hooks.mjs` because `module.register` runs the hook file on its
 * own thread — the registration call and the hook itself cannot live in one
 * module.
 */

import { register } from "node:module";

register("./ts-hooks.mjs", import.meta.url);
