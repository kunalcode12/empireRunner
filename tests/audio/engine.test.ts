import { describe, expect, it } from "vitest";
import { TUNING } from "@/game/config/tuning";
import { createAudioEngine } from "@/game/audio/engine";
import { Bus } from "@/game/audio/settings";
import {
  FakeAudioContext,
  FakeEventTarget,
  asAudioContext,
  asEventTarget,
  asVisibilityTarget,
  createFakeStorage,
} from "../helpers/fake-audio";

function harness(): {
  context: FakeAudioContext;
  gestures: FakeEventTarget;
  visibility: FakeEventTarget;
  engine: ReturnType<typeof createAudioEngine>;
  contextsBuilt: number;
} {
  const context = new FakeAudioContext();
  const gestures = new FakeEventTarget();
  const visibility = new FakeEventTarget();
  const state = { built: 0 };

  const engine = createAudioEngine({
    contextFactory: () => {
      state.built += 1;
      return asAudioContext(context);
    },
    gestureTarget: asEventTarget(gestures),
    visibilityTarget: asVisibilityTarget(visibility),
    storage: createFakeStorage(),
  });

  return {
    context,
    gestures,
    visibility,
    engine,
    get contextsBuilt() {
      return state.built;
    },
  };
}

describe("audio engine lifecycle", () => {
  /**
   * The single most common Web Audio bug: a context constructed at module load
   * is created suspended, looks completely healthy from the console, and never
   * makes a sound.
   */
  it("constructs no context until a gesture arrives", () => {
    const h = harness();
    expect(h.engine.context).toBeNull();
    expect(h.contextsBuilt).toBe(0);
  });

  it("arms gesture listeners at construction", () => {
    const h = harness();
    expect(h.gestures.count("pointerdown")).toBe(1);
    expect(h.gestures.count("keydown")).toBe(1);
    expect(h.gestures.count("touchstart")).toBe(1);
  });

  it("builds and resumes the context on the first gesture", async () => {
    const h = harness();
    h.gestures.fire("pointerdown");
    await Promise.resolve();
    await Promise.resolve();

    expect(h.contextsBuilt).toBe(1);
    expect(h.context.resumeCalls).toBeGreaterThan(0);
    expect(h.engine.running).toBe(true);
  });

  it("disarms the gesture listeners once running", async () => {
    const h = harness();
    await h.engine.unlock();
    expect(h.gestures.count("pointerdown")).toBe(0);
  });

  it("keeps listening when the browser refuses the resume", async () => {
    const h = harness();
    h.context.refuseResume = true;

    const running = await h.engine.unlock();
    expect(running).toBe(false);
    // Still armed: the next tap is the only thing that can recover this.
    expect(h.gestures.count("pointerdown")).toBe(1);
  });

  it("builds the documented bus graph", async () => {
    const h = harness();
    await h.engine.unlock();
    const buses = h.engine.buses;
    expect(buses).not.toBeNull();
    if (buses === null) {
      return;
    }
    // music -> musicDuck -> master, and sfx/ui straight to master.
    expect(buses.music.connect).toBeDefined();
    expect(h.engine.settings.musicGain).toBe(TUNING.audio.musicGain);
  });

  it("fades the master up rather than starting at full gain", async () => {
    const h = harness();
    await h.engine.unlock();
    const master = h.context.created.gains[0];
    expect(master).toBeDefined();
    const ramps = master?.gain.of("linearRampToValueAtTime") ?? [];
    expect(ramps.length).toBeGreaterThan(0);
    expect(ramps[0]?.time).toBeCloseTo(TUNING.audio.masterFadeIn, 6);
  });
});

describe("audio engine interruption recovery", () => {
  /**
   * A phone call, a screen lock, or another app taking the session. Safari
   * reports `interrupted`, which is not in the TypeScript AudioContextState
   * union but is real.
   *
   * The failure this prevents: audio dead for the rest of the page's life.
   */
  it("re-arms gestures when the context is interrupted out from under it", async () => {
    const h = harness();
    await h.engine.unlock();
    expect(h.gestures.count("pointerdown")).toBe(0);

    h.context.refuseResume = true;
    h.context.setState("interrupted");
    await Promise.resolve();

    expect(h.gestures.count("pointerdown")).toBe(1);
  });

  it("recovers on the next gesture after an interruption", async () => {
    const h = harness();
    await h.engine.unlock();

    h.context.refuseResume = true;
    h.context.setState("interrupted");
    await Promise.resolve();

    h.context.refuseResume = false;
    h.gestures.fire("pointerdown");
    await Promise.resolve();
    await Promise.resolve();

    expect(h.engine.running).toBe(true);
    // The same context, resumed — not a second one, which would restart music.
    expect(h.contextsBuilt).toBe(1);
  });

  it("suspends on tab hide and resumes on tab show", async () => {
    const h = harness();
    await h.engine.unlock();

    h.visibility.visibilityState = "hidden";
    h.visibility.fire("visibilitychange");
    await new Promise((resolve) => setTimeout(resolve, TUNING.audio.suspendFade * 1000 + 20));
    expect(h.context.suspendCalls).toBeGreaterThan(0);

    h.visibility.visibilityState = "visible";
    h.visibility.fire("visibilitychange");
    await Promise.resolve();
    await Promise.resolve();
    expect(h.engine.running).toBe(true);
  });
});

describe("audio engine settings", () => {
  it("persists a bus gain and ramps rather than jumping", async () => {
    const storage = createFakeStorage();
    const context = new FakeAudioContext();
    const engine = createAudioEngine({
      contextFactory: () => asAudioContext(context),
      gestureTarget: null,
      visibilityTarget: null,
      storage,
    });
    await engine.unlock();

    engine.setBusGain(Bus.Music, 0.2);
    expect(engine.settings.musicGain).toBe(0.2);
    expect(storage.map.size).toBe(1);

    const music = context.created.gains[1];
    expect(music?.gain.of("linearRampToValueAtTime").length).toBeGreaterThan(0);
  });

  it("mute silences the master without losing the volumes", async () => {
    const context = new FakeAudioContext();
    const engine = createAudioEngine({
      contextFactory: () => asAudioContext(context),
      gestureTarget: null,
      visibilityTarget: null,
      storage: createFakeStorage(),
    });
    await engine.unlock();

    engine.setMuted(true);
    const master = context.created.gains[0];
    expect(master?.gain.last("linearRampToValueAtTime")?.value).toBe(0);
    expect(engine.settings.masterGain).toBe(TUNING.audio.masterGain);

    engine.setMuted(false);
    expect(master?.gain.last("linearRampToValueAtTime")?.value).toBe(TUNING.audio.masterGain);
  });

  it("clamps a latency offset set from outside", async () => {
    const engine = createAudioEngine({
      contextFactory: () => asAudioContext(new FakeAudioContext()),
      gestureTarget: null,
      visibilityTarget: null,
      storage: createFakeStorage(),
    });
    engine.setLatencyOffset(99);
    expect(engine.settings.latencyOffset).toBe(TUNING.audio.latencyOffsetMax);
  });

  it("dispose removes every listener it attached", async () => {
    const h = harness();
    await h.engine.unlock();
    h.engine.dispose();

    expect(h.gestures.count("pointerdown")).toBe(0);
    expect(h.visibility.count("visibilitychange")).toBe(0);
    expect(h.context.closed).toBe(true);
  });
});
