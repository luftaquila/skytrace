import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import Database from "better-sqlite3";
import {
  isCanonicalSchema,
  migrate,
  schemaFingerprint,
} from "../src/db.mjs";
import {
  migratePreReleaseDatabase,
  PRE_RELEASE_SCHEMA_FINGERPRINT,
} from "../maintenance/migrate-pre-release.mjs";

const PRE_RELEASE_SCHEMA = fs.readFileSync(
  new URL("./fixtures/pre-release-schema.sql", import.meta.url),
  "utf8",
);

function legacyDatabase({ seed = true } = {}) {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(PRE_RELEASE_SCHEMA);
  if (seed) {
    db.prepare(`
      INSERT INTO receivers (id, name, show_position) VALUES ('rx-1', 'Receiver', 1)
    `).run();
    const batchId = Number(db.prepare(`
      INSERT INTO ingest_batches (
        receiver_id, received_at, aircraft_count, accepted_count, track_points
      ) VALUES ('rx-1', '2026-07-28T00:00:00.000Z', 1, 1, 1)
    `).run().lastInsertRowid);
    db.prepare(`
      INSERT INTO receiver_aircraft_current (
        receiver_id, hex, observed_at, position_at, lat, lon, source_json, batch_id
      ) VALUES ('rx-1', 'abc123', '2026-07-28T00:00:00.000Z',
        '2026-07-28T00:00:00.000Z', 37.5, 127.1, '{"hex":"abc123"}', ?)
    `).run(batchId);
    db.prepare(`
      INSERT INTO track_points (
        hex, receiver_id, observed_at, position_at, lat, lon, batch_id
      ) VALUES ('abc123', 'rx-1', '2026-07-28T00:00:00.000Z',
        '2026-07-28T00:00:00.000Z', 37.5, 127.1, ?)
    `).run(batchId);
    db.prepare(`
      INSERT INTO aircraft_sightings (
        hex, first_seen_at, last_seen_at, total_observations
      ) VALUES ('abc123', '2026-07-28T00:00:00.000Z', '2026-07-28T00:00:00.000Z', 1)
    `).run();
    db.prepare(`
      INSERT INTO coverage_receiver_state (
        receiver_id, schema_key, origin_lat, origin_lon, last_track_id, updated_at
      ) VALUES ('rx-1', 'old', 37.5, 127.1, 1, '2026-07-28T00:00:00.000Z')
    `).run();
  }
  return db;
}

test("the inspected pre-release fixture has the one accepted fingerprint", () => {
  const db = legacyDatabase({ seed: false });
  try {
    assert.equal(schemaFingerprint(db), PRE_RELEASE_SCHEMA_FINGERPRINT);
  } finally {
    db.close();
  }
});

test("one-shot migration preserves observations and produces the exact canonical schema", () => {
  const db = legacyDatabase();
  try {
    const result = migratePreReleaseDatabase(db);
    assert.equal(result.status, "migrated");
    assert.equal(isCanonicalSchema(db), true);
    assert.equal(db.pragma("foreign_keys", { simple: true }), 1);
    assert.equal(db.pragma("foreign_key_check").length, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM receiver_aircraft_current").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM track_points").get().count, 1);
    assert.equal(db.prepare("SELECT hex FROM track_points").get().hex, "abc123");

    const tableNames = db.prepare(`
      SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'
    `).all().map((row) => row.name);
    assert.equal(tableNames.includes("aircraft_sightings"), false);
    assert.equal(db.prepare("PRAGMA table_info(receivers)").all().some((row) => row.name === "show_position"), false);
    for (const table of ["receiver_aircraft_current", "track_points"]) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
      assert.equal(columns.includes("batch_id"), false);
      assert.equal(columns.includes("source_json"), false);
      const foreignTables = db.prepare(`PRAGMA foreign_key_list(${table})`).all()
        .map((row) => row.table);
      assert.deepEqual(foreignTables, ["receivers"]);
    }
    const indexes = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type='index' AND name NOT LIKE 'sqlite_autoindex_%'
      ORDER BY name
    `).all().map((row) => row.name);
    assert.deepEqual(indexes, [
      "idx_batches_received",
      "idx_batches_receiver_time",
      "idx_coverage_cells_active",
      "idx_coverage_track_state_time",
      "idx_receiver_current_hex",
      "idx_receiver_current_observed",
      "idx_track_hex_id",
      "idx_track_hex_time",
      "idx_track_receiver_id",
      "idx_track_receiver_time",
      "idx_track_time",
    ]);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM coverage_receiver_state").get().count, 0);
  } finally {
    db.close();
  }
});

test("canonical databases are a no-op and arbitrary schemas are rejected", () => {
  const canonical = new Database(":memory:");
  canonical.pragma("foreign_keys = ON");
  migrate(canonical);
  try {
    const before = schemaFingerprint(canonical);
    assert.equal(migratePreReleaseDatabase(canonical).status, "already-canonical");
    assert.equal(schemaFingerprint(canonical), before);
  } finally {
    canonical.close();
  }

  const arbitrary = legacyDatabase({ seed: false });
  try {
    arbitrary.exec("CREATE INDEX unexpected_index ON receivers(name)");
    assert.throws(
      () => migratePreReleaseDatabase(arbitrary),
      /unsupported database schema fingerprint/,
    );
    assert.equal(arbitrary.pragma("foreign_keys", { simple: true }), 1);
  } finally {
    arbitrary.close();
  }
});

test("every injected migration failure rolls back schema and data and restores foreign keys", () => {
  for (const faultAt of [
    "after-preflight",
    "after-copy-current",
    "after-copy-track",
    "after-rewrite",
    "before-commit",
  ]) {
    const db = legacyDatabase();
    try {
      const before = schemaFingerprint(db);
      assert.throws(
        () => migratePreReleaseDatabase(db, { faultAt }),
        new RegExp(`injected migration failure at ${faultAt}`),
      );
      assert.equal(schemaFingerprint(db), before, faultAt);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM track_points").get().count, 1);
      assert.equal(db.prepare("SELECT source_json FROM receiver_aircraft_current").get().source_json, '{"hex":"abc123"}');
      assert.equal(db.pragma("foreign_keys", { simple: true }), 1);
    } finally {
      db.close();
    }
  }
});
