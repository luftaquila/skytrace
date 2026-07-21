#!/usr/bin/env node
// Generate web/public/aircraft.glb — a slender low-poly jet used by the deck.gl ScenegraphLayer
// in the 3D view. Proportions match the old three.js `buildPlaneGeo` (slender rounded fuselage,
// SHORT nose taper, modestly-spanned swept wings, under-wing nacelles, swept tailplanes + fin)
// so the 3D aircraft reads exactly like the previous version.
//
// Model frame: nose points +X, up is +Z, wings span ±Y (deck tints the grey model per-altitude
// and orients it by [pitch, yaw, roll]).
//
//   node scripts/build-aircraft-glb.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OUT = path.resolve(fileURLToPath(new URL("../web/public/aircraft.glb", import.meta.url)));
const tris = []; // each: [ [x,y,z], [x,y,z], [x,y,z] ]
const tri = (a, b, c) => tris.push([a, b, c]);
const quad = (a, b, c, d) => { tri(a, b, c); tri(a, c, d); };

// --- Fuselage: slender rounded tube (10-sided) along X, short nose taper to a point ---
const SIDES = 10;
function ring(x, r) {
  return Array.from({ length: SIDES }, (_, i) => {
    const a = (i / SIDES) * Math.PI * 2;
    return [x, Math.cos(a) * r, Math.sin(a) * r]; // radial in Y (span) / Z (up)
  });
}
const nose = [0.40, 0, 0];         // short nose tip
const tail = [-0.37, 0, 0];
const r1 = ring(0.28, 0.032);      // nose shoulder (short taper 0.28 -> 0.40)
const r2 = ring(0.06, 0.050);      // forward barrel
const r3 = ring(-0.18, 0.049);     // aft barrel
const r4 = ring(-0.34, 0.024);     // tail cone base
for (let i = 0; i < SIDES; i += 1) {
  const j = (i + 1) % SIDES;
  tri(nose, r1[i], r1[j]);          // short nose cone
  quad(r1[i], r2[i], r2[j], r1[j]); // forward barrel
  quad(r2[i], r3[i], r3[j], r2[j]); // mid barrel
  quad(r3[i], r4[i], r4[j], r3[j]); // aft barrel
  tri(tail, r4[j], r4[i]);          // tail cone
}

// --- Thin swept slabs (read as real surfaces from any angle) ---
function slab(corners, z, t) { // corners: [x(chord), y(span)]
  const top = corners.map(([x, y]) => [x, y, z + t]);
  const bot = corners.map(([x, y]) => [x, y, z - t]);
  quad(top[0], top[1], top[2], top[3]);
  quad(bot[3], bot[2], bot[1], bot[0]);
  for (let i = 0; i < 4; i += 1) { const j = (i + 1) % 4; quad(top[i], bot[i], bot[j], top[j]); }
}
// Wings: modest span (to y=±0.32), swept aft, tapered — matches the old three.js wing.
slab([[0.0, 0.045], [-0.14, 0.045], [-0.26, 0.32], [-0.20, 0.32]], -0.01, 0.011);  // right (+Y)
slab([[0.0, -0.045], [-0.20, -0.32], [-0.26, -0.32], [-0.14, -0.045]], -0.01, 0.011); // left (-Y)
// Tailplanes (swept, small)
slab([[-0.32, 0.03], [-0.42, 0.16], [-0.46, 0.16], [-0.42, 0.03]], 0.015, 0.007);   // right
slab([[-0.32, -0.03], [-0.42, -0.16], [-0.46, -0.16], [-0.42, -0.03]], 0.015, 0.007); // left

// --- Under-wing nacelles: short tapered tubes along X, below the wing ---
function nacelle(ySign) {
  const y = ySign * 0.185;
  const zc = -0.055;
  const nr = ring(0, 0.024).map(([, cy, cz]) => [cy, cz]); // unit-ish radial offsets
  const front = 0.02, back = -0.14, rf = 0.026, rb = 0.020;
  const fRing = nr.map(([cy, cz]) => [front, y + (cy / 0.024) * rf, zc + (cz / 0.024) * rf]);
  const bRing = nr.map(([cy, cz]) => [back, y + (cy / 0.024) * rb, zc + (cz / 0.024) * rb]);
  const fc = [front + 0.03, y, zc], bc = [back, y, zc];
  for (let i = 0; i < SIDES; i += 1) {
    const j = (i + 1) % SIDES;
    tri(fc, fRing[j], fRing[i]);          // front cap (open-ish nose)
    quad(fRing[i], bRing[i], bRing[j], fRing[j]);
    tri(bc, bRing[i], bRing[j]);          // back cap
  }
}
nacelle(1); nacelle(-1);

