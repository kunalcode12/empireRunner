# `src/ui/hud/` — in-run overlay

## Belongs here

- Flow meter (0–100) and the Overdrive prompt that arms at 100
- Score, distance, Bits — all in the wide mono, all rolling like a mechanical counter
- Multiplier readout, shown to one decimal
- Shield pips, active-pickup timers
- Pause chip, and the Overdrive tap target on touch (≥ 56px, bottom-right, thumb-reachable)

## Does NOT belong here

- Anything read from the sim at 60Hz. Subscribe to the ≤ 15Hz derived-value push.
- Layout that reflows when a number's digit count changes. Use tabular figures and fixed-width
  slots, or the whole HUD will jitter every time the score crosses a power of ten.
- Elements in the corners the game needs for gesture input on touch.

## Reading at speed

The HUD is read peripherally at 34 u/s by someone who cannot look away. High contrast, few
elements, no animation that competes with the tunnel for attention. If a HUD element animates
during normal play, it had better mean something.
