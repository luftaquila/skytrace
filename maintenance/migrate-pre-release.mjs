#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { isCanonicalSchema, schemaFingerprint } from "../src/db.mjs";

// Exact fingerprint of the sole pre-release schema that was inspected before this breaking
// first release. This is intentionally not a catalogue of historical variants.
export const PRE_RELEASE_SCHEMA_FINGERPRINT =
  "595074bf438b296e8ef1e60573cb694d5afb6f8bfc04abe4f745fa3f2d14eb5f";

const CURRENT_COLUMNS = [
  "receiver_id", "hex", "observed_at", "position_at", "lat", "lon", "flight",
  "alt_baro", "alt_geom", "on_ground", "gs", "ias", "tas", "mach", "track",
  "true_heading", "mag_heading", "baro_rate", "geom_rate", "track_rate", "roll",
  "squawk", "category", "source_type", "source_kind", "emergency", "nav_qnh",
  "nav_altitude_mcp", "nav_altitude_fms", "nav_heading", "wd", "ws", "oat", "tat",
  "nac_p", "nac_v", "nic", "nic_baro", "rc", "sil", "sil_type", "version", "alert",
  "spi", "non_icao", "messages", "rssi", "seen_seconds", "seen_pos_seconds",
];

const TRACK_COLUMNS = [
  "id", "hex", "receiver_id", "observed_at", "position_at", "lat", "lon",
  "alt_baro", "alt_geom", "on_ground", "gs", "ias", "tas", "mach", "track",
  "true_heading", "mag_heading", "baro_rate", "geom_rate", "wd", "ws", "oat",
  "tat", "source_type", "messages", "rssi", "created_at",
];

function maybeFault(options, step) {
  if (options.faultAt === step) throw new Error(`injected migration failure at ${step}`);
}

function assertForeignKeysEnabled(db) {
  if (db.pragma("foreign_keys", { simple: true }) !== 1) {
    throw new Error("failed to restore PRAGMA foreign_keys=ON");
  }
}

