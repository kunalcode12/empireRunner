# `src/ui/screens/` — full-screen DOM states

## Belongs here

- Main menu, loadout (1 avatar + 2 boosts), store, upgrades, missions
- **Death screen** — the most important screen in the game
- Settings, including the reduced-motion toggle and remappable controls

## Does NOT belong here

- Anything that needs to be present while the canvas is running. That is `hud/`.
- Business logic. Screens read from `game/meta/` via zustand; they do not compute cost curves.

## The death screen is a retention mechanism

It must always show the **closest unmet objective as a near-miss**:

```
    WEEKLY  ·  REACH 3,000m IN ONE RUN
    ████████████████████████░░░  2,960m

    YOU WERE 40m SHORT
```

That line does more for D2 retention than any reward in the game. It is a **required**
element, not decoration — [docs/GAME_BIBLE.md §9.4](../../../../docs/GAME_BIBLE.md).

It must also name *why* the run ended, and specifically distinguish "you had no Shards" from
"you had no Fractures left," so the player knows whether to buy or to improve.
