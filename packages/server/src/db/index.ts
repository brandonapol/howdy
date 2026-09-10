import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { migrations } from "./migrations.js";

export type Db = Database.Database;

export const openDb = (path: string): Db => {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
};

export const migrate = (db: Db): number => {
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  const row = db.prepare("SELECT version FROM schema_version LIMIT 1").get() as
    | { version: number }
    | undefined;
  const current = row?.version ?? 0;
  if (row === undefined) db.prepare("INSERT INTO schema_version (version) VALUES (0)").run();

  const pending = migrations.slice(current);
  if (pending.length === 0) return current;

  const apply = db.transaction((sqls: readonly string[], from: number) => {
    sqls.forEach((sql) => db.exec(sql));
    db.prepare("UPDATE schema_version SET version = ?").run(from + sqls.length);
  });
  apply(pending, current);
  return current + pending.length;
};

export const today = (now: number = Date.now()): string =>
  new Date(now).toISOString().slice(0, 10);

export const recordSpend = (db: Db, tokens: number, costUsd: number, now = Date.now()): void => {
  db.prepare(
    `INSERT INTO spend (day, tokens, cost_usd) VALUES (?, ?, ?)
     ON CONFLICT(day) DO UPDATE SET tokens = tokens + excluded.tokens, cost_usd = cost_usd + excluded.cost_usd`,
  ).run(today(now), Math.max(0, Math.round(tokens)), Math.max(0, costUsd));
};

export const spendToday = (db: Db, now = Date.now()): { tokens: number; costUsd: number } => {
  const row = db.prepare("SELECT tokens, cost_usd AS costUsd FROM spend WHERE day = ?").get(today(now)) as
    | { tokens: number; costUsd: number }
    | undefined;
  return row ?? { tokens: 0, costUsd: 0 };
};

export const spendWindow = (
  db: Db,
  days: number,
  now = Date.now(),
): { tokens: number; costUsd: number } => {
  const from = today(now - (days - 1) * 24 * 60 * 60 * 1000);
  const row = db
    .prepare("SELECT COALESCE(SUM(tokens),0) AS tokens, COALESCE(SUM(cost_usd),0) AS costUsd FROM spend WHERE day >= ?")
    .get(from) as { tokens: number; costUsd: number };
  return row;
};

export const searchMessages = (
  db: Db,
  query: string,
  limit = 10,
): readonly { id: string; roomId: string; content: string; createdAt: number }[] => {
  const trimmed = query.trim();
  if (trimmed === "") return [];
  const escaped = `"${trimmed.replace(/"/g, '""')}"`;
  return db
    .prepare(
      `SELECT m.id AS id, m.room_id AS roomId, m.content AS content, m.created_at AS createdAt
       FROM messages_fts f JOIN messages m ON m.rowid = f.rowid
       WHERE messages_fts MATCH ? ORDER BY rank LIMIT ?`,
    )
    .all(escaped, limit) as never;
};
