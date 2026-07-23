import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "../src/app.mjs";
import { loadConfig } from "../src/config.mjs";
import { openDatabase } from "../src/db.mjs";
import { createSseHub } from "../src/sse.mjs";

async function withServer(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skytrace-track-query-"));
  const config = loadConfig({
    PORT: "0",
    SKYTRACE_DB_PATH: path.join(dir, "skytrace.db"),
    SKYTRACE_STATIC_DIR: path.join(dir, "missing-dist"),
  });
  const db = openDatabase(config.dbPath);
  db.prepare("INSERT INTO receivers (id) VALUES (?)").run("rx-1");
  const app = createApp({ db, config, sseHub: createSseHub() });
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({ baseUrl, db });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function insertPoint(db, hex, minute, lat = 37) {
  const positionAt = new Date(Date.UTC(2026, 6, 23, 0, minute)).toISOString();
  return db.prepare(`
    INSERT INTO track_points (hex, receiver_id, observed_at, position_at, lat, lon, alt_baro)
    VALUES (?, 'rx-1', ?, ?, ?, 127, 12000)
  `).run(hex, positionAt, positionAt, lat).lastInsertRowid;
}

async function query(baseUrl, aircraft, historic = false) {
  const response = await fetch(`${baseUrl}/api/aircraft/tracks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      aircraft,
      historic,
      from: "2026-07-23T00:00:00.000Z",
      to: "2026-07-23T01:00:00.000Z",
    }),
  });
  assert.equal(response.status, 200);
  return response.json();
}

test("bulk track API returns current runs and per-aircraft incremental cursors", async () => {
  await withServer(async ({ baseUrl, db }) => {
    insertPoint(db, "abc123", 0);
    insertPoint(db, "abc123", 5);
    const currentStart = insertPoint(db, "abc123", 20);
    insertPoint(db, "abc123", 25);
    insertPoint(db, "def456", 22, 38);

    const current = await query(baseUrl, [{ hex: "ABC123" }, { hex: "def456" }]);
    assert.deepEqual(current.tracks.map((track) => track.hex), ["abc123", "def456"]);
    assert.deepEqual(current.tracks[0].points.map((point) => point.id), [Number(currentStart), Number(currentStart) + 1]);
    assert.equal(current.tracks[0].points[0].receiverId, undefined);
    assert.equal(current.tracks[0].points[0].gs, undefined);

    const cursorId = current.tracks[0].cursorId;
    const nextId = insertPoint(db, "abc123", 30);
    const incremental = await query(baseUrl, [{ hex: "abc123", afterId: cursorId }]);
    assert.deepEqual(incremental.tracks[0].points.map((point) => point.id), [Number(nextId)]);
    assert.equal(incremental.tracks[0].cursorId, Number(nextId));
  });
});

test("bulk track API includes disconnected flights only in historic mode", async () => {
  await withServer(async ({ baseUrl, db }) => {
    insertPoint(db, "abc123", 0);
    insertPoint(db, "abc123", 5);
    insertPoint(db, "abc123", 20);
    insertPoint(db, "abc123", 25);

    const historic = await query(baseUrl, [{ hex: "abc123" }], true);
    assert.equal(historic.historic, true);
    assert.equal(historic.tracks[0].points.length, 4);
  });
});

test("bulk track API rejects oversized visible-aircraft sets", async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/aircraft/tracks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ aircraft: Array.from({ length: 251 }, () => ({ hex: "abc123" })) }),
    });
    assert.equal(response.status, 400);
  });
});
