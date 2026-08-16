import { describe, expect, it } from "vitest";
import { TUNING } from "@/game/config/tuning";
import {
  accountForDropped,
  clampCursor,
  createEventRing,
  emit,
  eventPayloadAt,
  eventTickAt,
  eventTypeAt,
  oldestReadable,
  resetEventRing,
  SimEvent,
} from "@/game/sim/events";

const CAPACITY = TUNING.pools.maxEvents;

describe("emitting and reading", () => {
  it("reads back what was written", () => {
    const ring = createEventRing();
    emit(ring, SimEvent.Coin, 42, 1, 2, 3, 4);

    expect(eventTypeAt(ring, 0)).toBe(SimEvent.Coin);
    expect(eventTickAt(ring, 0)).toBe(42);
    expect(eventPayloadAt(ring, 0, 0)).toBe(1);
    expect(eventPayloadAt(ring, 0, 1)).toBe(2);
    expect(eventPayloadAt(ring, 0, 2)).toBe(3);
    expect(eventPayloadAt(ring, 0, 3)).toBe(4);
  });

  it("defaults unspecified payload slots to zero", () => {
    const ring = createEventRing();
    emit(ring, SimEvent.Jump, 7);
    for (let slot = 0; slot < ring.payloadSlots; slot += 1) {
      expect(eventPayloadAt(ring, 0, slot)).toBe(0);
    }
  });

  it("never leaves a stale payload from a previous occupant of a slot", () => {
    // All four slots are always written. If they were not, a later event with
    // fewer payloads would read a previous event's values.
    const ring = createEventRing();
    for (let i = 0; i < CAPACITY; i += 1) {
      emit(ring, SimEvent.Coin, i, 9, 9, 9, 9);
    }
    emit(ring, SimEvent.Jump, CAPACITY);

    const index = CAPACITY;
    expect(eventTypeAt(ring, index)).toBe(SimEvent.Jump);
    for (let slot = 0; slot < ring.payloadSlots; slot += 1) {
      expect(eventPayloadAt(ring, index, slot)).toBe(0);
    }
  });

  it("advances head monotonically", () => {
    const ring = createEventRing();
    for (let i = 0; i < 1000; i += 1) {
      emit(ring, SimEvent.Coin, i);
      expect(ring.head).toBe(i + 1);
    }
  });

  it("handles negative and fractional payloads", () => {
    const ring = createEventRing();
    emit(ring, SimEvent.Land, 1, -12.5, 0.001, -0, 1e-9);
    expect(eventPayloadAt(ring, 0, 0)).toBe(-12.5);
    expect(eventPayloadAt(ring, 0, 1)).toBe(0.001);
    expect(eventPayloadAt(ring, 0, 3)).toBe(1e-9);
  });
});

describe("ring wraparound", () => {
  it("overwrites the oldest events once full", () => {
    const ring = createEventRing();
    const OVERFLOW = 10;
    for (let i = 0; i < CAPACITY + OVERFLOW; i += 1) {
      emit(ring, SimEvent.Coin, i);
    }

    expect(oldestReadable(ring)).toBe(OVERFLOW);
    // The overwritten ones report None rather than stale data.
    expect(eventTypeAt(ring, 0)).toBe(SimEvent.None);
    expect(eventTypeAt(ring, OVERFLOW - 1)).toBe(SimEvent.None);
    // The surviving ones are intact.
    expect(eventTypeAt(ring, OVERFLOW)).toBe(SimEvent.Coin);
    expect(eventTickAt(ring, OVERFLOW)).toBe(OVERFLOW);
    expect(eventTickAt(ring, CAPACITY + OVERFLOW - 1)).toBe(CAPACITY + OVERFLOW - 1);
  });

  it("oldestReadable is 0 until the ring fills", () => {
    const ring = createEventRing();
    for (let i = 0; i < CAPACITY; i += 1) {
      emit(ring, SimEvent.Coin, i);
      expect(oldestReadable(ring)).toBe(0);
    }
    emit(ring, SimEvent.Coin, CAPACITY);
    expect(oldestReadable(ring)).toBe(1);
  });

  it("returns None for an index past head", () => {
    const ring = createEventRing();
    emit(ring, SimEvent.Coin, 0);
    expect(eventTypeAt(ring, 1)).toBe(SimEvent.None);
    expect(eventTypeAt(ring, 9999)).toBe(SimEvent.None);
  });

  it("never grows", () => {
    const ring = createEventRing();
    const bytes = ring.type.byteLength + ring.tick.byteLength + ring.payload.byteLength;
    for (let i = 0; i < CAPACITY * 20; i += 1) {
      emit(ring, SimEvent.Coin, i);
    }
    expect(ring.type.byteLength + ring.tick.byteLength + ring.payload.byteLength).toBe(bytes);
  });
});

