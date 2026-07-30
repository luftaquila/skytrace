import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { ensureSchema } from "../server/db.mjs";
import { getCurrentAircraft, ingestReadsb } from "../server/ingest.mjs";

function database() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  ensureSchema(db);
  return db;
}

function options(overrides = {}) {
  return {
    receiverId: "rx-1",
    receivedAt: "2026-07-28T12:00:00.000Z",
    maxObservationAgeSeconds: 120,
    trackMinIntervalSeconds: 0,
    positionFilterMaxMach: 3.5,
    ...overrides,
  };
}

test("ingest truncates a batch at 1000 before normalization", () => {
  const db = database();
  try {
    const aircraft = Array.from({ length: 1001 }, (_, index) => ({
      hex: index.toString(16).padStart(6, "0"),
      seen: 0,
    }));
    const result = ingestReadsb(db, { aircraft }, options());
    assert.equal(result.aircraftCount, 1001);
    assert.equal(result.acceptedCount, 1000);
    assert.equal(result.truncatedCount, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM receiver_aircraft_current").get().count, 1000);
  } finally {
    db.close();
  }
});

test("receiver time, removed aliases and unbounded raw objects cannot poison stored telemetry", () => {
  const db = database();
  try {
    const result = ingestReadsb(db, {
      payload: {
        now: "2099-01-01T00:00:00.000Z",
        aircraft: [{
          hex: "abc123",
          seen: 2,
          seen_pos: 3,
          lat: 37.5,
          lon: 127.1,
          altitude: 99999,
          speed: 9999,
          gs: 9999,
          vert_rate: 9999,
          airground: "ground",
          flight: "THIS-CALLSIGN-IS-FAR-TOO-LONG",
          emergency: { nested: "x".repeat(10000) },
          arbitrary: { nested: "x".repeat(10000) },
        }],
      },
    }, options());
    assert.equal(result.sourceNow, "2099-01-01T00:00:00.000Z");
    assert.ok(result.truncatedFieldCount >= 1);
    assert.ok(result.invalidFieldCount >= 1);
    const row = db.prepare("SELECT * FROM receiver_aircraft_current").get();
    assert.equal(row.observed_at, "2026-07-28T11:59:58.000Z");
    assert.equal(row.position_at, "2026-07-28T11:59:57.000Z");
    assert.equal(row.alt_baro, null);
    assert.equal(row.gs, null);
    assert.equal(row.baro_rate, null);
    assert.equal(row.on_ground, 0);
    assert.equal(row.flight, "THIS-CALLSIGN-IS");
    assert.equal(row.emergency, null);
    assert.equal("source_json" in row, false);
  } finally {
    db.close();
  }
});

test("invalid seen drops an observation while invalid seen_pos clears only its position", () => {
  const db = database();
  try {
    const result = ingestReadsb(db, {
      aircraft: [
        { hex: "abc123", seen: -1, lat: 37, lon: 127, seen_pos: 0 },
        { hex: "def456", seen: 0, lat: 37, lon: 127, seen_pos: 121, gs: 200 },
      ],
    }, options());
    assert.equal(result.acceptedCount, 1);
    assert.equal(result.invalidObservationCount, 1);
    const row = db.prepare("SELECT * FROM receiver_aircraft_current").get();
    assert.equal(row.hex, "def456");
    assert.equal(row.gs, 200);
    assert.equal(row.position_at, null);
    assert.equal(row.lat, null);
    assert.equal(row.lon, null);
  } finally {
    db.close();
  }
});

test("new observations replace sticky telemetry and non-positive position time is rejected", () => {
  const db = database();
  try {
    ingestReadsb(db, {
      aircraft: [{
        hex: "abc123",
        seen: 0,
        seen_pos: 0,
        lat: 37.5,
        lon: 127.1,
        gs: 300,
        emergency: "general",
      }],
    }, options());
    const second = ingestReadsb(db, {
      aircraft: [{
        hex: "abc123",
        seen: 0,
        seen_pos: 0,
        lat: 37.6,
        lon: 127.2,
      }],
    }, options());
    assert.equal(second.filteredPositionCount, 1);
    const row = db.prepare("SELECT * FROM receiver_aircraft_current").get();
    assert.equal(row.position_at, null);
    assert.equal(row.lat, null);
    assert.equal(row.gs, null);
    assert.equal(row.emergency, null);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM track_points").get().count, 1);
  } finally {
    db.close();
  }
});

test("track budget drops permanent history but still updates current state", () => {
  const db = database();
  try {
    const result = ingestReadsb(db, {
      aircraft: [{
        hex: "abc123",
        seen: 0,
        seen_pos: 0,
        lat: 37.5,
        lon: 127.1,
      }],
    }, options({ consumeTrackBudget: () => ({ ok: false }) }));
    assert.equal(result.acceptedCount, 1);
    assert.equal(result.trackPoints, 0);
    assert.equal(result.trackBudgetDroppedCount, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM track_points").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM receiver_aircraft_current").get().count, 1);
  } finally {
    db.close();
  }
});

test("the per-receiver current cardinality cap still permits updates to existing hexes", () => {
  const db = database();
  try {
    db.prepare("INSERT INTO receivers (id) VALUES ('rx-1')").run();
    const insert = db.prepare(`
      INSERT INTO receiver_aircraft_current (receiver_id, hex, observed_at)
      VALUES ('rx-1', ?, '2026-07-28T11:00:00.000Z')
    `);
    db.transaction(() => {
      for (let index = 0; index < 20000; index += 1) {
        insert.run(index.toString(16).padStart(6, "0"));
      }
    })();
    const result = ingestReadsb(db, {
      aircraft: [
        { hex: "000000", seen: 0, gs: 250 },
        { hex: "ffffff", seen: 0, gs: 300 },
      ],
    }, options());
    assert.equal(result.acceptedCount, 1);
    assert.equal(result.currentCapacityDroppedCount, 1);
    assert.equal(db.prepare("SELECT gs FROM receiver_aircraft_current WHERE hex='000000'").get().gs, 250);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM receiver_aircraft_current").get().count, 20000);
    const current = getCurrentAircraft(db, {
      now: "2026-07-28T12:00:00.000Z",
      currentWindowSeconds: 120,
    });
    assert.equal(current.aircraft.length, 1);
  } finally {
    db.close();
  }
});
