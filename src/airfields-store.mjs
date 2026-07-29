// Self-maintaining worldwide airfield dataset, generated from OurAirports open data (public
// domain) into a persistent directory OUTSIDE the container image, so refreshing airports never
// needs an image rebuild.
//
//   - no data on boot  -> build immediately (the server keeps listening while it downloads)
//   - data on boot     -> serve it at once, check the source for freshness in the background
//   - every week       -> conditional check (ETag / Last-Modified), rebuild only on change
//   - every build lands in a temp dir, is validated, then committed by ATOMIC rename; a failed
//     download or a suspicious dataset leaves the current data untouched
//
// The output is a two-tier static layout the browser fetches by viewport:
//   manifest.json            what the current version is, and which cells exist
//   v-<version>/index.json   every open large/medium airport (always loaded by the client)
//   v-<version>/cell-<lat>-<lon>.json
//                            open small airports in one 10-degree cell, runways included
// Every payload is also written pre-compressed (.json.gz) so the routes can serve gzip without
// a per-request deflate.

import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { readResponseBytes } from "./stream-limit.mjs";

const AIRPORTS_URL = "https://davidmegginson.github.io/ourairports-data/airports.csv";
const RUNWAYS_URL = "https://davidmegginson.github.io/ourairports-data/runways.csv";
const KEEP_TYPES = new Set(["large_airport", "medium_airport", "small_airport"]);
const CELL_SIZE_DEG = 10;
const FORMAT = 1;
export const AIRFIELD_LIMITS = Object.freeze({
  airportsCsvRows: 100000,
  runwaysCsvRows: 250000,
  csvColumns: 64,
  csvFieldChars: 4096,
  airports: 75000,
  index: 15000,
  runways: 100000,
  cells: 648,
  cellFields: 10000,
  payloadBytes: 16 * 1024 * 1024,
  versionBytes: 64 * 1024 * 1024,
  storeBytes: 256 * 1024 * 1024,
});

const WEEK_MS = 7 * 24 * 3600 * 1000;
const RETRY_MS = 6 * 3600 * 1000;
const FETCH_TIMEOUT_MS = 120000;
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const PAYLOAD_CACHE_MS = 30 * 86400000;
const MAX_PAYLOAD_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_PAYLOAD_CACHE_ENTRIES = 1024;

// Minimal RFC-4180 CSV parser (quoted fields with embedded commas/quotes/newlines).
export function parseCsv(text, {
  maxRows = AIRFIELD_LIMITS.runwaysCsvRows,
  maxColumns = AIRFIELD_LIMITS.csvColumns,
  maxFieldChars = AIRFIELD_LIMITS.csvFieldChars,
} = {}) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const append = (ch) => {
    if (field.length >= maxFieldChars) throw new Error("CSV field exceeds the configured limit");
    field += ch;
  };
  const finishField = () => {
    if (row.length >= maxColumns) throw new Error("CSV row exceeds the configured column limit");
    row.push(field.replace(/\r$/, ""));
    field = "";
  };
  const finishRow = () => {
    finishField();
    rows.push(row);
    if (rows.length > maxRows) throw new Error("CSV exceeds the configured row limit");
    row = [];
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { append('"'); i += 1; } else quoted = false;
      } else append(ch);
    } else if (ch === '"') quoted = true;
    else if (ch === ",") finishField();
    else if (ch === "\n") finishRow();
    else append(ch);
  }
  if (quoted) throw new Error("unterminated quoted CSV field");
  if (field.length || row.length) finishRow();
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ""));
}

export function cellId(lat, lon) {
  const latIdx = Math.max(0, Math.min(17, Math.floor((lat + 90) / CELL_SIZE_DEG)));
  const lonIdx = Math.max(0, Math.min(35, Math.floor((lon + 180) / CELL_SIZE_DEG)));
  return `${latIdx}-${lonIdx}`;
}

