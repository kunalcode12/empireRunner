@AGENTS.md

# AXIS

A 3D endless runner. You run inside a four-face square tunnel — 3 lanes per face, 12 positions
total — and roll the world 90° to re-anchor gravity to an adjacent wall. Next.js 16 + React 19 +
react-three-fiber v9.

---

## RULES — apply to every response in this repo.

**CONTEXT**
- Before writing any code, read `docs/GAME_BIBLE.md`, `docs/TUNING.md`, and `PROGRESS.md`.
- Those files are the source of truth. If a prompt contradicts them, stop and ask which wins.

**HONESTY**
- Do not invent APIs. If unsure whether an export exists, grep `node_modules/` or the
  installed `.d.ts` before using it. If it does not exist, stop and tell me.
- Do not add, remove, or upgrade a dependency without asking first.
- If you cannot finish something, say so. Never ship a stub that looks finished.

**SCOPE**
- Only create or modify files inside the scope this prompt lists. If you need to touch
  anything outside it, list the files and wait for approval.
- Do not "improve" or refactor code from an earlier phase unless the prompt says to.

**QUALITY**
- TypeScript strict. No `any`, no `@ts-ignore`, no TODO comments, no commented-out code.
- Every gameplay number lives in `src/game/config/tuning.ts`. Zero magic numbers elsewhere.
- No placeholder asset paths that 404 at runtime. Generate procedural geometry instead.

**PROCESS**
- Plan first: print the file tree you intend to create/modify plus a 5-line summary per
  file. Wait for my "go" before writing code.
- After code: run the verify gate from the prompt, paste the real terminal output, and
  append a dated entry to `PROGRESS.md` — what shipped, what is deliberately deferred,
  known issues, what the next phase needs.

---

## Repo orientation

| Path | What lives there |
|---|---|
| `docs/GAME_BIBLE.md` | Design source of truth. Mechanics, entities, economy, themes, art direction. |
| `docs/TUNING.md` | Every tunable number with unit, default, valid range, and feel notes. |
| `docs/ARCHITECTURE.md` | Folder layout, the five architectural laws, dependency table. |
| `PROGRESS.md` | Phase table + dated build log. Read before starting, append after finishing. |
| `src/game/sim/` | Pure deterministic simulation. Imports nothing from react or three. |
| `src/game/config/` | `tuning.ts`, entity tables, theme registry. The only home for numbers. |
| `src/game/render/` | All r3f. Reads sim state, never writes it. |
| `src/game/input/` | keyboard / touch / gamepad → one normalised intent stream. |
| `src/game/audio/` `src/game/meta/` | Web Audio graph · economy, inventory, save, missions. |
| `src/app/` | Next.js routes and API. A shell, not the engine. |
| `src/ui/` | DOM UI, design tokens, screens. Never imports three. |

### The five laws (full text in `docs/ARCHITECTURE.md` §2)

1. **(a)** The sim is headless and deterministic: same seed + same input log = same result.
2. **(b)** The world translates toward a near-stationary player. Never move the player far from origin.
3. **(c)** Fixed 60Hz sim tick with an accumulator; render interpolates between the two most recent sim states.
4. **(d)** Zero heap allocation inside the tick. Everything pooled and pre-warmed.
5. **(e)** A physics engine is used **only** for cosmetic debris and ragdolls. The player controller and all gameplay collision are hand-rolled and deterministic.

Breaking one of these is a design change, not a refactor. Ask first.

### Three things that are easy to get wrong here

- **`@react-three/fiber` must be v9 and `@react-three/rapier` must be v2.** Those are the React 19 lines. v8 and v1 are React 18 and will not work.
- **The near-black + neon cyan/magenta cyberpunk grid look is banned.** See `docs/GAME_BIBLE.md` §11.3. It is banned as a placeholder too.
- **Never put per-frame sim state in zustand or React state.** It goes in `SimState`, plain objects, inside `sim/`.

---

## Commands

All wired as of P01:

```bash
npm run dev           # next dev (Turbopack)
npm run build         # next build
npm run start         # next start
npm run typecheck     # tsc --noEmit
npm run lint          # eslint .   — ALSO enforces the layering law
npm run lint:fix      # eslint . --fix
npm run test          # vitest run — tuning invariants, layering law; sim tests from P02
npm run test:watch    # vitest
npm run test:e2e      # playwright test — boot smoke; perf budgets from P05
npm run format        # prettier --write .
npm run format:check  # prettier --check .
npm run analyze       # next experimental-analyze (built in; no extra dependency)
```

Two things worth knowing:

- **`next build` does not run ESLint.** Next 16 dropped that. A green build says nothing about
  lint, and lint is where the layering law lives — so always run both.
- There is no separate `budgets` script. Perf budgets are assertions inside `test:e2e`
  (draw calls, bundle) and `test` (tick cost, allocation), landing at P05 and P02 respectively.
  `test:e2e` is deliberately **not** in CI yet — see PROGRESS.md P01.

## Verify gate

Every phase ends with one. Run the real commands, paste the real output. A gate that was
not run, or was run and failed, is a failed phase — say so.

If a gate fails, **stop.** Do not build the next phase on top of it. Use the Repair prompt (P15).
</content>
