#!/usr/bin/env node
// Regenerate web/src/runways.js from OurAirports open data (public domain).
//
//   node scripts/build-runways.mjs [path/to/runways.csv]
//
// Keeps runways whose airport ICAO matches a coded field in web/src/airfields.js, using
// the real threshold coordinates, length, width and heading. Where a runway row lacks
// threshold coordinates, the endpoints are derived from the airport centre + heading +
// length so every listed runway still draws to scale.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AIRFIELDS } from "../web/src/airfields.js";

const SOURCE_URL = "https://davidmegginson.github.io/ourairports-data/runways.csv";
const OUT = path.resolve(fileURLToPath(new URL("../web/src/runways.js", import.meta.url)));
const EARTH_R = 6378137;

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i += 1; } else inQuotes = false; } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Destination point given start, bearing (deg true) and distance (m).
function destination(lat, lon, brgDeg, distM) {
  const d = distM / EARTH_R;
  const b = (brgDeg * Math.PI) / 180;
  const la1 = (lat * Math.PI) / 180;
  const lo1 = (lon * Math.PI) / 180;
  const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(b));
  const lo2 = lo1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la1), Math.cos(d) - Math.sin(la1) * Math.sin(la2));
  return [(lo2 * 180) / Math.PI, (la2 * 180) / Math.PI];
}

async function loadCsv() {
  const arg = process.argv[2];
  if (arg) return fs.readFileSync(arg, "utf8");
  const res = await fetch(SOURCE_URL);
  if (!res.ok) throw new Error(`fetch ${SOURCE_URL} -> ${res.status}`);
  return res.text();
}

const byIcao = new Map(AIRFIELDS.filter((a) => a.icao).map((a) => [a.icao, a]));
const rows = parseCsv(await loadCsv());
const idx = Object.fromEntries(rows[0].map((h, i) => [h, i]));
const num = (v) => { const n = Number.parseFloat(v); return Number.isFinite(n) ? n : null; };

const runways = [];
for (let r = 1; r < rows.length; r += 1) {
  const row = rows[r];
  if (!row || row.length < rows[0].length) continue;
  const icao = row[idx.airport_ident];
  const field = byIcao.get(icao);
  if (!field) continue;
  if (row[idx.closed] === "1") continue;
  const lenFt = num(row[idx.length_ft]) || 0;
  const widthFt = num(row[idx.width_ft]) || 150;
  const hdg = num(row[idx.le_heading_degT]);
  let leLat = num(row[idx.le_latitude_deg]);
  let leLon = num(row[idx.le_longitude_deg]);
  let heLat = num(row[idx.he_latitude_deg]);
  let heLon = num(row[idx.he_longitude_deg]);
  if (leLat == null || leLon == null || heLat == null || heLon == null) {
    // Derive from the airport centre + heading + length when thresholds are missing.
    if (hdg == null || lenFt < 100) continue;
    const half = (lenFt * 0.3048) / 2;
    [leLon, leLat] = destination(field.lat, field.lon, (hdg + 180) % 360, half);
    [heLon, heLat] = destination(field.lat, field.lon, hdg, half);
  }
  const elevFt = num(row[idx.le_elevation_ft]) ?? num(row[idx.he_elevation_ft]);
  runways.push({
    icao,
    ident: `${row[idx.le_ident] || ""}/${row[idx.he_ident] || ""}`.replace(/^\/|\/$/g, ""),
    len: Math.round(lenFt),
    width: Math.round(widthFt),
    elevFt: elevFt == null ? null : Math.round(elevFt),
    le: [Number(leLon.toFixed(6)), Number(leLat.toFixed(6))],
    he: [Number(heLon.toFixed(6)), Number(heLat.toFixed(6))],
  });
}
runways.sort((a, b) => (a.icao === b.icao ? b.len - a.len : a.icao.localeCompare(b.icao)));

const body = runways
  .map((r) => `  {icao: ${JSON.stringify(r.icao)}, ident: ${JSON.stringify(r.ident)}, len: ${r.len}, width: ${r.width}, elevFt: ${r.elevFt}, le: [${r.le[0]}, ${r.le[1]}], he: [${r.he[0]}, ${r.he[1]}]},`)
  .join("\n");
const out = `// South Korean airport runways from OurAirports open data (public domain).
// Regenerate with scripts/build-runways.mjs. Coordinates are threshold [lon, lat];
// len/width in feet; elevFt is threshold elevation (null when unknown).
//
// @typedef {Object} Runway
// @property {string} icao  Owning airport ICAO (matches AIRFIELDS[].icao).
// @property {string} ident e.g. "16/34".
// @property {number} len   Length, feet.
// @property {number} width Width, feet.
// @property {?number} elevFt
// @property {[number, number]} le  Low-end threshold [lon, lat].
// @property {[number, number]} he  High-end threshold [lon, lat].

/** @type {Runway[]} */
export const RUNWAYS = [
${body}
];
`;
fs.writeFileSync(OUT, out);
console.log(`wrote ${runways.length} runways for ${new Set(runways.map((r) => r.icao)).size} airports -> ${path.relative(process.cwd(), OUT)}`);
