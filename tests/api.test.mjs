import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server/app.mjs";
import { loadConfig } from "../server/config.mjs";
import { openDatabase, syncReceiverTokens } from "../server/db.mjs";
import { createSseHub } from "../server/sse.mjs";
import { closeTestApp } from "./helpers/server.mjs";

const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

async function withServer(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skytrace-test-"));
  const config = loadConfig({
    PORT: "0",
    SKYTRACE_DB_PATH: path.join(dir, "skytrace.db"),
    SKYTRACE_RECEIVER_TOKENS: JSON.stringify({ "rx-1": TOKEN }),
    SKYTRACE_CURRENT_WINDOW_SECONDS: "120",
    SKYTRACE_MAX_OBSERVATION_AGE_SECONDS: "120",
    SKYTRACE_TRACK_MIN_INTERVAL_SECONDS: "0",
    SKYTRACE_STATIC_DIR: path.join(dir, "missing-dist"),
  });
  const db = openDatabase(config.dbPath);
  syncReceiverTokens(db, config.receiverTokens);
  const sseHub = createSseHub();
  const app = createApp({ db, config, sseHub });
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({ baseUrl, db, coverageCache: app.locals.coverageCache });
  } finally {
    await closeTestApp({ server, app, sseHub, db, dir });
  }
}

test("ingests receiver aircraft and exposes current state and track", async () => {
  await withServer(async ({ baseUrl, coverageCache }) => {
    const now = Date.now() / 1000;
    const ingest = await fetch(`${baseUrl}/api/ingest/readsb`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({
        receiver: {
          id: "rx-1",
          name: "Roof Receiver",
          lat: 37.5,
          lon: 127.1,
        },
        payload: {
          now,
          aircraft: [
            {
              hex: "abc123",
              type: "adsb_icao",
              flight: "SKY42",
              lat: 37.55,
              lon: 127.05,
              alt_baro: 32000,
              alt_geom: 33100,
              gs: 430,
              ias: 280,
              tas: 460,
              mach: 0.76,
              track: 90,
              true_heading: 91,
              mag_heading: 83,
              baro_rate: 64,
              geom_rate: 32,
              wd: 240,
              ws: 55,
              oat: -30,
              tat: -2,
              nac_p: 10,
              sil: 3,
              rc: 186,
              seen: 1,
              seen_pos: 1,
              messages: 50,
            },
          ],
        },
      }),
    });
    assert.equal(ingest.status, 200);
    const ingestBody = await ingest.json();
    assert.equal(ingestBody.acceptedCount, 1);
    assert.equal(ingestBody.trackPoints, 1);

    const live = await (await fetch(`${baseUrl}/api/live`)).json();
    assert.equal(live.count, 1);
    assert.equal(live.aircraft[0].hex, "abc123");
    assert.equal(live.aircraft[0].flight, "SKY42");
    assert.equal(live.aircraft[0].receiverCount, 1);
    assert.equal(live.aircraft[0].sourceKind, "adsb");
    assert.equal(live.aircraft[0].ias, 280);
    assert.equal(live.aircraft[0].trueHeading, 91);
    assert.equal(live.aircraft[0].windSpeed, 55);
    assert.equal(live.summary.withPosition, 1);
    assert.equal(live.receivers.length, 1);
    assert.equal(live.receivers[0].name, "Roof Receiver");
    assert.equal(live.receivers[0].lat, null);

    const track = await (await fetch(`${baseUrl}/api/aircraft/abc123/history`)).json();
    assert.equal(track.points.length, 1);
    assert.equal(track.points[0].lat, 37.55);
    assert.equal(track.points[0].sourceType, "adsb_icao");
    assert.equal(track.points[0].ias, 280);
    assert.equal(track.points[0].tas, 460);
    assert.equal(track.points[0].mach, 0.76);
    assert.equal(track.points[0].windSpeed, 55);

    const kmlResponse = await fetch(`${baseUrl}/api/aircraft/abc123/history.kml`);
    assert.equal(kmlResponse.headers.get("cache-control"), "no-store");
    const kml = await kmlResponse.text();
    assert.match(kml, /<kml/);
    assert.match(kml, /127.05,37.55/);

    assert.equal((await fetch(`${baseUrl}/api/aircraft/current`)).status, 404);
    assert.equal((await fetch(`${baseUrl}/api/receivers/public`)).status, 404);
    assert.equal((await fetch(`${baseUrl}/api/aircraft/abc123/track`)).status, 404);

    await coverageCache.refresh();
    const coverageResponse = await fetch(`${baseUrl}/api/coverage`);
    assert.equal(coverageResponse.headers.get("cache-control"), "public, max-age=0, must-revalidate");
    const coverage = await coverageResponse.json();
    assert.equal(coverage.type, "observed-occupancy");
    assert.equal(coverage.receiverCount, 1);
    assert.equal(coverage.areas.length, 1);
    assert.equal(coverage.areas[0].receiverName, "Roof Receiver");
    assert.equal(coverage.areas[0].receiverLat, undefined);
    assert.equal(coverage.areas[0].receiverLon, undefined);
    assert.equal(coverage.points.length, 0);
    assert.equal(coverage.areas[0].volumeMesh, null);
    assert.equal(coverage.refreshIntervalSeconds, 180);
    assert.equal(coverage.windowDays, 30);
    assert.equal(coverage.aggregation.type, "receiver-spatial-cells");
    assert.ok(Number.isFinite(Date.parse(coverage.contentGeneratedAt)));
    assert.equal(coverage.aggregation.rawPointsProcessed, undefined);
    assert.equal("polygon" in coverage.areas[0], false);
  });
});

