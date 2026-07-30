import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAreaFeed } from "../src/area-feed.mjs";
import { createApp } from "../src/app.mjs";
import { loadConfig } from "../src/config.mjs";
import { openDatabase } from "../src/db.mjs";
import { createSseHub } from "../src/sse.mjs";
import { closeTestApp } from "./helpers/server.mjs";

// An adsb.lol-style upstream: {ac: [...]} with epoch-ms `now`. One aircraft carries no position
// and must be dropped by normalization.
function upstreamBody() {
  return {
    now: Date.now(),
    ac: [
      { hex: "3c6444", type: "adsb_icao", flight: "DLH123  ", alt_baro: 36000, gs: 460, track: 90, lat: 50.1, lon: 8.6, seen: 0.4, seen_pos: 0.7, squawk: "1000", category: "A3" },
      { hex: "406a9d", type: "mlat", alt_baro: 12000, gs: 250, track: 180, lat: 51.4, lon: -0.4, seen: 1.2, seen_pos: 2.1 },
      { hex: "a1b2c3", type: "adsb_icao", alt_baro: 30000, gs: 400, seen: 0.2 },
    ],
  };
}

function fixtureUpstream(bodyFn = upstreamBody) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(bodyFn()));
  });
  return {
    requests,
    listen: () => new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
      resolve(`http://127.0.0.1:${server.address().port}/v2/point/{lat}/{lon}/{radius}`);
    })),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("area queries normalize v2 payloads into the current-aircraft item shape", async () => {
  const upstream = fixtureUpstream();
  const url = await upstream.listen();
  try {
    const feed = createAreaFeed({ url, minUpstreamGapMs: 0, log: () => {} });
    const result = await feed.query(50.0, 8.5, 80);
    assert.equal(result.radiusNm, 100); // 80 NM + slack buckets up to the 100 NM step
    assert.equal(result.count, 2, "the position-less aircraft must be dropped");
    const dlh = result.aircraft.find((item) => item.hex === "3c6444");
    assert.equal(dlh.flight, "DLH123");
    assert.equal(dlh.altBaro, 36000);
    assert.equal(dlh.sourceKind, "adsb");
    assert.equal(dlh.areaFeed, true);
    assert.deepEqual(dlh.receivers, []);
    assert.ok(Date.parse(dlh.observedAt) > 0);
  } finally {
    await upstream.close();
  }
});

test("the adsb.fi envelope ({aircraft: [...]}) is understood too", async () => {
  const upstream = fixtureUpstream(() => ({ now: Date.now() / 1000, aircraft: upstreamBody().ac, resultCount: 3 }));
  const url = await upstream.listen();
  try {
    const feed = createAreaFeed({ url, minUpstreamGapMs: 0, log: () => {} });
    const result = await feed.query(50.0, 8.5, 40);
    assert.equal(result.count, 2);
  } finally {
    await upstream.close();
  }
});

test("nearby pans share one cached area and the TTL bounds upstream calls", async () => {
  const upstream = fixtureUpstream();
  const url = await upstream.listen();
  try {
    const feed = createAreaFeed({ url, ttlMs: 60000, minUpstreamGapMs: 0, log: () => {} });
    // Same rounded centre, same radius bucket, one concurrent burst: exactly one upstream call.
    const [a, b, c] = await Promise.all([
      feed.query(50.00, 8.50, 80),
      feed.query(50.05, 8.45, 80), // rounds to the same 0.25-degree grid point
      feed.query(50.00, 8.50, 70), // same 100 NM bucket
    ]);
    assert.equal(upstream.requests.length, 1);
    assert.equal(a.count, b.count);
    assert.equal(a.count, c.count);
    // A genuinely different area is its own upstream call.
    await feed.query(35.0, 129.0, 80);
    assert.equal(upstream.requests.length, 2);
    const stats = feed.stats();
    assert.equal(stats.upstreamCalls, 2);
    assert.equal(stats.cachedAreas, 2);
    assert.ok(stats.cachedBytes > 0);
  } finally {
    await upstream.close();
  }
});

test("cache hits do not extend an area's upstream freshness forever", async () => {
  const upstream = fixtureUpstream();
  const url = await upstream.listen();
  let now = 10000;
  try {
    const feed = createAreaFeed({
      url,
      ttlMs: 5000,
      minUpstreamGapMs: 0,
      nowImpl: () => now,
    });
    await feed.query(50.0, 8.5, 80);
    now += 4000;
    await feed.query(50.0, 8.5, 80);
    assert.equal(upstream.requests.length, 1, "a hit inside the fixed TTL should use the cache");

    // This is six seconds after the upstream fetch but only two seconds after the cache hit.
    // Updating the freshness timestamp on that hit used to keep a stationary viewport stale.
    now += 2000;
    await feed.query(50.0, 8.5, 80);
    assert.equal(upstream.requests.length, 2, "the fixed TTL must expire from the upstream fetch");
  } finally {
    await upstream.close();
  }
});

