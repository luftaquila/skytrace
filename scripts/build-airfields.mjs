#!/usr/bin/env node
// Regenerate web/src/airfields.js from OurAirports open data (public domain).
//
//   node scripts/build-airfields.mjs [path/to/airports.csv]
//
// With no argument the current dataset is fetched from OurAirports. Keeps only
// KR large/medium/small airports, drops rows outside the Korea bounding box
// (removes mislabeled foreign coordinates), and deduplicates near-identical
// points, keeping the entry with the richest identifier.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_URL = "https://davidmegginson.github.io/ourairports-data/airports.csv";
const OUT = path.resolve(fileURLToPath(new URL("../web/src/airfields.js", import.meta.url)));
const KEEP_TYPES = new Set(["large_airport", "medium_airport", "small_airport"]);

// Minimal RFC-4180 CSV parser (handles quoted fields with commas/quotes).
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// South Korea bounding box (incl. Jeju, Ulleung, offshore).
const inKorea = (lat, lon) => lat >= 32.8 && lat <= 38.9 && lon >= 124.0 && lon <= 132.2;
const isRealIcao = (s) => /^RK[A-Z]{2}$/.test(s || "");

async function loadCsv() {
  const arg = process.argv[2];
  if (arg) return fs.readFileSync(arg, "utf8");
  const res = await fetch(SOURCE_URL);
  if (!res.ok) throw new Error(`fetch ${SOURCE_URL} -> ${res.status}`);
  return res.text();
}

const rows = parseCsv(await loadCsv());
const idx = Object.fromEntries(rows[0].map((h, i) => [h, i]));

const parsed = [];
for (let r = 1; r < rows.length; r += 1) {
  const row = rows[r];
  if (!row || row.length < rows[0].length) continue;
  if (row[idx.iso_country] !== "KR") continue;
  if (!KEEP_TYPES.has(row[idx.type])) continue;
  const lat = Number.parseFloat(row[idx.latitude_deg]);
  const lon = Number.parseFloat(row[idx.longitude_deg]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !inKorea(lat, lon)) continue;
  const ident = row[idx.ident];
  const icaoRaw = row[idx.icao_code] || ident;
  const icao = isRealIcao(icaoRaw) ? icaoRaw : null;
  const iata = row[idx.iata_code] || null;
  parsed.push({
    ident,
    icao,
    iata,
    code: iata || icao || ident,
    name: row[idx.name],
    kind: row[idx.type].replace("_airport", ""),
    city: row[idx.municipality] || null,
    lat: Math.round(lat * 1e5) / 1e5,
    lon: Math.round(lon * 1e5) / 1e5,
  });
}

// Dedup near-identical points (~500 m), keeping the richest identifier.
const rank = (a) => (a.iata ? 3 : 0) + (a.icao ? 2 : 0) + ({ large: 1, medium: 1, small: 0 }[a.kind] || 0);
const kept = [];
for (const a of [...parsed].sort((x, y) => rank(y) - rank(x))) {
  if (kept.some((b) => Math.abs(b.lat - a.lat) < 0.005 && Math.abs(b.lon - a.lon) < 0.005)) continue;
  kept.push(a);
}

const order = { large: 0, medium: 1, small: 2 };
kept.sort((a, b) => (order[a.kind] - order[b.kind]) || a.code.localeCompare(b.code));

const lines = kept.map((a) => {
  const o = { code: a.code, icao: a.icao, iata: a.iata, name: a.name, kind: a.kind, city: a.city, lat: a.lat, lon: a.lon };
  return "  " + JSON.stringify(o).replace(/"([a-zA-Z]+)":/g, "$1: ").replace(/,(\S)/g, ", $1");
});

const out = `// South Korean airfields — location and codes for the map reference overlay.
// Source: OurAirports open data (public domain), filtered to iso_country=KR,
// types large/medium/small_airport, cleaned to the Korea bounding box and
// deduplicated by proximity. \`icao\`/\`iata\` are null when no official code
// exists (military helipads, emergency strips); such fields have minor=true.
// Regenerate with scripts/build-airfields.mjs if the source data changes.

/**
 * @typedef {Object} Airfield
 * @property {string} code   Best display code: IATA, else ICAO, else raw ident.
 * @property {?string} icao  Official ICAO code (RKxx) or null.
 * @property {?string} iata  Official IATA code or null.
 * @property {string} name
 * @property {"large"|"medium"|"small"} kind
 * @property {?string} city
 * @property {number} lat
 * @property {number} lon
 */

/** @type {Airfield[]} */
export const AIRFIELDS = [
${lines.join(",\n")},
];

/** True for fields with no official ICAO/IATA code (minor military/emergency strips). */
export const isMinorAirfield = (a) => !a.icao && !a.iata;
`;

fs.writeFileSync(OUT, out);
const byKind = kept.reduce((m, a) => ((m[a.kind] = (m[a.kind] || 0) + 1), m), {});
console.log(`wrote ${OUT}: ${kept.length} airfields`, byKind);
