/**
 * Draining the sim event ring into presentation listeners.
 *
 * The sim writes events; consumers read them. That one-way coupling is the whole
 * point of the ring (see `sim/events.ts`): a callback fired from inside the tick
 * would let presentation code run at an arbitrary point in the simulation,
 * allocate, and mutate — killing law (a) and law (d) together.
 *
 * ## Each consumer owns its own cursor
 *
 * The ring holds no per-consumer state, so render and audio drain independently
 * and at different rates. Audio at P11 will want to drain on its own schedule,
 * ahead of the render frame, to schedule against the `AudioContext` clock; that
 * works only because neither drain consumes the events for the other.
 *
 * ## Dropped events are reported, not silently swallowed
 *
 * The ring is 256 events. A consumer that falls behind loses the oldest ones.
 * That is the correct behaviour — the alternative is unbounded growth inside a
 * fixed-memory design — but it must be *visible*, because a listener that
 * silently misses a Crash is a bug that presents as "the death sound sometimes
 * doesn't play". `dropped` counts them and the dev build warns.
 */

import {
  accountForDropped,
  clampCursor,
  eventPayloadAt,
  eventTickAt,
  eventTypeAt,
  type EventRing,
} from "@/game/sim/events";

/** One event, flattened for a listener. Reused — do not retain it. */
export interface DrainedEvent {
  type: number;
  tick: number;
  payload0: number;
  payload1: number;
  payload2: number;
  payload3: number;
}

export type EventListener = (event: Readonly<DrainedEvent>) => void;

export interface EventDrain {
  /** Registers a listener. Returns an unsubscribe function. */
  subscribe(listener: EventListener): () => void;
  /** Reads everything since the last call and dispatches it. */
  drain(ring: EventRing): void;
  /** Events lost because this drain fell behind the ring. Diagnostic. */
  readonly missed: number;
  /** Resets the cursor. Call on `sim.reset`, or the cursor outruns the ring. */
  reset(): void;
}

const PAYLOAD_0 = 0;
const PAYLOAD_1 = 1;
const PAYLOAD_2 = 2;
const PAYLOAD_3 = 3;

/**
 * Creates a drain.
 *
 * The scratch event and the listener array are allocated once. `drain` runs
 * every frame and allocates nothing, which matters less than it does in the sim
 * — a render-frame allocation is not a determinism problem — but a per-frame
 * object churning at 144Hz is still garbage nobody needs.
 */
export function createEventDrain(): EventDrain {
  const listeners: EventListener[] = [];
  const scratch: DrainedEvent = {
    type: 0,
    tick: 0,
    payload0: 0,
    payload1: 0,
    payload2: 0,
    payload3: 0,
  };

  let cursor = 0;
  let missed = 0;

  return {
    get missed() {
      return missed;
    },

    subscribe(listener: EventListener): () => void {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) {
          listeners.splice(index, 1);
        }
      };
    },

    drain(ring: EventRing): void {
      missed += accountForDropped(ring, cursor);
      cursor = clampCursor(ring, cursor);

      for (; cursor < ring.head; cursor += 1) {
        scratch.type = eventTypeAt(ring, cursor);
        scratch.tick = eventTickAt(ring, cursor);
        scratch.payload0 = eventPayloadAt(ring, cursor, PAYLOAD_0);
        scratch.payload1 = eventPayloadAt(ring, cursor, PAYLOAD_1);
        scratch.payload2 = eventPayloadAt(ring, cursor, PAYLOAD_2);
        scratch.payload3 = eventPayloadAt(ring, cursor, PAYLOAD_3);

        for (let i = 0; i < listeners.length; i += 1) {
          listeners[i]?.(scratch);
        }
      }
    },

    reset(): void {
      cursor = 0;
      missed = 0;
    },
  };
}