test("coverage API returns a compact indexed occupancy mesh", async () => {
  await withServer(async ({ baseUrl, coverageCache }) => {
    const now = Date.now() / 1000;
    const aircraft = [
      ["aaa001", 37.45, 127.00, 8000],
      ["aaa002", 37.50, 127.05, 10000],
      ["aaa003", 37.55, 127.10, 12000],
      ["aaa004", 37.60, 127.15, 14000],
    ].map(([hex, lat, lon, alt_baro]) => ({
      hex, type: "adsb_icao", lat, lon, alt_baro, seen: 0, seen_pos: 0,
    }));
    const response = await fetch(`${baseUrl}/api/ingest/readsb`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        receiver: { id: "rx-1", name: "Roof Receiver", lat: 37.5, lon: 127.1 },
        payload: { now, aircraft },
      }),
    });
    assert.equal(response.status, 200);

    await coverageCache.refresh();
    const coverage = await (await fetch(`${baseUrl}/api/coverage`)).json();
    const mesh = coverage.areas[0].volumeMesh;
    assert.equal(mesh.type, "observed-occupancy-surface");
    assert.equal(mesh.encoding, "quantized-uint16-le-base64");
    assert.match(mesh.indexEncoding, /^uint(16|32)-le-base64$/);
    assert.equal(mesh.sourcePointCount, 4);
    assert.ok(mesh.vertexCount > 0);
    assert.ok(mesh.triangleCount > 0);
    assert.ok(mesh.origin[0] > 126 && mesh.origin[0] < 128);
    assert.ok(mesh.origin[1] > 37 && mesh.origin[1] < 38);
    assert.ok(Math.max(...mesh.positionBounds.map(Math.abs)) < 100000);
    assert.equal(mesh.horizontalInterpolationCells, 2);
    assert.equal(mesh.horizontalSmoothingPasses, 2);
    assert.equal(mesh.verticalSmoothingPasses, 4);
    assert.equal(mesh.smoothingIterations, 5);
    assert.equal(coverage.areas[0].receiverLat, undefined);
    assert.equal(coverage.areas[0].receiverLon, undefined);
  });
});

