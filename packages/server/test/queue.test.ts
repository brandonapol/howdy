import { test } from "node:test";
import assert from "node:assert/strict";
import { TurnTimeoutError, createTurnQueue } from "../dist/orchestrator/queue.js";

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason as Error);
    });
  });

test("jobs run strictly one at a time", async () => {
  const queue = createTurnQueue({ timeoutMs: 5000 });
  let concurrent = 0;
  let peak = 0;
  const order: number[] = [];

  await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      queue.submit({
        key: `job-${i}`,
        run: async () => {
          concurrent += 1;
          peak = Math.max(peak, concurrent);
          await sleep(5);
          order.push(i);
          concurrent -= 1;
          return i;
        },
      }),
    ),
  );

  assert.equal(peak, 1);
  assert.deepEqual(order, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(queue.depth(), 0);
});

test("a hung turn is reaped by the watchdog and the queue keeps going", async () => {
  const queue = createTurnQueue({ timeoutMs: 60 });
  let secondRan = false;

  const hung = queue.submit({
    key: "hung",
    run: (signal) => sleep(10_000, signal),
  });
  const next = queue.submit({
    key: "next",
    run: async () => {
      secondRan = true;
      return "ok";
    },
  });

  await assert.rejects(hung, (e: unknown) => e instanceof TurnTimeoutError);
  assert.equal(await next, "ok");
  assert.ok(secondRan);
});

test("aborting a running turn rejects it and releases the queue", async () => {
  const queue = createTurnQueue({ timeoutMs: 5000 });
  const running = queue.submit({ key: "long", run: (signal) => sleep(10_000, signal) });
  await sleep(10);
  assert.equal(queue.abort("long"), true);
  await assert.rejects(running);
  assert.equal(await queue.submit({ key: "after", run: async () => "after" }), "after");
});

test("aborting a queued turn removes it before it ever starts", async () => {
  const queue = createTurnQueue({ timeoutMs: 5000 });
  let queuedRan = false;
  const first = queue.submit({ key: "first", run: (signal) => sleep(200, signal) });
  const queued = queue.submit({
    key: "queued",
    run: async () => {
      queuedRan = true;
      return "nope";
    },
  });

  await sleep(10);
  assert.equal(queue.abort("queued"), true);
  await assert.rejects(queued);
  await first.catch(() => undefined);
  assert.equal(queuedRan, false);
});

test("abortAll clears the running turn and everything pending", async () => {
  const queue = createTurnQueue({ timeoutMs: 5000 });
  const jobs = Array.from({ length: 4 }, (_, i) =>
    queue.submit({ key: `j${i}`, run: (signal) => sleep(10_000, signal) }),
  );
  await sleep(10);
  assert.equal(queue.abortAll(), 4);
  await Promise.all(jobs.map((j) => assert.rejects(j)));
  assert.equal(queue.depth(), 0);
});

test("aborting an unknown key reports false", async () => {
  const queue = createTurnQueue({ timeoutMs: 5000 });
  assert.equal(queue.abort("ghost"), false);
});

test("depth changes are reported and drain waits for the backlog", async () => {
  const depths: number[] = [];
  const queue = createTurnQueue({
    timeoutMs: 5000,
    onDepthChange: (d) => depths.push(d),
  });
  const jobs = Array.from({ length: 3 }, (_, i) =>
    queue.submit({ key: `d${i}`, run: () => sleep(5).then(() => i) }),
  );
  assert.ok(Math.max(...depths) >= 3);
  await queue.drain();
  await Promise.all(jobs);
  assert.equal(queue.depth(), 0);
});

test("a failing turn does not wedge the queue", async () => {
  const queue = createTurnQueue({ timeoutMs: 5000 });
  const boom = queue.submit({
    key: "boom",
    run: async () => {
      throw new Error("kaboom");
    },
  });
  await assert.rejects(boom, /kaboom/);
  assert.equal(await queue.submit({ key: "fine", run: async () => 42 }), 42);
});
