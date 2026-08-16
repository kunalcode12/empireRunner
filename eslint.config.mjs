import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/**
 * AXIS lint configuration.
 *
 * The blocks below marked LAYERING LAW are load-bearing. They enforce the import
 * boundaries described in docs/ARCHITECTURE.md §3 in CI, not in a comment. Breaking
 * one of them is a design change, not a refactor — see docs/ARCHITECTURE.md §2.
 *
 * Note: Next.js 16 no longer runs ESLint as part of `next build`, so `npm run lint`
 * is its own required CI step. A green build does NOT imply a green lint.
 */

/** Packages the deterministic sim may never see. Law (a). */
const SIM_FORBIDDEN_PACKAGES = [
  "react",
  "react/**",
  "react-dom",
  "react-dom/**",
  "three",
  "three/**",
  "@react-three/*",
  "@react-three/**",
  "postprocessing",
  "postprocessing/**",
  "zustand",
  "zustand/**",
  "next",
  "next/**",
  "motion",
  "motion/**",
  "leva",
  "r3f-perf",
];

/** Layers above the sim. Importing these from sim/ inverts the dependency graph. */
const SIM_FORBIDDEN_LAYERS = [
  "@/ui",
  "@/ui/**",
  "@/app",
  "@/app/**",
  "@/game/render",
  "@/game/render/**",
  "@/game/input",
  "@/game/input/**",
  "@/game/audio",
  "@/game/audio/**",
  "@/game/meta",
  "@/game/meta/**",
];

const SIM_IMPORT_MESSAGE =
  "LAYERING LAW (docs/ARCHITECTURE.md §2a): src/game/sim/ is the pure deterministic " +
  "simulation. It may import ONLY from src/game/config/ and other files inside src/game/sim/. " +
  "This boundary is what makes replays reproducible and server-side leaderboard validation " +
  "possible. If you need this import, the code does not belong in sim/.";

export default defineConfig([
  ...nextVitals,
  ...nextTs,

  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "coverage/**",
    "playwright-report/**",
    "test-results/**",
    "next-env.d.ts",
  ]),

  // ───────────────────────────────────────────────────────────────────────────
  // LAYERING LAW — src/game/sim/ is headless and deterministic. Law (a).
  // ───────────────────────────────────────────────────────────────────────────
  {
    files: ["src/game/sim/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [...SIM_FORBIDDEN_PACKAGES, ...SIM_FORBIDDEN_LAYERS],
              message: SIM_IMPORT_MESSAGE,
            },
            {
              // Any relative traversal out of sim/ that is not into config/.
              // `../config/x` is legal; `../render/x` and `../../ui/x` are not.
              regex: "^\\.\\./(?!config/)",
              message: SIM_IMPORT_MESSAGE,
            },
          ],
        },
      ],

      // no-restricted-imports only sees static `import`. These close the other two doors.
      "no-restricted-syntax": [
        "error",
        {
          selector: "ImportExpression",
          message: `Dynamic import() is banned in src/game/sim/. ${SIM_IMPORT_MESSAGE}`,
        },
        {
          selector: "CallExpression[callee.name='require']",
          message: `require() is banned in src/game/sim/. ${SIM_IMPORT_MESSAGE}`,
        },
      ],

      // Law (a): the sim knows tick counts, never wall-clock time, and never
      // unseeded randomness. All randomness comes from the seeded PRNG in sim/rng.ts.
      "no-restricted-properties": [
        "error",
        {
          object: "Math",
          property: "random",
          message:
            "Math.random() is banned in src/game/sim/. Use the seeded PRNG in sim/rng.ts — " +
            "docs/ARCHITECTURE.md §2a.",
        },
        {
          object: "Date",
          property: "now",
          message:
            "Date.now() is banned in src/game/sim/. The sim measures tick counts, not " +
            "wall-clock time — docs/ARCHITECTURE.md §2a.",
        },
        {
          object: "performance",
          property: "now",
          message:
            "performance.now() is banned in src/game/sim/. The sim measures tick counts, not " +
            "wall-clock time — docs/ARCHITECTURE.md §2a.",
        },
      ],

      "no-restricted-globals": [
        "error",
        {
          name: "window",
          message: "src/game/sim/ is headless and must run under Node — no DOM globals.",
        },
        {
          name: "document",
          message: "src/game/sim/ is headless and must run under Node — no DOM globals.",
        },
        {
          name: "requestAnimationFrame",
          message:
            "The sim ticks on a fixed 60Hz accumulator, never on rAF — docs/ARCHITECTURE.md §2c.",
        },
      ],
    },
  },

  // ───────────────────────────────────────────────────────────────────────────
  // LAYERING LAW — src/game/config/ is leaf data. It imports nothing.
  // ───────────────────────────────────────────────────────────────────────────
  {
    files: ["src/game/config/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              // Anything that is not a relative sibling import.
              regex: "^(?!\\./)",
              message:
                "LAYERING LAW (docs/ARCHITECTURE.md §3): src/game/config/ is leaf data and " +
                "imports nothing. Only relative sibling imports (./entities, ./themes) are allowed.",
            },
          ],
        },
      ],
    },
  },

  // ───────────────────────────────────────────────────────────────────────────
  // LAYERING LAW — src/ui/ is DOM only. A canvas-rendered HUD costs draw calls
  // the budget in docs/TUNING.md §14 does not have.
  // ───────────────────────────────────────────────────────────────────────────
  {
    files: ["src/ui/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "three",
                "three/**",
                "@react-three/*",
                "@react-three/**",
                "postprocessing",
                "r3f-perf",
                "@/game/render",
                "@/game/render/**",
              ],
              message:
                "LAYERING LAW (docs/ARCHITECTURE.md §3): src/ui/ is DOM only and never imports " +
                "three or @react-three/*. The HUD is DOM.",
            },
          ],
        },
      ],
    },
  },

  // ───────────────────────────────────────────────────────────────────────────
  // Every gameplay number lives in src/game/config/tuning.ts. CLAUDE.md QUALITY.
  // ───────────────────────────────────────────────────────────────────────────
  {
    files: ["src/game/**/*.{ts,tsx}"],
    ignores: ["src/game/config/**"],
    rules: {
      "no-magic-numbers": [
        "error",
        {
          ignore: [-1, 0, 1, 2],
          ignoreArrayIndexes: true,
          enforceConst: true,
          detectObjects: false,
        },
      ],
    },
  },

  // Tests assert on concrete values by definition.
  {
    files: ["tests/**/*.{ts,tsx}", "**/*.test.{ts,tsx}", "**/*.spec.{ts,tsx}"],
    rules: {
      "no-magic-numbers": "off",
      "no-restricted-syntax": "off",
    },
  },
]);