test("rejects missing and mismatched ingest tokens", async () => {
  await withServer(async ({ baseUrl }) => {
    const missing = await fetch(`${baseUrl}/api/ingest/readsb`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ receiver: { id: "rx-1" }, aircraft: [] }),
    });
    assert.equal(missing.status, 401);

    const mismatch = await fetch(`${baseUrl}/api/ingest/readsb`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ receiver: { id: "rx-2" }, aircraft: [] }),
    });
    assert.equal(mismatch.status, 401);
  });
});

test("filters implausible position jumps from track storage", async () => {
  await withServer(async ({ baseUrl }) => {
    const now = Date.now() / 1000;
    for (const [seen, lat, lon] of [
      [10, 37.5, 127.0],
      [1, 10.0, 10.0],
    ]) {
      const response = await fetch(`${baseUrl}/api/ingest/readsb`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify({
          receiver: { id: "rx-1" },
          payload: {
            now,
            aircraft: [{ hex: "abc124", type: "adsb_icao", lat, lon, alt_baro: 10000, seen, seen_pos: seen }],
          },
        }),
      });
      assert.equal(response.status, 200);
    }

    const track = await (await fetch(`${baseUrl}/api/aircraft/abc124/history`)).json();
    assert.equal(track.points.length, 1);
    assert.equal(track.points[0].lat, 37.5);
  });
});

test("coverage work can wait without blocking health or live HTTP handling", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skytrace-worker-http-"));
  const config = loadConfig({
    PORT: "0",
    SKYTRACE_DB_PATH: path.join(dir, "skytrace.db"),
    SKYTRACE_STATIC_DIR: path.join(dir, "missing-dist"),
  });
  const db = openDatabase(config.dbPath);
  let releaseBuild;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const buildResult = new Promise((resolve) => { releaseBuild = resolve; });
  const coverageWorker = {
    build: async () => {
      markStarted();
      return buildResult;
    },
    async close() {},
  };
  const sseHub = createSseHub();
  const app = createApp({ db, config, sseHub, coverageWorker });
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await started;
    const pendingCoverage = await fetch(`${baseUrl}/api/coverage`);
    assert.equal(pendingCoverage.status, 503);
    assert.equal(pendingCoverage.headers.get("retry-after"), "5");
    const health = await (await fetch(`${baseUrl}/healthz`)).json();
    assert.deepEqual(health, { ok: true });

    releaseBuild({
      type: "observed-occupancy",
      from: "2026-06-23T00:00:00.000Z",
      to: "2026-07-23T00:00:00.000Z",
      windowDays: 30,
      count: 0,
      receiverCount: 0,
      areas: [],
      points: [],
    });
    await app.locals.coverageCache.ready();
    const coverage = await (await fetch(`${baseUrl}/api/coverage`)).json();
    assert.equal(coverage.windowDays, 30);
  } finally {
    await closeTestApp({ server, app, sseHub, db, dir });
  }
});

test("live snapshot applies the bounded public aircraft limit and keeps summary consistent", async () => {
  await withServer(async ({ baseUrl, db }) => {
    const now = new Date().toISOString();
    const insert = db.prepare(`
      INSERT INTO receiver_aircraft_current (
        receiver_id, hex, observed_at, source_kind
      )
      VALUES ('rx-1', ?, ?, 'adsb')
    `);
    db.transaction(() => {
      for (let index = 0; index < 20001; index += 1) {
        insert.run(index.toString(16).padStart(6, "0"), now);
      }
    })();

    const response = await fetch(`${baseUrl}/api/live`);
    assert.equal(response.status, 200);
    const live = await response.json();
    assert.equal(live.count, 5000);
    assert.equal(live.aircraft.length, 5000);
    assert.equal(live.truncatedCount, 15001);
    assert.equal(live.summary.withPosition, 0);
    assert.equal(live.summary.sources.adsb, 5000);
  });
});
