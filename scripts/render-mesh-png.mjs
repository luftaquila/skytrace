#!/usr/bin/env node
// Offline software rasterizer → PNG, so meshes can be eyeballed without a browser. Reads
// scratchpad/type-meshes.json and renders a grid: each mesh as [3/4 view | side view | top view]
// with z-buffered flat shading. Frame: +X nose, +Y span, +Z up.
//   node scripts/build-type-meshes.mjs && node scripts/render-mesh-png.mjs [name1 name2 ...]
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IN = path.join(HERE, "../scratchpad/type-meshes.json");
const OUT = path.join(HERE, "../scratchpad/mesh-render.png");

const meshes = JSON.parse(fs.readFileSync(IN, "utf8"));
const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(meshes);

const CELL = 300, COLS = (process.env.VIEWS || "3/4,side,top").split(",").length;
const ROWS = names.length;
const W = CELL * COLS, H = CELL * ROWS;
const img = new Uint8Array(W * H * 3);
const zbuf = new Float32Array(W * H).fill(-Infinity);
// dark tactical background
for (let i = 0; i < W * H; i++) { img[i * 3] = 10; img[i * 3 + 1] = 18; img[i * 3 + 2] = 22; }

const rotZ = (p, a) => [p[0] * Math.cos(a) - p[1] * Math.sin(a), p[0] * Math.sin(a) + p[1] * Math.cos(a), p[2]];
const rotX = (p, a) => [p[0], p[1] * Math.cos(a) - p[2] * Math.sin(a), p[1] * Math.sin(a) + p[2] * Math.cos(a)];
// views return [screenX, screenY(up), depth(bigger=closer)]
const VIEWS = {
  "3/4": (p) => { const q = rotX(rotZ(p, -0.6), -1.15); return [q[0], q[2], q[1]]; },
  side: (p) => [p[0], p[2], -p[1]],   // look along +Y → X-Z plane (nose right, up = +Z)
  top: (p) => [p[0], -p[1], p[2]],    // look down -Z → X-Y plane (nose right)
  front: (p) => [-p[1], p[2], p[0]],  // look along -X → Y-Z cross-section (up = +Z), nose toward camera
  under: (p) => [p[0], p[1], -p[2]],  // look UP from below (checks scooped/hollow undersides)
  rear: (p) => { const q = rotX(rotZ(p, 2.45), -1.15); return [q[0], q[2], q[1]]; }, // rear 3/4 from above
  rearlow: (p) => { const q = rotX(rotZ(p, 2.45), -1.85); return [q[0], q[2], q[1]]; }, // rear 3/4 from below
};
const VIEW_LIST = (process.env.VIEWS || "3/4,side,top").split(",");

function shade(nv) { // nv = view-space normal; light from upper-front
  const L = [0.3, 0.5, 0.8], ll = Math.hypot(...L);
  const d = Math.abs((nv[0] * L[0] + nv[1] * L[1] + nv[2] * L[2]) / (ll * (Math.hypot(...nv) || 1)));
  return 0.45 + 0.55 * d;
}

const FOCUS = process.env.FOCUS ? process.env.FOCUS.split(",").map(Number) : null; // [xmin,xmax] model-space
function drawCell(mesh, viewName, ox, oy) {
  const view = VIEWS[viewName];
  const P = mesh.positions, N = mesh.normals;
  const n = P.length / 3;
  const sv = new Array(n), sn = new Array(n);
  const inFocus = (t) => !FOCUS || (() => { const cx = (P[t * 3] + P[(t + 1) * 3] + P[(t + 2) * 3]) / 3; return cx >= FOCUS[0] && cx <= FOCUS[1]; })();
  let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity;
  for (let i = 0; i < n; i++) {
    const p = [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];
    const s = view(p); sv[i] = s;
    sn[i] = view([N[i * 3], N[i * 3 + 1], N[i * 3 + 2]]); // rotate normal the same way (views are rotations/axis-swaps)
    if (FOCUS && !inFocus(Math.floor(i / 3) * 3)) continue;
    mnx = Math.min(mnx, s[0]); mxx = Math.max(mxx, s[0]); mny = Math.min(mny, s[1]); mxy = Math.max(mxy, s[1]);
  }
  const pad = 26, span = Math.max(mxx - mnx, mxy - mny) || 1;
  const sc = (CELL - pad * 2) / span;
  const cx = (mnx + mxx) / 2, cy = (mny + mxy) / 2;
  const toPx = (s) => [ox + CELL / 2 + (s[0] - cx) * sc, oy + CELL / 2 - (s[1] - cy) * sc];
  for (let t = 0; t < n; t += 3) {
    if (FOCUS && !inFocus(t)) continue;
    const a = toPx(sv[t]), b = toPx(sv[t + 1]), c = toPx(sv[t + 2]);
    const nrm = [(sn[t][0] + sn[t + 1][0] + sn[t + 2][0]), (sn[t][1] + sn[t + 1][1] + sn[t + 2][1]), (sn[t][2] + sn[t + 1][2] + sn[t + 2][2])];
    const g = shade(nrm);
    const col = [Math.min(255, 150 * g + 20), Math.min(255, 205 * g), Math.min(255, 230 * g)];
    const dep = (sv[t][2] + sv[t + 1][2] + sv[t + 2][2]) / 3;
    const minx = Math.max(ox, Math.floor(Math.min(a[0], b[0], c[0]))), maxx = Math.min(ox + CELL - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
    const miny = Math.max(oy, Math.floor(Math.min(a[1], b[1], c[1]))), maxy = Math.min(oy + CELL - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
    const area = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
    if (Math.abs(area) < 1e-6) continue;
    for (let y = miny; y <= maxy; y++) for (let x = minx; x <= maxx; x++) {
      const px = x + 0.5, py = y + 0.5;
      const w0 = ((b[0] - px) * (c[1] - py) - (c[0] - px) * (b[1] - py)) / area;
      const w1 = ((c[0] - px) * (a[1] - py) - (a[0] - px) * (c[1] - py)) / area;
      const w2 = 1 - w0 - w1;
      if (w0 < -0.001 || w1 < -0.001 || w2 < -0.001) continue;
      const idx = y * W + x;
      if (dep <= zbuf[idx]) continue;
      zbuf[idx] = dep;
      img[idx * 3] = col[0]; img[idx * 3 + 1] = col[1]; img[idx * 3 + 2] = col[2];
    }
  }
}

names.forEach((name, r) => {
  if (!meshes[name]) { console.warn(`no mesh: ${name}`); return; }
  VIEW_LIST.forEach((vn, cIdx) => drawCell(meshes[name], vn, cIdx * CELL, r * CELL));
});

// ---- PNG encode (RGB, color type 2) ----
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const tb = Buffer.from(type, "ascii");
  const body = Buffer.concat([tb, data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y++) { raw[y * (W * 3 + 1)] = 0; for (let x = 0; x < W * 3; x++) raw[y * (W * 3 + 1) + 1 + x] = img[y * W * 3 + x]; }
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2; // 8-bit, RGB
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
  chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
]);
fs.writeFileSync(OUT, png);
console.log(`wrote ${path.relative(process.cwd(), OUT)} (${W}×${H}, rows: ${names.join(", ")}; cols: ${VIEW_LIST.join(" | ")})`);
