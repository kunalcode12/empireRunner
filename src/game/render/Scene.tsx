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
 *
 * ## Two modes, two component subtrees
 *
 * `title` and `play` are separate components rather than a flag inside one,
 * because `useGameLoop` is a hook and hooks cannot be called conditionally —
 * and, more importantly, because the title diorama must not construct a sim at
 * all. See `TitleDiorama.tsx`.
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
import { TitleDiorama } from "./TitleDiorama";
import type { EventListener } from "./events";
import type { HudSink } from "./hud-sink";
import type { RunSummary } from "@/game/meta";

export interface SceneProps {
  seed: number;
  onEvent?: EventListener;
  paused?: boolean;
  /** The HUD. Declared in `hud-sink.ts`; implemented in `src/ui/`. */
  hud?: HudSink;
  /** Fired once when the run ends. The sim -> meta handoff. */
  onRunEnd?: (summary: RunSummary) => void;
  /** Shards the player brought in. GAME_BIBLE §12 cause 6. */
  startingShards?: number;
  /** `title` renders the attract diorama instead of a playable run. */
  mode?: "play" | "title";
}

export function Scene({
  seed,
  onEvent,
  paused = false,
  hud,
  onRunEnd,
  startingShards,
  mode = "play",
}: SceneProps): React.ReactElement {
  return (
    <>
      {/* Background and fog, declared rather than assigned onto the scene.
          Key-line black, which is the darkest colour in every theme's palette
          and therefore exactly at the §11.3 limit rather than below it. P10
          swaps the fog distances per theme. */}
      <color attach="background" args={[BACKGROUND_COLOR]} />
      <fog attach="fog" args={[BACKGROUND_COLOR, TUNING.fog.kiln.near, TUNING.fog.kiln.far]} />

      {mode === "title" ? (
        <TitleDiorama />
      ) : (
        <PlayScene
          seed={seed}
          onEvent={onEvent}
          paused={paused}
          hud={hud}
          onRunEnd={onRunEnd}
          startingShards={startingShards}
        />
      )}

      <DrawCallGuard />
      <PerfMonitor />
    </>
  );
}

function PlayScene({
  seed,
  onEvent,
  paused,
  hud,
  onRunEnd,
  startingShards,
}: Omit<SceneProps, "mode"> & { paused: boolean }): React.ReactElement {
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

  useGameLoop(refs, { seed, onEvent, paused, hud, onRunEnd, startingShards });

  return (
    <>
      <Tunnel handleRef={tunnel} />
      <EntityRenderer handleRef={entities} />
      <RunnerRig handleRef={player} />
      <CameraRig handleRef={camera} />
      <LightingRig handleRef={lighting} />
      <ParticleSystem handleRef={particles} />
      <SpeedLines handleRef={speedLines} />
    </>
  );
}
