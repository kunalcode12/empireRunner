"use client";

/**
 * The frame driver. This is the seam between the fixed-rate sim and the
 * variable-rate display, and it is the piece the whole render layer depends on
 * being right.
 *
 * ```
 *   useFrame(delta):
 *     intent  = input.poll()
 *     ticks   = advance(clock, delta)        // accumulator, spiral guard
 *     repeat ticks: sim.tick(intent)
 *     view    = interpolate(previous, current, clock.alpha)
 *     write view into Object3D transforms
 *     drain the event ring
 * ```
 *
 * ## Zero React re-renders per frame — the hard rule
 *
 * Nothing on this path calls a `useState` setter. Not for score, not for Flow,
 * not for FPS. React reconciliation at 144Hz is roughly two orders of magnitude
 * too slow for a 6.9ms frame budget (docs/ARCHITECTURE.md §3.1), and a single
 * stray `setX` in `useFrame` re-renders the subtree every frame and quietly
 * destroys the frame time for the rest of the project.
 *
 * So everything the loop touches is a ref or an `Object3D` mutated in place. The
 * HUD gets its values at P14 by pushing into zustand at **<= 15Hz**, which is a
 * different mechanism on purpose — the eye cannot read a number changing faster
 * than that anyway.
 *
 * ## Why the intent is polled here and not in an effect
 *
 * Input has to be sampled once per frame, immediately before the ticks it feeds,
 * or it is a frame stale. Sampling it in a React effect would tie input latency
 * to the render schedule and make it inconsistent between frame rates.
 *
 * ## One intent for N ticks, and why that is correct
 *
 * When a frame produces three ticks, all three get the same intent. That is the
 * honest reading: the player held one input across that whole wall-clock
 * interval, and the sim has no finer-grained information about when within it
 * anything changed. It also matches what the replay records — one intent byte
 * per tick, written from this same value — so a server re-simulation reproduces
 * it exactly.
 */