describe("consumer cursors", () => {
  it("lets render and audio drain independently", () => {
    // The ring holds no per-consumer state, so two consumers at different rates
    // do not interfere.
    const ring = createEventRing();
    for (let i = 0; i < 10; i += 1) {
      emit(ring, SimEvent.Coin, i);
    }

    let renderCursor = 0;
    let audioCursor = 0;

    while (renderCursor < ring.head) {
      expect(eventTickAt(ring, renderCursor)).toBe(renderCursor);
      renderCursor += 1;
    }
    expect(renderCursor).toBe(10);
    expect(audioCursor).toBe(0);

    while (audioCursor < ring.head) {
      audioCursor += 1;
    }
    expect(audioCursor).toBe(10);
  });

  it("clamps a cursor that fell off the back", () => {
    const ring = createEventRing();
    for (let i = 0; i < CAPACITY * 2; i += 1) {
      emit(ring, SimEvent.Coin, i);
    }
    expect(clampCursor(ring, 0)).toBe(oldestReadable(ring));
    expect(clampCursor(ring, ring.head - 1)).toBe(ring.head - 1);
  });

  it("counts events a slow consumer missed", () => {
    const ring = createEventRing();
    const TOTAL = CAPACITY + 25;
    for (let i = 0; i < TOTAL; i += 1) {
      emit(ring, SimEvent.Coin, i);
    }

    const missed = accountForDropped(ring, 0);
    expect(missed).toBe(25);
    expect(ring.dropped).toBe(25);
  });

  it("reports zero missed for a cursor that kept up", () => {
    const ring = createEventRing();
    emit(ring, SimEvent.Coin, 0);
    expect(accountForDropped(ring, 0)).toBe(0);
    expect(ring.dropped).toBe(0);
  });
});

describe("bounds and reset", () => {
  it("returns 0 for an out-of-range payload slot", () => {
    const ring = createEventRing();
    emit(ring, SimEvent.Coin, 0, 5);
    expect(eventPayloadAt(ring, 0, -1)).toBe(0);
    expect(eventPayloadAt(ring, 0, ring.payloadSlots)).toBe(0);
  });

  it("clears fully on reset", () => {
    const ring = createEventRing();
    for (let i = 0; i < CAPACITY * 3; i += 1) {
      emit(ring, SimEvent.Coin, i, 1, 2, 3, 4);
    }
    accountForDropped(ring, 0);

    resetEventRing(ring);

    expect(ring.head).toBe(0);
    expect(ring.dropped).toBe(0);
    expect(eventTypeAt(ring, 0)).toBe(SimEvent.None);
    expect(oldestReadable(ring)).toBe(0);
  });
});

describe("the event catalogue", () => {
  it("gives every event a distinct id", () => {
    const values = Object.values(SimEvent);
    expect(new Set(values).size).toBe(values.length);
  });

  it("reserves 0 for None, so a zeroed buffer reads as empty", () => {
    expect(SimEvent.None).toBe(0);
  });
});
