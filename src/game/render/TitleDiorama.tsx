"use client";

/**
 * The title screen's living background.
 *
 * The runner idles in the tunnel and the camera orbits it slowly. The menu is
 * DOM on top, with no scrim between them, so the menu reads as being inside the
 * game world rather than laid over a screenshot of it.
 *
 * ## It does not tick the sim
 *
 * This is the important part. Running a real sim behind the menu would burn the
 * whole tick budget on a screen nobody is playing, and worse, it would advance
 * the generator — so the first thing a player saw on pressing RUN would be a
 * track the menu had already partly consumed.
 *
 * So: no `useGameLoop`, no `createSim`, no accumulator. One `useFrame` that
 * advances an orbit angle and drives the rig's stride phase directly. The runner
 * appears to be running because the tunnel scrolls past it and its legs cycle;
 * nothing is being simulated.
 *
 * ## The scroll is a wall-clock integral, not a distance
 *
 * `distance += speed * delta` accumulated locally. The rig's run cycle is driven
 * by distance rather than by time (TUNING §13b `strideLength`), so feeding it a
 * fake distance makes the feet land correctly at whatever speed we choose —
 * exactly as they do in a real run.
 */

import { useEffect, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { TUNING } from "@/game/config/tuning";
import { acquireAudioDirector, type AudioDirector } from "@/game/audio";
import { RunnerRig, type RunnerRigHandle } from "./animation/RunnerRig";
import { AnimationState } from "./interpolate";
import { Tunnel, type TunnelHandle } from "./Tunnel";
import { LightingRig, type LightingRigHandle } from "./LightingRig";

/** rad/s — how fast the camera swings around the tunnel axis. */
const ORBIT_RATE = 0.07;
/** u/s — the idle scroll. Well under `baseSpeed`; this is an attract loop. */
const IDLE_SPEED = 7.5;
/**
 * u — how far the camera sits from the axis while orbiting.
 *
 * Tightened from 5.2 after looking at the first screenshot: at that radius the
 * runner was a speck at the end of a corridor and the four-face prism read as a
 * plain tunnel. Close enough to see the runner, far enough that the orbit still
 * shows more than one face.
 */
const ORBIT_RADIUS = 3.4;
/** x — fraction of the play camera's height the diorama sits at. Lower reads
 *  as looking along the tunnel rather than down into it. */
const ORBIT_HEIGHT_SCALE = 0.55;
/** rad/s multiplier — the vertical bob runs at half the orbit rate, so the path
 *  is a slow figure-of-eight rather than a circle. */
const BOB_RATE_SCALE = 0.5;
/** u — amplitude of that bob. */
const BOB_AMPLITUDE = 0.6;
/** x — how far back along z the orbit centre sits, as a fraction of the play
 *  camera's distance. Keeps the runner in frame through the whole sweep. */
const ORBIT_DEPTH_SCALE = 0.62;
/** u — height of the point the camera aims at. Roughly the runner's chest, so
 *  the figure is the subject rather than the vanishing point behind it. */
const LOOK_HEIGHT = 0.9;
/** u — how far AHEAD of the runner the camera looks. Small: aiming at the
 *  horizon is what made the first pass read as an empty corridor. */
const LOOK_AHEAD = 2.4;

export function TitleDiorama(): React.ReactElement {
  const tunnel = useRef<TunnelHandle | null>(null);
  const player = useRef<RunnerRigHandle | null>(null);
  const lighting = useRef<LightingRigHandle | null>(null);

  const distance = useRef(0);
  const angle = useRef(0);

  /**
   * The menu has music.
   *
   * P14 first shipped without this and it was a regression in two directions.
   * The obvious one: a title screen in silence, with a whole adaptive music
   * layer built and idle. The one that caught it: `AudioDirector` is what
   * publishes `window.__axisAudio` and arms the gesture listeners that satisfy
   * the autoplay policy, so moving the entry point from a run to a menu meant
   * audio never unlocked at all — and all ten P11 e2e tests failed.
   *
   * The director takes no events here because there is no sim to emit them.
   * Telemetry is pushed at the idle scroll speed and zero Flow, which lands the
   * adaptive layering at its floor — base stem only, no percussion, no tension.
   * That is exactly what a menu bed should be, and it comes out of the existing
   * `layerTargets` curve rather than a special case.
   */
  const audioRef = useRef<AudioDirector | null>(null);
  useEffect(() => {
    const director = acquireAudioDirector();
    audioRef.current = director;
    return () => {
      director.dispose();
      audioRef.current = null;
    };
  }, []);

  useFrame(({ camera }, delta) => {
    // A tab that has been backgrounded returns one enormous delta. Clamped with
    // the same ceiling the sim's accumulator uses, so the diorama does not spin
    // like a top when the player comes back.
    const step = Math.min(delta, TUNING.sim.maxAccumulator);

    distance.current += IDLE_SPEED * step;
    angle.current += ORBIT_RATE * step;

    tunnel.current?.update(distance.current, 0);

    const rig = player.current;
    if (rig !== null) {
      rig.setContext({
        distance: distance.current,
        laneBias: 0,
        worldRoll: 0,
        hazardX: 0,
        verticalSpeed: 0,
      });
      rig.update(0, 0, 0, 0, AnimationState.Running, step);
    }

    lighting.current?.update(0, 0, 0);

    // Zero Flow, idle speed: the adaptive layers settle at their floor.
    audioRef.current?.setTelemetry(IDLE_SPEED, 0);

    // The orbit. `Math.sin`/`cos` are perfectly legal here — the transcendental
    // ban is scoped to `src/game/sim/**` for cross-engine replay validation, and
    // nothing on this screen is simulated or submitted.
    camera.position.set(
      Math.sin(angle.current) * ORBIT_RADIUS,
      TUNING.camera.cameraHeight * ORBIT_HEIGHT_SCALE +
        Math.sin(angle.current * BOB_RATE_SCALE) * BOB_AMPLITUDE,
      Math.cos(angle.current) * ORBIT_RADIUS + TUNING.camera.cameraDistance * ORBIT_DEPTH_SCALE,
    );
    camera.lookAt(0, LOOK_HEIGHT, -LOOK_AHEAD);
  });

  return (
    <>
      <Tunnel handleRef={tunnel} />
      <RunnerRig handleRef={player} />
      <LightingRig handleRef={lighting} />
    </>
  );
}
