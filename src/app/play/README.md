# `src/app/play/` — where the game mounts

## Belongs here

- `page.tsx` — mounts the game and nothing else:

```ts
const GameCanvas = dynamic(() => import("@/game/render/GameCanvas"), { ssr: false });
```

The `{ ssr: false }` is not optional. There is no server rendering of anything on a canvas.

## Does NOT belong here

- Gameplay logic of any kind. This route is a mount point.
- Server components that touch sim state. A run is fully client-authoritative until it is
  submitted, and then it is fully re-verified ([P12](../api/replay/README.md)).
- The HUD. That is DOM, from `src/ui/hud/`, composed alongside the canvas — not inside it.

Empty until P05. [docs/ARCHITECTURE.md §6](../../../docs/ARCHITECTURE.md).