// Parse both CSVs into the compact tuple rows the browser consumes:
//   [code, icao, iata, name, kindInitial, city, lat, lon, [[ends, lengthM], ...]]
export function buildAirfieldTuples(airportsCsv, runwaysCsv) {
  const airportRows = parseCsv(airportsCsv, { maxRows: AIRFIELD_LIMITS.airportsCsvRows });
  const runwayRows = parseCsv(runwaysCsv, { maxRows: AIRFIELD_LIMITS.runwaysCsvRows });
  if (airportRows.length < 2 || runwayRows.length < 2) throw new Error("empty source dataset");
  const a = Object.fromEntries(airportRows[0].map((h, i) => [h, i]));
  const r = Object.fromEntries(runwayRows[0].map((h, i) => [h, i]));
  for (const col of ["ident", "type", "latitude_deg", "longitude_deg", "name"]) {
    if (a[col] == null) throw new Error(`airports.csv is missing the ${col} column`);
  }
  for (const col of ["airport_ident", "le_ident", "he_ident", "length_ft", "closed"]) {
    if (r[col] == null) throw new Error(`runways.csv is missing the ${col} column`);
  }

  const runwaysByAirport = new Map();
  let runwayCount = 0;
  for (let i = 1; i < runwayRows.length; i += 1) {
    const row = runwayRows[i];
    if (!row || row.length < runwayRows[0].length || row[r.closed] === "1") continue;
    const ident = row[r.airport_ident];
    if (!ident) continue;
    const ends = [row[r.le_ident], row[r.he_ident]].filter(Boolean).join("/") || null;
    const lengthFeet = Number.parseFloat(row[r.length_ft]);
    const lengthM = Number.isFinite(lengthFeet) ? Math.round(lengthFeet * 0.3048) : null;
    if (!ends && lengthM == null) continue;
    const list = runwaysByAirport.get(ident) || [];
    list.push([ends, lengthM]);
    runwaysByAirport.set(ident, list);
    runwayCount += 1;
  }

  const index = [];
  const cells = new Map();
  for (let i = 1; i < airportRows.length; i += 1) {
    const row = airportRows[i];
    if (!row || row.length < airportRows[0].length || !KEEP_TYPES.has(row[a.type])) continue;
    const lat = Number.parseFloat(row[a.latitude_deg]);
    const lon = Number.parseFloat(row[a.longitude_deg]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;
    const ident = row[a.ident];
    const icao = row[a.icao_code] || null;
    const iata = row[a.iata_code] || null;
    const runways = (runwaysByAirport.get(ident) || [])
      .sort((x, y) => ((y[1] ?? -1) - (x[1] ?? -1)) || String(x[0] || "").localeCompare(String(y[0] || "")));
    const kind = row[a.type].replace("_airport", "");
    const tuple = [
      iata || icao || ident,
      icao,
      iata,
      row[a.name],
      kind[0],
      row[a.municipality] || null,
      Math.round(lat * 1e5) / 1e5,
      Math.round(lon * 1e5) / 1e5,
      runways,
    ];
    if (kind === "small") {
      const id = cellId(lat, lon);
      const cell = cells.get(id) || [];
      cell.push(tuple);
      cells.set(id, cell);
    } else {
      index.push(tuple);
    }
  }
  const byCode = (x, y) => String(x[0]).localeCompare(String(y[0]));
  index.sort(byCode);
  for (const cell of cells.values()) cell.sort(byCode);
  const small = [...cells.values()].reduce((sum, cell) => sum + cell.length, 0);
  return { index, cells, counts: { airports: index.length + small, index: index.length, small, runways: runwayCount, cells: cells.size } };
}

export function createAirfieldsStore({
  dir,
  airportsUrl = AIRPORTS_URL,
  runwaysUrl = RUNWAYS_URL,
  refreshMs = WEEK_MS,
  retryMs = RETRY_MS,
  fetchImpl = fetch,
  log = (...args) => console.log("[airfields]", ...args),
} = {}) {
  if (!dir) throw new Error("airfields store needs a data directory");
  function validatedSourceUrl(value) {
    const parsed = new URL(value);
    const loopback = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
    if (parsed.username || parsed.password || (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback))) {
      throw new Error("airfield sources must use credential-free HTTPS (HTTP is loopback-only)");
    }
    return parsed.href;
  }
  airportsUrl = validatedSourceUrl(airportsUrl);
  runwaysUrl = validatedSourceUrl(runwaysUrl);
  const manifestPath = path.join(dir, "manifest.json");
  let manifest = null;
  let timer = null;
  let refreshing = null;
  let closed = false;
  const payloadCache = new Map();
  const buildWorkers = new Set();
  let payloadCacheBytes = 0;

  function removeCachedPayload(key) {
    const cached = payloadCache.get(key);
    if (!cached) return;
    payloadCacheBytes -= cached.bytes.byteLength;
    payloadCache.delete(key);
  }

  function prunePayloadCache(now = Date.now()) {
    for (const [key, cached] of payloadCache) {
      if (now - cached.at >= PAYLOAD_CACHE_MS) removeCachedPayload(key);
    }
    while (
      payloadCache.size > MAX_PAYLOAD_CACHE_ENTRIES
      || payloadCacheBytes > MAX_PAYLOAD_CACHE_BYTES
    ) {
      const oldest = [...payloadCache.entries()]
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!oldest) break;
      removeCachedPayload(oldest[0]);
    }
  }

  function loadManifestFromDisk() {
    try {
      if (fs.statSync(manifestPath).size > 1024 * 1024) return null;
      const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (parsed?.format === FORMAT && typeof parsed.version === "string"
        && fs.existsSync(path.join(dir, `v-${parsed.version}`, "index.json"))) {
        return parsed;
      }
    } catch { /* no or corrupt manifest: treated as no data */ }
    return null;
  }

  // The manifest write is the COMMIT: readers switch to the new version only when this rename
  // lands, and rename within one directory is atomic on POSIX.
  function writeManifest(next) {
    const tmp = path.join(dir, `manifest.tmp-${process.pid}`);
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, manifestPath);
    manifest = next;
  }

  function pruneTemporaryFiles() {
    for (const entry of fs.readdirSync(dir)) {
      const stale = entry.startsWith("tmp-") || entry.startsWith("manifest.tmp-");
      if (!stale) continue;
      fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
    }
  }

  async function fetchSource(url, cached) {
    const headers = {};
    if (cached?.etag) headers["if-none-match"] = cached.etag;
    if (cached?.lastModified) headers["if-modified-since"] = cached.lastModified;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetchImpl(url, { headers, signal: controller.signal, redirect: "manual" });
      if (res.status === 304) return { unchanged: true, ...cached };
      if (res.status >= 300 && res.status < 400) throw new Error("airfield source redirected");
      if (!res.ok) throw new Error(`airfield source HTTP ${res.status}`);
      const contentType = String(res.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
      if (!["text/csv", "text/plain", "application/octet-stream"].includes(contentType)) {
        throw new Error(`airfield source has unexpected content type ${contentType || "(missing)"}`);
      }
      const body = (await readResponseBytes(res, MAX_BODY_BYTES, {
        abort: () => controller.abort(),
      })).toString("utf8");
      return {
        unchanged: false,
        body,
        etag: res.headers.get("etag") || null,
        lastModified: res.headers.get("last-modified") || null,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  function runBuildWorker(airports, runways, now) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL("./airfields-build-worker.mjs", import.meta.url), {
        workerData: {
          dir,
          airportsBody: airports.body,
          runwaysBody: runways.body,
          now,
          currentCounts: manifest?.counts || null,
          keepVersions: [manifest?.version, manifest?.previousVersion].filter(Boolean),
        },
      });
      buildWorkers.add(worker);
      worker.once("message", (message) => {
        if (message.ok) resolve(message.result);
        else reject(new Error(message.error || "airfield build failed"));
      });
      worker.once("error", reject);
      worker.once("exit", (code) => {
        buildWorkers.delete(worker);
        if (code !== 0) reject(new Error("airfield build worker exited"));
      });
    });
  }

  async function build(airports, runways, now) {
    const { version, counts, cellCounts } = await runBuildWorker(airports, runways, now);
    if (manifest?.version === version) return version;
    writeManifest({
      format: FORMAT,
      version,
      previousVersion: manifest?.version || null,
      generatedAt: now,
      checkedAt: now,
      source: {
        airports: { etag: airports.etag, lastModified: airports.lastModified },
        runways: { etag: runways.etag, lastModified: runways.lastModified },
      },
      counts,
      cellSizeDeg: CELL_SIZE_DEG,
      cells: cellCounts,
    });
    log(`dataset ${version} committed: ${counts.airports} airports, ${counts.runways} runways, ${counts.cells} cells`);
    return version;
  }

  async function refreshOnce() {
    const now = new Date().toISOString();
    let airports = await fetchSource(airportsUrl, manifest?.source?.airports);
    let runways = await fetchSource(runwaysUrl, manifest?.source?.runways);
    if (manifest && airports.unchanged && runways.unchanged) {
      writeManifest({ ...manifest, checkedAt: now });
      log("source unchanged");
      return manifest.version;
    }
    // One side changed (or no dataset yet): a build needs BOTH bodies, so a 304 side re-fetches.
    if (airports.unchanged || !airports.body) airports = await fetchSource(airportsUrl, null);
    if (runways.unchanged || !runways.body) runways = await fetchSource(runwaysUrl, null);
    return build(airports, runways, now);
  }

  function schedule(delayMs, reason) {
    if (closed) return;
    clearTimeout(timer);
    timer = setTimeout(() => { void refresh(reason); }, delayMs);
    timer.unref?.();
  }

  async function refresh(reason = "scheduled") {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        await refreshOnce();
        // Weekly cadence with jitter, so a fleet restarted together does not stampede the source.
        schedule(refreshMs + Math.floor(Math.random() * refreshMs * 0.05), "scheduled");
      } catch (error) {
        log(`refresh (${reason}) failed, serving the current dataset:`, error.message);
        schedule(retryMs, "retry");
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  function init() {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    manifest = loadManifestFromDisk();
    pruneTemporaryFiles();
    if (manifest) {
      log(`serving dataset ${manifest.version} (generated ${manifest.generatedAt}); checking freshness in the background`);
      schedule(5000, "boot-freshness");
    } else {
      log("no dataset yet — building now");
      void refresh("boot-build");
    }
  }

  return {
    init,
    refresh,
    manifest: () => manifest,
    versionDir: (version) => (/^[0-9]{8}-[0-9a-f]{10}$/.test(version) ? path.join(dir, `v-${version}`) : null),
    async payload(version, file, encoding = "identity") {
      if (!/^[0-9]{8}-[0-9a-f]{10}$/.test(version) || !/^(index|cell-\d{1,2}-\d{1,2})\.json$/.test(file)) return null;
      const suffix = encoding === "gzip" ? ".gz" : "";
      const key = `${version}/${file}${suffix}`;
      const cached = payloadCache.get(key);
      if (cached && Date.now() - cached.at < PAYLOAD_CACHE_MS) {
        cached.at = Date.now();
        return cached.bytes;
      }
      removeCachedPayload(key);
      try {
        const payloadPath = path.join(dir, `v-${version}`, `${file}${suffix}`);
        const stat = await fs.promises.stat(payloadPath);
        if (!stat.isFile() || stat.size > AIRFIELD_LIMITS.payloadBytes) {
          throw new Error("airfield payload exceeds the configured limit");
        }
        const bytes = await fs.promises.readFile(payloadPath);
        if (bytes.byteLength <= MAX_PAYLOAD_CACHE_BYTES) {
          payloadCache.set(key, { at: Date.now(), bytes });
          payloadCacheBytes += bytes.byteLength;
          prunePayloadCache();
        }
        return bytes;
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      await Promise.allSettled([...buildWorkers].map((worker) => worker.terminate()));
      await refreshing?.catch?.(() => {});
      payloadCache.clear();
      payloadCacheBytes = 0;
    },
  };
}
