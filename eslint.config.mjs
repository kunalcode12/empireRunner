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
              // Relative escapes into a sibling LAYER, at any nesting depth.
              //
              // Two earlier versions of this rule were wrong, both in the same
              // way — they tried to allowlist what is permitted:
              //
              //   v1  `^\.\./(?!config/)`
              //       assumed every sim file sat directly in src/game/sim/, and
              //       rejected a subdirectory's legal `../state` the moment
              //       src/game/sim/player/ existed.
              //   v2  allowlisted sibling module names by hand, and rejected
              //       `../chunk` the moment src/game/sim/level/ added one.
              //
              // An allowlist of module names goes stale every time a module is
              // added, and the failure is a false positive that blocks correct
              // code. So this denylists the destinations instead: the only
              // relative escapes that matter are into the six sibling layers,
              // and those names are fixed by the architecture rather than by
              // whatever files happen to exist today.
              //
              // Bare-package and `@/`-aliased escapes are already covered by the
              // group patterns above, so this only has to catch relative ones.
              regex: "^(\\.\\./)+(render|ui|app|input|audio|meta)(/|$)",
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

        // ── Transcendentals ──────────────────────────────────────────────────
        //
        // ECMA-262 specifies +, -, *, / and Math.sqrt as exactly reproducible
        // (IEEE-754). It specifies exp, log, pow, sin, cos, tan, atan2, cbrt
        // and hypot only as "implementation-approximated" — engines may differ
        // in the last ulp.
        //
        // P12 re-validates a browser-recorded replay on a Node server. Chrome,
        // Safari and Firefox do not share a libm, so one ulp compounded over
        // 36,000 ticks diverges, and the failure mode is honest players being
        // rejected as cheaters.
        //
        // If the sim genuinely needs one of these, evaluate it ONCE offline and
        // freeze the result as a decimal literal in TUNING.determinism, the way
        // speedApproachPerTick is handled. Decimal-to-double conversion IS
        // exactly specified, so every engine reads the identical bits.
        ...[
          "exp",
          "log",
          "log2",
          "log10",
          "pow",
          "sin",
          "cos",
          "tan",
          "asin",
          "acos",
          "atan",
          "atan2",
          "sinh",
          "cosh",
          "tanh",
          "cbrt",
          "hypot",
          "expm1",
          "log1p",
        ].map((fn) => ({
          object: "Math",
          property: fn,
          message:
            `Math.${fn}() is banned in src/game/sim/. It is only ` +
            '"implementation-approximated" by ECMA-262, so browser engines disagree in the ' +
            "last ulp and cross-engine replay validation breaks. Use exact arithmetic " +
            "(+ - * / Math.sqrt), or freeze the value offline in TUNING.determinism — see " +
            "speedApproachPerTick for the pattern.",
        })),
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
    // Exempt the two places that are DATA rather than logic.
    //
    // src/game/config/**      the tuning table itself.
    // src/game/sim/level/chunks/**  hand-authored chunk layouts. These are lists
    //   of "entity X at face F, lane L, z Z" — every number IS the content.
    //   Hoisting each z offset to a named constant would make 32 chunk files
    //   unreadable to the person authoring the 33rd, which is exactly who they
    //   are written for. Chunk files contain no branches and no arithmetic; if
    //   one ever does, it wants to be two chunks instead.
    ignores: [
      "src/game/config/**",
      "src/game/sim/level/chunks/**",
      // Pose data. Identical case to the chunks: a pose is a list of joint
      // angles and every number IS the content. These are PRESENTATION values —
      // none can change a gameplay outcome, which is what the tuning.ts rule
      // actually protects. Values that affect feel ACROSS clips (swing, bob,
      // lean, blend times) live in TUNING.animation, not here.
      "src/game/render/animation/clips.ts",
      "src/game/render/animation/rig.ts",
    ],
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
