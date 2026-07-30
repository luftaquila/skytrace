import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";
import { buildAirfieldTuples, cellId, createAirfieldsStore, parseCsv } from "../server/airfields-store.mjs";
import { createApp } from "../server/app.mjs";
import { loadConfig } from "../server/config.mjs";
import { openDatabase } from "../server/db.mjs";
import { createSseHub } from "../server/sse.mjs";
import { closeTestApp } from "./helpers/server.mjs";

// --- Fixture dataset: large enough to clear the sanity floors, small enough to stay fast. ----

function fixtureCsvs({ airports = 41000, renameOne = false } = {}) {
  const airportLines = ["id,ident,type,name,latitude_deg,longitude_deg,icao_code,iata_code,municipality"];
  const runwayLines = ["id,airport_ref,airport_ident,length_ft,closed,le_ident,he_ident"];
  for (let i = 0; i < airports; i += 1) {
    const medium = i < 5000;
    const ident = medium ? `MED${String(i).padStart(4, "0")}` : `SM${String(i).padStart(6, "0")}`;
    const lat = -80 + (i % 160) + 0.5;
    const lon = -170 + ((i * 7) % 340) + 0.25;
    const name = renameOne && i === 0 ? "Renamed Field" : `Field ${i}`;
    airportLines.push([
      i, ident, medium ? "medium_airport" : "small_airport", name, lat, lon,
      medium ? ident : "", medium && i < 100 ? `M${String(i).padStart(2, "0")}` : "", "Town",
    ].join(","));
    if (i < 25000) runwayLines.push([i, i, ident, 4921, 0, "09", "27"].join(","));
  }
  // One closed airport and one closed runway that must both be filtered out.
  airportLines.push("999999,XCLOSED,closed,Gone,10.5,10.5,,,");
  runwayLines.push("999999,0,MED0000,9000,1,18,36");
  return { airports: airportLines.join("\n"), runways: runwayLines.join("\n") };
}

