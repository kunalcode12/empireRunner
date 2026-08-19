"use client";

/**
 * /play — the whole game.
 *
 * ## This file is the seam, and it is the only one
 *
 * `src/ui/` may not import `@/game/render` and render may not import ui —
 * dependencies point one way (docs/ARCHITECTURE.md §3). `app` sits above both,
 * so this is where the HUD controller built by `src/ui/hud/Hud.tsx` is handed to
 * `GameCanvas` as a `HudSink`. That single assignment is where TypeScript checks
 * the two structurally-typed halves actually agree; there is no shared enum to
 * drift, which is the failure mode that produced the `ThemeChange` bug at P11 and
 * the pickup-kind bug at P13.
 *
 * ## Why `ssr: false` is load-bearing
 *
 * `<Canvas>` constructs a `WebGLRenderer` on mount, which requires a real
 * `HTMLCanvasElement` and a GL context. Neither exists in Node. App Router
 * renders client components on the server by default, so without this the build
 * throws during static generation. It also keeps three.js out of the server
 * bundle, which is most of why the 250KB first-load budget is reachable.
 *
 * ## The canvas mounts once and stays mounted
 *
 * It is deliberately **not** keyed on the run. `useGameLoop`'s engine effect
 * already depends on `seed`, so a new run rebuilds the sim through the effect
 * that owns it — which is the clean path — while the WebGL context, the geometry
 * and the pools survive.
 *
 * The first version keyed it on `runId` and unmounted it whenever a menu was
 * open. That was wrong three ways: it threw away and rebuilt a WebGL context on
 * every retry and every visit to the shop, it re-warmed every pool, and it tore
 * down the audio graph mid-handover — so the music died the instant you pressed
 * RUN and never came back, because the new context's gesture listeners were
 * armed *after* the click that would have unlocked them.
 *
 * The title diorama and the playable scene swap inside the same canvas via
 * `mode`. Menu screens are opaque, so the canvas behind them is invisible; it
 * costs a handful of draw calls to leave running and saves a context rebuild
 * every time the player opens a menu.
 */

import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";
import type { RunSummary } from "@/game/meta";
import { LoadingScreen } from "@/ui/screens/LoadingScreen";
import { Halftone } from "@/ui/components/Halftone";
import { CommitCounter, countRender, markRenderCheckpoint } from "@/ui/CommitCounter";
import { resetTheme } from "@/ui/theme";
import { Hud, type HudController } from "@/ui/hud/Hud";
import { Router } from "@/ui/transition/Router";
import { TitleScreen } from "@/ui/screens/TitleScreen";
import { DeathScreen } from "@/ui/screens/DeathScreen";
import { PauseScreen } from "@/ui/screens/PauseScreen";
import { ShopScreen } from "@/ui/screens/ShopScreen";
import { InventoryScreen } from "@/ui/screens/InventoryScreen";
import { AvatarScreen } from "@/ui/screens/AvatarScreen";
import { MissionsScreen } from "@/ui/screens/MissionsScreen";
import { SettingsScreen } from "@/ui/screens/SettingsScreen";
import { LeaderboardScreen } from "@/ui/screens/LeaderboardScreen";
import { Screen, applyStoredSettings, useUiStore, type ScreenName } from "@/ui/state/uiStore";
import { useMetaStore } from "@/ui/state/metaStore";

const GameCanvas = dynamic(() => import("@/game/render/GameCanvas").then((mod) => mod.GameCanvas), {
  ssr: false,
  loading: () => <LoadingScreen detail="Loading renderer" />,
});

