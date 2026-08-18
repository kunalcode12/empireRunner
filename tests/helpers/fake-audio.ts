/**
 * A fake Web Audio implementation, for the Node half of the audio tests.
 *
 * vitest runs `environment: "node"` and that is load-bearing (see
 * vitest.config.ts) — the sim must be provable without a DOM. There is no Web
 * Audio under Node, and jsdom does not implement it either, so the choice is
 * this or no unit tests at all for the audio layer.
 *
 * What this fake is FOR: asserting the automation that gets scheduled. Every
 * `AudioParam` call is recorded with its arguments and time, so a test can say
 * "the duck ramped to 0.7 over exactly 8ms and then released with a 60ms time
 * constant" — which is the part of the audio layer that is logic rather than
 * sound.
 *
 * What it is NOT for: anything that requires actual DSP. It renders no samples
 * and it is not a Web Audio conformance model. Drift, clicks and CPU cost are
 * measured in real Chromium by `tests/e2e/audio.spec.ts`, which is where those
 * questions can be answered honestly.
 */

/** One recorded automation call. */
export interface ParamEvent {
  method:
    | "setValueAtTime"
    | "linearRampToValueAtTime"
    | "exponentialRampToValueAtTime"
    | "setTargetAtTime"
    | "cancelScheduledValues";
  value: number;
  time: number;
  timeConstant?: number;
}

export class FakeAudioParam {
  value: number;
  readonly events: ParamEvent[] = [];

  constructor(initial = 0) {
    this.value = initial;
  }

  setValueAtTime(value: number, time: number): FakeAudioParam {
    this.events.push({ method: "setValueAtTime", value, time });
    this.value = value;
    return this;
  }

  linearRampToValueAtTime(value: number, time: number): FakeAudioParam {
    this.events.push({ method: "linearRampToValueAtTime", value, time });
    // The fake jumps to the ramp target immediately. Real automation would
    // interpolate, but nothing here reads `value` expecting a mid-ramp figure —
    // the tests assert on the recorded events, which are exact.
    this.value = value;
    return this;
  }

  exponentialRampToValueAtTime(value: number, time: number): FakeAudioParam {
    this.events.push({ method: "exponentialRampToValueAtTime", value, time });
    this.value = value;
    return this;
  }

  setTargetAtTime(value: number, time: number, timeConstant: number): FakeAudioParam {
    this.events.push({ method: "setTargetAtTime", value, time, timeConstant });
    return this;
  }

  cancelScheduledValues(time: number): FakeAudioParam {
    this.events.push({ method: "cancelScheduledValues", value: 0, time });
    return this;
  }

  /** Every event of one kind, in order. */
  of(method: ParamEvent["method"]): ParamEvent[] {
    return this.events.filter((event) => event.method === method);
  }

  /** The last event of one kind, or undefined. */
  last(method: ParamEvent["method"]): ParamEvent | undefined {
    return this.of(method).at(-1);
  }
}

class FakeNode {
  readonly connected: FakeNode[] = [];
  connect(target: FakeNode): FakeNode {
    this.connected.push(target);
    return target;
  }
  disconnect(): void {
    this.connected.length = 0;
  }
}

export class FakeGainNode extends FakeNode {
  readonly gain = new FakeAudioParam(1);
}

export class FakeStereoPannerNode extends FakeNode {
  readonly pan = new FakeAudioParam(0);
}

export class FakeBiquadFilterNode extends FakeNode {
  type = "lowpass";
  readonly frequency = new FakeAudioParam(350);
  readonly Q = new FakeAudioParam(1);
}

export class FakeOscillatorNode extends FakeNode {
  type = "sine";
  readonly frequency = new FakeAudioParam(440);
  readonly detune = new FakeAudioParam(0);
  startedAt: number | null = null;
  stoppedAt: number | null = null;
  start(when = 0): void {
    this.startedAt = when;
  }
  stop(when = 0): void {
    this.stoppedAt = when;
  }
}

export class FakeAudioBuffer {
  readonly duration: number;
  constructor(
    readonly numberOfChannels: number,
    readonly length: number,
    readonly sampleRate: number,
  ) {
    this.duration = length / sampleRate;
  }
  private readonly channels = new Map<number, Float32Array>();
  getChannelData(channel: number): Float32Array {
    let data = this.channels.get(channel);
    if (data === undefined) {
      data = new Float32Array(this.length);
      this.channels.set(channel, data);
    }
    return data;
  }
  copyToChannel(source: Float32Array, channel: number): void {
    this.getChannelData(channel).set(source);
  }
}

export class FakeBufferSourceNode extends FakeNode {
  buffer: FakeAudioBuffer | null = null;
  readonly playbackRate = new FakeAudioParam(1);
  readonly detune = new FakeAudioParam(0);
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  onended: (() => void) | null = null;
  startedAt: number | null = null;
  stoppedAt: number | null = null;