// A tiny OurAirports stand-in with ETag/304 support and a request counter.
function fixtureSource(initial) {
  let payloads = initial;
  let etagSeed = 1;
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    const body = req.url.includes("airports") ? payloads.airports : payloads.runways;
    const etag = `"${etagSeed}-${req.url.includes("airports") ? "a" : "r"}"`;
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304).end();
      return;
    }
    res.writeHead(200, { etag, "content-type": "text/csv" }).end(body);
  });
  return {
    server,
    requests,
    setPayloads: (next) => { payloads = next; etagSeed += 1; },
    listen: () => new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      resolve({ airportsUrl: `${base}/airports.csv`, runwaysUrl: `${base}/runways.csv` });
    })),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function withStore(fn, { payloads = fixtureCsvs() } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skytrace-airfields-"));
  const source = fixtureSource(payloads);
  const urls = await source.listen();
  const make = () => createAirfieldsStore({ dir, ...urls, log: () => {} });
  try {
    await fn({ dir, source, make });
  } finally {
    await source.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("airfield source URLs allow credential-free HTTPS and loopback HTTP only", () => {
  const make = (base) => createAirfieldsStore({
    dir: path.join(os.tmpdir(), "unused-skytrace-airfields-test"),
    airportsUrl: `${base}/airports.csv`,
    runwaysUrl: `${base}/runways.csv`,
  });
  for (const base of [
    "https://airfields.example.test",
    "http://localhost",
    "http://localhost.",
    "http://127.0.0.2",
    "http://[::1]",
  ]) {
    assert.doesNotThrow(() => make(base), base);
  }
  for (const base of [
    "http://192.0.2.1",
    "ftp://airfields.example.test",
    "https://user:pass@airfields.example.test",
  ]) {
    assert.throws(() => make(base), /credential-free HTTPS/, base);
  }
});

test("csv parsing honours quoted fields", () => {
  const rows = parseCsv('a,b\n"x, ""y""",2\r\n3,4\n');
  assert.deepEqual(rows, [["a", "b"], ['x, "y"', "2"], ["3", "4"]]);
});

test("csv parsing rejects oversized and malformed source structures before building", () => {
  assert.throws(
    () => parseCsv("a\nb\nc\n", { maxRows: 2 }),
    /row limit/,
  );
  assert.throws(
    () => parseCsv("header\noversized\n", { maxFieldChars: 4 }),
    /field exceeds/,
  );
  assert.throws(
    () => parseCsv('a,b\n"unterminated,2'),
    /unterminated/,
  );
});

test("tuples split into an index tier and 10-degree small-airport cells", () => {
  const { airports, runways } = fixtureCsvs({ airports: 41000 });
  const { index, cells, counts } = buildAirfieldTuples(airports, runways);
  assert.equal(counts.index, 5000);
  assert.equal(counts.small, 36000);
  assert.equal(counts.airports, 41000);
  assert.ok(counts.runways >= 20000);
  assert.equal(index.length, 5000);
  // The closed airport and the closed runway are gone.
  assert.ok(!index.some((t) => t[0] === "XCLOSED"));
  const med0 = index.find((t) => t[1] === "MED0000");
  assert.equal(med0[8].length, 1);
  // Every small airport landed in the cell its coordinates dictate.
  for (const [id, fields] of cells) {
    for (const t of fields) assert.equal(cellId(t[6], t[7]), id);
  }
});

test("first build commits an atomic versioned dataset with pre-compressed payloads", async () => {
  await withStore(async ({ dir, make }) => {
    const store = make();
    const version = await (store.refresh(), store.refresh()); // concurrent refreshes coalesce
    const manifest = store.manifest();
    assert.equal(manifest.version, version ?? manifest.version);
    assert.match(manifest.version, /^[0-9]{8}-[0-9a-f]{10}$/);
    const versionDir = path.join(dir, `v-${manifest.version}`);
    assert.ok(fsSync.existsSync(path.join(versionDir, "index.json")));
    assert.ok(fsSync.existsSync(path.join(versionDir, "index.json.gz")));
    const index = JSON.parse(fsSync.readFileSync(path.join(versionDir, "index.json"), "utf8"));
    assert.equal(index.fields.length, 5000);
    assert.deepEqual(
      JSON.parse(zlib.gunzipSync(fsSync.readFileSync(path.join(versionDir, "index.json.gz"))).toString()),
      index,
    );
    const firstCell = Object.keys(manifest.cells)[0];
    const cell = JSON.parse(fsSync.readFileSync(path.join(versionDir, `cell-${firstCell}.json`), "utf8"));
    assert.equal(cell.fields.length, manifest.cells[firstCell]);
    // No tmp leftovers: the build directory was renamed into place.
    assert.ok(!fsSync.readdirSync(dir).some((entry) => entry.startsWith("tmp-")));
    store.close();
  });
});

test("an unchanged source is a 304 no-op that only refreshes checkedAt", async () => {
  await withStore(async ({ source, make }) => {
    const store = make();
    await store.refresh();
    const before = store.manifest();
    source.requests.length = 0;
    await store.refresh();
    const after = store.manifest();
    assert.equal(after.version, before.version);
    assert.notEqual(after.checkedAt, before.checkedAt);
    // Two conditional GETs answered 304 — nothing was re-downloaded.
    assert.equal(source.requests.length, 2);
    store.close();
  });
});

test("a broken refresh keeps the current dataset serving", async () => {
  await withStore(async ({ dir, source, make }) => {
    const store = make();
    await store.refresh();
    const good = store.manifest();
    // The source now returns a truncated dataset under a new ETag: validation must refuse it.
    source.setPayloads({ airports: "ident,type,name,latitude_deg,longitude_deg,icao_code,iata_code,municipality\nX,large_airport,X,1,1,,,", runways: "airport_ident,le_ident,he_ident,length_ft,closed\n" });
    await store.refresh();
    assert.equal(store.manifest().version, good.version);
    assert.ok(fsSync.existsSync(path.join(dir, `v-${good.version}`, "index.json")));
    store.close();
  });
});

test("a changed source mints a new version and keeps the previous for in-flight clients", async () => {
  await withStore(async ({ dir, source, make }) => {
    const store = make();
    await store.refresh();
    const first = store.manifest().version;
    source.setPayloads(fixtureCsvs({ renameOne: true }));
    await store.refresh();
    const manifest = store.manifest();
    assert.notEqual(manifest.version, first);
    assert.equal(manifest.previousVersion, first);
    assert.ok(fsSync.existsSync(path.join(dir, `v-${first}`, "index.json")));
    // A restart against the committed manifest serves immediately.
    const rebooted = make();
    rebooted.init();
    assert.equal(rebooted.manifest().version, manifest.version);
    rebooted.close();
    store.close();
  });
});

test("the airfield routes serve immutable gzip payloads and refuse traversal", async () => {
  await withStore(async ({ make }) => {
    const store = make();
    await store.refresh();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skytrace-airfields-app-"));
    const config = loadConfig({ PORT: "0", SKYTRACE_DB_PATH: path.join(dir, "db.sqlite"), SKYTRACE_STATIC_DIR: path.join(dir, "nope") });
    const db = openDatabase(config.dbPath);
    const sseHub = createSseHub();
    const app = createApp({ db, config, sseHub, airfieldsStore: store });
    const server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const manifestRes = await fetch(`${base}/api/airfields/manifest`);
      assert.equal(manifestRes.status, 200);
      assert.match(manifestRes.headers.get("cache-control"), /must-revalidate/);
      const manifest = await manifestRes.json();

      const indexRes = await fetch(`${base}/api/airfields/${manifest.version}/index.json`, { headers: { "accept-encoding": "gzip" } });
      assert.equal(indexRes.status, 200);
      assert.match(indexRes.headers.get("cache-control"), /immutable/);
      const index = await indexRes.json(); // fetch un-gzips transparently
      assert.equal(index.fields.length, 5000);

      for (const bad of [
        `${base}/api/airfields/${manifest.version}/..%2Fmanifest.json`,
        `${base}/api/airfields/not-a-version/index.json`,
        `${base}/api/airfields/${manifest.version}/cell-999-999.json`,
      ]) {
        assert.equal((await fetch(bad)).status, 404, bad);
      }
    } finally {
      await closeTestApp({ server, app, sseHub, db, dir, airfieldsStore: store });
    }
  });
});
