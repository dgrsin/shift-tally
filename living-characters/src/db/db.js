// SQLite persistence (node:sqlite, built into Node >= 22.13). Single file, WAL mode.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS simulations (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,                 -- running | paused | ended | reset
  scenario TEXT NOT NULL,
  started_at_real INTEGER NOT NULL,     -- epoch ms, real clock
  time_offset_ms INTEGER NOT NULL DEFAULT 0, -- world = real + offset (fast-forward / pause accounting)
  paused_at_real INTEGER,               -- real clock when paused
  last_tick_world INTEGER,              -- world time of last tick
  last_world_advance_world INTEGER,     -- world time of last world-engine LLM advance
  world_state TEXT NOT NULL,            -- JSON (omniscient truth)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sim_id TEXT NOT NULL,
  key TEXT NOT NULL,                    -- idempotency key, unique per sim
  type TEXT NOT NULL,
  status TEXT NOT NULL,                 -- scheduled | completed | cancelled
  fixed INTEGER NOT NULL DEFAULT 0,     -- 1 = predetermined event
  scheduled_world INTEGER NOT NULL,     -- world time at which it (is to) occur(s)
  occurred_world INTEGER,               -- world time recorded as the occurrence
  fired_real INTEGER,                   -- real clock when the engine processed it
  payload TEXT NOT NULL,                -- JSON: description, truth, perceptions {character: text}
  caused_by INTEGER,                    -- parent event id (causality)
  visible_to TEXT NOT NULL DEFAULT '[]',-- JSON array of character names
  created_at INTEGER NOT NULL,
  UNIQUE (sim_id, key)
);
CREATE INDEX IF NOT EXISTS idx_events_due ON events (sim_id, status, scheduled_world);
CREATE TABLE IF NOT EXISTS characters (
  sim_id TEXT NOT NULL,
  name TEXT NOT NULL,
  state TEXT NOT NULL,                  -- JSON (personality, emotions, knowledge, memory, ...)
  last_deliberation_world INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (sim_id, name)
);
CREATE TABLE IF NOT EXISTS deliberations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sim_id TEXT NOT NULL,
  character TEXT NOT NULL,
  world_time INTEGER NOT NULL,
  trigger TEXT NOT NULL,
  input TEXT NOT NULL,                  -- JSON snapshot of what the character saw
  output TEXT NOT NULL,                 -- JSON decision
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sim_id TEXT NOT NULL,
  character TEXT NOT NULL,
  direction TEXT NOT NULL,              -- out (character -> user) | in (user -> character)
  text TEXT NOT NULL,
  world_time INTEGER NOT NULL,
  real_time INTEGER NOT NULL,
  status TEXT NOT NULL,                 -- pending | sent | failed | received
  idempotency_key TEXT NOT NULL,
  telegram_message_id INTEGER,
  telegram_update_id INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_real INTEGER,
  last_error TEXT,
  delay_ms INTEGER NOT NULL DEFAULT 0,  -- natural pause before sending this bubble
  UNIQUE (idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_messages_pending ON messages (status, next_attempt_real);
CREATE TABLE IF NOT EXISTS inbound_updates (
  update_id INTEGER PRIMARY KEY,        -- Telegram update_id dedupe
  bot TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
`;

export function openDb(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return wrap(db);
}

function wrap(db) {
  const stmtCache = new Map();
  const prep = (sql) => {
    let s = stmtCache.get(sql);
    if (!s) { s = db.prepare(sql); stmtCache.set(sql, s); }
    return s;
  };
  const api = {
    raw: db,
    run: (sql, ...params) => prep(sql).run(...params),
    get: (sql, ...params) => prep(sql).get(...params),
    all: (sql, ...params) => prep(sql).all(...params),
    transaction(fn) {
      db.exec('BEGIN IMMEDIATE');
      try { const r = fn(); db.exec('COMMIT'); return r; }
      catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    kvGet(key) { const r = prep('SELECT value FROM kv WHERE key = ?').get(key); return r ? r.value : null; },
    kvSet(key, value) { prep('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value)); },
    kvDel(key) { prep('DELETE FROM kv WHERE key = ?').run(key); },
    close() { db.close(); },
  };
  return api;
}

export const J = {
  parse: (s, d = null) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } },
  str: (o) => JSON.stringify(o),
};