export default function PlayPage(): React.ReactElement {
  countRender("PlayPage");

  const screen = useUiStore((state) => state.screen);
  const seed = useUiStore((state) => state.seed);
  const go = useUiStore((state) => state.go);

  const hydrate = useMetaStore((state) => state.hydrate);
  const ready = useMetaStore((state) => state.ready);
  const shards = useMetaStore((state) => state.balances.shards);

  const [summary, setSummary] = useState<RunSummary | null>(null);

  // The controller the HUD hands back.
  //
  // State, not a ref, and deliberately so: it has to be READ during render to be
  // passed down as a prop, and reading a ref during render is both a
  // `react-hooks/refs` error and genuinely wrong under concurrent rendering. It
  // arrives exactly once, at mount, before any run has started — so the cost is
  // one extra render on a screen where nothing is moving.
  const [hud, setHud] = useState<HudController | null>(null);
  const onHudReady = useCallback((controller: HudController | null) => {
    setHud(controller);
  }, []);

  useEffect(() => {
    hydrate();
    applyStoredSettings();
    // Writes the boot theme's role tokens and its `data-*` flags onto the root.
    // Without it the flags are absent until a run crosses a theme milestone, and
    // anything keyed off them falls back for the whole first session.
    resetTheme();
  }, [hydrate]);

  // Auto-pause on blur. GAME_BIBLE §12: "Tab blur / window unfocus — the run
  // auto-pauses", and it is explicitly listed as NOT a failure state.
  const running = screen === Screen.Run;
  useEffect(() => {
    if (!running) {
      return;
    }
    function onHidden(): void {
      if (document.visibilityState === "hidden") {
        useUiStore.getState().go(Screen.Pause);
      }
    }
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("blur", onHidden);
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("blur", onHidden);
    };
  }, [running]);

  // Pause with Escape or P while running, matching GAME_BIBLE §6.1.
  useEffect(() => {
    if (!running) {
      return;
    }
    function onKey(event: KeyboardEvent): void {
      if (event.key === "Escape" || event.key.toLowerCase() === "p") {
        event.preventDefault();
        useUiStore.getState().go(Screen.Pause);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [running]);

  // The summary is set here and only here, immediately before navigating to the
  // death screen — so it is always the run that just ended.
  //
  // An earlier version also cleared it in an effect when a run started, which
  // was both a cascading setState and unnecessary: the death screen is only ever
  // reached through this callback, so there is no path on which it could read a
  // stale summary.
  const onRunEnd = useCallback(
    (finished: RunSummary) => {
      // The last instant that is unambiguously "during a run". Everything after
      // this line — the summary, the screen change, the shutter, the five death
      // beats — is legitimate React work, and the render budget must not count
      // it. See `CommitCounter.tsx` for why the test cannot find this moment on
      // its own.
      markRenderCheckpoint("run-end");
      setSummary(finished);
      go(Screen.Death);
    },
    [go],
  );

  const paused = screen !== Screen.Run;
  const isTitle = screen === Screen.Title;

  function renderScreen(current: ScreenName): React.ReactNode {
    switch (current) {
      case Screen.Title:
        return <TitleScreen />;
      case Screen.Death:
        return <DeathScreen summary={summary} />;
      case Screen.Pause:
        return (
          <PauseScreen
            onResume={() => go(Screen.Run)}
            onQuit={() => {
              // Quitting settles the run exactly as a crash would, so nothing
              // earned is thrown away — the pause screen says so.
              hud?.setPaused(false);
              go(Screen.Title);
            }}
          />
        );
      case Screen.Shop:
        return <ShopScreen />;
      case Screen.Inventory:
        return <InventoryScreen />;
      case Screen.Avatars:
        return <AvatarScreen />;
      case Screen.Missions:
        return <MissionsScreen />;
      case Screen.Settings:
        return <SettingsScreen />;
      case Screen.Leaderboard:
        return <LeaderboardScreen />;
      default:
        return null;
    }
  }

  return (
    <main className="relative h-full w-full overflow-hidden">
      {/* Everything the run touches sits inside the profiler, including the
          canvas host and the HUD. A measurement that excluded the HUD would be
          measuring the wrong thing — it is the piece with a value changing 60
          times a second, and the whole reason it is built imperatively. */}
      <CommitCounter>
        {/* Always mounted. See the header for what unmounting it cost. */}
        <GameCanvas
          seed={seed}
          mode={isTitle ? "title" : "play"}
          paused={paused}
          startingShards={shards}
          // The seam. `HudController` and `HudSink` are structurally identical
          // and this line is where the compiler proves it.
          hud={hud ?? undefined}
          onRunEnd={onRunEnd}
        />

        {/* Mounted for the whole session, hidden outside a run, so no counter is
            rebuilt on resume and the odometer never restarts from zero. */}
        <Hud
          onReady={onHudReady}
          hidden={!running && screen !== Screen.Pause}
          onPause={() => go(Screen.Pause)}
          onOverdrive={() => {
            // Touch Overdrive — GAME_BIBLE §6.2 wants a tap on the Flow meter.
            // The keyboard and gamepad bindings go through `game/input`; this
            // synthesises the same key so there is one path into the verb.
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift" }));
            window.setTimeout(() => {
              window.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift" }));
            }, 0);
          }}
        />

        <Router render={renderScreen} />
      </CommitCounter>

      <Halftone />

      {!ready && <LoadingScreen detail="Reading your save" />}
    </main>
  );
}
