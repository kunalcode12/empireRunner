# `src/ui/` — the DOM half of the game

Shipped at **P14**. Design tokens, the run HUD, nine screens, the transition, and the
accessibility layer. No `three`, no `@react-three/*`, ever — enforced by
`eslint.config.mjs`, because a canvas-rendered HUD costs draw calls the budget in
[TUNING.md](../../docs/TUNING.md) §14 does not have.

## Files

| Path | What lives there |
|---|---|
| `tokens.css` | Colour roles, type scale, spacing, motion, layers, safe areas |
| `styles.css` | Every component's rules. **No hex values below `tokens.css`.** |
| `theme.ts` | Writes the active theme's roles onto `<html>` on `ThemeChange` |
| `fonts.ts` · `fonts/` | Anton, Martian Mono, Archivo — self-hosted woff2 + OFL |
| `motion.ts` | The motion scale, in whole 60Hz sim ticks, plus the sim's easings |
| `hud/` | THE AXIS RING, the odometers, the Fracture ring, the Flow popups |
| `screens/` | Title, death, shop, loadout, runners, missions, settings, leaderboard, pause |
| `transition/` | The screen-print shutter, its clock, and the screen stack |
| `components/` | Plate, Button, Meter, TierPips, StepSlider, Glyph, Halftone |
| `a11y/` | Focus trap, roving tabindex, gamepad navigation, colourblind mode |
| `state/` | zustand: meta state (run boundaries) and UI state (screens, settings) |
| `CommitCounter.tsx` | The render counter the "zero re-renders" budget is measured with |

## THE AXIS RING

The Flow meter is a **square**, and that is the signature of this interface.

Every other game's meter is a circle, and a circle says nothing about *this* game. AXIS is a
four-face square prism ([GAME_BIBLE.md](../../docs/GAME_BIBLE.md) §3.1), so the meter has four
sides, one per face — the HUD is a diagram of the level rather than a widget over it. It reads
better in peripheral vision than an arc for a mechanical reason: 25/50/75/100% land exactly on
the corners, and "the ink turned the corner" is a discrete event the periphery can catch, while
an arc's fill is a continuous quantity it cannot read at all.

The side representing the face currently under the player's feet is drawn at double key-line
weight, so the element carries **two facts in one shape**.

## Three rules that keep this honest

- **The HUD renders once and never again.** Every value change during a run is a
  `setAttribute` or a `style.transform` on a node created at mount. There is no `useState` in
  `hud/` and there must never be one. `tests/e2e/ui.spec.ts` counts renders across a live run
  and asserts **zero**, using a checkpoint the app marks at the exact instant the run ends.
- **No hex value appears outside `tokens.css` and `config/themes.ts`.** Every surface, rule,
  glyph and label resolves to an `--axis-*` role, and `tests/ui/contrast.test.ts` recomputes
  every text pair from the registry. A hex typed into a component is invisible to that test.
- **`ui/` and `render/` never name each other.** The HUD is driven through an output port
  declared in `render/hud-sink.ts` and implemented structurally here; `app/play/page.tsx` is
  the one place they meet, and the one place the compiler checks they agree.

## Banned in this folder

`backdrop-filter`, blurred `box-shadow`, `opacity` transitions, `border-radius` on a plate, and
any gradient without hard stops. These are §11.1's "no soft gradients" and "deep shadow with a
hard edge" wearing DOM clothing, and `tests/ui/tokens.test.ts` greps for every one of them.

Full art direction: [GAME_BIBLE.md](../../docs/GAME_BIBLE.md) §11. Numbers:
[TUNING.md](../../docs/TUNING.md) §18.
