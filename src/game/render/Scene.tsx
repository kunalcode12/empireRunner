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

import { useMemo, useRef } from "react";
import { TUNING } from "@/game/config/tuning";
import { CameraRig, type CameraRigHandle } from "./CameraRig";
import { EntityRenderer, type EntityRendererHandle } from "./EntityRenderer";
import { LightingRig, type LightingRigHandle } from "./LightingRig";
import { RunnerRig, type RunnerRigHandle } from "./animation/RunnerRig";
import { ParticleSystem, type ParticleSystemHandle } from "./vfx/ParticleSystem";
import { SpeedLines, type SpeedLinesHandle } from "./feel/SpeedLines";
import { Tunnel, type TunnelHandle } from "./Tunnel";
import { BACKGROUND_COLOR } from "./palette";
import { useGameLoop } from "./useGameLoop";
import { DrawCallGuard, PerfMonitor } from "./perf/PerfMonitor";
import type { EventListener } from "./events";

export interface SceneProps {
  seed: number;
  onEvent?: EventListener;
  paused?: boolean;
}

export function Scene({ seed, onEvent, paused = false }: SceneProps): React.ReactElement {
  const tunnel = useRef<TunnelHandle | null>(null);
  const entities = useRef<EntityRendererHandle | null>(null);
  const player = useRef<RunnerRigHandle | null>(null);
  const camera = useRef<CameraRigHandle | null>(null);
  const lighting = useRef<LightingRigHandle | null>(null);
  const particles = useRef<ParticleSystemHandle | null>(null);
  const speedLines = useRef<SpeedLinesHandle | null>(null);

  const refs = useMemo(
    () => ({ tunnel, entities, player, camera, lighting, particles, speedLines }),
    [tunnel, entities, player, camera, lighting, particles, speedLines],
  );

  useGameLoop(refs, { seed, onEvent, paused });

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
      <RunnerRig handleRef={player} />
      <CameraRig handleRef={camera} />
      <LightingRig handleRef={lighting} />
      <ParticleSystem handleRef={particles} />
      <SpeedLines handleRef={speedLines} />
      <DrawCallGuard />
      <PerfMonitor />
    </>
  );
}
