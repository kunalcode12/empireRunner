"use client";

/**
 * The in-canvas root.
 *
 * Owns the handle refs, assembles the rigs, and hosts the loop. It renders
 * **exactly once per theme change** — everything between is imperative mutation
 * through the handles, per docs/ARCHITECTURE.md §3.1.
 *
 * The rigs communicate with the loop through handle refs rather than props for
 * one reason: a prop carrying a per-frame value would mean a re-render per
 * frame. A ref that the loop writes into costs nothing and React never sees it.
 *
 * ## Two prop fields, always
 *
 * One for the theme being left and one for the theme being entered. During a
 * transition both are mounted and their strengths cross; the rest of the time
 * the incoming one is at full and the outgoing one draws nothing, which costs
 * zero draw calls because an instanced mesh with `count = 0` is skipped.
 *
 * Mounting the incoming field only when a transition starts was the obvious
 * alternative and it is worse: building instanced meshes and compiling a shader
 * is exactly the work that must not happen during the four seconds the player is
 * watching a crossfade.
 *
 * ## Two modes, two component subtrees
 *
 * `title` and `play` are separate components rather than a flag inside one,
 * because `useGameLoop` is a hook and hooks cannot be called conditionally —
 * and, more importantly, because the title diorama must not construct a sim at
 * all. See `TitleDiorama.tsx`.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { TUNING } from "@/game/config/tuning";
import { DEFAULT_THEME, themeBySlug, type Theme } from "@/game/config/themes";
import { CameraRig, type CameraRigHandle } from "./CameraRig";
import { EntityRenderer, type EntityRendererHandle } from "./EntityRenderer";
import { LightingRig, type LightingRigHandle } from "./LightingRig";
import { RunnerRig, type RunnerRigHandle } from "./animation/RunnerRig";
import { ParticleSystem, type ParticleSystemHandle } from "./vfx/ParticleSystem";
import { SpeedLines, type SpeedLinesHandle } from "./feel/SpeedLines";
import { Tunnel, type TunnelHandle } from "./Tunnel";
import { PropField, type PropFieldHandle } from "./props/PropField";
import { useGameLoop } from "./useGameLoop";
import { DrawCallGuard, PerfMonitor } from "./perf/PerfMonitor";
import { TitleDiorama } from "./TitleDiorama";
import { assetTier } from "./theme/tier";
import { createThemeDirector, type ThemeDirector } from "./theme/ThemeDirector";
import { ensureLoaded, onLoadProgress, type ThemeAssets } from "./theme/loader";
import type { EventListener } from "./events";
import type { HudSink } from "./hud-sink";
import { NULL_THEME_SINK, type ThemeSink } from "./theme-sink";
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
  /** Theme slugs the player has unlocked. Static is the only locked one. */
  unlockedThemes?: readonly string[];
  /** `title` renders the attract diorama instead of a playable run. */
  mode?: "play" | "title";
  /** The DOM layer. Declared in `theme-sink.ts`; implemented in `src/ui/`. */
  themeSink?: ThemeSink;
  /**
   * Start in a named theme instead of Kiln, ignoring its unlock.
   *
   * The verify gate has to photograph all four themes in one session, and Static
   * is a 5,000m unlock at 34 u/s — roughly two and a half minutes of clean
   * running, per run, that no screenshot test can be asked to perform. So the
   * play route reads `?theme=` and passes it here.
   *
   * It is a render-layer override and nothing else: the sim's milestone
   * schedule, its RNG stream and its event ordering are untouched, so a seeded
   * replay is identical with and without it. Which is the same separation
   * `ThemeDirector`'s header describes for Static's unlock generally.
   */
  themeOverride?: string | null;
  /**
   * Where the finished replay is left for the submit path.
   *
   * Written immediately before the run-end callback fires, so the handler can
   * read it synchronously and post it to `/api/run/submit`.
   */
  replayRef?: React.MutableRefObject<Uint8Array | null>;
}

