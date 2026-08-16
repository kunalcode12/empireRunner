"use client";

/**
 * The canvas. One client component, mounted only through
 * `dynamic(..., { ssr: false })` — see `src/app/play/page.tsx`.
 *
 * ## Why ssr:false is mandatory and not a convenience
 *
 * `<Canvas>` creates a `WebGLRenderer` on mount, which needs a real
 * `HTMLCanvasElement` and a GL context. Neither exists in Node, so a server
 * render throws. Next's App Router renders client components on the server by
 * default; `ssr: false` is what opts this subtree out.
 *
 * ## dpr
 *
 * `[1, min(devicePixelRatio, pixelRatioCap)]` gives r3f a range rather than a
 * fixed value, so it can drop resolution under load. The cap is 2 and it is
 * LOCKED: above 2 the fragment cost on high-DPI phones destroys the frame budget
 * for no visible gain at a flat-colour art direction (TUNING.md §13).
 *
 * ## Colour space, stated explicitly
 *
 * Three's default has changed across versions and getting it wrong produces
 * washed-out or over-saturated flat colours — which is fatal for an art
 * direction built entirely on exact flat colour fields. Pinning it here means
 * the palette hexes in `palette.ts` are the colours that actually appear.
 */

import { Suspense, useMemo } from "react";
import { Canvas } from "@react-three/fiber";
import * as THREE from "three";
import { TUNING } from "@/game/config/tuning";
import { Scene } from "./Scene";
import { getQuality } from "./perf/quality";
import type { EventListener } from "./events";
import { LoadingScreen } from "@/ui/screens/LoadingScreen";

export interface GameCanvasProps {
  seed?: number;
  onEvent?: EventListener;
  paused?: boolean;
  seedWorld?: boolean;
}

const DEFAULT_SEED = 1;

export function GameCanvas({
  seed = DEFAULT_SEED,
  onEvent,
  paused,
  seedWorld,
}: GameCanvasProps): React.ReactElement {
  const quality = getQuality();

  // Resolved once. Reading `devicePixelRatio` during render is fine here because
  // this component renders once and never again.
  const dpr = useMemo<[number, number]>(() => {
    const device = typeof window === "undefined" ? 1 : window.devicePixelRatio;
    return [1, Math.min(device, quality.pixelRatioCap)];
  }, [quality.pixelRatioCap]);

  return (
    <div className="absolute inset-0" style={{ background: "var(--axis-bg)" }}>
      <Suspense fallback={<LoadingScreen />}>
        <Canvas
          dpr={dpr}
          frameloop="always"
          shadows={quality.shadows}
          gl={{
            antialias: quality.tier !== "LOW",
            powerPreference: "high-performance",
            // The scene always paints a full-screen background, so there is
            // nothing behind the canvas to composite against.
            alpha: false,
            stencil: false,
            depth: true,
          }}
          camera={{
            fov: TUNING.camera.cameraFov,
            near: 0.1,
            far: TUNING.fog.bazaar.far * 2,
            position: [0, TUNING.camera.cameraHeight, TUNING.camera.cameraDistance],
          }}
          onCreated={({ gl }) => {
            gl.outputColorSpace = THREE.SRGBColorSpace;
            gl.toneMapping = THREE.NoToneMapping;
            if (quality.shadows) {
              gl.shadowMap.enabled = true;
              // Hard-edged shadow, per GAME_BIBLE §11.1: "a single flat darker
              // colour from the palette, with a hard edge. Not a blur."
              gl.shadowMap.type = THREE.PCFShadowMap;
            }
          }}
        >
          <Scene seed={seed} onEvent={onEvent} paused={paused} seedWorld={seedWorld} />
        </Canvas>
      </Suspense>
    </div>
  );
}

export default GameCanvas;
