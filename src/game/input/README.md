# `src/game/input/` — three devices, one intent stream

Every device normalises to the same thing: a stream of `{ verb, tickIssued }`. The sim never
sees a key, a touch, or a button. That is what makes replays device-agnostic and P12's
server-side validation possible.

## Belongs here

- `keyboard.ts`, `touch.ts`, `gamepad.ts` — device adapters
- `intent.ts` — normalisation, the input buffer, coyote time, and the intent queue

## Does NOT belong here

- Calls into the sim. This layer **produces** intents; the sim pulls the queue at tick
  boundaries. Pushing into the sim breaks the fixed-timestep contract.
- Gameplay decisions about whether a verb is *legal* — that is `sim/player.ts`. This layer only
  decides that a verb was *requested*.
- `drei`'s `KeyboardControls`. Deliberately unused: this folder owns the buffer and coyote
  windows, and they have to apply identically across all three devices.

## The eight verbs

`LANE_LEFT` · `LANE_RIGHT` · `JUMP` · `SLIDE` · `ROLL_LEFT` · `ROLL_RIGHT` · `OVERDRIVE` ·
`PAUSE`. There are no others. A seventh movement verb needs a design review, not a keybind.
Mappings for all three devices: [docs/GAME_BIBLE.md §6](../../../../docs/GAME_BIBLE.md).

## Two forgiveness systems, applied equally to every device

- **`inputBuffer` 0.15s** — a verb issued early is held and fired the instant it becomes legal
- **`coyoteTime` 0.10s** — `JUMP` stays legal briefly after leaving a ledge

**The one exception:** input arriving during `rollCommitLock` is **dropped, not buffered**.
That is deliberate — it is the risk that stops the roll being a free escape button.

## The riskiest thing in this folder

Roll on touch is a **two-finger horizontal swipe**, and `twoFingerTolerance` (80ms) decides
whether two fingers landing slightly apart read as a roll or as a lane change. Playtest it on
real hardware first — [docs/GAME_BIBLE.md §6.2](../../../../docs/GAME_BIBLE.md).
