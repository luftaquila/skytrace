import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";

export function hashToken(token) {
  return crypto.createHash("sha256").update(String(token), "utf8").digest("hex");
}

export function nowIso() {
  return new Date().toISOString();
}

export function openDatabase(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}

export function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS receivers (
      id TEXT PRIMARY KEY,
      name TEXT,
      public_name TEXT,
      lat REAL,
      lon REAL,
      show_position INTEGER NOT NULL DEFAULT 0,
      last_seen_at TEXT,
      last_ip TEXT,
      user_agent TEXT,
      total_ingests INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE IF NOT EXISTS receiver_tokens (
      receiver_id TEXT NOT NULL,
      token_hash TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      last_used_at TEXT,
      FOREIGN KEY (receiver_id) REFERENCES receivers(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS ingest_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      receiver_id TEXT NOT NULL,
      received_at TEXT NOT NULL,
      source_now TEXT,
      aircraft_count INTEGER NOT NULL,
      accepted_count INTEGER NOT NULL,
      track_points INTEGER NOT NULL DEFAULT 0,
      remote_addr TEXT,
      FOREIGN KEY (receiver_id) REFERENCES receivers(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS receiver_aircraft_current (
      receiver_id TEXT NOT NULL,
      hex TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      position_at TEXT,
      lat REAL,
      lon REAL,
      flight TEXT,
      alt_baro REAL,
      alt_geom REAL,
      on_ground INTEGER NOT NULL DEFAULT 0,
      gs REAL,
      track REAL,
      baro_rate REAL,
      squawk TEXT,
      category TEXT,
      messages INTEGER,
      rssi REAL,
      seen_seconds REAL,
      seen_pos_seconds REAL,
      source_json TEXT NOT NULL,
      batch_id INTEGER,
      PRIMARY KEY (receiver_id, hex),
      FOREIGN KEY (receiver_id) REFERENCES receivers(id) ON DELETE CASCADE,
      FOREIGN KEY (batch_id) REFERENCES ingest_batches(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS track_points (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hex TEXT NOT NULL,
      receiver_id TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      position_at TEXT NOT NULL,
      lat REAL NOT NULL,
      lon REAL NOT NULL,
      alt_baro REAL,
      alt_geom REAL,
      on_ground INTEGER NOT NULL DEFAULT 0,
      gs REAL,
      track REAL,
      messages INTEGER,
      batch_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE (hex, receiver_id, position_at),
      FOREIGN KEY (receiver_id) REFERENCES receivers(id) ON DELETE CASCADE,
      FOREIGN KEY (batch_id) REFERENCES ingest_batches(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS aircraft_sightings (
      hex TEXT PRIMARY KEY,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      total_observations INTEGER NOT NULL DEFAULT 0,
      last_flight TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_receiver_current_observed ON receiver_aircraft_current(observed_at);
    CREATE INDEX IF NOT EXISTS idx_receiver_current_hex ON receiver_aircraft_current(hex);
    CREATE INDEX IF NOT EXISTS idx_track_hex_time ON track_points(hex, position_at);
    CREATE INDEX IF NOT EXISTS idx_track_time ON track_points(position_at);
    CREATE INDEX IF NOT EXISTS idx_batches_receiver_time ON ingest_batches(receiver_id, received_at);
  `);
}

export function syncReceiverTokens(db, receiverTokens) {
  if (!receiverTokens?.length) return;
  const upsertReceiver = db.prepare(`
    INSERT INTO receivers (id, name, public_name, updated_at)
    VALUES (@id, @id, @id, @now)
    ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at
  `);
  const upsertToken = db.prepare(`
    INSERT INTO receiver_tokens (receiver_id, token_hash)
    VALUES (@receiverId, @tokenHash)
    ON CONFLICT(token_hash) DO UPDATE SET receiver_id = excluded.receiver_id
  `);

  const tx = db.transaction((entries) => {
    for (const entry of entries) {
      upsertReceiver.run({ id: entry.receiverId, now: nowIso() });
      upsertToken.run({ receiverId: entry.receiverId, tokenHash: hashToken(entry.token) });
    }
  });
  tx(receiverTokens);
}
