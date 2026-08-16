# `src/ui/components/` — shared DOM primitives

## Belongs here

- `RollingNumber` — the mechanical counter. Digits translate vertically like an odometer.
  **Every numeral in the game goes through this**, so the behaviour is consistent everywhere.
- Buttons, meters, progress bars, modals, toggles
- The halftone/key-line CSS treatments shared across screens

## Does NOT belong here

- Screen-specific one-offs. Those live next to their screen.
- Anything importing `three` or `@react-three/*`.
- Colour literals. Use the tokens in `../tokens.css`.

## House style

Heavy black key-lines, flat fills, hard-edged shadow, no soft gradients. A component that
needs a gradient to look right is the wrong component — posterise it into 3–4 hard steps.

Numbers never fade in and never ease. They roll.
