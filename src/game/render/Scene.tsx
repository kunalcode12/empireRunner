"use client";

/**
 * The in-canvas root.
 *
 * Owns the handle refs, assembles the rigs, and hosts the loop. It renders
 * **exactly once** — everything after mount is imperative mutation through the
 * handles, per docs/ARCHITECTURE.md §3.1.
 *
 * The rigs communicate with the loop through handle refs rather than props for
 * one reason: a prop carrying a per-frame value would mean a re-render per
 * frame. A ref that the loop writes into costs nothing and React never sees it.
 */

import { useCallback, useMemo, useRef } from "react";
import { TUNING } from "@/game/config/tuning";
import type { Sim } from "@/game/sim/sim";
import { CameraRig, type CameraRigHandle } from "./CameraRig";
import { EntityRenderer, type EntityRendererHandle } from "./EntityRenderer";
import { LightingRig, type LightingRigHandle } from "./LightingRig";
import { PlayerRig, type PlayerRigHandle } from "./PlayerRig";
import { Tunnel, type TunnelHandle } from "./Tunnel";
import { BACKGROUND_COLOR } from "./palette";
import { seedSim } from "./devSeed";
import { useGameLoop } from "./useGameLoop";
import { DrawCallGuard, PerfMonitor } from "./perf/PerfMonitor";
import type { EventListener } from "./events";

export interface SceneProps {
  seed: number;
  onEvent?: EventListener;
  paused?: boolean;
  /** Populate the tunnel with real authored chunks. Dev only; see devSeed.ts. */
  seedWorld?: boolean;
}

export function Scene({
  seed,
  onEvent,
  paused = false,
  seedWorld = true,
}: SceneProps): React.ReactElement {
  const tunnel = useRef<TunnelHandle | null>(null);
  const entities = useRef<EntityRendererHandle | null>(null);
  const player = useRef<PlayerRigHandle | null>(null);
  const camera = useRef<CameraRigHandle | null>(null);
  const lighting = useRef<LightingRigHandle | null>(null);

  const refs = useMemo(
    () => ({ tunnel, entities, player, camera, lighting }),
    [tunnel, entities, player, camera, lighting],
  );

  const seedFn = useCallback(
    (sim: Sim) => {
      if (seedWorld) {
        seedSim(sim);
      }
    },
    [seedWorld],
  );

  useGameLoop(refs, { seed, onEvent, paused, seedWorld: seedFn });

  return (
    <>
      {/* Background and fog, declared rather than assigned onto the scene.
          Kiln gunmetal, never black — GAME_BIBLE §11.3 bans a background darker
          than the active theme's darkest colour, placeholders included. P10
          swaps these per theme. */}
      <color attach="background" args={[BACKGROUND_COLOR]} />
      <fog attach="fog" args={[BACKGROUND_COLOR, TUNING.fog.kiln.near, TUNING.fog.kiln.far]} />

      <Tunnel handleRef={tunnel} />
      <EntityRenderer handleRef={entities} />
      <PlayerRig handleRef={player} />
      <CameraRig handleRef={camera} />
      <LightingRig handleRef={lighting} />
      <DrawCallGuard />
      <PerfMonitor />
    </>
  );
}