export function migratePreReleaseDatabase(db, options = {}) {
  if (isCanonicalSchema(db)) {
    return { status: "already-canonical", fingerprint: schemaFingerprint(db) };
  }
  const beforeFingerprint = schemaFingerprint(db);
  if (beforeFingerprint !== PRE_RELEASE_SCHEMA_FINGERPRINT) {
    throw new Error(
      `unsupported database schema fingerprint ${beforeFingerprint}; expected the inspected pre-release schema`,
    );
  }
  if (db.inTransaction) throw new Error("offline migration requires no active transaction");
  assertForeignKeysEnabled(db);
  maybeFault(options, "after-preflight");

  let committed = false;
  db.pragma("foreign_keys = OFF");
  try {
    db.exec("BEGIN IMMEDIATE");
    db.exec(`
      CREATE TABLE receiver_aircraft_current_new (
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
        ias REAL,
        tas REAL,
        mach REAL,
        track REAL,
        true_heading REAL,
        mag_heading REAL,
        baro_rate REAL,
        geom_rate REAL,
        track_rate REAL,
        roll REAL,
        squawk TEXT,
        category TEXT,
        source_type TEXT,
        source_kind TEXT,
        emergency TEXT,
        nav_qnh REAL,
        nav_altitude_mcp REAL,
        nav_altitude_fms REAL,
        nav_heading REAL,
        wd REAL,
        ws REAL,
        oat REAL,
        tat REAL,
        nac_p INTEGER,
        nac_v INTEGER,
        nic INTEGER,
        nic_baro INTEGER,
        rc INTEGER,
        sil INTEGER,
        sil_type TEXT,
        version INTEGER,
        alert INTEGER,
        spi INTEGER,
        non_icao INTEGER NOT NULL DEFAULT 0,
        messages INTEGER,
        rssi REAL,
        seen_seconds REAL,
        seen_pos_seconds REAL,
        PRIMARY KEY (receiver_id, hex),
        FOREIGN KEY (receiver_id) REFERENCES receivers(id) ON DELETE CASCADE
      )
    `);
    const currentBefore = db.prepare("SELECT COUNT(*) AS count FROM receiver_aircraft_current").get().count;
    const currentChanges = db.prepare(`
      INSERT INTO receiver_aircraft_current_new (${CURRENT_COLUMNS.join(", ")})
      SELECT ${CURRENT_COLUMNS.join(", ")} FROM receiver_aircraft_current
    `).run().changes;
    if (currentChanges !== currentBefore) throw new Error("current-aircraft row count changed during copy");
    maybeFault(options, "after-copy-current");

    db.exec(`
      CREATE TABLE track_points_new (
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
        ias REAL,
        tas REAL,
        mach REAL,
        track REAL,
        true_heading REAL,
        mag_heading REAL,
        baro_rate REAL,
        geom_rate REAL,
        wd REAL,
        ws REAL,
        oat REAL,
        tat REAL,
        source_type TEXT,
        messages INTEGER,
        rssi REAL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        UNIQUE (hex, receiver_id, position_at),
        FOREIGN KEY (receiver_id) REFERENCES receivers(id) ON DELETE CASCADE
      )
    `);
    const trackBefore = db.prepare("SELECT COUNT(*) AS count FROM track_points").get().count;
    const trackChanges = db.prepare(`
      INSERT INTO track_points_new (${TRACK_COLUMNS.join(", ")})
      SELECT ${TRACK_COLUMNS.join(", ")} FROM track_points
    `).run().changes;
    if (trackChanges !== trackBefore) throw new Error("track row count changed during copy");
    maybeFault(options, "after-copy-track");

    db.exec(`
      DROP TABLE receiver_aircraft_current;
      ALTER TABLE receiver_aircraft_current_new RENAME TO receiver_aircraft_current;
      DROP TABLE track_points;
      ALTER TABLE track_points_new RENAME TO track_points;
      ALTER TABLE receivers DROP COLUMN show_position;
      DROP TABLE aircraft_sightings;
      DROP TABLE coverage_cells;
      DROP TABLE coverage_track_state;
      DROP TABLE coverage_receiver_state;

      CREATE TABLE coverage_receiver_state (
        receiver_id TEXT PRIMARY KEY,
        config_key TEXT NOT NULL,
        origin_lat REAL NOT NULL,
        origin_lon REAL NOT NULL,
        last_track_id INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (receiver_id) REFERENCES receivers(id) ON DELETE CASCADE
      );
      CREATE TABLE coverage_track_state (
        receiver_id TEXT NOT NULL,
        hex TEXT NOT NULL,
        position_at TEXT NOT NULL,
        lat REAL NOT NULL,
        lon REAL NOT NULL,
        altitude_ft REAL NOT NULL,
        PRIMARY KEY (receiver_id, hex),
        FOREIGN KEY (receiver_id) REFERENCES receivers(id) ON DELETE CASCADE
      );
      CREATE TABLE coverage_cells (
        receiver_id TEXT NOT NULL,
        config_key TEXT NOT NULL,
        cell_x INTEGER NOT NULL,
        cell_y INTEGER NOT NULL,
        cell_z INTEGER NOT NULL,
        lat REAL NOT NULL,
        lon REAL NOT NULL,
        altitude_ft REAL NOT NULL,
        last_seen_at TEXT NOT NULL,
        hit_count INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (receiver_id, config_key, cell_x, cell_y, cell_z),
        FOREIGN KEY (receiver_id) REFERENCES receivers(id) ON DELETE CASCADE
      );

      CREATE INDEX idx_receiver_current_observed ON receiver_aircraft_current(observed_at);
      CREATE INDEX idx_receiver_current_hex ON receiver_aircraft_current(hex);
      CREATE INDEX idx_track_hex_time ON track_points(hex, position_at, id);
      CREATE INDEX idx_track_hex_id ON track_points(hex, id);
      CREATE INDEX idx_track_time ON track_points(position_at);
      CREATE INDEX idx_track_receiver_id ON track_points(receiver_id, id);
      CREATE INDEX idx_track_receiver_time ON track_points(receiver_id, position_at, id);
      CREATE INDEX idx_batches_received ON ingest_batches(received_at, id);
      CREATE INDEX idx_coverage_cells_active
        ON coverage_cells(receiver_id, config_key, last_seen_at);
      CREATE INDEX idx_coverage_track_state_time
        ON coverage_track_state(receiver_id, position_at);
    `);
    maybeFault(options, "after-rewrite");

    const foreignKeyProblems = db.pragma("foreign_key_check");
    if (foreignKeyProblems.length > 0) {
      throw new Error(`foreign key check failed with ${foreignKeyProblems.length} violation(s)`);
    }
    if (!isCanonicalSchema(db)) throw new Error("rewritten database did not match the canonical fingerprint");
    maybeFault(options, "before-commit");
    db.exec("COMMIT");
    committed = true;
  } catch (error) {
    if (db.inTransaction) db.exec("ROLLBACK");
    throw error;
  } finally {
    if (!committed && db.inTransaction) db.exec("ROLLBACK");
    db.pragma("foreign_keys = ON");
    assertForeignKeysEnabled(db);
  }

  return {
    status: "migrated",
    previousFingerprint: beforeFingerprint,
    fingerprint: schemaFingerprint(db),
  };
}

function openMigrationDatabase(filename) {
  const resolved = path.resolve(filename);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("database path must be an existing regular file, not a symlink");
  }
  const db = new Database(resolved);
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  return db;
}

async function main() {
  if (process.argv.length !== 3) {
    throw new Error("usage: node maintenance/migrate-pre-release.mjs /absolute/path/to/skytrace.db");
  }
  const db = openMigrationDatabase(process.argv[2]);
  try {
    const result = migratePreReleaseDatabase(db);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`migration failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
