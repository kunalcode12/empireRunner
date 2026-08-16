import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Vitest runs the headless side of AXIS: the deterministic sim, the tuning
 * invariants, and the layering-law enforcement test.
 *
 * `environment: "node"` is deliberate and load-bearing. docs/ARCHITECTURE.md §2a
 * requires src/game/sim/ to run with no DOM whatsoever — the same code path the
 * server uses to re-validate submitted replays in P12. If a sim test ever needs
 * jsdom, the sim has a bug.
 *
 * Playwright specs live in tests/e2e/ and are excluded here so the two runners
 * never fight over the same files.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "src/game/**/*.test.ts"],
    exclude: ["node_modules/**", ".next/**", "tests/e2e/**"],
    coverage: {
      provider: "v8",
      include: ["src/game/**"],
      exclude: ["src/game/**/*.test.ts"],
      reporter: ["text", "lcov"],
    },
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
