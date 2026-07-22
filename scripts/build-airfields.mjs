#!/usr/bin/env node
// Regenerate web/src/airfields.js from OurAirports open data (public domain).
//
//   node scripts/build-airfields.mjs [path/to/airports.csv] [path/to/runways.csv]
//
// With no arguments the current datasets are fetched from OurAirports. The
// generated overlay contains every open large/medium/small airport worldwide,
// its official ICAO/IATA codes, map coordinate, and every usable published open
// runway entry.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const AIRPORTS_SOURCE_URL = "https://davidmegginson.github.io/ourairports-data/airports.csv";
const RUNWAYS_SOURCE_URL = "https://davidmegginson.github.io/ourairports-data/runways.csv";
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

async function loadCsv(file, url) {
  if (file) return fs.readFileSync(file, "utf8");
  const response = await fetch(url);
  if (!response.ok) throw new Error(`fetch ${url} -> ${response.status}`);
  return response.text();
}

const [airportText, runwayText] = await Promise.all([
  loadCsv(process.argv[2], AIRPORTS_SOURCE_URL),
  loadCsv(process.argv[3], RUNWAYS_SOURCE_URL),
]);
const airportRows = parseCsv(airportText);
const runwayRows = parseCsv(runwayText);
const airportIndex = Object.fromEntries(airportRows[0].map((heading, index) => [heading, index]));
const runwayIndex = Object.fromEntries(runwayRows[0].map((heading, index) => [heading, index]));

const runwaysByAirport = new Map();
for (let r = 1; r < runwayRows.length; r += 1) {
  const row = runwayRows[r];
  if (!row || row.length < runwayRows[0].length || row[runwayIndex.closed] === "1") continue;
  const airportIdent = row[runwayIndex.airport_ident];
  if (!airportIdent) continue;
  const ends = [row[runwayIndex.le_ident], row[runwayIndex.he_ident]].filter(Boolean).join("/") || null;
  const lengthFeet = Number.parseFloat(row[runwayIndex.length_ft]);
  const lengthM = Number.isFinite(lengthFeet) ? Math.round(lengthFeet * 0.3048) : null;
  if (!ends && lengthM == null) continue;
  const runways = runwaysByAirport.get(airportIdent) || [];
  runways.push({ ends, lengthM });
  runwaysByAirport.set(airportIdent, runways);
}

const airfields = [];
for (let r = 1; r < airportRows.length; r += 1) {
  const row = airportRows[r];
  if (!row || row.length < airportRows[0].length || !KEEP_TYPES.has(row[airportIndex.type])) continue;
  const lat = Number.parseFloat(row[airportIndex.latitude_deg]);
  const lon = Number.parseFloat(row[airportIndex.longitude_deg]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;
  const ident = row[airportIndex.ident];
  const icao = row[airportIndex.icao_code] || null;
  const iata = row[airportIndex.iata_code] || null;
  const runways = runwaysByAirport.get(ident) || [];
  runways.sort((a, b) => (b.lengthM ?? -1) - (a.lengthM ?? -1) || (a.ends || "").localeCompare(b.ends || ""));
  airfields.push({
    code: iata || icao || ident,
    icao,
    iata,
    name: row[airportIndex.name],
    kind: row[airportIndex.type].replace("_airport", ""),
    city: row[airportIndex.municipality] || null,
    lat: Math.round(lat * 1e5) / 1e5,
    lon: Math.round(lon * 1e5) / 1e5,
    runways,
  });
}

const kindOrder = { large: 0, medium: 1, small: 2 };
airfields.sort((a, b) => (kindOrder[a.kind] - kindOrder[b.kind]) || a.code.localeCompare(b.code));

const lines = airfields.map((airfield) => {
  // Compact tuples keep the checked-in global dataset and its browser payload
  // substantially smaller than repeating object keys for every airport/runway.
  const tuple = [
    airfield.code,
    airfield.icao,
    airfield.iata,
    airfield.name,
    airfield.kind[0],
    airfield.city,
    airfield.lat,
    airfield.lon,
    airfield.runways.map((runway) => [runway.ends, runway.lengthM]),
  ];
  return `  ${JSON.stringify(tuple)}`;
});

const out = `// Worldwide airports and runways for the map reference overlay.\n// Source: OurAirports open data (public domain), filtered to open\n// large/medium/small airports. Regenerate with scripts/build-airfields.mjs.\n\n/**\n * @typedef {Object} Runway\n * @property {?string} ends Reciprocal runway identifiers, for example 16L/34R.\n * @property {?number} lengthM Published runway length, rounded to metres.\n */\n\n/**\n * @typedef {Object} Airfield\n * @property {string} code Best display code: IATA, else ICAO, else OurAirports ident.\n * @property {?string} icao Official ICAO code or null.\n * @property {?string} iata Official IATA code or null.\n * @property {string} name\n * @property {"large"|"medium"|"small"} kind\n * @property {?string} city\n * @property {number} lat\n * @property {number} lon\n * @property {Runway[]} runways All published open runways.\n */\n\nconst DATA = [\n${lines.join(",\n")}\n];\n\nconst KINDS = { l: "large", m: "medium", s: "small" };\n\n/** @type {Airfield[]} */\nexport const AIRFIELDS = DATA.map(([code, icao, iata, name, kind, city, lat, lon, runways]) => ({\n  code,\n  icao,\n  iata,\n  name,\n  kind: KINDS[kind],\n  city,\n  lat,\n  lon,\n  runways: runways.map(([ends, lengthM]) => ({ ends, lengthM })),\n}));\n\n/** True for fields with no official ICAO/IATA code. */\nexport const isMinorAirfield = (airfield) => !airfield.icao && !airfield.iata;\n`;

fs.writeFileSync(OUT, out);
console.log(`Wrote ${airfields.length} airports and ${airfields.reduce((sum, airfield) => sum + airfield.runways.length, 0)} runways to ${OUT}`);