  start(when = 0): void {
    if (this.startedAt !== null) {
      throw new Error("AudioBufferSourceNode cannot be started twice");
    }
    this.startedAt = when;
  }
  stop(when = 0): void {
    if (this.startedAt === null) {
      throw new Error("cannot stop a source that never started");
    }
    this.stoppedAt = when;
  }
  /** Fires `onended`, which the real implementation does asynchronously. */
  finish(): void {
    this.onended?.();
  }
}

export type FakeContextState = "running" | "suspended" | "closed" | "interrupted";

/**
 * A fake `AudioContext` with a manually advanced clock.
 *
 * The clock does not run by itself: a test moves it and therefore controls
 * exactly what "now" was when a cue was scheduled. Wall-clock time in a test is
 * a source of flakes and there is no reason to accept one here.
 */
export class FakeAudioContext {
  currentTime = 0;
  sampleRate = 48_000;
  baseLatency = 0.005;
  outputLatency = 0.02;
  state: FakeContextState = "suspended";
  readonly destination = new FakeGainNode();
  readonly created: { gains: FakeGainNode[]; sources: FakeBufferSourceNode[] } = {
    gains: [],
    sources: [],
  };

  private readonly listeners = new Map<string, Set<() => void>>();
  resumeCalls = 0;
  suspendCalls = 0;
  closed = false;
  /** Set to make `resume()` reject, as a browser does without a gesture. */
  refuseResume = false;

  advance(seconds: number): void {
    this.currentTime += seconds;
  }

  createGain(): FakeGainNode {
    const node = new FakeGainNode();
    this.created.gains.push(node);
    return node;
  }
  createStereoPanner(): FakeStereoPannerNode {
    return new FakeStereoPannerNode();
  }
  createBiquadFilter(): FakeBiquadFilterNode {
    return new FakeBiquadFilterNode();
  }
  createOscillator(): FakeOscillatorNode {
    return new FakeOscillatorNode();
  }
  createBufferSource(): FakeBufferSourceNode {
    const node = new FakeBufferSourceNode();
    this.created.sources.push(node);
    return node;
  }
  createBuffer(channels: number, length: number, sampleRate: number): FakeAudioBuffer {
    return new FakeAudioBuffer(channels, length, sampleRate);
  }

  addEventListener(type: string, listener: () => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  /** Moves to a state and fires `statechange`, exactly as a browser would. */
  setState(state: FakeContextState): void {
    this.state = state;
    for (const listener of this.listeners.get("statechange") ?? []) {
      listener();
    }
  }

  async resume(): Promise<void> {
    this.resumeCalls += 1;
    if (this.refuseResume) {
      throw new Error("play() failed because the user didn't interact with the document first");
    }
    this.setState("running");
  }
  async suspend(): Promise<void> {
    this.suspendCalls += 1;
    this.setState("suspended");
  }
  async close(): Promise<void> {
    this.closed = true;
    this.setState("closed");
  }
}

/** A minimal `EventTarget` that records what was attached. */
export class FakeEventTarget {
  visibilityState: "visible" | "hidden" = "visible";
  readonly handlers = new Map<string, Set<EventListenerOrEventListenerObject>>();

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const set = this.handlers.get(type) ?? new Set();
    set.add(listener);
    this.handlers.set(type, set);
  }
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    this.handlers.get(type)?.delete(listener);
  }
  /** How many listeners are attached for a type. */
  count(type: string): number {
    return this.handlers.get(type)?.size ?? 0;
  }
  /** Invokes every listener for a type. */
  fire(type: string): void {
    for (const listener of [...(this.handlers.get(type) ?? [])]) {
      if (typeof listener === "function") {
        listener(new Event(type));
      } else {
        listener.handleEvent(new Event(type));
      }
    }
  }
}

/** In-memory `SettingsStorage`, so tests never touch a real `localStorage`. */
export function createFakeStorage(initial: Record<string, string> = {}): {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  readonly map: Map<string, string>;
} {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}

/** Casts a fake into the DOM type the production code expects. */
export function asAudioContext(fake: FakeAudioContext): AudioContext {
  return fake as unknown as AudioContext;
}

/** Casts a fake into `BaseAudioContext`, for the pool and the music system. */
export function asBaseContext(fake: FakeAudioContext): BaseAudioContext {
  return fake as unknown as BaseAudioContext;
}

/** Casts a fake gain node into `GainNode`. */
export function asGainNode(fake: FakeGainNode): GainNode {
  return fake as unknown as GainNode;
}

/** Casts a fake param into `AudioParam`. */
export function asAudioParam(fake: FakeAudioParam): AudioParam {
  return fake as unknown as AudioParam;
}

/** Casts a fake buffer into `AudioBuffer`. */
export function asAudioBuffer(fake: FakeAudioBuffer): AudioBuffer {
  return fake as unknown as AudioBuffer;
}

/** Casts a fake event target into what the engine's options expect. */
export function asEventTarget(fake: FakeEventTarget): EventTarget {
  return fake as unknown as EventTarget;
}

/** Casts a fake event target into the visibility-target shape. */
export function asVisibilityTarget(
  fake: FakeEventTarget,
): EventTarget & { visibilityState?: string } {
  return fake as unknown as EventTarget & { visibilityState?: string };
}
