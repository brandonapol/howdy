export const migrations: readonly string[] = [
  `
  CREATE TABLE bots (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    model TEXT NOT NULL,
    effort TEXT NOT NULL,
    noisiness REAL NOT NULL,
    cooldown_turns INTEGER NOT NULL,
    avatar_color TEXT NOT NULL,
    bot_dir TEXT NOT NULL,
    workspace_path TEXT NOT NULL,
    allowed_commands TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE rooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    goal TEXT,
    status TEXT NOT NULL,
    ceilings TEXT NOT NULL,
    step_mode INTEGER NOT NULL DEFAULT 0,
    rng_seed INTEGER NOT NULL,
    turn_index INTEGER NOT NULL DEFAULT 0,
    tokens_used INTEGER NOT NULL DEFAULT 0,
    turns_used INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE room_participants (
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    noisiness REAL NOT NULL,
    cooldown_turns INTEGER NOT NULL,
    last_spoke_at_turn INTEGER,
    PRIMARY KEY (room_id, bot_id)
  );

  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    speaker_kind TEXT NOT NULL,
    bot_id TEXT,
    content TEXT NOT NULL,
    turn_index INTEGER NOT NULL,
    tool_call_count INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_messages_room ON messages(room_id, created_at);

  CREATE TABLE turns (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    bot_id TEXT NOT NULL,
    session_id TEXT,
    status TEXT NOT NULL,
    detail TEXT,
    duration_ms INTEGER,
    started_at INTEGER NOT NULL,
    finished_at INTEGER
  );
  CREATE INDEX idx_turns_room ON turns(room_id, started_at);

  CREATE TABLE permissions (
    id TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    tool_name TEXT NOT NULL,
    rule TEXT NOT NULL,
    behavior TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (bot_id, tool_name, rule)
  );

  CREATE TABLE spend (
    day TEXT PRIMARY KEY,
    tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0
  );
  `,
  `
  CREATE VIRTUAL TABLE messages_fts USING fts5(
    content,
    content='messages',
    content_rowid='rowid'
  );

  CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
  END;

  CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  END;

  CREATE TRIGGER messages_fts_update AFTER UPDATE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
    INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
  END;
  `,
  `
  ALTER TABLE rooms ADD COLUMN kind TEXT NOT NULL DEFAULT 'solo';
  ALTER TABLE rooms ADD COLUMN decay_count INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE rooms ADD COLUMN pending_mentions TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE room_participants ADD COLUMN base_noisiness REAL NOT NULL DEFAULT 0.7;
  `,
];
