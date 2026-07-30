import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { createApp } from "../server/app.mjs";
import { loadConfig } from "../server/config.mjs";
import { openDatabase } from "../server/db.mjs";
import { encodeJsonForRequest, negotiateEncoding } from "../server/http-response.mjs";
import { createSseHub } from "../server/sse.mjs";
import { closeTestApp } from "./helpers/server.mjs";

function coverageSnapshot(now) {
  return {
    type: "observed-occupancy",
    from: new Date(Date.parse(now) - 86400000).toISOString(),
    to: now,
    windowHours: 24,
    windowDays: 1,
    count: 0,
    receiverCount: 0,
    bounds: null,
    areas: [],
    points: [],
    aggregation: {
      type: "receiver-spatial-cells",
      activeCells: 0,
      rawPointsProcessed: 123,
    },
  };
}

async function withServer(fn, {
  build = async (now) => coverageSnapshot(now),
  staticFixture = false,
  configEnv = {},
} = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skytrace-http-security-"));
  const staticDir = path.join(dir, staticFixture ? "dist" : "missing-dist");
  if (staticFixture) {
    const assetsDir = path.join(staticDir, "assets");
    const asset = Buffer.from("console.log('hashed asset');\n");
    await fs.mkdir(assetsDir, { recursive: true });
    await fs.writeFile(path.join(staticDir, "index.html"), "<!doctype html><div id=\"app\"></div>");
    await fs.writeFile(path.join(assetsDir, "app-abc123.js"), asset);
    await fs.writeFile(path.join(assetsDir, "app-abc123.js.gz"), gzipSync(asset));
    // An unhashed root asset with a precompressed twin: the licence notices.
    const notices = Buffer.from(`${JSON.stringify({ packages: [{ name: "vue", version: "3", license: "MIT", text: "MIT" }] })}\n`);
    await fs.writeFile(path.join(staticDir, "third-party-notices.json"), notices);
    await fs.writeFile(path.join(staticDir, "third-party-notices.json.gz"), gzipSync(notices));
  }
  const config = loadConfig({
    ...configEnv,
    PORT: "0",
    SKYTRACE_DB_PATH: path.join(dir, "skytrace.db"),
    SKYTRACE_STATIC_DIR: staticDir,
  });
  const db = openDatabase(config.dbPath);
  const sseHub = createSseHub();
  const coverageWorker = { build, async close() {} };
  const app = createApp({ db, config, sseHub, coverageWorker });
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({ baseUrl, app, db });
  } finally {
    await closeTestApp({ server, app, sseHub, db, dir });
  }
}

test("encoding negotiation obeys q-values, wildcard and identity refusal", () => {
  assert.equal(negotiateEncoding("", true), "identity");
  assert.equal(negotiateEncoding("gzip", true), "gzip");
  assert.equal(negotiateEncoding("gzip;q=0", true), "identity");
  assert.equal(negotiateEncoding("gzip;q=0.4, identity;q=0.8", true), "identity");
  assert.equal(negotiateEncoding("br, *;q=1, identity;q=0", true), "gzip");
  assert.equal(negotiateEncoding("gzip;q=0, identity;q=0, *;q=0", true), null);
});