export function Scene(props: SceneProps): React.ReactElement {
  const { mode = "play" } = props;

  return (
    <>
      <DrawCallGuard />
      <PerfMonitor />
      {/* Outside the mode switch on purpose — see the component. */}
      <ThemePreload themeSink={props.themeSink} themeOverride={props.themeOverride} />
      {mode === "title" ? <TitleDiorama /> : <PlayScene {...props} />}
    </>
  );
}

/**
 * Streams the first theme while the player is still on the menu.
 *
 * ## Why this is outside the mode switch
 *
 * The brief: "First theme blocks the first run, the rest stream in the
 * background." Both halves of that need the load to have *started* before the
 * player presses RUN, and the theme director lives inside `PlayScene`, which
 * only exists once they have. So the first theme was being fetched at the moment
 * it was needed, which is the one moment it must not be — the player would watch
 * an unfurnished tunnel for the first second of every first run.
 *
 * Mounted here, the fetch begins with the title diorama and has the whole menu
 * to finish in. It is 3.5KB gzipped, so in practice it is resident long before
 * anyone reaches the button.
 *
 * ## `done` is the FIRST theme being resident, not "nothing is pending"
 *
 * The obvious readiness signal — an empty pending list — is true before any load
 * starts, so it reported ready instantly and blocked nothing at all. Readiness
 * is taken from the load promise instead, which is also the only version that
 * survives a missing manifest: `ensureLoaded` resolves with an empty asset set
 * rather than rejecting, so a theme whose props fail to download is a theme
 * without props, never a run that cannot begin.
 */
