"use client";

/**
 * /play — where the game mounts.
 *
 * The route is a shell. docs/ARCHITECTURE.md §6: "Next.js is a shell, not the
 * engine." Everything below the dynamic import is the render layer's problem.
 *
 * ## Why `ssr: false` is load-bearing
 *
 * `<Canvas>` constructs a `WebGLRenderer` on mount, which requires a real
 * `HTMLCanvasElement` and a GL context. Neither exists in Node. App Router
 * renders client components on the server by default, so without this the build
 * throws during static generation — and it throws at `next build`, not at
 * runtime, which is at least the good failure mode.
 *
 * `ssr: false` also keeps three.js out of the server bundle entirely, which is
 * most of why the first-load JS budget in TUNING.md §14 is achievable at all.
 */

import dynamic from "next/dynamic";
import { LoadingScreen } from "@/ui/screens/LoadingScreen";

const GameCanvas = dynamic(() => import("@/game/render/GameCanvas").then((mod) => mod.GameCanvas), {
  ssr: false,
  loading: () => <LoadingScreen detail="Loading renderer" />,
});

export default function PlayPage(): React.ReactElement {
  return (
    <main className="relative h-full w-full overflow-hidden">
      <GameCanvas />
    </main>
  );
}
