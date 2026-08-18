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
import { F } from "@/game/sim/state";
import { createAudioDirector, type AudioDirector } from "@/game/audio";

/** Everything the loop drives. All refs; all mutated, never re-rendered. */
export interface GameLoopRefs {
  tunnel: React.MutableRefObject<TunnelHandle | null>;
  entities: React.MutableRefObject<EntityRendererHandle | null>;
  player: React.MutableRefObject<RunnerRigHandle | null>;
  camera: React.MutableRefObject<CameraRigHandle | null>;
  lighting: React.MutableRefObject<LightingRigHandle | null>;
  particles: React.MutableRefObject<ParticleSystemHandle | null>;
  speedLines: React.MutableRefObject<SpeedLinesHandle | null>;
}

export interface GameLoopOptions {
  /** Run seed. Changing it resets the sim. */
  seed: number;
  /** Registered before the first frame, so nothing is missed at run start. */
  onEvent?: EventListener;
  /** Suspends ticking without unmounting. Pause, or a lost window focus. */
  paused?: boolean;
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
}

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
  const { seed, onEvent, paused = false } = options;

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
      sim: createSim(seed),
      clock: createClock(),
      drain: createEventDrain(),
      view: createRenderView(),
      frames: 0,
      input: manager,
      audio: createAudioDirector(),
      feel: createFeel(),
      feelContext: { playerX: 0, playerY: 0, playerZ: 0, landingSpeed: 0 },
      worldPos: { x: 0, y: 0, z: 0 },
    };

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
      listenerRef.current?.(event);
    });

    resetFeel(engine.feel);

    engineRef.current = engine;

    return () => {
      unsubscribe();
      manager.dispose();
      engine.audio.dispose();
      engineRef.current = null;
    };
  }, [seed]);

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

    // 2. Fixed-timestep ticks. `advance` owns the accumulator and the spiral
    //    guard; this loop never sees wall-clock time again after this line.
    const ticks = paused ? 0 : advance(engine.clock, delta);
    for (let i = 0; i < ticks; i += 1) {
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

    // 4b. Audio telemetry.
    //
    //     Pushed BEFORE the hit-stop return below, deliberately. Hit-stop
    //     freezes the picture, not the game — and certainly not the music. A
    //     90ms hole in the audio would read as a dropped buffer, which is the
    //     opposite of the weight the freeze is trying to add.
    engine.audio.setTelemetry(view.worldSpeed, view.flow);

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
    refs.tunnel.current?.update(view.distance, view.roll);
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
