import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  AIRFIELD_RETRY_MIN_MS,
  CELL_FETCH_MIN_ZOOM,
  createAirfieldsFeed,
  isMinorAirfield,
} from "../web/src/airfields-live.js";

const tactical = await readFile(new URL("../web/src/tactical3d.js", import.meta.url), "utf8");

function stubFetch(routes, log = []) {
  return async (url) => {
    log.push(url);
    const payload = routes[url];
    if (!payload) return { ok: false, status: 404 };
    return { ok: true, status: 200, json: async () => payload };
  };
}

const MANIFEST = {
  format: 1,
  version: "20260727-abcdef1234",
  cellSizeDeg: 10,
  cells: { "12-30": 2, "12-31": 1 },
};
const ROUTES = {
  "/api/airfields/manifest": MANIFEST,
  [`/api/airfields/${MANIFEST.version}/index.json`]: {
    fields: [["ICN", "RKSI", "ICN", "Incheon Intl", "l", "Seoul", 37.46, 126.44, [["15L/33R", 3962]]]],
  },
  [`/api/airfields/${MANIFEST.version}/cell-12-30.json`]: {
    fields: [["ZZ01", null, null, "Grass Strip", "s", null, 36.1, 127.2, [[null, 400]]]],
  },
  [`/api/airfields/${MANIFEST.version}/cell-12-31.json`]: { fields: [] },
};
const bounds = (west, south, east, north) => ({
  getWest: () => west, getSouth: () => south, getEast: () => east, getNorth: () => north,
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("the manifest and index tier load once, and decode to the classic airfield shape", async () => {
  const log = [];
  let updates = 0;
  const feed = createAirfieldsFeed({ onUpdate: () => { updates += 1; }, fetchImpl: stubFetch(ROUTES, log) });
  feed.ensureViewport(bounds(120, 30, 130, 40), 5, true);
  feed.ensureViewport(bounds(120, 30, 130, 40), 5, true); // second pass must not re-request
  await settle();
  await settle();
  assert.equal(updates, 1);
  assert.deepEqual(log, ["/api/airfields/manifest", `/api/airfields/${MANIFEST.version}/index.json`]);
  const fields = [...feed.all()];
  assert.equal(fields.length, 1);
  assert.equal(fields[0].kind, "large");
  assert.deepEqual(fields[0].runways, [{ ends: "15L/33R", lengthM: 3962 }]);
  assert.equal(isMinorAirfield(fields[0]), false);
});

test("cells load only past the small-airfield zoom, only for viewport cells that exist", async () => {
  const log = [];
  const feed = createAirfieldsFeed({ onUpdate: () => {}, fetchImpl: stubFetch(ROUTES, log) });
  feed.ensureViewport(bounds(124, 33, 130, 39), 5, true);
  await settle(); await settle();
  assert.ok(!log.some((url) => url.includes("cell-")), "below the zoom gate no cell may load");

  feed.ensureViewport(bounds(124, 33, 130, 39), CELL_FETCH_MIN_ZOOM + 1, true);
  await settle(); await settle();
  // Korea sits in lat cells 12 (with padding) — only cells the manifest lists are requested.
  const cellUrls = log.filter((url) => url.includes("cell-"));
  assert.deepEqual(cellUrls.sort(), [
    `/api/airfields/${MANIFEST.version}/cell-12-30.json`,
    `/api/airfields/${MANIFEST.version}/cell-12-31.json`,
  ]);
  const minor = [...feed.all()].find((f) => f.code === "ZZ01");
  assert.equal(isMinorAirfield(minor), true);

  log.length = 0;
  feed.ensureViewport(bounds(124, 33, 130, 39), 8, true);
  await settle();
  assert.deepEqual(log, [], "loaded cells never re-request");
});

test("a failed viewport cell uses the same bounded retry instead of hammering or staying blank", async () => {
  let now = 0;
  let failedCellAttempts = 0;
  const log = [];
  const errors = [];
  const failedCellUrl = `/api/airfields/${MANIFEST.version}/cell-12-30.json`;
  const fetchImpl = async (url) => {
    log.push(url);
    if (url === failedCellUrl && failedCellAttempts++ === 0) {
      return { ok: false, status: 503 };
    }
    const payload = ROUTES[url];
    return payload
      ? { ok: true, status: 200, json: async () => payload }
      : { ok: false, status: 404 };
  };
  const feed = createAirfieldsFeed({
    onUpdate: () => {},
    onError: (error) => errors.push(error),
    fetchImpl,
    nowImpl: () => now,
  });

  feed.ensureViewport(bounds(124, 33, 130, 39), 8, true);
  await settle(); await settle();
  feed.ensureViewport(bounds(124, 33, 130, 39), 8, true);
  await settle(); await settle();
  assert.equal(log.filter((url) => url === failedCellUrl).length, 1);
  assert.equal(errors.at(-1).scope, "cell");
  assert.equal(errors.at(-1).retryInMs, AIRFIELD_RETRY_MIN_MS);

  now = AIRFIELD_RETRY_MIN_MS - 1;
  feed.ensureViewport(bounds(124, 33, 130, 39), 8, true);
  await settle();
  assert.equal(log.filter((url) => url === failedCellUrl).length, 1);

  now = AIRFIELD_RETRY_MIN_MS;
  feed.ensureViewport(bounds(124, 33, 130, 39), 8, true);
  await settle(); await settle();
  assert.equal(log.filter((url) => url === failedCellUrl).length, 2);
  assert.ok([...feed.all()].some((field) => field.code === "ZZ01"));
});

test("a feed that is disabled or disposed stays quiet", async () => {
  const log = [];
  const feed = createAirfieldsFeed({ onUpdate: () => {}, fetchImpl: stubFetch(ROUTES, log) });
  feed.ensureViewport(bounds(120, 30, 130, 40), 9, false);
  await settle();
  assert.deepEqual(log, [], "airfields off: nothing may be fetched");
  feed.dispose();
  feed.ensureViewport(bounds(120, 30, 130, 40), 9, true);
  await settle();
  assert.deepEqual(log, []);
});

test("disposing during an in-flight request suppresses late retries and diagnostics", async () => {
  let rejectFetch;
  const errors = [];
  const feed = createAirfieldsFeed({
    onUpdate: () => assert.fail("a disposed feed cannot update"),
    onError: (error) => errors.push(error),
    fetchImpl: () => new Promise((_resolve, reject) => { rejectFetch = reject; }),
  });
  feed.ensureViewport(bounds(120, 30, 130, 40), 9, true);
  feed.dispose();
  rejectFetch(new Error("offline"));
  await settle(); await settle();
  assert.deepEqual(errors, []);
  assert.deepEqual([...feed.all()], []);
});

test("a transient manifest failure retries quickly without waiting for a page reload", async () => {
  let now = 0;
  let manifestAttempts = 0;
  const log = [];
  const errors = [];
  let updates = 0;
  const fetchImpl = async (url) => {
    log.push(url);
    if (url === "/api/airfields/manifest" && manifestAttempts++ === 0) {
      return { ok: false, status: 503 };
    }
    const payload = ROUTES[url];
    return payload
      ? { ok: true, status: 200, json: async () => payload }
      : { ok: false, status: 404 };
  };
  const feed = createAirfieldsFeed({
    onUpdate: () => { updates += 1; },
    onError: (error) => errors.push(error),
    fetchImpl,
    nowImpl: () => now,
  });
  feed.ensureViewport(bounds(120, 30, 130, 40), 9, true);
  await settle(); await settle();

  now = AIRFIELD_RETRY_MIN_MS - 1;
  feed.ensureViewport(bounds(120, 30, 130, 40), 9, true);
  await settle();
  assert.deepEqual(log, ["/api/airfields/manifest"], "the retry must wait out the backoff window");

  now = AIRFIELD_RETRY_MIN_MS;
  feed.ensureViewport(bounds(120, 30, 130, 40), 9, true);
  await settle(); await settle();
  assert.deepEqual(log, [
    "/api/airfields/manifest",
    "/api/airfields/manifest",
    `/api/airfields/${MANIFEST.version}/index.json`,
  ]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].scope, "manifest");
  assert.equal(errors[0].retryInMs, AIRFIELD_RETRY_MIN_MS);
  assert.equal(updates, 1);
  assert.equal([...feed.all()].length, 1);
});

test("tactical3d streams airfields from the feed instead of a baked module", () => {
  assert.match(tactical, /import \{ createAirfieldsFeed, isMinorAirfield \} from "\.\/airfields-live\.js"/);
  assert.doesNotMatch(tactical, /from "\.\/airfields\.js"/);
  assert.match(tactical, /for \(const f of airfieldsFeed\.all\(\)\)/);
  // A burst of cell arrivals is coalesced into one cached source rebuild instead of serializing the
  // whole loaded field set once per response.
  assert.match(tactical, /onUpdate: \(\) => \{[\s\S]*airfieldDataDirty = true/);
  assert.match(tactical, /onError: \(\{ error, scope, id, retryInMs \}\) => \{/);
  assert.match(tactical, /Airfield \$\{target\} unavailable; retrying in \$\{retryInMs\} ms/);
  assert.match(tactical, /window\.setTimeout\(\(\) => \{[\s\S]*refreshAirfields\(\);[\s\S]*AIRFIELD_SOURCE_BATCH_MS/);
  assert.match(tactical, /if \(!airfieldDataDirty && settingsKey === cachedAirfieldSettingsKey\) return cachedAirfieldFC/);
  assert.match(tactical, /if \(!force && next === appliedAirfieldFC\) return/);
  assert.match(tactical, /airfieldsFeed\.ensureViewport\(map\.getBounds\(\), map\.getZoom\(\), Boolean\(deps\.getSettings\(\)\.airfields\)\)/);
  assert.match(tactical, /airfieldsFeed\.dispose\(\)/);
});
