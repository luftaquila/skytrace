import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { parentPort, workerData } from "node:worker_threads";
import { AIRFIELD_LIMITS, buildAirfieldTuples } from "./airfields-store.mjs";

const FORMAT = 1;
// A refresh that produced obviously less data than the world has (or than we already serve) is a
// broken download, not a smaller planet. Absolute floors catch a truncated first build; the
// relative floor catches a source regression once a good dataset exists.
const MIN_AIRPORTS = 40000;
const MIN_INDEX = 4000;
const MIN_RUNWAYS = 20000;
const RELATIVE_FLOOR = 0.9;
const VERSION_RETENTION_MS = 60 * 86400000;

function validate(counts, current) {
  if (counts.airports < MIN_AIRPORTS) throw new Error("airport dataset is incomplete");
  if (counts.index < MIN_INDEX) throw new Error("airport index is incomplete");
  if (counts.runways < MIN_RUNWAYS) throw new Error("runway dataset is incomplete");
  if (counts.airports > AIRFIELD_LIMITS.airports) throw new Error("airport dataset exceeds the configured limit");
  if (counts.index > AIRFIELD_LIMITS.index) throw new Error("airport index exceeds the configured limit");
  if (counts.runways > AIRFIELD_LIMITS.runways) throw new Error("runway dataset exceeds the configured limit");
  if (counts.cells > AIRFIELD_LIMITS.cells) throw new Error("airport cell count exceeds the configured limit");
  if (current) {
    for (const key of ["airports", "index", "small", "runways"]) {
      if (counts[key] < current[key] * RELATIVE_FLOOR) throw new Error("airport dataset regressed");
    }
  }
}

function writePayload(dirPath, name, payload, budget) {
  const json = Buffer.from(JSON.stringify(payload));
  if (json.byteLength > AIRFIELD_LIMITS.payloadBytes) {
    throw new Error(`${name} exceeds the configured payload limit`);
  }
  const compressed = zlib.gzipSync(json);
  if (compressed.byteLength > AIRFIELD_LIMITS.payloadBytes) {
    throw new Error(`${name}.gz exceeds the configured payload limit`);
  }
  budget.bytes += json.byteLength + compressed.byteLength;
  if (budget.bytes > AIRFIELD_LIMITS.versionBytes) {
    throw new Error("airfield version exceeds the configured byte limit");
  }
  fs.writeFileSync(path.join(dirPath, name), json, { mode: 0o600 });
  fs.writeFileSync(path.join(dirPath, `${name}.gz`), compressed, { mode: 0o600 });
}

function directoryBytes(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    total += entry.isDirectory() ? directoryBytes(file) : fs.statSync(file).size;
  }
  return total;
}

function pruneVersions(dir, keep, nowMs) {
  const versions = fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^v-[0-9]{8}-[0-9a-f]{10}$/.test(entry.name))
    .map((entry) => {
      const target = path.join(dir, entry.name);
      const stat = fs.statSync(target);
      return {
        name: entry.name,
        version: entry.name.slice(2),
        target,
        mtimeMs: stat.mtimeMs,
        bytes: directoryBytes(target),
      };
    })
    .sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const version of versions) {
    if (!keep.has(version.version) && nowMs - version.mtimeMs >= VERSION_RETENTION_MS) {
      fs.rmSync(version.target, { recursive: true, force: true });
      version.removed = true;
    }
  }
  let total = versions.filter((version) => !version.removed).reduce((sum, version) => sum + version.bytes, 0);
  for (const version of versions) {
    if (total <= AIRFIELD_LIMITS.storeBytes) break;
    if (version.removed || keep.has(version.version)) continue;
    fs.rmSync(version.target, { recursive: true, force: true });
    version.removed = true;
    total -= version.bytes;
  }
  if (total > AIRFIELD_LIMITS.storeBytes) {
    throw new Error("retained airfield versions exceed the configured store limit");
  }
}

function build() {
  const { dir, airportsBody, runwaysBody, now, currentCounts, keepVersions } = workerData;
  const { index, cells, counts } = buildAirfieldTuples(airportsBody, runwaysBody);
  validate(counts, currentCounts);
  const version = `${now.slice(0, 10).replaceAll("-", "")}-${
    crypto.createHash("sha256").update(airportsBody).update(runwaysBody).digest("hex").slice(0, 10)}`;
  const target = path.join(dir, `v-${version}`);
  const cellCounts = {};
  let created = false;
  if (!fs.existsSync(target)) {
    const tmpDir = path.join(dir, `tmp-${process.pid}-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
    try {
      const budget = { bytes: 0 };
      writePayload(tmpDir, "index.json", { format: FORMAT, version, tier: "index", fields: index }, budget);
      for (const [id, fields] of cells) {
        if (fields.length > AIRFIELD_LIMITS.cellFields) {
          throw new Error(`airfield cell ${id} exceeds the configured field limit`);
        }
        cellCounts[id] = fields.length;
        writePayload(tmpDir, `cell-${id}.json`, { format: FORMAT, version, cell: id, fields }, budget);
      }
      fs.renameSync(tmpDir, target);
      created = true;
    } catch (error) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      throw error;
    }
  } else {
    if (directoryBytes(target) > AIRFIELD_LIMITS.versionBytes) {
      throw new Error("existing airfield version exceeds the configured byte limit");
    }
    for (const [id, fields] of cells) cellCounts[id] = fields.length;
  }
  try {
    pruneVersions(dir, new Set([...keepVersions, version]), Date.parse(now));
  } catch (error) {
    if (created) fs.rmSync(target, { recursive: true, force: true });
    throw error;
  }
  return { version, counts, cellCounts };
}

try {
  parentPort.postMessage({ ok: true, result: build() });
} catch (error) {
  parentPort.postMessage({ ok: false, error: error?.message || "airfield build failed" });
}
