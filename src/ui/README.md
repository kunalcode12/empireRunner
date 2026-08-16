# `src/ui/` — DOM only

**Never imports `three` or `@react-three/*`.** Enforced by `eslint.config.mjs`.

The HUD is DOM because a canvas-rendered HUD costs draw calls the budget in
[docs/TUNING.md §14](../../../docs/TUNING.md) does not have.

## Belongs here

- `tokens.css` — design tokens: palettes, type scale, spacing
- `hud/` — Flow meter, score, distance, Overdrive prompt
- `screens/` — menu, loadout, store, missions, death screen
- `components/` — buttons, rolling numerals, meters

## Does NOT belong here

- `three`, `@react-three/*`, `postprocessing`, `r3f-perf`, or anything from `game/render/`
- Per-frame state. HUD values are pushed from the render loop at **≤ 15Hz** — the eye cannot
  read a number changing at 60Hz, and pushing at 60Hz re-renders the whole HUD tree 60 times a
  second for nothing.
- Hard-coded colours. Everything comes from `tokens.css`, never from Tailwind's default
  palette — that palette is not the theme palette.

## Type rules

| Role | Face |
|---|---|
| Display | Heavy condensed grotesque |
| **Every numeral in the game** | Wide monospace |
| Body | Clean sans |

Numbers **roll like a mechanical counter** — digits translate vertically, the way an odometer
moves. They never fade in, never scale-pop, never count up with an easing tween.

## The ban

Near-black + neon cyan/magenta + glowing perspective grid is banned here too — menus, HUD,
death screen, store, loading state, favicon. [GAME_BIBLE §11.3](../../../docs/GAME_BIBLE.md).
