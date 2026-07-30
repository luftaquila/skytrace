import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { ensureSchema } from "../server/db.mjs";
import { queryAircraftHistory } from "../server/history-query.mjs";

const NOW = Date.parse("2026-07-28T12:00:00.000Z");

function database() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  ensureSchema(db);
  db.prepare("INSERT INTO receivers (id) VALUES ('rx-1')").run();
  return db;
}

function seed(db, count, { hex = "abc123", startMs = NOW - 86400000 } = {}) {
  const insert = db.prepare(`
    INSERT INTO track_points (
      hex, receiver_id, observed_at, position_at, lat, lon, alt_baro
    ) VALUES (?, 'rx-1', ?, ?, 37.5, 127.1, 12000)
  `);
  db.transaction(() => {
    for (let index = 0; index < count; index += 1) {
      const at = new Date(startMs + index * 1000).toISOString();
      insert.run(hex, at, at);
    }
  })();
}

test("history cursors expose every retained point exactly once in bounded pages", () => {
  const db = database();
  try {
    seed(db, 12003);
    const ids = [];
    let cursor = null;
    let first = true;
    do {
      const page = queryAircraftHistory(db, "ABC123", {
        now: new Date(NOW).toISOString(),
        retentionDays: 90,
        limit: 5000,
        olderCursor: cursor,
      });
      assert.ok(page.points.length <= 5000);
      assert.equal(page.points.every((point, index, rows) =>
        index === 0 || point.positionAt >= rows[index - 1].positionAt), true);
      if (first) {
        assert.equal(page.liveCursorId, 12003);
        assert.equal(page.points.at(-1).id, 12003);
        first = false;
      }
      ids.push(...page.points.map((point) => point.id));
      cursor = page.olderCursor;
      assert.equal(page.hasOlder, Boolean(cursor));
    } while (cursor);
    assert.equal(ids.length, 12003);
    assert.equal(new Set(ids).size, 12003);
    assert.deepEqual([...ids].sort((a, b) => a - b), Array.from({ length: 12003 }, (_, i) => i + 1));

    const plan = db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT id FROM track_points
      WHERE hex = ? AND (position_at, id) < (?, ?)
      ORDER BY position_at DESC, id DESC LIMIT 5001
    `).all("abc123", new Date(NOW).toISOString(), Number.MAX_SAFE_INTEGER);
    assert.match(plan.map((row) => row.detail).join("\n"), /idx_track_hex_time/);
  } finally {
    db.close();
  }
});

test("history supports bounded date jumps, empty tracks and validates cursors", () => {
  const db = database();
  try {
    seed(db, 10);
    const at = new Date(NOW - 86400000 + 5.5 * 1000).toISOString();
    const jumped = queryAircraftHistory(db, "abc123", {
      now: new Date(NOW).toISOString(),
      retentionDays: 90,
      limit: 3,
      at,
    });
    assert.deepEqual(jumped.points.map((point) => point.id), [4, 5, 6]);

    const latest = queryAircraftHistory(db, "abc123", {
      now: new Date(NOW).toISOString(),
      retentionDays: 90,
      limit: 3,
    });
    const tampered = `${latest.olderCursor.slice(0, -1)}x`;
    assert.throws(
      () => queryAircraftHistory(db, "abc123", {
        now: new Date(NOW).toISOString(),
        olderCursor: tampered,
      }),
      (error) => error.status === 400,
    );
    assert.throws(
      () => queryAircraftHistory(db, "def456", {
        now: new Date(NOW).toISOString(),
        olderCursor: latest.olderCursor,
      }),
      (error) => error.status === 400,
    );

    const empty = queryAircraftHistory(db, "def456", {
      now: new Date(NOW).toISOString(),
      retentionDays: 90,
    });
    assert.deepEqual(empty.points, []);
    assert.equal(empty.liveCursorId, null);
    assert.equal(empty.olderCursor, null);
  } finally {
    db.close();
  }
});

test("history distinguishes a retention-expired server cursor with 410", () => {
  const db = database();
  try {
    seed(db, 3, { startMs: NOW - 80 * 86400000 });
    const page = queryAircraftHistory(db, "abc123", {
      now: new Date(NOW).toISOString(),
      retentionDays: 90,
      limit: 1,
    });
    assert.ok(page.olderCursor);
    assert.throws(
      () => queryAircraftHistory(db, "abc123", {
        now: new Date(NOW + 20 * 86400000).toISOString(),
        retentionDays: 90,
        olderCursor: page.olderCursor,
      }),
      (error) => error.status === 410,
    );
  } finally {
    db.close();
  }
});
