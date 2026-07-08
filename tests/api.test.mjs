import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.mjs";
import { loadConfig } from "../src/config.mjs";
import { openDatabase, syncReceiverTokens } from "../src/db.mjs";
import { createSseHub } from "../src/sse.mjs";

async function withServer(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skytrace-test-"));
  const config = loadConfig({
    PORT: "0",
    SKYTRACE_DB_PATH: path.join(dir, "skytrace.db"),
    SKYTRACE_RECEIVER_TOKENS: JSON.stringify({ "rx-1": "secret-token" }),
    SKYTRACE_CURRENT_WINDOW_SECONDS: "120",
    SKYTRACE_MAX_OBSERVATION_AGE_SECONDS: "120",
    SKYTRACE_TRACK_MIN_INTERVAL_SECONDS: "0",
    SKYTRACE_STATIC_DIR: path.join(dir, "missing-dist"),
  });
  const db = openDatabase(config.dbPath);
  syncReceiverTokens(db, config.receiverTokens);
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

test("ingests receiver aircraft and exposes current state and track", async () => {
  await withServer(async ({ baseUrl }) => {
    const now = Date.now() / 1000;
    const ingest = await fetch(`${baseUrl}/api/ingest/readsb`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret-token",
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

    const current = await (await fetch(`${baseUrl}/api/aircraft/current`)).json();
    assert.equal(current.count, 1);
    assert.equal(current.aircraft[0].hex, "abc123");
    assert.equal(current.aircraft[0].flight, "SKY42");
    assert.equal(current.aircraft[0].receiverCount, 1);
    assert.equal(current.aircraft[0].sourceKind, "adsb");
    assert.equal(current.aircraft[0].ias, 280);
    assert.equal(current.aircraft[0].trueHeading, 91);
    assert.equal(current.aircraft[0].windSpeed, 55);
    assert.equal(current.summary.withPosition, 1);

    const track = await (await fetch(`${baseUrl}/api/aircraft/abc123/track`)).json();
    assert.equal(track.points.length, 1);
    assert.equal(track.points[0].lat, 37.55);
    assert.equal(track.points[0].sourceType, "adsb_icao");
    assert.equal(track.points[0].ias, 280);
    assert.equal(track.points[0].tas, 460);
    assert.equal(track.points[0].mach, 0.76);
    assert.equal(track.points[0].windSpeed, 55);

    const kml = await (await fetch(`${baseUrl}/api/aircraft/abc123/track.kml`)).text();
    assert.match(kml, /<kml/);
    assert.match(kml, /127.05,37.55/);

    const receivers = await (await fetch(`${baseUrl}/api/receivers/public`)).json();
    assert.equal(receivers.receivers.length, 1);
    assert.equal(receivers.receivers[0].name, "Roof Receiver");
    assert.equal(receivers.receivers[0].lat, null);

    const coverage = await (await fetch(`${baseUrl}/api/coverage`)).json();
    assert.equal(coverage.type, "observed-envelope");
    assert.equal(coverage.receiverCount, 1);
    assert.equal(coverage.areas.length, 1);
    assert.equal(coverage.areas[0].receiverName, "Roof Receiver");
    assert.equal(coverage.areas[0].receiverLat, undefined);
    assert.equal(coverage.areas[0].receiverLon, undefined);
    assert.equal(coverage.points.length, 1);
    assert.equal(coverage.points[0].lat, 37.55);
    assert.equal(coverage.points[0].lon, 127.05);
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
        authorization: "Bearer secret-token",
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
          authorization: "Bearer secret-token",
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

    const track = await (await fetch(`${baseUrl}/api/aircraft/abc124/track`)).json();
    assert.equal(track.points.length, 1);
    assert.equal(track.points[0].lat, 37.5);
  });
});