function ThemePreload({
  themeSink = NULL_THEME_SINK,
  themeOverride = null,
}: Pick<SceneProps, "themeSink" | "themeOverride">): null {
  useEffect(() => {
    const tier = assetTier();
    const boot = (themeOverride === null ? null : themeBySlug(themeOverride)) ?? DEFAULT_THEME;
    let cancelled = false;

    // Byte-accurate, straight from `GLTFLoader`'s progress events against the
    // manifest's exact figures. Nothing here advances on a clock.
    const unsubscribe = onLoadProgress((progress) => {
      if (!cancelled) {
        themeSink.setLoadProgress(progress.fraction, false);
      }
    });

    void ensureLoaded(boot.slug, tier).then(() => {
      if (!cancelled) {
        themeSink.setLoadProgress(1, true);
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [themeSink, themeOverride]);

  return null;
}

function PlayScene({
  seed,
  onEvent,
  paused = false,
  hud,
  onRunEnd,
  startingShards,
  unlockedThemes,
  themeSink = NULL_THEME_SINK,
  themeOverride = null,
  replayRef,
}: SceneProps): React.ReactElement {
  const tunnel = useRef<TunnelHandle | null>(null);
  const entities = useRef<EntityRendererHandle | null>(null);
  const player = useRef<RunnerRigHandle | null>(null);
  const camera = useRef<CameraRigHandle | null>(null);
  const lighting = useRef<LightingRigHandle | null>(null);
  const particles = useRef<ParticleSystemHandle | null>(null);
  const speedLines = useRef<SpeedLinesHandle | null>(null);
  const propsOut = useRef<PropFieldHandle | null>(null);
  const propsIn = useRef<PropFieldHandle | null>(null);

  /**
   * Fog and background are constructed once and MUTATED by the director.
   *
   * Declaring them as JSX `<fog args={...}>` would rebuild the object whenever
   * the theme changed, and the director writes to them every frame — so they are
   * plain objects attached to the scene and never re-created.
   */
  const fog = useMemo(
    () => new THREE.Fog(DEFAULT_THEME.fog.color, DEFAULT_THEME.fog.near, DEFAULT_THEME.fog.far),
    [],
  );
  const background = useMemo(() => new THREE.Color(DEFAULT_THEME.fog.color), []);

  /**
   * The two themes the scene currently has geometry for.
   *
   * React state, deliberately: a theme change is a structural change — different
   * materials, different prop meshes — and it happens at most a handful of times
   * a run. That is exactly what state is for, and it is why the render-budget
   * test measures renders *during a run* rather than across a transition.
   */
  const [stage, setStage] = useState<{
    current: Theme;
    incoming: Theme;
    currentAssets: ThemeAssets | null;
    incomingAssets: ThemeAssets | null;
  }>({
    current: DEFAULT_THEME,
    incoming: DEFAULT_THEME,
    currentAssets: null,
    incomingAssets: null,
  });

  const directorRef = useRef<ThemeDirector | null>(null);

  useEffect(() => {
    const director = createThemeDirector({
      tier: assetTier(),
      unlocked: unlockedThemes ?? [],
      startSlug: themeOverride,
      listener: {
        onThemeChanged: (theme) => {
          // Promotion happens inside the director; this only mirrors it into
          // React so the JSX below mounts the right prop meshes.
          const live = directorRef.current;
          if (live !== null) {
            setStage({
              current: live.current,
              incoming: live.incoming,
              currentAssets: live.currentAssets,
              incomingAssets: live.incomingAssets,
            });
          }
          themeSink.setTheme(theme.slug);
        },
        onTitleCard: (theme) => {
          themeSink.setTitleCard(theme?.slug ?? null);
        },
        onMusicSwap: (theme) => {
          themeSink.swapStems(theme.stemSet);
        },
      },
    });
    directorRef.current = director;
    return () => {
      director.dispose();
      directorRef.current = null;
    };
  }, [unlockedThemes, themeSink, themeOverride]);

  /**
   * Assets arrive asynchronously, so the stage is re-synced when they land.
   *
   * Polled rather than pushed because the loader resolves per bundle and the
   * director owns which slot a bundle belongs to. A 250ms poll costs nothing
   * outside a transition and cannot fire during the render-budget window, which
   * a promise callback landing mid-run could.
   */
  useEffect(() => {
    const POLL_MS = 250;
    const timer = setInterval(() => {
      const live = directorRef.current;
      if (live === null) {
        return;
      }
      setStage((previous) =>
        previous.current === live.current &&
        previous.incoming === live.incoming &&
        previous.currentAssets === live.currentAssets &&
        previous.incomingAssets === live.incomingAssets
          ? previous
          : {
              current: live.current,
              incoming: live.incoming,
              currentAssets: live.currentAssets,
              incomingAssets: live.incomingAssets,
            },
      );
    }, POLL_MS);
    return () => clearInterval(timer);
  }, []);

  const refs = useMemo(
    () => ({
      tunnel,
      entities,
      player,
      camera,
      lighting,
      particles,
      speedLines,
      propsOut,
      propsIn,
    }),
    [],
  );

  useGameLoop(refs, {
    seed,
    onEvent,
    paused,
    hud,
    onRunEnd,
    startingShards,
    director: directorRef,
    fog,
    background,
    replayRef,
  });

  return (
    <>
      {/* Attached rather than declared, so the director can write to them every
          frame without React rebuilding either. §11.3: the background is never
          darker than the theme's darkest colour, and it tracks the fog so the
          tunnel has no visible end. */}
      <primitive object={fog} attach="fog" />
      <primitive object={background} attach="background" />

      <Tunnel handleRef={tunnel} theme={stage.current} />

      {/* The theme being left. Draws nothing outside a transition. */}
      <PropField
        key={`out-${stage.current.slug}`}
        theme={stage.current}
        assets={stage.currentAssets}
        handleRef={propsOut}
      />
      {/* The theme being entered — the same field outside a transition. */}
      <PropField
        key={`in-${stage.incoming.slug}`}
        theme={stage.incoming}
        assets={stage.incomingAssets ?? stage.currentAssets}
        handleRef={propsIn}
      />

      <EntityRenderer handleRef={entities} />
      <RunnerRig handleRef={player} />
      <CameraRig handleRef={camera} />
      <LightingRig handleRef={lighting} theme={stage.current} />
      <ParticleSystem handleRef={particles} />
      <SpeedLines handleRef={speedLines} />
    </>
  );
}

/** Draw calls the static scene costs before props. Diagnostic. */
export const SCENE_BASE_DRAW_CALLS = TUNING.geometry.faceCount;