test("request-scoped JSON encoding compresses only when gzip is selected", async () => {
  const value = { payload: "x".repeat(4096) };
  const identity = await encodeJsonForRequest("gzip;q=0", value);
  assert.equal(identity.encoding, "identity");
  assert.equal(identity.representation.gzip, null);
  assert.equal(identity.representation.gzipEtag, null);

  const compressed = await encodeJsonForRequest("gzip", value);
  assert.equal(compressed.encoding, "gzip");
  assert.ok(compressed.representation.gzip);
  assert.match(compressed.representation.gzipEtag, /^"sha256-/);
});

test("security headers preserve first-party Locate while blocking unrelated capabilities", async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/healthz`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-powered-by"), null);
    assert.match(response.headers.get("content-security-policy"), /worker-src 'self' blob:/);
    assert.doesNotMatch(response.headers.get("content-security-policy"), /unsafe-eval/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
    assert.match(response.headers.get("permissions-policy"), /geolocation=\(self\)/);
    assert.match(response.headers.get("permissions-policy"), /camera=\(\)/);
    const health = await response.json();
    assert.deepEqual(health, { ok: true });
  });
});

test("health reports unavailable when the required database schema is missing", async () => {
  await withServer(async ({ baseUrl, db }) => {
    db.exec("ALTER TABLE receivers RENAME TO receivers_unhealthy");
    const response = await fetch(`${baseUrl}/healthz`);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { ok: false });
  });
});

test("the HTTP app does not infer TLS redirects or HSTS from forwarding headers", async () => {
  await withServer(async ({ baseUrl }) => {
    const direct = await fetch(`${baseUrl}/api/live`);
    assert.equal(direct.status, 200);
    assert.equal(direct.headers.get("strict-transport-security"), null);

    const proxied = await fetch(`${baseUrl}/api/live`, {
      headers: { "x-forwarded-proto": "https" },
    });
    assert.equal(proxied.status, 200);
    assert.equal(proxied.headers.get("strict-transport-security"), null);
  }, {
    configEnv: {
      NODE_ENV: "production",
      SKYTRACE_TRUST_PROXY: "127.0.0.1/32",
    },
  });
});

test("canonical coverage reuses bytes and strong validators and handles HEAD/304", async () => {
  await withServer(async ({ baseUrl, app }) => {
    await app.locals.coverageCache.ready();
    const originalRepresentation = app.locals.coverageCache.representation();
    await app.locals.coverageCache.refresh();
    assert.strictEqual(app.locals.coverageCache.representation(), originalRepresentation);

    const identity = await fetch(`${baseUrl}/api/coverage`, {
      headers: { "accept-encoding": "gzip;q=0" },
    });
    assert.equal(identity.status, 200);
    assert.equal(identity.headers.get("content-encoding"), null);
    assert.equal(identity.headers.get("vary"), "Accept-Encoding");
    const identityEtag = identity.headers.get("etag");
    const body = await identity.json();
    assert.equal(body.aggregation.rawPointsProcessed, undefined);
    assert.equal(body.contentGeneratedAt != null, true);

    const notModified = await fetch(`${baseUrl}/api/coverage`, {
      headers: {
        "accept-encoding": "gzip;q=0",
        "if-none-match": identityEtag,
      },
    });
    assert.equal(notModified.status, 304);
    assert.equal((await notModified.arrayBuffer()).byteLength, 0);

    const compressed = await fetch(`${baseUrl}/api/coverage`, {
      headers: { "accept-encoding": "gzip" },
    });
    assert.equal(compressed.status, 200);
    assert.equal(compressed.headers.get("content-encoding"), "gzip");
    assert.notEqual(compressed.headers.get("etag"), identityEtag);

    const head = await fetch(`${baseUrl}/api/coverage`, {
      method: "HEAD",
      headers: { "accept-encoding": "gzip;q=0" },
    });
    assert.equal(head.status, 200);
    assert.equal((await head.arrayBuffer()).byteLength, 0);

    const unacceptable = await fetch(`${baseUrl}/api/coverage`, {
      headers: { "accept-encoding": "gzip;q=0, identity;q=0, *;q=0" },
    });
    assert.equal(unacceptable.status, 406);
  });
});

test("live JSON reuses a pre-encoded snapshot with encoding-specific strong validators", async () => {
  await withServer(async ({ baseUrl, db }) => {
    const now = new Date().toISOString();
    db.prepare("INSERT INTO receivers (id) VALUES ('rx-1')").run();
    const insert = db.prepare(`
      INSERT INTO receiver_aircraft_current (
        receiver_id, hex, observed_at, flight, source_kind
      )
      VALUES ('rx-1', ?, ?, 'LONGCALLSIGN12345', 'adsb')
    `);
    db.transaction(() => {
      for (let index = 0; index < 40; index += 1) {
        insert.run(index.toString(16).padStart(6, "0"), now);
      }
    })();

    const identity = await fetch(`${baseUrl}/api/live`, {
      headers: { "accept-encoding": "gzip;q=0" },
    });
    assert.equal(identity.status, 200);
    assert.equal(identity.headers.get("content-encoding"), null);
    const identityEtag = identity.headers.get("etag");
    assert.match(identityEtag, /^"sha256-/);

    const compressed = await fetch(`${baseUrl}/api/live`, {
      headers: { "accept-encoding": "gzip" },
    });
    assert.equal(compressed.status, 200);
    assert.equal(compressed.headers.get("content-encoding"), "gzip");
    assert.notEqual(compressed.headers.get("etag"), identityEtag);

    const repeated = await fetch(`${baseUrl}/api/live`, {
      headers: { "accept-encoding": "gzip" },
    });
    assert.equal(repeated.headers.get("etag"), compressed.headers.get("etag"));

    const notModified = await fetch(`${baseUrl}/api/live`, {
      headers: {
        "accept-encoding": "gzip;q=0",
        "if-none-match": identityEtag,
      },
    });
    assert.equal(notModified.status, 304);
    assert.equal((await notModified.arrayBuffer()).byteLength, 0);

    const head = await fetch(`${baseUrl}/api/live`, {
      method: "HEAD",
      headers: { "accept-encoding": "gzip;q=0" },
    });
    assert.equal(head.status, 200);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
  });
});

test("live snapshots shed aircraft rather than exceed the configured byte budget", async () => {
  await withServer(async ({ baseUrl, db }) => {
    const now = new Date().toISOString();
    db.prepare("INSERT INTO receivers (id) VALUES ('rx-1')").run();
    const insert = db.prepare(`
      INSERT INTO receiver_aircraft_current (
        receiver_id, hex, observed_at, flight, source_kind
      )
      VALUES ('rx-1', ?, ?, ?, 'adsb')
    `);
    const longFlight = "X".repeat(2000);
    db.transaction(() => {
      for (let index = 0; index < 100; index += 1) {
        insert.run(index.toString(16).padStart(6, "0"), now, longFlight);
      }
    })();

    const response = await fetch(`${baseUrl}/api/live`, {
      headers: { "accept-encoding": "gzip;q=0" },
    });
    assert.equal(response.status, 200);
    assert.ok(Number(response.headers.get("content-length")) <= 64 * 1024);
    const live = await response.json();
    assert.ok(live.count < 100);
    assert.equal(live.truncatedCount, 100 - live.count);
  }, {
    configEnv: {
      SKYTRACE_LIVE_MAX_AIRCRAFT: "100",
      SKYTRACE_LIVE_MAX_BYTES: String(64 * 1024),
    },
  });
});

test("hashed static assets negotiate precompressed bytes and vary every representation", async () => {
  await withServer(async ({ baseUrl }) => {
    const identity = await fetch(`${baseUrl}/assets/app-abc123.js`, {
      headers: { "accept-encoding": "gzip;q=0" },
    });
    assert.equal(identity.status, 200);
    assert.equal(identity.headers.get("content-encoding"), null);
    assert.equal(identity.headers.get("vary"), "Accept-Encoding");
    assert.match(identity.headers.get("cache-control"), /immutable/);

    const compressed = await fetch(`${baseUrl}/assets/app-abc123.js`, {
      headers: { "accept-encoding": "gzip" },
    });
    assert.equal(compressed.status, 200);
    assert.equal(compressed.headers.get("content-encoding"), "gzip");
    const gzipEtag = compressed.headers.get("etag");
    assert.match(gzipEtag, /^"sha256-/);

    const notModified = await fetch(`${baseUrl}/assets/app-abc123.js`, {
      headers: {
        "accept-encoding": "gzip",
        "if-none-match": gzipEtag,
      },
    });
    assert.equal(notModified.status, 304);

    const head = await fetch(`${baseUrl}/assets/app-abc123.js`, {
      method: "HEAD",
      headers: { "accept-encoding": "gzip" },
    });
    assert.equal(head.status, 200);
    assert.equal((await head.arrayBuffer()).byteLength, 0);

    const unacceptable = await fetch(`${baseUrl}/assets/app-abc123.js`, {
      headers: { "accept-encoding": "gzip;q=0, identity;q=0, *;q=0" },
    });
    assert.equal(unacceptable.status, 406);

    const index = await fetch(`${baseUrl}/`);
    assert.match(index.headers.get("cache-control"), /must-revalidate/);
  }, { staticFixture: true });
});

test("the licence notices serve their precompressed twin without going immutable", async () => {
  await withServer(async ({ baseUrl }) => {
    // Nothing in front of this server compresses on the fly, and the notices are the one unhashed
    // root asset big enough for the twin to matter — so it has to be served, not just generated.
    const compressed = await fetch(`${baseUrl}/third-party-notices.json`, {
      headers: { "accept-encoding": "gzip" },
    });
    assert.equal(compressed.status, 200);
    assert.equal(compressed.headers.get("content-encoding"), "gzip");
    assert.equal(compressed.headers.get("vary"), "Accept-Encoding");
    assert.match(compressed.headers.get("content-type"), /application\/json/);
    // The filename is stable across builds, so it must revalidate rather than pin for a year the
    // way /assets does.
    assert.match(compressed.headers.get("cache-control"), /must-revalidate/);
    assert.doesNotMatch(compressed.headers.get("cache-control"), /immutable/);
    assert.deepEqual((await compressed.json()).packages.map((p) => p.name), ["vue"]);

    const etag = compressed.headers.get("etag");
    assert.match(etag, /^"sha256-/);
    const notModified = await fetch(`${baseUrl}/third-party-notices.json`, {
      headers: { "accept-encoding": "gzip", "if-none-match": etag },
    });
    assert.equal(notModified.status, 304);

    // A client that refuses gzip still gets the plain file through the static handler.
    const identity = await fetch(`${baseUrl}/third-party-notices.json`, {
      headers: { "accept-encoding": "gzip;q=0" },
    });
    assert.equal(identity.status, 200);
    assert.equal(identity.headers.get("content-encoding"), null);
    assert.deepEqual((await identity.json()).packages.map((p) => p.name), ["vue"]);
  }, { staticFixture: true });
});

test("a missing notices file does not fall through to the SPA shell as JSON", async () => {
  // Without the fixture there is no dist at all, so the route must not answer with index.html --
  // the panel would then fail on a parse error rather than a clear status.
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/third-party-notices.json`);
    assert.equal(response.status, 404);
    assert.match(response.headers.get("content-type"), /application\/json/);
  });
});

test("untrusted forwarding headers cannot evade per-IP limits and public health exposes no metrics", async () => {
  await withServer(async ({ baseUrl, app }) => {
    await app.locals.coverageCache.ready();
    const statuses = [];
    for (let index = 0; index < 6; index += 1) {
      statuses.push((await fetch(`${baseUrl}/api/coverage`, {
        headers: { "x-forwarded-for": `203.0.113.${index + 1}` },
      })).status);
    }
    assert.deepEqual(statuses.slice(0, 5), [200, 200, 200, 200, 200]);
    assert.equal(statuses[5], 429);
    const health = await (await fetch(`${baseUrl}/healthz`)).json();
    assert.deepEqual(health, { ok: true });
    assert.equal(app.locals.requestLimits.stats().coverage.accepted, 5);
    assert.equal(app.locals.requestLimits.stats().coverage.rateLimited, 1);
  });
});
