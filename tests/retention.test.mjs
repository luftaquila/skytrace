import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDatabase } from "../src/db.mjs";
import { createRetention } from "../src/retention.mjs";

const NOW = Date.parse("2026-07-28T12:00:00.000Z");
const isoBefore = (milliseconds) => new Date(NOW - milliseconds).toISOString();
const isoAfter = (milliseconds) => new Date(NOW + milliseconds).toISOString();

async function withRetentionDatabase(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skytrace-retention-"));
  const dbPath = path.join(dir, "skytrace.db");
  const db = openDatabase(dbPath);
  for (const id of ["rx-1", "rx-2", "rx-3"]) {
    db.prepare("INSERT INTO receivers (id) VALUES (?)").run(id);
  }
  let retention;
  try {
    retention = createRetention({
      dbPath,
      firstRunMs: 3600000,
      now: () => NOW,
      logger: { info() {}, warn() {}, error() {} },
    });
    await fn({ db, retention });
  } finally {
    await retention?.close();
    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function insertTrack(db, receiverId, hex, positionAt) {
  db.prepare(`
    INSERT INTO track_points (
      hex, receiver_id, observed_at, position_at, lat, lon
    ) VALUES (?, ?, ?, ?, 37.5, 127.1)
  `).run(hex, receiverId, positionAt, positionAt);
}

function insertCurrent(db, receiverId, hex, observedAt) {
  db.prepare(`
    INSERT INTO receiver_aircraft_current (receiver_id, hex, observed_at)
    VALUES (?, ?, ?)
  `).run(receiverId, hex, observedAt);
}

function insertBatch(db, receiverId, receivedAt) {
  db.prepare(`
    INSERT INTO ingest_batches (
      receiver_id, received_at, aircraft_count, accepted_count
    ) VALUES (?, ?, 0, 0)
  `).run(receiverId, receivedAt);
}

test("retention prunes by timestamps, including receivers without coverage state and future poison", async () => {
  await withRetentionDatabase(async ({ db, retention }) => {
    insertTrack(db, "rx-1", "aaa001", isoBefore(100 * 86400000));
    insertTrack(db, "rx-1", "aaa002", isoBefore(89 * 86400000));
    insertTrack(db, "rx-3", "aaa003", isoBefore(200 * 86400000));
    insertTrack(db, "rx-2", "aaa004", isoAfter(10 * 60000));
    db.prepare(`
      INSERT INTO coverage_receiver_state (
        receiver_id, config_key, origin_lat, origin_lon, last_track_id, updated_at
      ) VALUES ('rx-1', 'test', 37.5, 127, 0, ?)
    `).run(new Date(NOW).toISOString());

    // Insert out of chronological order: deletion must use timestamps, never AUTOINCREMENT ids.
    insertBatch(db, "rx-1", isoBefore(6 * 86400000));
    insertBatch(db, "rx-1", isoBefore(8 * 86400000));
    insertCurrent(db, "rx-1", "bbb001", isoBefore(23 * 3600000));
    insertCurrent(db, "rx-1", "bbb002", isoBefore(25 * 3600000));
    insertCurrent(db, "rx-2", "bbb003", isoAfter(10 * 60000));

    const result = await retention.runNow();
    assert.equal(result.complete, true);
    assert.equal(result.trackOld, 2);
    assert.equal(result.trackFuture, 1);
    assert.equal(result.batches, 1);
    assert.equal(result.currentOld, 1);
    assert.equal(result.currentFuture, 1);
    assert.deepEqual(
      db.prepare("SELECT hex FROM track_points ORDER BY hex").all().map((row) => row.hex),
      ["aaa002"],
    );
    assert.deepEqual(
      db.prepare("SELECT received_at FROM ingest_batches").all().map((row) => row.received_at),
      [isoBefore(6 * 86400000)],
    );
    assert.deepEqual(
      db.prepare("SELECT hex FROM receiver_aircraft_current").all().map((row) => row.hex),
      ["bbb001"],
    );
    assert.equal(result.cursorWarnings.length, 1);
    assert.equal(result.cursorWarnings[0].receiverId, "rx-1");
    assert.deepEqual(result.futureRows.map((row) => row.table).sort(), [
      "receiver_aircraft_current",
      "track_points",
    ]);
    assert.ok(Number.isInteger(result.storage.pageCount));
    assert.ok(Number.isInteger(result.storage.freelistCount));
  });
});

test("a short retention budget resumes in later worker runs and close is idempotent", async () => {
  await withRetentionDatabase(async ({ db, retention }) => {
    const insert = db.prepare(`
      INSERT INTO track_points (
        hex, receiver_id, observed_at, position_at, lat, lon
      ) VALUES (?, 'rx-1', ?, ?, 37.5, 127.1)
    `);
    const old = isoBefore(100 * 86400000);
    db.transaction(() => {
      for (let index = 0; index < 6000; index += 1) {
        insert.run(index.toString(16).padStart(6, "0"), old, old);
      }
    })();

    // Create a second worker with a deliberately tiny tick budget.
    const tiny = createRetention({
      dbPath: db.name,
      firstRunMs: 3600000,
      budgetMs: 1,
      now: () => NOW,
      logger: { info() {}, warn() {}, error() {} },
    });
    try {
      let result;
      for (let run = 0; run < 20; run += 1) {
        result = await tiny.runNow();
        if (result.complete) break;
      }
      assert.equal(result.complete, true);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM track_points").get().count, 0);
      await tiny.close();
      await tiny.close();
    } finally {
      await tiny.close();
    }

    // The fixture-owned worker remains independently closable after the peer worker exits.
    assert.equal(retention.state().running, false);
  });
});
