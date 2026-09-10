import { test } from "node:test";
import assert from "node:assert/strict";
import { createEventBus, effectToEvent } from "../dist/events.js";
import type { Envelope } from "../dist/events.js";

test("every subscriber receives a published event", () => {
  const bus = createEventBus();
  const a: Envelope[] = [];
  const b: Envelope[] = [];
  bus.subscribe((e) => a.push(e));
  bus.subscribe((e) => b.push(e));
  bus.publish({ kind: "queueDepth", depth: 3 });
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
  assert.equal(a[0]?.id, 1);
});

test("unsubscribing stops delivery and drops the listener", () => {
  const bus = createEventBus();
  const seen: Envelope[] = [];
  const off = bus.subscribe((e) => seen.push(e));
  bus.publish({ kind: "queueDepth", depth: 1 });
  off();
  bus.publish({ kind: "queueDepth", depth: 2 });
  assert.equal(seen.length, 1);
  assert.equal(bus.subscriberCount(), 0);
});

test("a subscriber that throws is evicted rather than breaking the bus", () => {
  const bus = createEventBus();
  const good: Envelope[] = [];
  bus.subscribe(() => {
    throw new Error("bad listener");
  });
  bus.subscribe((e) => good.push(e));
  bus.publish({ kind: "queueDepth", depth: 1 });
  bus.publish({ kind: "queueDepth", depth: 2 });
  assert.equal(good.length, 2);
  assert.equal(bus.subscriberCount(), 1);
});

test("subscribing with a last seen id replays what was missed", () => {
  const bus = createEventBus();
  bus.publish({ kind: "queueDepth", depth: 1 });
  bus.publish({ kind: "queueDepth", depth: 2 });
  const seen: Envelope[] = [];
  bus.subscribe((e) => seen.push(e), 1);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.id, 2);
});

test("the replay buffer is bounded", () => {
  const bus = createEventBus(3);
  for (let i = 0; i < 10; i += 1) bus.publish({ kind: "queueDepth", depth: i });
  assert.equal(bus.replay(0).length, 3);
  assert.equal(bus.replay(0)[0]?.id, 8);
});

test("effects map onto stream events, and aborts stay internal", () => {
  assert.equal(effectToEvent("r1", { kind: "abortTurn", speaker: "b" as never }), null);
  const announced = effectToEvent("r1", { kind: "announce", text: "quieting down" });
  assert.equal(announced?.kind, "announce");
  const halted = effectToEvent("r1", { kind: "halted", reason: { kind: "manual" } });
  assert.equal(halted?.kind, "halted");
});