// --- Vertical fin (swept), in the X-Z plane at y=0 ---
{
  const c = [[-0.32, 0], [-0.46, 0], [-0.47, 0.19], [-0.37, 0.19]]; // [x, z(up)]
  const t = 0.009;
  const top = c.map(([x, z]) => [x, t, z]);
  const bot = c.map(([x, z]) => [x, -t, z]);
  quad(top[0], top[1], top[2], top[3]);
  quad(bot[3], bot[2], bot[1], bot[0]);
  for (let i = 0; i < 4; i += 1) { const j = (i + 1) % 4; quad(top[i], bot[i], bot[j], top[j]); }
}

// --- Emit non-indexed positions + per-face normals ---
const pos = [];
const nrm = [];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
for (const [a, b, c] of tris) {
  let n = cross(sub(b, a), sub(c, a));
  const len = Math.hypot(...n) || 1;
  n = [n[0] / len, n[1] / len, n[2] / len];
  for (const v of [a, b, c]) { pos.push(...v); nrm.push(...n); }
}
const posArr = new Float32Array(pos);
const nrmArr = new Float32Array(nrm);
const count = posArr.length / 3;
const min = [Infinity, Infinity, Infinity];
const max = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i < count; i += 1) {
  for (let k = 0; k < 3; k += 1) {
    const v = posArr[i * 3 + k];
    if (v < min[k]) min[k] = v;
    if (v > max[k]) max[k] = v;
  }
}

const posBytes = posArr.byteLength;
const bin = new Uint8Array(posBytes + nrmArr.byteLength);
bin.set(new Uint8Array(posArr.buffer), 0);
bin.set(new Uint8Array(nrmArr.buffer), posBytes);

const gltf = {
  asset: { version: "2.0", generator: "skytrace build-aircraft-glb" },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ mesh: 0 }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, material: 0, mode: 4 }] }],
  materials: [{
    pbrMetallicRoughness: { baseColorFactor: [0.82, 0.85, 0.9, 1], metallicFactor: 0.1, roughnessFactor: 0.5 },
    doubleSided: true,
  }],
  buffers: [{ byteLength: bin.byteLength }],
  bufferViews: [
    { buffer: 0, byteOffset: 0, byteLength: posBytes, target: 34962 },
    { buffer: 0, byteOffset: posBytes, byteLength: nrmArr.byteLength, target: 34962 },
  ],
  accessors: [
    { bufferView: 0, componentType: 5126, count, type: "VEC3", min, max },
    { bufferView: 1, componentType: 5126, count, type: "VEC3" },
  ],
};

function padTo4(buf, padByte) {
  const rem = buf.byteLength % 4;
  if (rem === 0) return buf;
  const pad = new Uint8Array(4 - rem).fill(padByte);
  return Buffer.concat([Buffer.from(buf), Buffer.from(pad)]);
}
const jsonChunk = padTo4(Buffer.from(JSON.stringify(gltf), "utf8"), 0x20);
const binChunk = padTo4(Buffer.from(bin), 0x00);
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0); // "glTF"
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8);
const jsonHeader = Buffer.alloc(8);
jsonHeader.writeUInt32LE(jsonChunk.length, 0);
jsonHeader.writeUInt32LE(0x4e4f534a, 4); // "JSON"
const binHeader = Buffer.alloc(8);
binHeader.writeUInt32LE(binChunk.length, 0);
binHeader.writeUInt32LE(0x004e4942, 4); // "BIN\0"
fs.writeFileSync(OUT, Buffer.concat([header, jsonHeader, jsonChunk, binHeader, binChunk]));
console.log(`wrote ${tris.length} triangles (${count} verts) -> ${path.relative(process.cwd(), OUT)} (${fs.statSync(OUT).size} bytes)`);
