import { test } from "node:test";
import assert from "node:assert/strict";
import { migrate, openDb, recordSpend, searchMessages, spendToday } from "../dist/db/index.js";

const seedMessage = (db: ReturnType<typeof openDb>, id: string, content: string) => {
  db.prepare(
    `INSERT INTO rooms (id, name, status, ceilings, rng_seed, started_at, created_at)
     VALUES ('r1', 'room', '{}', '{}', 1, 0, 0) ON CONFLICT(id) DO NOTHING`,
  ).run();
  db.prepare(
    `INSERT INTO messages (id, room_id, speaker_kind, content, turn_index, created_at)
     VALUES (?, 'r1', 'bot', ?, 0, 0)`,
  ).run(id, content);
};

test("migrations run to completion and are idempotent", () => {
  const db = openDb(":memory:");
  const version = migrate(db);
  assert.equal(migrate(db), version);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r) => (r as { name: string }).name);
  for (const t of ["bots", "rooms", "messages", "turns", "permissions", "spend"]) {
    assert.ok(tables.includes(t), `missing table ${t}`);
  }
  db.close();
});

test("full text search finds a seeded message and ignores misses", () => {
  const db = openDb(":memory:");
  seedMessage(db, "m1", "The argo sync is stuck on a PreSync hook");
  seedMessage(db, "m2", "Unrelated chatter about lunch");
  const hits = searchMessages(db, "argo");
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.id, "m1");
  assert.equal(searchMessages(db, "kubernetes").length, 0);
  db.close();
});

test("search tolerates quotes and empty queries without throwing", () => {
  const db = openDb(":memory:");
  seedMessage(db, "m1", "quoting \"trouble\" here");
  assert.deepEqual(searchMessages(db, ""), []);
  assert.equal(searchMessages(db, 'trouble"').length, 1);
  db.close();
});

test("deleting a message removes it from the search index", () => {
  const db = openDb(":memory:");
  seedMessage(db, "m1", "ephemeral thought about helm");
  assert.equal(searchMessages(db, "helm").length, 1);
  db.prepare("DELETE FROM messages WHERE id = 'm1'").run();
  assert.equal(searchMessages(db, "helm").length, 0);
  db.close();
});

test("spend accumulates per day and clamps negatives", () => {
  const db = openDb(":memory:");
  const now = Date.parse("2026-09-10T12:00:00Z");
  recordSpend(db, 1000, 0.5, now);
  recordSpend(db, 500, 0.25, now);
  recordSpend(db, -50, -1, now);
  const spend = spendToday(db, now);
  assert.equal(spend.tokens, 1500);
  assert.equal(spend.costUsd, 0.75);
  assert.equal(spendToday(db, Date.parse("2026-09-11T12:00:00Z")).tokens, 0);
  db.close();
});