import { useEffect, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { advance, createClock, resync, type Clock } from "@/game/sim/clock";
import { createSim, type Sim } from "@/game/sim/sim";
import { IDLE_INTENT, type Intent } from "@/game/sim/intent";
import {
  createGamepadSource,
  createInputManager,
  createKeyboardSource,
  createTouchSource,
  type InputManager,
} from "@/game/input";
import { createEventDrain, type EventDrain, type EventListener } from "./events";
import {
  animationForPhase,
  createRenderView,
  faceLocalToWorld,
  readInterpolated,
} from "./interpolate";
import { TUNING } from "@/game/config/tuning";
import type { TunnelHandle } from "./Tunnel";
import type { EntityRendererHandle } from "./EntityRenderer";
import type { RunnerRigHandle } from "./animation/RunnerRig";
import type { CameraRigHandle } from "./CameraRig";
import type { LightingRigHandle } from "./LightingRig";
import type { ParticleSystemHandle } from "./vfx/ParticleSystem";
import type { SpeedLinesHandle } from "./feel/SpeedLines";
import { createFeel, handleFeelEvent, resetFeel, stepFeel, type FeelState } from "./feel";
import { emitFootDust, emitOverdriveTrail } from "./vfx/emitters";
import { nearestHazardX } from "./animation/procedural";
import { F, RunStatus } from "@/game/sim/state";
import { acquireAudioDirector, type AudioDirector } from "@/game/audio";
import { SimEvent } from "@/game/sim/events";
import {
  createRecorder,
  record as recordIntent,
  resetRecorder,
  serializeReplay,
  type Recorder,
} from "@/game/sim/replay";
import {
  buildRunSummary,
  createRunRecorder,
  recordEvent,
  recordFlow,
  resetRunRecorder,
  type RunRecorder,
  type RunSummary,
} from "@/game/meta";
import * as THREE from "three";
import { NULL_HUD_SINK, type HudSink } from "./hud-sink";
import type { PropFieldHandle } from "./props/PropField";
import type { ThemeDirector } from "./theme/ThemeDirector";
import { getScore, scoreMultiplier, shardCostFor } from "@/game/sim/scoring";

/** Everything the loop drives. All refs; all mutated, never re-rendered. */
export interface GameLoopRefs {
  tunnel: React.MutableRefObject<TunnelHandle | null>;
  entities: React.MutableRefObject<EntityRendererHandle | null>;
  player: React.MutableRefObject<RunnerRigHandle | null>;
  camera: React.MutableRefObject<CameraRigHandle | null>;
  lighting: React.MutableRefObject<LightingRigHandle | null>;
  particles: React.MutableRefObject<ParticleSystemHandle | null>;
  speedLines: React.MutableRefObject<SpeedLinesHandle | null>;
  /** The prop field for the theme being left. Drawn only during a transition. */
  propsOut: React.MutableRefObject<PropFieldHandle | null>;
  /** The prop field for the theme being entered, and the resting one. */
  propsIn: React.MutableRefObject<PropFieldHandle | null>;
}

export interface GameLoopOptions {
  /** Run seed. Changing it resets the sim. */
  seed: number;
  /** Registered before the first frame, so nothing is missed at run start. */
  onEvent?: EventListener;
  /** Suspends ticking without unmounting. Pause, or a lost window focus. */
  paused?: boolean;
  /**
   * The HUD.
   *
   * Structurally typed and declared in `hud-sink.ts` — this layer never names
   * anything in `src/ui/`, and `src/app` performs the assignment. See that file
   * for why the dependency has to point this way.
   */
  hud?: HudSink;
  /**
   * Called once when the run ends, with the finished summary.
   *
   * This is the sim -> meta handoff. P13 built the whole settlement path and
   * left it deliberately unreachable; the death screen is what consumes this.
   */
  onRunEnd?: (summary: RunSummary) => void;
  /**
   * Shards the player brought in.
   *
   * GAME_BIBLE §12 cause 6 makes a run end on a fatal hit with 0 Shards held,
   * and `tryArmFracture` enforces that — but until P14 the sim started every run
   * at zero regardless of what the player had banked, so a Fracture was
   * unreachable unless they picked a Shard up mid-run. See `sim.RunOptions`.
   */
  startingShards?: number;
  /**
   * The theme director, as a ref.
   *
   * A ref rather than a value because it is created in an effect — the loop
   * reads `.current` each frame and simply does nothing on the handful of frames
   * before it exists, exactly as it already does for the rigs.
   */
  director?: React.MutableRefObject<ThemeDirector | null>;
  /** The scene fog, mutated by the director. */
  fog?: THREE.Fog;
  /** The scene background, kept equal to the fog colour. */
  background?: THREE.Color;
  /**
   * Where the finished replay is left for the submit path.
   *
   * Written immediately BEFORE `onRunEnd` fires, so the handler can read it
   * synchronously and post it. A ref rather than a summary field because the
   * bytes are up to 105KB and `RunSummary` is passed into React state — putting
   * a six-figure byte array through the reconciler on every death would be a
   * real cost for a value nothing renders.
   *
   * `null` means there is nothing submittable: the run overflowed the 30-minute
   * recorder, so its bytes would re-simulate to a different hash and the server
   * would correctly call a genuine run a forgery.
   */
  replayRef?: React.MutableRefObject<Uint8Array | null>;
}

/** The mutable machine behind the loop. Lives in a ref, never in React state. */
interface Engine {
  sim: Sim;
  clock: Clock;
  drain: EventDrain;
  view: ReturnType<typeof createRenderView>;
  frames: number;
  input: InputManager | null;
  /**
   * The audio layer.
   *
   * Built here beside the input manager because both need the DOM and both are
   * per-run. It receives every drained event and one telemetry push per frame,
   * and it can never write back — `AudioDirector` exposes no path into the sim,
   * which is what keeps an audio hitch from changing a run's outcome.
   */
  audio: AudioDirector;
  feel: FeelState;
  /** Reused; where effects spawn. Written each frame before the drain. */
  feelContext: { playerX: number; playerY: number; playerZ: number; landingSpeed: number };
  /** Scratch for the face-local -> world conversion. */
  worldPos: { x: number; y: number; z: number };
  /**
   * The run recorder.
   *
   * ARCHITECTURE §3 names this as the ONE exception to "meta runs no logic
   * during a run": it counts events inside the frame loop because
   * `bitsCollected`, `nearMisses` and `peakFlow` are not `SimState` fields and
   * the event ring holds 256 entries, so by run end the data is gone rather than
   * merely awkward to reach. It allocates nothing, decides nothing, and has no
   * economy import.
   */
  recorder: RunRecorder;
  /**
   * The REPLAY recorder — one packed intent byte per tick.
   *
   * Not the same thing as `recorder` above, which counts events for the meta
   * summary. This one is the anti-cheat: it is what `/api/run/submit` sends, and
   * what the server re-simulates to compute the authoritative score.
   *
   * P02 built it and, until P12, nothing called it. A recorder nobody records
   * into is a leaderboard nobody can submit to.
   *
   * It writes one byte into a buffer preallocated at `TUNING.replay.maxTicks`,
   * so recording inside the tick loop allocates nothing and respects law (d).
   */
  replay: Recorder;
  /** True once `onRunEnd` has fired. A run settles exactly once. */
  ended: boolean;
  /** ms — when the HUD was last written. Gates DOM writes to `hudPushHz`. */
  lastHudPush: number;
  /** Last Overdrive state pushed, so the inversion is not re-applied per frame. */
  overdriveShown: boolean;
  /** Last paused state pushed, so the dim is not re-applied every frame. */
  pausedShown: boolean;
  /**
   * Reused target object for the theme director.
   *
   * The director takes its targets as an argument rather than holding refs to
   * them, which keeps it testable — but the loop still allocates nothing, so
   * this is one object mutated in place rather than a fresh literal per frame.
   */
  themeTargets: {
    tunnel: TunnelHandle | null;
    lighting: LightingRigHandle | null;
    fog: THREE.Fog | null;
    background: THREE.Color | null;
  };
  /** s — render time since the engine was built. Drives the surface effects. */
  renderTime: number;
}

const MS_PER_SECOND = 1000;

export type GameLoopApi = React.MutableRefObject<Engine | null>;

/**
 * Drives the sim from the r3f frame loop.
 *
 * ## Why the engine lives in a ref built inside an effect
 *
 * The obvious version builds it in `useMemo`. That is wrong twice over.
 * Constructing a `Sim` is a side effect, and React 19 double-invokes render in
 * strict mode, so `useMemo` can build two sims and throw one away — along with
 * whatever the discarded one had already ticked. And the React Compiler's
 * immutability rule correctly rejects mutating a memo result from inside a hook
 * callback, which this loop does on every single frame by design.
 *
 * A ref populated in an effect is the honest shape: created once, after mount,
 * explicitly mutable, and torn down deterministically. The frame callback guards
 * on null for the handful of frames before the effect runs.
 *
 * Returns the ref rather than the engine so callers read it outside render —
 * reading `.current` during render is the hazard `react-hooks/refs` exists to
 * catch, and it would be genuinely wrong here since it is null on first paint.
 */
export function useGameLoop(refs: GameLoopRefs, options: GameLoopOptions): GameLoopApi {
  const {
    seed,
    onEvent,
    paused = false,
    hud,
    onRunEnd,
    startingShards = 0,
    director,
    fog,
    background,
    replayRef: externalReplayRef,
  } = options;

  const engineRef = useRef<Engine | null>(null);

  // The refs object is captured by the event subscription, which is created once
  // in the mount effect. Holding it behind a ref keeps that closure valid even
  // if the caller passes a new object.
  const refsRef = useRef(refs);
  useEffect(() => {
    refsRef.current = refs;
  }, [refs]);

  // The listener is held in a ref and refreshed in an effect rather than during
  // render, so swapping it never tears the engine down and restarts the run.
  const listenerRef = useRef<EventListener | undefined>(undefined);
  useEffect(() => {
    listenerRef.current = onEvent;
  }, [onEvent]);

  // Same treatment for the HUD and the run-end callback: held behind refs and
  // refreshed in an effect, so swapping either never tears the engine down and
  // restarts the run mid-play.
  const hudRef = useRef<HudSink>(NULL_HUD_SINK);
  useEffect(() => {
    hudRef.current = hud ?? NULL_HUD_SINK;
  }, [hud]);

  const runEndRef = useRef<((summary: RunSummary) => void) | undefined>(undefined);
  useEffect(() => {
    runEndRef.current = onRunEnd;
  }, [onRunEnd]);

  // Read once, at construction, and deliberately NOT a dependency of the mount
  // effect. Settlement credits Shards while the death screen is up and the
  // canvas is still mounted on the same seed; if this were a dependency, that
  // credit would tear the engine down and restart the run the player just
  // finished. The next run picks up the new balance because `startRun` changes
  // the seed, which IS a dependency.
  //
  // Written in an effect rather than during render. Effects inside one component
  // run in declaration order, so this one lands before the engine effect below
  // and the value is already correct when the sim is constructed.
  const shardsRef = useRef(startingShards);
  useEffect(() => {
    shardsRef.current = startingShards;
  }, [startingShards]);

  // Built once, after mount. Input sources need the DOM, which is another reason
  // this cannot happen during render.
  useEffect(() => {
    // `getGamepads` is injected rather than read inside the source, so the
    // gamepad layer stays testable without a browser — that is why P03 made it
    // a required option instead of reaching for `navigator` itself.
    const manager = createInputManager([
      createKeyboardSource({ target: window }),
      createTouchSource({ target: window }),
      createGamepadSource({
        getGamepads: () => (navigator.getGamepads ? navigator.getGamepads() : []),
      }),
    ]);

    const engine: Engine = {
      sim: createSim(seed, { shards: shardsRef.current }),
      clock: createClock(),
      drain: createEventDrain(),
      view: createRenderView(),
      frames: 0,
      input: manager,
      audio: acquireAudioDirector(),
      feel: createFeel(),
      feelContext: { playerX: 0, playerY: 0, playerZ: 0, landingSpeed: 0 },
      worldPos: { x: 0, y: 0, z: 0 },
      recorder: createRunRecorder(),
      replay: createRecorder(seed),
      ended: false,
      lastHudPush: 0,
      overdriveShown: false,
      pausedShown: false,
      themeTargets: {
        tunnel: null,
        lighting: null,
        fog: fog ?? null,
        background: background ?? null,
      },
      renderTime: 0,
    };

    /*
     * The music follows the DIRECTOR, not the sim event.
     *
     * `SimEvent.ThemeChange` carries the ordinal the run reached. The director
     * resolves that against the unlock table, so a player without Static cycles
     * back to Kiln — and if the music keyed off the raw event it would play
     * Static's detuned FM lead over Kiln's foundry. Routing it here also puts
     * the swap inside the crossfade's musical window rather than at its start,
     * so the stems and the walls arrive together.
     *
     * `music.play` still owns the alignment: it starts the new set a whole
     * number of loops after the session origin, which is a bar boundary by
     * construction (4 beats/bar, 4 bars/loop).
     */
    const attachedDirector = director?.current ?? null;
    attachedDirector?.setMusicListener((stemSet) => {
      engine.audio.setTheme(stemSet);
    });

    // Subscribed through a ref so changing the listener does not tear the engine
    // down and restart the run.
    // Feel first, then any external listener. The feel layer must see every
    // event even when nobody else is listening.
    const unsubscribe = engine.drain.subscribe((event) => {
      const pool = refsRef.current.particles.current?.pool;
      if (pool !== undefined) {
        handleFeelEvent(engine.feel, event, pool, engine.feelContext);
      }
      // Audio before the external listener, for the same reason feel is: it is
      // a first-class consumer of the ring, not an observer of one.
      engine.audio.handleEvent(event);

      // The meta recorder. Counting only — see the field comment on `recorder`.
      recordEvent(engine.recorder, event.type, event.payload0);

      // Discrete HUD reactions. These are NOT rate-limited: a near-miss kick or
      // a theme swap arriving 66ms late is visible, and each is one attribute
      // write rather than a layout-triggering counter update.
      const sink = hudRef.current;
      switch (event.type) {
        case SimEvent.NearMiss:
          sink.nearMiss();
          break;
        case SimEvent.FlowGain:
          sink.flowGain(event.payload0);
          break;
        case SimEvent.OverdriveStart:
          sink.setOverdrive(true);
          engine.overdriveShown = true;
          break;
        case SimEvent.OverdriveEnd:
          sink.setOverdrive(false);
          engine.overdriveShown = false;
          break;
        case SimEvent.ThemeChange:
          // The sim says WHEN; the director decides what that ordinal means,
          // whether the player has unlocked it, and therefore what the DOM and
          // the music should follow. The HUD is NOT told directly: this event
          // carries the ordinal the sim reached, and for a player without Static
          // that is a theme they never see.
          director?.current?.requestTheme(event.payload0);
          break;
        case SimEvent.FractureTick:
          // payload1 = fraction remaining, payload2 = the one clearing verb.
          //
          // `fracturesUsed` has ALREADY been incremented by `tryArmFracture` by
          // the time the window is ticking, so the cost that was actually
          // charged is the one for the previous index — not the next.
          sink.setFracture({
            fraction: event.payload1,
            verb: event.payload2,
            shardCost: shardCostFor(Math.max(0, engine.sim.getState().fracturesUsed - 1)),
          });
          break;
        case SimEvent.FractureResolve:
          sink.setFracture(null);
          break;
        default:
          break;
      }

      listenerRef.current?.(event);
    });

    resetFeel(engine.feel);
    resetRunRecorder(engine.recorder);
    resetRecorder(engine.replay);
    hudRef.current.reset();

    engineRef.current = engine;

    return () => {
      unsubscribe();
      manager.dispose();
      engine.audio.dispose();
      engineRef.current = null;
    };
    // `fog`, `background` and `director` are all stable for the life of the
    // scene — two `useMemo` objects and a ref — so listing them satisfies the
    // exhaustive-deps rule without ever actually rebuilding the engine. Leaving
    // them out would be the kind of silent staleness this rule exists to catch.
  }, [seed, fog, background, director]);

  /**
   * A backgrounded tab must DROP its accumulated time, not simulate it.
   *
   * `advance`'s spiral guard would clamp a 4-minute stall to 5 ticks, which is
   * survivable but still lurches the world forward through obstacles the player
   * never saw. `resync` discards it entirely and the run resumes where it
   * paused. The sim cannot detect this itself — it has no DOM (law a).
   */
  useEffect(() => {
    const onVisibility = (): void => {
      const engine = engineRef.current;
      if (engine !== null && document.visibilityState === "visible") {
        resync(engine.clock);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onVisibility);
    };
  }, []);

  useFrame((_state, delta) => {
    const engine = engineRef.current;
    if (engine === null) {
      // The mount effect has not run yet. A handful of frames at most.
      return;
    }
    engine.frames += 1;

    const sim = engine.sim;

    // 1. Input — sampled once, immediately before the ticks it feeds.
    const intent: Readonly<Intent> = paused ? IDLE_INTENT : (engine.input?.poll() ?? IDLE_INTENT);

    // 1b. The HUD dims while held. Pushed from the frame loop rather than from
    //     a React effect so it lands on the same frame the ticks stop, not one
    //     render later.
    if (paused !== engine.pausedShown) {
      engine.pausedShown = paused;
      hudRef.current.setPaused(paused);
    }

    // 2. Fixed-timestep ticks. `advance` owns the accumulator and the spiral
    //    guard; this loop never sees wall-clock time again after this line.
    const ticks = paused ? 0 : advance(engine.clock, delta);
    for (let i = 0; i < ticks; i += 1) {
      // Recorded BEFORE the tick, so byte N is the intent tick N ran with. The
      // server replays it the same way round; reversing either end silently
      // shifts every input by one tick and nothing verifies again.
      recordIntent(engine.replay, intent);
      sim.tick(intent);
    }

    // 3. Interpolate. Law (c): every transform below comes from the blend of the
    //    two most recent snapshots, never from raw `current`. At 34 u/s a raw
    //    read stutters by 0.567u per tick and it is instantly visible.
    const view = readInterpolated(
      engine.view,
      sim.getPrevious(),
      sim.getState(),
      engine.clock.alpha,
    );

    // 4. Events, drained BEFORE the transforms.
    //
    //    Order reversed at the feel pass, and it matters: a Crash event requests
    //    a hit-stop, and hit-stop has to be known before the transforms are
    //    decided or the freeze starts one frame late — which is a sixth of the
    //    whole 90ms effect.
    // WORLD space, not face-local. Emitters place particles directly into the
    // scene, so handing them the sim's face-local coordinates puts every burst
    // on the tunnel axis instead of at the runner.
    const world = faceLocalToWorld(
      engine.worldPos,
      view.x,
      view.y,
      view.z,
      view.face,
      TUNING.geometry.prismInnerSize,
    );
    engine.feelContext.playerX = world.x;
    engine.feelContext.playerY = world.y;
    engine.feelContext.playerZ = world.z;
    engine.drain.drain(sim.events);

    // 4a. The HUD, and the run-summary recorder.
    //
    //     Both read the INTERPOLATED view rather than raw `current`, for the
    //     same reason the transforms do — a raw read stutters by a whole tick.
    //     Flow is recorded every frame because `peakFlow` is a high-water mark
    //     and sampling it at 15Hz would miss a spike that lasted three frames.
    const state = sim.getState();
    recordFlow(engine.recorder, view.flow);

    const sink = hudRef.current;
    const nowMs = performance.now();
    if (nowMs - engine.lastHudPush >= MS_PER_SECOND / TUNING.ui.hudPushHz) {
      engine.lastHudPush = nowMs;
      sink.setScore(getScore(state));
      sink.setDistance(view.distance);
      sink.setBits(engine.recorder.bitsCollected);
      sink.setFlow(view.flow);
      sink.setMultiplier(scoreMultiplier(state));
      sink.setFace(view.face);
      sink.setShields(state.player.shields);
    }

    // 4c. Run end — the sim -> meta handoff, fired exactly once.
    //
    //     `runStatus` becomes `Ended` inside the tick above, and the death
    //     screen needs a summary rather than a live state, because the sim is
    //     about to be reset out from under it by the next run.
    if (!engine.ended && state.runStatus === RunStatus.Ended) {
      engine.ended = true;
      sink.setFracture(null);
      const summary = buildRunSummary(engine.recorder, {
        distance: state.f[F.distance] ?? 0,
        score: getScore(state),
        bestCombo: state.bestCombo,
        band: state.band,
        elapsedSeconds: state.f[F.elapsed] ?? 0,
        seed: sim.getSeed(),
        shieldsHeld: state.player.shields,
      });

      /*
       * The replay, serialised at exactly this instant.
       *
       * `sim.hash()` has to be read here rather than later: the next run resets
       * the sim in place, and a hash read after that is the hash of a fresh
       * state. Every submission would then be rejected — correctly, and
       * inexplicably.
       *
       * A truncated recording (a run past 30 minutes) is deliberately NOT
       * submitted. The bytes would parse and re-simulate to a different hash,
       * so sending them would report a genuine 30-minute run as a forgery.
       */
      if (externalReplayRef !== undefined) {
        externalReplayRef.current = engine.replay.overflowed
          ? null
          : serializeReplay(engine.replay, sim.hash());
      }

      runEndRef.current?.(summary);
    }

    // 4b. Audio telemetry.
    //
    //     Pushed BEFORE the hit-stop return below, deliberately. Hit-stop
    //     freezes the picture, not the game — and certainly not the music. A
    //     90ms hole in the audio would read as a dropped buffer, which is the
    //     opposite of the weight the freeze is trying to add.
    engine.audio.setTelemetry(view.worldSpeed, view.flow);

    // 4d. The theme crossfade.
    //
    //     Also before the hit-stop return, and for the same reason: a four
    //     second transition should not pause for 90ms because the player clipped
    //     something. The fade is atmosphere, and atmosphere does not flinch.
    const themeDirector = director?.current ?? null;
    if (themeDirector !== null) {
      engine.themeTargets.tunnel = refs.tunnel.current;
      engine.themeTargets.lighting = refs.lighting.current;
      themeDirector.update(delta, engine.themeTargets);
      publishThemeDiagnostics(themeDirector);
    }

    // 5. Feel. Decays trauma and the aberration pulse, and reports whether the
    //    picture is frozen this frame.
    const held = stepFeel(engine.feel, delta);

    // 6. HIT-STOP.
    //
    //    The sim already ticked above and will keep ticking; only the picture
    //    holds. Freezing the sim instead would hand the player free time, break
    //    input, and make the run unreplayable on a server with no renderer —
    //    law (a). The world snapping forward when the freeze lifts IS the
    //    effect.
    //
    //    Particles keep integrating: debris frozen mid-air reads as a bug, and
    //    the burst that caused the freeze should already be expanding when the
    //    picture resumes.
    const worldDelta = held ? 0 : view.worldSpeed * delta;
    refs.particles.current?.update(delta, worldDelta);

    if (held) {
      return;
    }

    // 7. Write transforms. Direct Object3D mutation, no React involved.
    engine.renderTime += delta;
    refs.tunnel.current?.update(view.distance, view.roll, engine.renderTime);

    // The prop fields. Two of them: the theme being left and the one being
    // entered. Outside a transition the outgoing field is at zero strength and
    // draws nothing at all, because an instanced mesh with `count = 0` costs no
    // draw call.
    refs.propsOut.current?.update(
      view.distance,
      view.roll,
      themeDirector?.outgoingProps ?? 0,
      engine.renderTime,
    );
    refs.propsIn.current?.update(
      view.distance,
      view.roll,
      themeDirector?.incomingProps ?? 1,
      engine.renderTime,
    );
    refs.entities.current?.update(sim.getState());

    const animation = animationForPhase(view.phase);
    const runner = refs.player.current;
    if (runner !== null) {
      runner.setContext({
        distance: view.distance,
        laneBias: intent.lateral,
        worldRoll: view.roll,
        hazardX: nearestHazardX(sim.getState().obstacles, view.face),
        verticalSpeed: sim.getState().f[F.playerVy] ?? 0,
      });
      runner.update(view.x, view.y, view.z, view.face, animation, delta);

      // Foot dust, from the rig's own stride phase rather than a timer — so a
      // puff lands exactly when a foot does, at any speed.
      const contact = runner.footContact;
      const pool = refs.particles.current?.pool;
      if (contact.stepped && pool !== undefined) {
        emitFootDust(pool, contact.x, contact.y, contact.z);
      }
    }

    // The Overdrive trail, while the window is open.
    const pool = refs.particles.current?.pool;
    if (pool !== undefined && (sim.getState().f[F.overdriveTimer] ?? 0) > 0) {
      engine.feel.trailAccumulator = emitOverdriveTrail(
        pool,
        world.x,
        world.y,
        world.z,
        delta,
        engine.feel.trailAccumulator,
      );
    }

    const shake = engine.feel.trauma.offset;
    refs.camera.current?.update(
      view.x,
      view.y,
      view.roll,
      view.face,
      view.worldSpeed,
      intent.lateral,
      delta,
      shake,
    );
    refs.lighting.current?.update(view.x, view.y, view.face);
    refs.speedLines.current?.update(view.worldSpeed);
  });

  return engineRef;
}

/**
 * What the theme system is doing this frame, on `window`.
 *
 * Exists for the P10 verify gate, which has to report a transition's real
 * duration and which theme each measurement belongs to. There is no other way
 * to ask: the crossfade is deliberately invisible to React, so a Playwright spec
 * cannot read it off the DOM.
 *
 * One object, allocated once and mutated — this runs every frame.
 */
/** Placeholder until the first frame attaches the real director. */
function noThemeDirector(): void {
  /* no director yet */
}

const THEME_DIAGNOSTICS = {
  slug: "",
  incoming: "",
  phase: "",
  /** 0..1 through the current fade, or 1 when idle. */
  t: 1,
  /** Seconds since the current transition was requested. */
  elapsed: 0,
  /** Completed transitions this session. The gate waits on this changing. */
  changes: 0,

  /**
   * Requests a transition, exactly as a milestone would.
   *
   * The P10 gate has to measure a real mid-run crossfade, and the first
   * milestone is 1,200m — thirty-five seconds of flawless running that a
   * headless browser on a software rasteriser will not survive. There is no
   * other way to reach one.
   *
   * This ships. It is safe to ship for a reason stronger than obscurity: the
   * theme director is presentation-only and has NO path into the sim. It cannot
   * move the player, spawn an entity, award Flow or advance the RNG stream, so
   * calling this changes what a run looks like and nothing about what it scores.
   * A replay of the same seed is byte-identical with or without it. That is the
   * same separation `ThemeDirector`'s header describes for Static's unlock.
   */
  request: noThemeDirector as (ordinal: number) => void,
};

interface ThemeDiagnosticsWindow extends Window {
  __axisTheme?: typeof THEME_DIAGNOSTICS;
}

function publishThemeDiagnostics(themeDirector: ThemeDirector): void {
  const d = THEME_DIAGNOSTICS;
  if (d.slug !== themeDirector.current.slug) {
    d.slug = themeDirector.current.slug;
    d.changes += 1;
  }
  d.incoming = themeDirector.incoming.slug;
  d.phase = themeDirector.state.phase;
  d.t = themeDirector.state.t;
  d.elapsed = themeDirector.state.elapsed;
  d.request = (ordinal: number): void => {
    themeDirector.requestTheme(ordinal);
  };
  (window as ThemeDiagnosticsWindow).__axisTheme = d;
}
