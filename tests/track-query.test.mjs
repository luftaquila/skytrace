import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "../server/app.mjs";
import { loadConfig } from "../server/config.mjs";
import { openDatabase } from "../server/db.mjs";
import { createSseHub } from "../server/sse.mjs";
import { closeTestApp } from "./helpers/server.mjs";

async function withServer(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skytrace-track-query-"));
  const config = loadConfig({
    PORT: "0",
    SKYTRACE_DB_PATH: path.join(dir, "skytrace.db"),
    SKYTRACE_STATIC_DIR: path.join(dir, "missing-dist"),
  });
  const db = openDatabase(config.dbPath);
  db.prepare("INSERT INTO receivers (id) VALUES (?)").run("rx-1");
  const sseHub = createSseHub();
  const app = createApp({ db, config, sseHub });
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({ baseUrl, db, app });
  } finally {
    await closeTestApp({ server, app, sseHub, db, dir });
  }
}

function insertPoint(db, hex, ageSeconds, lat = 37, gs = 320) {
  const positionAt = new Date(Date.now() - ageSeconds * 1000).toISOString();
  return Number(db.prepare(`
    INSERT INTO track_points (
      hex, receiver_id, observed_at, position_at, lat, lon, alt_baro, gs
    )
    VALUES (?, 'rx-1', ?, ?, ?, 127, 12000, ?)
  `).run(hex, positionAt, positionAt, lat, gs).lastInsertRowid);
}

async function query(baseUrl, body) {
  const response = await fetch(`${baseUrl}/api/aircraft/tracks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

test("bulk track API advances mandatory per-aircraft cursors with one detailed target", async () => {
  await withServer(async ({ baseUrl, db }) => {
    const abcCursor = insertPoint(db, "abc123", 300);
    const defCursor = insertPoint(db, "def456", 300, 38);
    const abcNext = insertPoint(db, "abc123", 200, 37.1, 330);
    const defNext = insertPoint(db, "def456", 200, 38.1, 340);

    const result = await query(baseUrl, {
      aircraft: [
        { hex: "ABC123", afterId: abcCursor },
        { hex: "def456", afterId: defCursor },
      ],
      detail: "abc123",
    });
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.body.tracks.map((track) => track.hex), ["abc123", "def456"]);
    assert.deepEqual(result.body.tracks[0].points.map((point) => point.id), [abcNext]);
    assert.equal(result.body.tracks[0].points[0].gs, 330);
    assert.deepEqual(result.body.tracks[1].points.map((point) => point.id), [defNext]);
    assert.equal(result.body.tracks[1].points[0].gs, undefined);
    assert.equal(result.body.tracks[0].cursorId, abcNext);
    assert.equal(result.body.tracks[0].resetRequired, false);
  });
});

test("bulk track API marks missing, wrong-hex and old cursors for reset", async () => {
  await withServer(async ({ baseUrl, db }) => {
    const otherHexCursor = insertPoint(db, "def456", 300);
    const oldCursor = insertPoint(db, "abc123", 25 * 3600);
    for (const afterId of [999999, otherHexCursor, oldCursor]) {
      const result = await query(baseUrl, {
        aircraft: [{ hex: "abc123", afterId }],
        detail: "abc123",
      });
      assert.equal(result.response.status, 200);
      assert.equal(result.body.tracks[0].resetRequired, true);
      assert.deepEqual(result.body.tracks[0].points, []);
    }
  });
});

test("bulk track API rejects legacy fields, missing cursors and more than 32 aircraft", async () => {
  await withServer(async ({ baseUrl }) => {
    for (const body of [
      { aircraft: [{ hex: "abc123" }] },
      { aircraft: [{ hex: "abc123", afterId: 1 }], historic: true },
      { aircraft: [{ hex: "abc123", afterId: 1 }], detail: "def456" },
      {
        aircraft: Array.from({ length: 33 }, (_, index) => ({
          hex: index.toString(16).padStart(6, "0"),
          afterId: index + 1,
        })),
      },
    ]) {
      const result = await query(baseUrl, body);
      assert.equal(result.response.status, 400);
    }
  });
});

test("bulk JSON limits run before parsing and release concurrency on parser errors", async () => {
  await withServer(async ({ baseUrl, app }) => {
    const malformed = await fetch(`${baseUrl}/api/aircraft/tracks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), { ok: false, error: "invalid JSON body" });
    assert.equal(app.locals.requestLimits.stats().bulk.accepted, 1);
    assert.equal(app.locals.requestLimits.stats().bulk.inFlight, 0);

    const oversized = await fetch(`${baseUrl}/api/aircraft/tracks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(64 * 1024) }),
    });
    assert.equal(oversized.status, 413);
    assert.deepEqual(await oversized.json(), { ok: false, error: "request body too large" });
    assert.equal(app.locals.requestLimits.stats().bulk.accepted, 2);
    assert.equal(app.locals.requestLimits.stats().bulk.inFlight, 0);
  });
});

test("bulk track API fairly bounds 32 dense tracks to 10000 rows and uses the hex-id index", async () => {
  await withServer(async ({ baseUrl, db }) => {
    const insert = db.prepare(`
      INSERT INTO track_points (
        hex, receiver_id, observed_at, position_at, lat, lon, alt_baro
      )
      VALUES (?, 'rx-1', ?, ?, 37, 127, 12000)
    `);
    const aircraft = [];
    db.transaction(() => {
      for (let aircraftIndex = 0; aircraftIndex < 32; aircraftIndex += 1) {
        const hex = aircraftIndex.toString(16).padStart(6, "0");
        const at = new Date(Date.now() - 300000).toISOString();
        const afterId = Number(insert.run(hex, at, at).lastInsertRowid);
        aircraft.push({ hex, afterId });
        for (let pointIndex = 0; pointIndex < 400; pointIndex += 1) {
          const pointAt = new Date(Date.now() - (299 - pointIndex * 0.5) * 1000).toISOString();
          insert.run(hex, pointAt, pointAt);
        }
      }
    })();

    const result = await query(baseUrl, { aircraft, detail: aircraft[0].hex });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.tracks.length, 32);
    assert.equal(result.body.tracks.reduce((sum, track) => sum + track.points.length, 0), 9984);
    assert.equal(result.body.tracks.every((track) => track.points.length === 312), true);
    assert.equal(result.body.tracks.every((track) => track.hasMore && track.truncated), true);
    assert.equal("gs" in result.body.tracks[0].points[0], true);
    assert.equal("gs" in result.body.tracks[1].points[0], false);

    const plan = db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT id, position_at
      FROM track_points
      WHERE hex = ? AND id > ? AND position_at >= ?
      ORDER BY id ASC
      LIMIT ?
    `).all("000000", aircraft[0].afterId, new Date(Date.now() - 86400000).toISOString(), 313);
    assert.match(plan.map((row) => row.detail).join("\n"), /idx_track_hex_id/);
  });
});