test("an unset template disables the feed and the route answers 404", async () => {
  assert.equal(createAreaFeed({ log: () => {} }).enabled, false);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skytrace-area-feed-"));
  const config = loadConfig({ PORT: "0", SKYTRACE_DB_PATH: path.join(dir, "db.sqlite"), SKYTRACE_STATIC_DIR: path.join(dir, "nope") });
  const db = openDatabase(config.dbPath);
  const sseHub = createSseHub();
  const routeApp = createApp({ db, config, sseHub });
  const server = routeApp.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/area-traffic?lat=50&lon=8&radius=100`);
    assert.equal(res.status, 404);
    const live = await (await fetch(`http://127.0.0.1:${server.address().port}/api/live`)).json();
    assert.equal(live.features.areaFeed, false);
  } finally {
    await closeTestApp({ server, app: routeApp, sseHub, db, dir });
  }
});

test("configured area feed templates fail startup unless their URL boundary is safe", () => {
  const invalid = [
    " ",
    "https://example.com/api",
    "relative/{lat}/{lon}/{radius}",
    "http://example.com/{lat}/{lon}/{radius}",
    "https://user:pass@example.com/{lat}/{lon}/{radius}",
    "https://example.com/{lat}/{lon}/{radius}#fragment",
    "https://{lat}.example.com/{lon}/{radius}",
    "https://example.com/{lat}/{lat}/{lon}/{radius}",
    "ftp://example.com/{lat}/{lon}/{radius}",
  ];
  for (const url of invalid) {
    assert.throws(
      () => createAreaFeed({ url, log: () => {} }),
      /invalid SKYTRACE_AREA_FEED_URL/,
      url,
    );
  }

  for (const url of [
    "http://127.0.0.1:8080/{lat}/{lon}/{radius}",
    "http://[::1]:8080/feed?lat={lat}&lon={lon}&radius={radius}",
    "https://10.0.0.4/feed/{lat}/{lon}/{radius}",
    "https://feed.internal.test/?lat={lat}&lon={lon}&radius={radius}",
  ]) {
    assert.equal(createAreaFeed({ url, log: () => {} }).enabled, true, url);
  }
});

test("area feed substitutions keep the configured origin and refuse redirects", async () => {
  const feed = createAreaFeed({
    url: "https://feed.internal.test/api/{lat}/{lon}?radius={radius}",
    minUpstreamGapMs: 0,
    fetchImpl: async (target, init) => {
      assert.equal(target.origin, "https://feed.internal.test");
      assert.equal(init.redirect, "manual");
      return new Response(null, {
        status: 302,
        headers: { location: "https://example.com/" },
      });
    },
  });
  await assert.rejects(feed.query(37.5, 127.0, 80), /upstream redirect refused/);
});

test("the route validates coordinates and serves normalized traffic uncached", async () => {
  const upstream = fixtureUpstream();
  const url = await upstream.listen();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skytrace-area-feed-app-"));
  const config = loadConfig({
    PORT: "0",
    SKYTRACE_DB_PATH: path.join(dir, "db.sqlite"),
    SKYTRACE_STATIC_DIR: path.join(dir, "nope"),
    SKYTRACE_AREA_FEED_URL: url,
    SKYTRACE_AREA_FEED_MIN_UPSTREAM_MS: "0",
  });
  const db = openDatabase(config.dbPath);
  const sseHub = createSseHub();
  const routeApp = createApp({ db, config, sseHub });
  const server = routeApp.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const ok = await fetch(`${base}/api/area-traffic?lat=50&lon=8.5&radius=80`);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("cache-control"), "no-store");
    const body = await ok.json();
    assert.equal(body.count, 2);
    assert.ok(body.aircraft.every((item) => item.areaFeed === true));
    const live = await (await fetch(`${base}/api/live`)).json();
    assert.equal(live.features.areaFeed, true);
    for (const bad of ["lat=91&lon=8&radius=80", "lat=50&lon=8&radius=0", "lat=50&lon=8"]) {
      assert.equal((await fetch(`${base}/api/area-traffic?${bad}`)).status, 400, bad);
    }
  } finally {
    await closeTestApp({ server, app: routeApp, sseHub, db, dir });
    await upstream.close();
  }
});

test("the feed reports its upstream host so the browser can credit the right database", () => {
  // The operator picks the aggregator, so the credit cannot be written into the client. Only the
  // host is exposed: the path and query may carry a feed UUID.
  const feed = createAreaFeed({
    url: "https://api.adsb.lol/v2/point/{lat}/{lon}/{radius}",
    log: () => {},
  });
  assert.equal(feed.enabled, true);
  assert.equal(feed.host, "api.adsb.lol");

  const other = createAreaFeed({
    url: "https://opendata.adsb.fi/api/v2/lat/{lat}/lon/{lon}/dist/{radius}",
    log: () => {},
  });
  assert.equal(other.host, "opendata.adsb.fi");
});

test("a disabled feed reports no host and invalid configured feeds throw", () => {
  assert.equal(createAreaFeed({ url: "", log: () => {} }).host, null);
  assert.throws(
    () => createAreaFeed({ url: "https://api.adsb.lol/v2/point", log: () => {} }),
    /invalid SKYTRACE_AREA_FEED_URL/,
  );
  assert.throws(
    () => createAreaFeed({ url: "not-a-url/{lat}/{lon}/{radius}", log: () => {} }),
    /invalid SKYTRACE_AREA_FEED_URL/,
  );
});
