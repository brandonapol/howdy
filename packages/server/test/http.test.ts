import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, recordSpend } from "../dist/db/index.js";
import { createEventBus } from "../dist/events.js";
import { createBotStore } from "../dist/bots/store.js";
import { createTurnQueue } from "../dist/orchestrator/queue.js";
import { createApp } from "../dist/http/app.js";

const harness = (over: Record<string, unknown> = {}) => {
  const root = mkdtempSync(join(tmpdir(), "howdy-test-"));
  const config = {
    root,
    dbPath: ":memory:",
    botsDir: join(root, "bots"),
    workspacesDir: join(root, "workspaces"),
    host: "127.0.0.1",
    port: 0,
    sharedSecret: null,
    turnTimeoutMs: 1000,
    dailyTokenCeiling: 1_000_000,
    webDist: null,
    ...over,
  } as never;
  const db = openDb(":memory:");
  const bus = createEventBus();
  const bots = createBotStore(db, config);
  const queue = createTurnQueue({ timeoutMs: 1000 });
  const app = createApp({ config, db, bus, bots, queue });
  return { app, db, bus, bots, queue, config, cleanup: () => rmSync(root, { recursive: true, force: true }) };
};

test("health reports the queue and today's spend", async () => {
  const h = harness();
  const res = await h.app.fetch(new Request("http://x/api/health"));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; queueDepth: number; tokenCeiling: number };
  assert.equal(body.ok, true);
  assert.equal(body.queueDepth, 0);
  assert.equal(body.tokenCeiling, 1_000_000, "the UI meter needs the ceiling before any spend lands");
  h.cleanup();
});

test("a bot can be created, listed, fetched and deleted", async () => {
  const h = harness();
  const created = await h.app.fetch(
    new Request("http://x/api/bots", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Sre Bot" }),
    }),
  );
  assert.equal(created.status, 201);
  const bot = (await created.json()) as { id: string; slug: string };
  assert.equal(bot.slug, "sre-bot");

  const list = (await (await h.app.fetch(new Request("http://x/api/bots"))).json()) as unknown[];
  assert.equal(list.length, 1);

  const fetched = (await (
    await h.app.fetch(new Request(`http://x/api/bots/${bot.id}`))
  ).json()) as { personality: string };
  assert.match(fetched.personality, /Who you are/);

  const removed = await h.app.fetch(new Request(`http://x/api/bots/${bot.id}`, { method: "DELETE" }));
  assert.equal(removed.status, 200);
  h.cleanup();
});

test("creating a bot without a name is rejected", async () => {
  const h = harness();
  const res = await h.app.fetch(
    new Request("http://x/api/bots", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "  " }),
    }),
  );
  assert.equal(res.status, 400);
  h.cleanup();
});

test("duplicate names get distinct slugs and distinct workspaces", async () => {
  const h = harness();
  const a = h.bots.create({ name: "Twin" });
  const b = h.bots.create({ name: "Twin" });
  assert.equal(a.slug, "twin");
  assert.equal(b.slug, "twin-2");
  assert.notEqual(a.workspacePath, b.workspacePath);
  h.cleanup();
});

test("a message to a missing bot is rejected before anything is spawned", async () => {
  const h = harness();
  const res = await h.app.fetch(
    new Request("http://x/api/rooms/general/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "howdy", botId: "nope" }),
    }),
  );
  assert.equal(res.status, 400);
  assert.equal(h.queue.depth(), 0);
  h.cleanup();
});

test("an empty message is rejected", async () => {
  const h = harness();
  const bot = h.bots.create({ name: "Sre" });
  const res = await h.app.fetch(
    new Request("http://x/api/rooms/general/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "   ", botId: bot.id }),
    }),
  );
  assert.equal(res.status, 400);
  h.cleanup();
});

test("the daily token ceiling refuses a turn before it spawns a subprocess", async () => {
  const h = harness({ dailyTokenCeiling: 1000 });
  const bot = h.bots.create({ name: "Spendy" });
  recordSpend(h.db, 1500, 1);
  const res = await h.app.fetch(
    new Request("http://x/api/rooms/general/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "burn some tokens", botId: bot.id }),
    }),
  );
  assert.equal(res.status, 429);
  assert.equal(h.queue.depth(), 0);
  h.cleanup();
});

test("the shared secret gates the api but never the health check", async () => {
  const h = harness({ sharedSecret: "hunter2" });
  assert.equal((await h.app.fetch(new Request("http://x/api/health"))).status, 200);
  assert.equal((await h.app.fetch(new Request("http://x/api/bots"))).status, 401);
  const ok = await h.app.fetch(
    new Request("http://x/api/bots", { headers: { "x-howdy-secret": "hunter2" } }),
  );
  assert.equal(ok.status, 200);

  const viaQuery = await h.app.fetch(new Request("http://x/api/bots?secret=hunter2"));
  assert.equal(viaQuery.status, 200, "EventSource cannot set headers, so the query param must work");
  assert.equal((await h.app.fetch(new Request("http://x/api/bots?secret=wrong"))).status, 401);
  h.cleanup();
});

test("halting a room that does not exist is reported, not silently ignored", async () => {
  const h = harness();
  const res = await h.app.fetch(new Request("http://x/api/rooms/ghost/halt", { method: "POST" }));
  assert.equal(res.status, 404);
  h.cleanup();
});

test("halt stops a real room and panic announces across everything", async () => {
  const h = harness();
  const bot = h.bots.create({ name: "Sre" });
  const seen: string[] = [];
  h.bus.subscribe((e) => seen.push(e.event.kind));

  const room = await h.app.fetch(
    new Request("http://x/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "party", kind: "party", participants: [{ botId: bot.id }] }),
    }),
  );
  const created = (await room.json()) as { id: string };

  const halted = await h.app.fetch(
    new Request(`http://x/api/rooms/${created.id}/halt`, { method: "POST" }),
  );
  assert.equal(halted.status, 200);
  assert.ok(seen.includes("halted"));

  const panicked = await h.app.fetch(new Request("http://x/api/panic", { method: "POST" }));
  assert.equal(panicked.status, 200);
  assert.ok(seen.includes("announce"));
  h.cleanup();
});

test("messages persist and come back in order, and search finds them", async () => {
  const h = harness();
  h.db.prepare(
    `INSERT INTO rooms (id, name, status, ceilings, rng_seed, started_at, created_at)
     VALUES ('general','general','{}','{}',1,0,0)`,
  ).run();
  h.db.prepare(
    `INSERT INTO messages (id, room_id, speaker_kind, content, turn_index, created_at)
     VALUES ('m1','general','human','the argo sync is wedged',0,1),
            ('m2','general','bot','looking at the presync hook',1,2)`,
  ).run();
  const list = (await (
    await h.app.fetch(new Request("http://x/api/rooms/general/messages"))
  ).json()) as { id: string }[];
  assert.deepEqual(list.map((m) => m.id), ["m1", "m2"]);

  const hits = (await (
    await h.app.fetch(new Request("http://x/api/search?q=presync"))
  ).json()) as unknown[];
  assert.equal(hits.length, 1);
  h.cleanup();
});
