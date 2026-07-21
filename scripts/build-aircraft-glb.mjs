#!/usr/bin/env node
// Generate web/public/aircraft.glb — a small low-poly airliner used by the Cesium 3D view.
// Nose points +X, up is +Z (Cesium tints the grey model per-altitude via Model.color).
//
//   node scripts/build-aircraft-glb.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OUT = path.resolve(fileURLToPath(new URL("../web/public/aircraft.glb", import.meta.url)));
const tris = []; // each: [ [x,y,z], [x,y,z], [x,y,z] ]
const tri = (a, b, c) => tris.push([a, b, c]);
const quad = (a, b, c, d) => { tri(a, b, c); tri(a, c, d); };

// --- Fuselage: hexagonal tube, nose taper to a point, tapered tail ---
const SIDES = 6;
function ring(x, r) {
  return Array.from({ length: SIDES }, (_, i) => {
    const a = (i / SIDES) * Math.PI * 2;
    return [x, Math.cos(a) * r, Math.sin(a) * r];
  });
}
const nose = [0.62, 0, 0];
const tail = [-0.56, 0, 0];
const r1 = ring(0.34, 0.055);
const r2 = ring(-0.1, 0.062);
const r3 = ring(-0.42, 0.045);
for (let i = 0; i < SIDES; i += 1) {
  const j = (i + 1) % SIDES;
  tri(nose, r1[i], r1[j]);           // nose cone
  quad(r1[i], r2[i], r2[j], r1[j]);  // mid barrel
  quad(r2[i], r3[i], r3[j], r2[j]);  // aft barrel
  tri(tail, r3[j], r3[i]);           // tail cone
}

// --- Wings (swept), thin slabs so they read from any angle ---
function slab(corners, z, t) {
  const top = corners.map(([x, y]) => [x, y, z + t]);
  const bot = corners.map(([x, y]) => [x, y, z - t]);
  quad(top[0], top[1], top[2], top[3]);
  quad(bot[3], bot[2], bot[1], bot[0]);
  for (let i = 0; i < 4; i += 1) {
    const j = (i + 1) % 4;
    quad(top[i], bot[i], bot[j], top[j]);
  }
}
// right wing (+Y), root near fuselage, tip swept aft
slab([[0.05, 0.05], [-0.14, 0.05], [-0.26, 0.5], [-0.12, 0.5]], -0.008, 0.012);
// left wing (-Y)
slab([[0.05, -0.05], [-0.12, -0.5], [-0.26, -0.5], [-0.14, -0.05]], -0.008, 0.012);
// tailplanes
slab([[-0.4, 0.04], [-0.5, 0.04], [-0.56, 0.2], [-0.48, 0.2]], 0.01, 0.008);
slab([[-0.4, -0.04], [-0.48, -0.2], [-0.56, -0.2], [-0.5, -0.04]], 0.01, 0.008);
// vertical fin (in X-Z plane)
{
  const c = [[-0.4, 0.02], [-0.52, 0.02], [-0.56, 0.22], [-0.46, 0.22]]; // [x, z]
  const t = 0.01;
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
    pbrMetallicRoughness: { baseColorFactor: [0.82, 0.85, 0.9, 1], metallicFactor: 0.1, roughnessFactor: 0.6 },
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
