#!/usr/bin/env node
// Q-012 — ONE pure-JS procedural generator for every aircraft mesh in the 3D view (no three.js):
//
//   size buckets:  small (P-51), medium, large — authored directly with the procedural primitives
//                  in this generator.
//
//   per-type:      helicopter (A7), glider (B1), airship (B2), F-22 fighter (A6), quadcopter UAV (B6),
//                  Starship (B7), parachutist (B3), surface vehicle (C1/C2)   — new for Q-012.
//
// Model frame: +X nose (forward), +Y span (right/left), +Z up. Normals are baked with crease-angle
// smoothing. Every per-type mesh is a closed watertight solid (no zero-thickness surfaces) built only
// from closed primitives, with each part interpenetrating its neighbour rather than merely touching.
// Run:  node scripts/build-type-meshes.mjs
//   → validates every mesh (watertight / no degenerate triangles / outward normals / triangle budget),
//     writes web/src/aircraft-geometry.js (what the app renders) and .cache/meshes/type-meshes.json (what
//     build-mesh-preview.mjs and render-mesh-png.mjs read to look at the result). The generated module
//     is committed, so `git diff web/src/aircraft-geometry.js` is the regression guard: a shape that
//     already has sign-off cannot move without showing up there.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PREVIEW_JSON = path.join(HERE, "../.cache/meshes/type-meshes.json");
const GEOMETRY_JS = path.join(HERE, "../web/src/aircraft-geometry.js");

// ---- vector helpers ----------------------------------------------------------------------------
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mulS = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// ================================================================================================
// Builder — a triangle-soup accumulator with every primitive both mesh families need.
// ================================================================================================
function Builder() {
  const tris = [];
  const tri = (a, b, c) => tris.push([a, b, c]);
  const quad = (a, b, c, d) => { tri(a, b, c); tri(a, c, d); };

  // ---- solids for the per-type meshes (helicopter / glider / airship) --------------------------

  // Capped elliptical tube revolved around X. sections: [{ x, ry, rz, y?, z? }] front→back; y/z offset
  // the ring centre (bendable axis). A +π/2 phase puts a VERTEX at the top (+Z) and keeps left-right
  // symmetry for any side count. ry=rz=0 ⇒ a point (cone) cap; open ends get a flat fan cap.
  function tube(sections, sides) {
    const ctr = (s) => [s.x, s.y || 0, s.z || 0];
    const ringAt = (s) => Array.from({ length: sides }, (_, i) => {
      const a = Math.PI / 2 + (i / sides) * Math.PI * 2;
      return [s.x, (s.y || 0) + Math.cos(a) * s.ry, (s.z || 0) + Math.sin(a) * s.rz];
    });
    const isPt = (s) => s.ry === 0 && s.rz === 0;
    const rings = sections.map((s) => (isPt(s) ? null : ringAt(s)));
    for (let k = 0; k < sections.length - 1; k += 1) {
      const r0 = rings[k], r1 = rings[k + 1];
      if (r0 && r1) { for (let i = 0; i < sides; i += 1) { const j = (i + 1) % sides; quad(r0[i], r1[i], r1[j], r0[j]); } }
      else if (r0 && !r1) { const tip = ctr(sections[k + 1]); for (let i = 0; i < sides; i += 1) { const j = (i + 1) % sides; tri(tip, r0[j], r0[i]); } }
      else if (!r0 && r1) { const tip = ctr(sections[k]); for (let i = 0; i < sides; i += 1) { const j = (i + 1) % sides; tri(tip, r1[i], r1[j]); } }
    }
    if (rings[0]) { const c = ctr(sections[0]); for (let i = 0; i < sides; i += 1) { const j = (i + 1) % sides; tri(c, rings[0][i], rings[0][j]); } }
    const last = rings.length - 1;
    if (rings[last]) { const c = ctr(sections[last]); for (let i = 0; i < sides; i += 1) { const j = (i + 1) % sides; tri(c, rings[last][j], rings[last][i]); } }
  }

  // Thick extruded panel: 4 planar corners extruded ±t along axis ('x'|'y'|'z'). 12 tris, closed.
  function panel(corners, axis, t) {
    const off = axis === "x" ? [t, 0, 0] : axis === "y" ? [0, t, 0] : [0, 0, t];
    const top = corners.map((c) => add(c, off));
    const bot = corners.map((c) => sub(c, off));
    quad(top[0], top[1], top[2], top[3]);
    quad(bot[3], bot[2], bot[1], bot[0]);
    for (let i = 0; i < 4; i += 1) { const j = (i + 1) % 4; quad(top[i], bot[i], bot[j], top[j]); }
  }

  // Axis-aligned box centred at c with half-extents h. 12 tris, closed.
  function box(c, h) {
    const [x, y, z] = c, [hx, hy, hz] = h;
    const v = [
      [x - hx, y - hy, z - hz], [x + hx, y - hy, z - hz], [x + hx, y + hy, z - hz], [x - hx, y + hy, z - hz],
      [x - hx, y - hy, z + hz], [x + hx, y - hy, z + hz], [x + hx, y + hy, z + hz], [x - hx, y + hy, z + hz],
    ];
    quad(v[4], v[5], v[6], v[7]); quad(v[3], v[2], v[1], v[0]);
    quad(v[0], v[1], v[5], v[4]); quad(v[2], v[3], v[7], v[6]);
    quad(v[1], v[2], v[6], v[5]); quad(v[3], v[0], v[4], v[7]);
  }

  // Rectangular strut between arbitrary points p0→p1 (square cross-section, half-width w). 12 tris.
  function bar(p0, p1, w) {
    const axis = norm(sub(p1, p0));
    const ref = Math.abs(axis[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    const u = norm(cross(axis, ref));
    const v = cross(axis, u);
    const corner = (p, s, t) => [p[0] + u[0] * s * w + v[0] * t * w, p[1] + u[1] * s * w + v[1] * t * w, p[2] + u[2] * s * w + v[2] * t * w];
    const A = [corner(p0, 1, 1), corner(p0, -1, 1), corner(p0, -1, -1), corner(p0, 1, -1)];
    const B = [corner(p1, 1, 1), corner(p1, -1, 1), corner(p1, -1, -1), corner(p1, 1, -1)];
    quad(A[0], A[1], A[2], A[3]); quad(B[3], B[2], B[1], B[0]);
    for (let i = 0; i < 4; i += 1) { const j = (i + 1) % 4; quad(A[i], B[i], B[j], A[j]); }
  }

  // Vertical fin (4 corners in X-Z, y=0) whose THICKNESS tapers along X (forward=tFront, aft=tRear).
  function finXZ(corners, tFront, tRear) { finAxis(corners, "y", tFront, tRear); }
  // Same, but thickness is extruded along an explicit axis ('y' vertical fin, 'z' horizontal fin).
  function finAxis(corners, axis, tFront, tRear) {
    const xs = corners.map((c) => c[0]);
    const xMin = Math.min(...xs), xMax = Math.max(...xs);
    const thk = corners.map((c) => tRear + (tFront - tRear) * (xMax === xMin ? 1 : (c[0] - xMin) / (xMax - xMin)));
    const off = (t) => (axis === "y" ? [0, t, 0] : [0, 0, t]);
    const top = corners.map((c, i) => add(c, off(thk[i])));
    const bot = corners.map((c, i) => sub(c, off(thk[i])));
    quad(top[0], top[1], top[2], top[3]);
    quad(bot[3], bot[2], bot[1], bot[0]);
    for (let i = 0; i < 4; i += 1) { const j = (i + 1) % 4; quad(top[i], bot[i], bot[j], top[j]); }
  }

  // Chined fuselage loft (F-22): 6-vertex sections — a FLAT upper deck (±wt), the ±chine at max width,
  // and a FLAT bottom (±wb). { x, w, wt, wb, zTop, zChine, zBot }; w===0 ⇒ a point (cone cap). The deck
  // is what the canted tails and the stabilators actually mount on: with a single spine vertex at y=0
  // the skin falls away immediately outboard, so a root at y≈0.09 ends up hanging in mid-air.
  // Ring order matches tube(): top → −Y → bottom → +Y, so band/cap winding is outward.
  function chineLoft(sections) {
    const ring = (s) => (s.w === 0 ? null : [
      [s.x, s.wt, s.zTop], [s.x, -s.wt, s.zTop], [s.x, -s.w, s.zChine],
      [s.x, -s.wb, s.zBot], [s.x, s.wb, s.zBot], [s.x, s.w, s.zChine],
    ]);
    const ctr = (s) => [s.x, 0, (s.zTop + s.zBot) / 2];
    const rings = sections.map(ring);
    const K = 6;
    for (let k = 0; k < sections.length - 1; k += 1) {
      const r0 = rings[k], r1 = rings[k + 1];
      if (r0 && r1) { for (let i = 0; i < K; i += 1) { const j = (i + 1) % K; quad(r0[i], r1[i], r1[j], r0[j]); } }
      else if (r0 && !r1) { const tip = ctr(sections[k + 1]); for (let i = 0; i < K; i += 1) tri(tip, r0[(i + 1) % K], r0[i]); }
      else if (!r0 && r1) { const tip = ctr(sections[k]); for (let i = 0; i < K; i += 1) tri(tip, r1[i], r1[(i + 1) % K]); }
    }
    if (rings[0]) { const c = ctr(sections[0]); for (let i = 0; i < K; i += 1) tri(c, rings[0][i], rings[0][(i + 1) % K]); }
    const last = rings.length - 1;
    if (rings[last]) { const c = ctr(sections[last]); for (let i = 0; i < K; i += 1) tri(c, rings[last][(i + 1) % K], rings[last][i]); }
  }

  // Thick plate from 4 corners extruded along the quad's OWN normal, per-corner half-thickness.
  // Handles arbitrary cant (F-22 canted tails, Starship flaps) that finAxis's fixed axis can't. 12 tris.
  function plate(corners, thk) {
    const n = norm(add(cross(sub(corners[1], corners[0]), sub(corners[2], corners[0])),
      cross(sub(corners[2], corners[0]), sub(corners[3], corners[0]))));
    const top = corners.map((c, i) => add(c, mulS(n, thk[i])));
    const bot = corners.map((c, i) => sub(c, mulS(n, thk[i])));
    quad(top[0], top[1], top[2], top[3]);
    quad(bot[3], bot[2], bot[1], bot[0]);
    for (let i = 0; i < 4; i += 1) { const j = (i + 1) % 4; quad(top[i], bot[i], bot[j], top[j]); }
  }

  // Solid of revolution about any axis, centred at `at`. sections [{ t, r }] ordered by DECREASING t
  // (t is measured along the axis FROM `at`; r=0 ⇒ point cap). The ring lives in the two remaining axes
  // taken cyclically, so the winding matches tube().
  function revolveAxis(sections, sides, axis, at = [0, 0, 0]) {
    const mk = (t, u, v) => add(at, axis === "x" ? [t, u, v] : axis === "y" ? [v, t, u] : [u, v, t]);
    const ringAt = (s) => Array.from({ length: sides }, (_, i) => {
      const a = Math.PI / 2 + (i / sides) * Math.PI * 2;
      return mk(s.t, Math.cos(a) * s.r, Math.sin(a) * s.r);
    });
    const ctr = (s) => mk(s.t, 0, 0);
    const rings = sections.map((s) => (s.r === 0 ? null : ringAt(s)));
    for (let k = 0; k < sections.length - 1; k += 1) {
      const r0 = rings[k], r1 = rings[k + 1];
      if (r0 && r1) { for (let i = 0; i < sides; i += 1) { const j = (i + 1) % sides; quad(r0[i], r1[i], r1[j], r0[j]); } }
      else if (r0 && !r1) { const tip = ctr(sections[k + 1]); for (let i = 0; i < sides; i += 1) tri(tip, r0[(i + 1) % sides], r0[i]); }
      else if (!r0 && r1) { const tip = ctr(sections[k]); for (let i = 0; i < sides; i += 1) tri(tip, r1[i], r1[(i + 1) % sides]); }
    }
    if (rings[0]) { const c = ctr(sections[0]); for (let i = 0; i < sides; i += 1) tri(c, rings[0][i], rings[0][(i + 1) % sides]); }
    const last = rings.length - 1;
    if (rings[last]) { const c = ctr(sections[last]); for (let i = 0; i < sides; i += 1) tri(c, rings[last][(i + 1) % sides], rings[last][i]); }
  }

  // Rectangular loft along X: sections [{ x, y, z, hy, hz }] front→back, each a rectangle centred at
  // (y, z). Caps are single quads, so a two-section loft costs the same 12 triangles as a box but can
  // TAPER — which is what lets a nozzle shrink into its exit instead of ending as a parallel-sided slab.
  function boxLoft(sections) {
    const ring = (s) => [
      [s.x, (s.y || 0) + s.hy, (s.z || 0) + s.hz], [s.x, (s.y || 0) - s.hy, (s.z || 0) + s.hz],
      [s.x, (s.y || 0) - s.hy, (s.z || 0) - s.hz], [s.x, (s.y || 0) + s.hy, (s.z || 0) - s.hz],
    ];
    const rings = sections.map(ring);
    for (let k = 0; k < rings.length - 1; k += 1) {
      const r0 = rings[k], r1 = rings[k + 1];
      for (let i = 0; i < 4; i += 1) { const j = (i + 1) % 4; quad(r0[i], r1[i], r1[j], r0[j]); }
    }
    const f = rings[0], bk = rings.at(-1);
    quad(f[3], f[2], f[1], f[0]);
    quad(bk[0], bk[1], bk[2], bk[3]);
  }

  // Lathe: revolve a CLOSED 2-D profile [[r, t], …] about an axis, centred at `at` (t measured along the
  // axis from `at`). Unlike revolveAxis this does not cap the ends — the profile itself is the closed
  // cross-section — so a wall with an inner and an outer face becomes a hollow solid: the only way to
  // give a parachute canopy real thickness with a scooped-out underside instead of a one-sided sheet.
  // Exactly one profile point may sit on the axis (r=0); it collapses to a single apex vertex.
  function latheAxis(profile, sides, axis, at = [0, 0, 0]) {
    const mk = (t, u, v) => add(at, axis === "x" ? [t, u, v] : axis === "y" ? [v, t, u] : [u, v, t]);
    const rings = profile.map(([r, t]) => (r === 0 ? null : Array.from({ length: sides }, (_, i) => {
      const a = Math.PI / 2 + (i / sides) * Math.PI * 2;
      return mk(t, Math.cos(a) * r, Math.sin(a) * r);
    })));
    for (let k = 0; k < profile.length; k += 1) {
      const n = (k + 1) % profile.length;
      const r0 = rings[k], r1 = rings[n];
      if (r0 && r1) { for (let i = 0; i < sides; i += 1) { const j = (i + 1) % sides; quad(r0[i], r1[i], r1[j], r0[j]); } }
      else if (r0 && !r1) { const tip = mk(profile[n][1], 0, 0); for (let i = 0; i < sides; i += 1) tri(tip, r0[(i + 1) % sides], r0[i]); }
      else if (!r0 && r1) { const tip = mk(profile[k][1], 0, 0); for (let i = 0; i < sides; i += 1) tri(tip, r1[i], r1[(i + 1) % sides]); }
    }
  }

  // ---- jet primitives (medium / large) ---------------------------------------------------------

  // Elliptical loft. The +π/2 phase places a VERTEX at the top (+Z) of every section (matching the
  // airship/glider fuselages) while leaving the elliptical envelope — hence the side/top silhouette —
  // unchanged; only the facet vertices rotate about the axis.
  function loft(sections, sides, phase = Math.PI / 2) {
    const rings = sections.map(({ x, width, height, z = 0 }) => (
      width === 0 && height === 0 ? [[x, 0, z]]
        : Array.from({ length: sides }, (_, i) => { const a = phase + i / sides * Math.PI * 2; return [x, Math.cos(a) * width, z + Math.sin(a) * height]; })
    ));
    for (let s = 0; s < rings.length - 1; s += 1) {
      const cur = rings[s], fol = rings[s + 1];
      if (cur.length === 1) { for (let i = 0; i < sides; i += 1) tri(cur[0], fol[i], fol[(i + 1) % sides]); continue; }
      if (fol.length === 1) { for (let i = 0; i < sides; i += 1) tri(cur[i], fol[0], cur[(i + 1) % sides]); continue; }
      for (let i = 0; i < sides; i += 1) { const n = (i + 1) % sides; quad(cur[i], fol[i], fol[n], cur[n]); }
    }
    for (const [ring, rev] of [[rings[0], true], [rings.at(-1), false]]) {
      if (ring.length === 1) continue;
      const c = ring.reduce((s, p) => s.map((v, i) => v + p[i]), [0, 0, 0]).map((v) => v / sides);
      for (let i = 0; i < sides; i += 1) { const n = (i + 1) % sides; if (rev) tri(c, ring[n], ring[i]); else tri(c, ring[i], ring[n]); }
    }
  }

  // Swept wing / tailplane prism, mirrored to both sides, tapering to a sharp trailing edge.
  function wingPrism(o) {
    const { rootLead, rootTrail, tipLead, tipTrail, rootY, span, rootZ, tipZ, thickness, tipThickness = thickness, trailingThickness = thickness, tipTrailingThickness = trailingThickness, rootTrailingThickness = trailingThickness, closeRoot = true, closeTip = true, closeTrailing = true } = o;
    for (const sign of [-1, 1]) {
      const outline = [[rootLead, sign * rootY, rootZ], [tipLead, sign * span, tipZ], [tipTrail, sign * span, tipZ], [rootTrail, sign * rootY, rootZ]];
      const th = [thickness, tipThickness, tipTrailingThickness, rootTrailingThickness];
      const top = outline.map(([x, y, z], i) => [x, y, z + th[i] / 2]);
      const bot = outline.map(([x, y, z], i) => [x, y, z - th[i] / 2]);
      quad(top[0], top[1], top[2], top[3]);
      quad(bot[3], bot[2], bot[1], bot[0]);
      const idxs = [0, 1, 2, 3].filter((i) => (closeRoot || i !== 3) && (closeTip || i !== 1) && (closeTrailing || i !== 2));
      for (const i of idxs) {
        const n = (i + 1) % 4;
        if (th[i] === 0 && th[n] === 0) continue;
        if (th[i] === 0) tri(top[i], bot[n], top[n]);
        else if (th[n] === 0) tri(top[i], bot[i], top[n]);
        else quad(top[i], bot[i], bot[n], top[n]);
      }
    }
  }

  // Vertical stabilizer (thick swept slab in X-Z).
  function verticalTail(o) {
    const { frontX, backX, baseZ, frontTopX, backTopX, topZ, halfThickness } = o;
    const right = [[frontX, halfThickness, baseZ], [frontTopX, halfThickness, topZ], [backTopX, halfThickness, topZ], [backX, halfThickness, baseZ]];
    const left = right.map(([x, , z]) => [x, -halfThickness, z]);
    quad(...right);
    quad(left[3], left[2], left[1], left[0]);
    for (let i = 0; i < 4; i += 1) { const n = (i + 1) % 4; quad(right[i], left[i], left[n], right[n]); }
  }

  // Podded engine nacelle (ring stack offset to (y,z), intake cone or flat front).
  function nacelle(o) {
    const { rings, sides, y, z, frontInset = 0, closeFront = true, closeBack = false, flatFront = false } = o;
    const verts = rings.map(({ x, radius }) => Array.from({ length: sides }, (_, i) => { const a = i / sides * Math.PI * 2; return [x, y + Math.cos(a) * radius, z + Math.sin(a) * radius]; }));
    for (let r = 0; r < verts.length - 1; r += 1) for (let i = 0; i < sides; i += 1) { const n = (i + 1) % sides; quad(verts[r][i], verts[r + 1][i], verts[r + 1][n], verts[r][n]); }
    if (closeFront) {
      const fr = verts[0];
      if (flatFront) { for (let i = 1; i < fr.length - 1; i += 1) tri(fr[0], fr[i + 1], fr[i]); }
      else { const intake = [rings[0].x - frontInset, y, z]; for (let i = 0; i < sides; i += 1) tri(intake, fr[(i + 1) % sides], fr[i]); }
    }
    if (closeBack) { const br = verts.at(-1); const ex = [rings.at(-1).x, y, z]; for (let i = 0; i < sides; i += 1) tri(br[i], ex, br[(i + 1) % sides]); }
  }

  // ---- P-51 primitives (small) ---------------------------------------------------------------

  // Flat-topped elliptical-hexagon loft (paired top & bottom vertices avoid a pointed section).
  function loftHex(sections) {
    const rings = sections.map((s) => {
      if (s.point) return [[s.x, 0, s.z]];
      const center = (s.top + s.bottom) / 2;
      const bottomWidth = s.bottomWidth ?? s.width;
      return [
        [s.x, s.width, center], [s.x, s.width * 0.5, s.top], [s.x, -s.width * 0.5, s.top],
        [s.x, -bottomWidth, center], [s.x, -bottomWidth * 0.5, s.bottom], [s.x, bottomWidth * 0.5, s.bottom],
      ];
    });
    for (let s = 0; s < rings.length - 1; s += 1) {
      const cur = rings[s], nx = rings[s + 1];
      if (cur.length === 1) { for (let i = 0; i < 6; i += 1) tri(cur[0], nx[i], nx[(i + 1) % 6]); }
      else if (nx.length === 1) { for (let i = 0; i < 6; i += 1) tri(cur[i], nx[0], cur[(i + 1) % 6]); }
      else { for (let i = 0; i < 6; i += 1) quad(cur[i], nx[i], nx[(i + 1) % 6], cur[(i + 1) % 6]); }
    }
    if (sections[0].cap && rings[0].length > 1) {
      const c = rings[0].reduce((sum, p) => sum.map((v, i) => v + p[i]), [0, 0, 0]).map((v) => v / rings[0].length);
      for (let i = 0; i < 6; i += 1) tri(c, rings[0][(i + 1) % 6], rings[0][i]);
    }
    const last = rings.at(-1);
    if (sections.at(-1).cap && last.length > 2) { for (let i = 1; i < last.length - 1; i += 1) tri(last[0], last[i + 1], last[i]); }
  }

  // Wing/tailplane prism from an outline of { x, y, z, thickness } points (fans + side quads).
  function prism(outline, { openRoot = false } = {}) {
    const top = outline.map(({ x, y, z, thickness }) => [x, y, z + thickness / 2]);
    const bottom = outline.map(({ x, y, z, thickness }) => [x, y, z - thickness / 2]);
    for (let i = 1; i < outline.length - 1; i += 1) { tri(top[0], top[i], top[i + 1]); tri(bottom[0], bottom[i + 1], bottom[i]); }
    for (let i = 0; i < outline.length; i += 1) {
      if (openRoot && i === outline.length - 1) continue;
      const n = (i + 1) % outline.length;
      quad(top[i], bottom[i], bottom[n], top[n]);
    }
  }

  // Vertical fin from a 2-D (x,z) outline extruded ±halfWidth in Y.
  function profilePrism(outline, halfWidth) {
    const right = outline.map(([x, z]) => [x, halfWidth, z]);
    const left = outline.map(([x, z]) => [x, -halfWidth, z]);
    for (let i = 1; i < outline.length - 1; i += 1) { tri(right[0], right[i], right[i + 1]); tri(left[0], left[i + 1], left[i]); }
    for (let i = 0; i < outline.length; i += 1) { const n = (i + 1) % outline.length; quad(right[i], left[i], left[n], right[n]); }
  }

  // Canopy: rounded-top rings ({ x, width, base, top } or { x, point, z }) lofted together.
  function canopy(sections) {
    const rings = sections.map((s) => s.point ? [[s.x, 0, s.z]] : [
      [s.x, s.width, s.base], [s.x, s.width * 0.48, s.top], [s.x, -s.width * 0.48, s.top], [s.x, -s.width, s.base],
    ]);
    for (let s = 0; s < rings.length - 1; s += 1) {
      const cur = rings[s], nx = rings[s + 1];
      if (cur.length === 1) { for (let i = 0; i < 4; i += 1) tri(cur[0], nx[i], nx[(i + 1) % 4]); }
      else if (nx.length === 1) { for (let i = 0; i < 4; i += 1) tri(cur[i], nx[0], cur[(i + 1) % 4]); }
      else { for (let i = 0; i < 4; i += 1) quad(cur[i], nx[i], nx[(i + 1) % 4], cur[(i + 1) % 4]); }
    }
  }

  return { tri, quad, tube, panel, box, bar, finXZ, finAxis, chineLoft, plate, revolveAxis, boxLoft, latheAxis, loft, wingPrism, verticalTail, nacelle, loftHex, prism, profilePrism, canopy, tris };
}

// Bake triangle soup → non-indexed positions + crease-angle-smoothed normals (sequential indices).
function bake(tris, creaseDeg = 60) {
  const cosT = Math.cos((creaseDeg * Math.PI) / 180);
  const fn = tris.map(([a, b, c]) => norm(cross(sub(b, a), sub(c, a))));
  const rkey = (p) => `${Math.round(p[0] * 1e5)},${Math.round(p[1] * 1e5)},${Math.round(p[2] * 1e5)}`;
  const incident = new Map();
  tris.forEach(([a, b, c], f) => { for (const p of [a, b, c]) { const k = rkey(p); (incident.get(k) || incident.set(k, []).get(k)).push(f); } });
  const positions = [], normals = [], indices = [];
  let vi = 0;
  tris.forEach((t, f) => {
    for (const p of t) {
      let acc = [0, 0, 0];
      for (const g of incident.get(rkey(p))) if (dot(fn[f], fn[g]) >= cosT) acc = add(acc, fn[g]);
      const n = norm(acc);
      positions.push(p[0], p[1], p[2]); normals.push(n[0], n[1], n[2]); indices.push(vi++);
    }
  });
  return { positions, normals, indices };
}

// Signed volume via the divergence theorem. Positive ⇒ triangles wind counter-clockwise seen from
// OUTSIDE, i.e. the baked normals point out of the solid. A part built with a reversed ring order shows
// up as a shrunken or negative total, which two-sided shading would otherwise hide.
function signedVolume(positions) {
  let v = 0;
  for (let i = 0; i < positions.length; i += 9) {
    const p = (k) => [positions[i + k * 3], positions[i + k * 3 + 1], positions[i + k * 3 + 2]];
    v += dot(p(0), cross(p(1), p(2))) / 6;
  }
  return v;
}

// Weld duplicate (position, normal) pairs into an INDEXED mesh for the shipped bundle. bake() emits one
// vertex per triangle corner so crease-angle normals can differ across an edge; smooth regions share a
// normal and dedupe cleanly, which roughly halves the shipped arrays without moving a single pixel.
// Coordinates are rounded first (1e-4 of a ~1-unit model, 1e-3 for normals) — anything that collapses at
// that precision was already visually identical.
function weld(mesh, posDp = 4, nrmDp = 3) {
  const rd = (v, dp) => { const r = Math.round(v * 10 ** dp) / 10 ** dp; return r === 0 ? 0 : r; };
  const positions = [], normals = [], indices = [], seen = new Map();
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const p = [rd(mesh.positions[i], posDp), rd(mesh.positions[i + 1], posDp), rd(mesh.positions[i + 2], posDp)];
    const n = [rd(mesh.normals[i], nrmDp), rd(mesh.normals[i + 1], nrmDp), rd(mesh.normals[i + 2], nrmDp)];
    const key = `${p.join(",")}|${n.join(",")}`;
    let idx = seen.get(key);
    if (idx === undefined) { idx = positions.length / 3; seen.set(key, idx); positions.push(...p); normals.push(...n); }
    indices.push(idx);
  }
  return { positions, normals, indices };
}

// Count open boundary edges (odd parity) — 0 ⇒ watertight closed solid.
function openEdgeCount(positions) {
  const key = (a, b) => {
    const r = (v) => Math.round(v * 1e5) / 1e5;
    const ka = `${r(a[0])},${r(a[1])},${r(a[2])}`, kb = `${r(b[0])},${r(b[1])},${r(b[2])}`;
    return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
  };
  const edges = new Map();
  for (let i = 0; i < positions.length; i += 9) {
    const p = (k) => [positions[i + k * 3], positions[i + k * 3 + 1], positions[i + k * 3 + 2]];
    for (const [x, y] of [[0, 1], [1, 2], [2, 0]]) { const e = key(p(x), p(y)); edges.set(e, (edges.get(e) || 0) + 1); }
  }
  let open = 0;
  for (const c of edges.values()) if (c % 2 !== 0) open += 1;
  return open;
}

// P-51 post-process: apply the target span:length ratio, then uniformly fit into a 2×2 icon box
// centred on the origin. Transforms each UNIQUE vertex once (soup shares vertex references between
// triangles).
function scaleToIconBox(tris, spanLenRatio) {
  const P = [...new Set(tris.flat())];
  const bbox = () => {
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (const p of P) for (let k = 0; k < 3; k += 1) { mn[k] = Math.min(mn[k], p[k]); mx[k] = Math.max(mx[k], p[k]); }
    return { mn, mx };
  };
  let { mn, mx } = bbox();
  const longScale = ((mx[1] - mn[1]) / spanLenRatio) / (mx[0] - mn[0]);
  for (const p of P) p[0] *= longScale;
  ({ mn, mx } = bbox());
  const c = [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2];
  const uni = 2 / Math.max(mx[0] - mn[0], mx[1] - mn[1]);
  for (const p of P) { p[0] = (p[0] - c[0]) * uni; p[1] = (p[1] - c[1]) * uni; p[2] = (p[2] - c[2]) * uni; }
}

// ================================================================================================
// SIZE-BUCKET JETS — directly authored procedural geometry.
// ================================================================================================

// small — P-51 Mustang, built in metres then scaled to the icon box.
// Fuselage + swept wings + tailplanes + vertical fin + canopy.
function jetSmall() {
  const b = Builder();
  b.loftHex([
    { x: 0.830, point: true, z: -0.060 },
    { x: 0.730, width: 0.130, top: 0.070, bottom: -0.190 },
    { x: 0.430, width: 0.285, top: 0.200, bottom: -0.320 },
    { x: -0.220, width: 0.483, top: 0.360, bottom: -0.550 },
    { x: -1.500, width: 0.510, top: 0.460, bottom: -0.550 },
    { x: -2.800, width: 0.506, top: 0.500, bottom: -0.580 },
    { x: -4.200, width: 0.488, top: 0.450, bottom: -0.500 },
    { x: -5.500, width: 0.422, top: 0.400, bottom: -0.440 },
    { x: -6.700, width: 0.315, top: 0.360, bottom: -0.380 },
    { x: -8.450, width: 0.070, top: 0.120, bottom: -0.120, cap: true },
  ]);
  for (const sign of [-1, 1]) {
    const wing = [
      { x: -1.475, y: 0, z: -0.350, thickness: 0.280 },
      { x: -2.140, y: sign * 5.250, z: -0.225, thickness: 0.100 },
      { x: -2.450, y: sign * 5.550, z: -0.215, thickness: 0.070 },
      { x: -2.750, y: sign * 5.680, z: -0.210, thickness: 0.060 },
      { x: -3.050, y: sign * 5.550, z: -0.215, thickness: 0.070 },
      { x: -3.350, y: sign * 5.250, z: -0.225, thickness: 0.100 },
      { x: -4.064, y: 0, z: -0.350, thickness: 0.260 },
    ];
    b.prism(sign > 0 ? wing : wing.reverse(), { openRoot: true });
    const tail = [
      { x: -6.972, y: 0, z: 0.200, thickness: 0.110 },
      { x: -7.328, y: sign * 2.009, z: 0.245, thickness: 0.055 },
      { x: -8.035, y: sign * 2.009, z: 0.245, thickness: 0.055 },
      { x: -8.294, y: 0, z: 0.190, thickness: 0.110 },
    ];
    b.prism(sign > 0 ? tail : tail.reverse(), { openRoot: true });
  }
  b.profilePrism([[-6.300, 0.200], [-7.800, 1.659], [-8.250, 1.500], [-8.380, 0.080]], 0.055);
  b.canopy([
    { x: -2.057, point: true, z: 0.300 },
    { x: -2.600, width: 0.255, base: 0.460, top: 0.820 },
    { x: -3.350, width: 0.250, base: 0.450, top: 0.850 },
    { x: -4.235, point: true, z: 0.400 },
  ]);
  scaleToIconBox(b.tris, 37 / 32.25);
  return { ...bake(b.tris), triCount: b.tris.length };
}

// medium — directly authored twin-engine swept jet.
function jetMedium() {
  const b = Builder();
  b.loft([
    { x: .96, width: 0, height: 0, z: 0 },
    { x: .94, width: .035, height: .035, z: 0 },
    { x: .88, width: .070, height: .070, z: 0 },
    { x: .75, width: .115, height: .12, z: 0 },
    { x: .25, width: .13, height: .135, z: .005 },
    { x: -.35, width: .125, height: .13, z: .012 },
    { x: -.76, width: .068, height: .075, z: .035 },
    { x: -.96, width: 0, height: 0, z: .07 },
  ], 7);
  b.wingPrism({ rootLead: .18, rootTrail: -.12, tipLead: -.14, tipTrail: -.32, rootY: .075, span: .76, rootZ: -.025, tipZ: .035, thickness: .024, tipThickness: .010, tipTrailingThickness: .003, rootTrailingThickness: .007, closeRoot: false });
  b.wingPrism({ rootLead: -.68, rootTrail: -.90, tipLead: -.78, tipTrail: -.88, rootY: .025, span: .265, rootZ: .062, tipZ: .088, thickness: .018, tipThickness: .009, tipTrailingThickness: .009, rootTrailingThickness: .018, closeRoot: false });
  b.verticalTail({ frontX: -.56, backX: -.90, baseZ: .055, frontTopX: -.745, backTopX: -.875, topZ: .36, halfThickness: .010 });
  for (const sign of [-1, 1]) b.nacelle({ rings: [{ x: .15, radius: .052 }, { x: .10, radius: .064 }, { x: -.09, radius: .040 }], sides: 7, y: sign * .37, z: -.075, frontInset: .024 });
  return { ...bake(b.tris), triCount: b.tris.length };
}

// large — directly authored four-engine widebody.
function jetLarge() {
  const b = Builder();
  b.loft([
    { x: 1.12, width: 0, height: 0, z: -.01 },
    { x: 1.095, width: .040, height: .038, z: -.009 },
    { x: 1.02, width: .080, height: .075, z: -.005 },
    { x: .86, width: .13, height: .125, z: 0 },
    { x: .30, width: .155, height: .15, z: .005 },
    { x: -.35, width: .15, height: .15, z: .01 },
    { x: -.78, width: .10, height: .11, z: .035 },
    { x: -1.07, width: 0, height: 0, z: .085 },
  ], 6);
  b.wingPrism({ rootLead: .24, rootTrail: -.20, tipLead: -.26, tipTrail: -.45, rootY: .09, span: 1.04, rootZ: -.035, tipZ: .08, thickness: .028, tipThickness: .012, tipTrailingThickness: .004, rootTrailingThickness: .008, closeRoot: false });
  b.wingPrism({ rootLead: -.72, rootTrail: -.98, tipLead: -.84, tipTrail: -.94, rootY: .025, span: .35, rootZ: .078, tipZ: .11, thickness: .020, tipThickness: .010, tipTrailingThickness: .010, rootTrailingThickness: .020, closeRoot: false });
  b.verticalTail({ frontX: -.62, backX: -1.01, baseZ: .075, frontTopX: -.82, backTopX: -.965, topZ: .44, halfThickness: .012 });
  for (const y of [.44, .73]) {
    const spanRatio = (y - .09) / .95;
    const wingLeadingEdge = .24 + (-.26 - .24) * spanRatio;
    for (const sign of [-1, 1]) {
      const wingZ = -.035 + spanRatio * .115;
      b.nacelle({ rings: [{ x: wingLeadingEdge + .115, radius: .060 }, { x: wingLeadingEdge + .055, radius: .072 }, { x: wingLeadingEdge - .140, radius: .046 }], sides: 5, y: sign * y, z: wingZ - .073, frontInset: .022, flatFront: true });
    }
  }
  return { ...bake(b.tris), triCount: b.tris.length };
}

// ================================================================================================
// PER-TYPE MESHES (new for Q-012) — built from the generic closed-solid primitives.
// ================================================================================================

// A7 — Helicopter. Bulbous cockpit pod + upswept tail boom, X main rotor on a thin mast, a compact
// tapered fin with a + tail rotor, and skid gear on diagonal struts. All closed solids.
function helicopter() {
  const b = Builder();
  b.tube([
    { x: 0.25, ry: 0, rz: 0 },
    { x: 0.205, ry: 0.058, rz: 0.066 },
    { x: 0.10, ry: 0.092, rz: 0.107 },
    { x: -0.13, ry: 0.050, rz: 0.058, z: 0.004 },
    { x: -0.30, ry: 0.028, rz: 0.034, z: 0.016 },
    { x: -0.47, ry: 0.010, rz: 0.013, z: 0.040 },
  ], 7);
  const zc = 0.155;
  b.box([0.03, 0, 0.11], [0.012, 0.012, 0.055]); // thin mast
  const R = 0.34, bt = 0.006, bw = 0.022, hx = 0.03;
  const rotorBlade = (angDeg) => {
    const a = angDeg * Math.PI / 180, dx = Math.cos(a), dy = Math.sin(a), px = -Math.sin(a), py = Math.cos(a);
    b.panel([
      [hx + R * dx + bw * px, R * dy + bw * py, zc], [hx + R * dx - bw * px, R * dy - bw * py, zc],
      [hx - R * dx - bw * px, -R * dy - bw * py, zc], [hx - R * dx + bw * px, -R * dy + bw * py, zc],
    ], "z", bt);
  };
  rotorBlade(45); rotorBlade(-45); // X main rotor
  b.finXZ([[-0.33, 0, 0.02], [-0.42, 0, 0.13], [-0.47, 0, 0.13], [-0.47, 0, 0.03]], 0.006, 0.0012);
  const tcx = -0.42, tcz = 0.08;
  b.box([tcx, 0.023, tcz], [0.013, 0.023, 0.013]); // tail-rotor hub stub
  b.panel([[tcx - 0.06, 0.04, tcz + 0.008], [tcx + 0.06, 0.04, tcz + 0.008], [tcx + 0.06, 0.04, tcz - 0.008], [tcx - 0.06, 0.04, tcz - 0.008]], "y", 0.004);
  b.panel([[tcx + 0.008, 0.04, tcz + 0.05], [tcx - 0.008, 0.04, tcz + 0.05], [tcx - 0.008, 0.04, tcz - 0.05], [tcx + 0.008, 0.04, tcz - 0.05]], "y", 0.004);
  for (const yS of [-1, 1]) {
    b.box([0.02, yS * 0.085, -0.15], [0.16, 0.012, 0.012]); // skid rail
    b.bar([0.10, yS * 0.03, -0.085], [0.10, yS * 0.085, -0.145], 0.009);  // front strut
    b.bar([-0.06, yS * 0.03, -0.05], [-0.06, yS * 0.085, -0.145], 0.009); // rear strut
  }
  return { ...bake(b.tris), triCount: b.tris.length, budgetNote: "the + tail rotor's second blade; kept on the user's call" };
}

// A6 — F-22 Raptor, authored directly as procedural geometry in normalised model coordinates.
// Stations are `s` = fraction of overall length aft of the nose; x = 0.5 - s puts the nose at +0.5.
// Lateral values pass through Y() for the span correction; z uses a fixed datum shift to centre the
// fuselage.
function fighter() {
  const b = Builder();
  const X = (s) => 0.5 - s;
  const Y = (v) => v * (0.7167 / 0.7205);
  // Fuselage. The forebody chine is nearly constant to s=.256, the caret inlets flare it out at s=.302,
  // and it keeps widening to s=.823 — that aft width is the boom the tails hang on beneath the
  // wing/stabilator.
  b.chineLoft([
    { x: X(0.000), w: 0, wt: 0, wb: 0, zTop: -0.006, zChine: -0.006, zBot: -0.006 },
    { x: X(0.045), w: Y(0.021), wt: Y(0.009), wb: Y(0.014), zTop: 0.017, zChine: -0.004, zBot: -0.021 },
    { x: X(0.126), w: Y(0.038), wt: Y(0.017), wb: Y(0.027), zTop: 0.035, zChine: -0.004, zBot: -0.036 },
    { x: X(0.256), w: Y(0.045), wt: Y(0.021), wb: Y(0.032), zTop: 0.042, zChine: -0.004, zBot: -0.040 },
    { x: X(0.302), w: Y(0.101), wt: Y(0.048), wb: Y(0.062), zTop: 0.043, zChine: -0.010, zBot: -0.041 },
    { x: X(0.453), w: Y(0.118), wt: Y(0.070), wb: Y(0.078), zTop: 0.046, zChine: -0.012, zBot: -0.045 },
    { x: X(0.700), w: Y(0.143), wt: Y(0.108), wb: Y(0.092), zTop: 0.043, zChine: -0.012, zBot: -0.047 },
    { x: X(0.823), w: Y(0.156), wt: Y(0.126), wb: Y(0.096), zTop: 0.037, zChine: -0.010, zBot: -0.033 },
    { x: X(0.870), w: Y(0.132), wt: Y(0.110), wb: Y(0.084), zTop: 0.029, zChine: -0.006, zBot: -0.023 },
    { x: X(0.905), w: Y(0.100), wt: Y(0.086), wb: Y(0.066), zTop: 0.019, zChine: 0.001, zBot: -0.008 },
  ]);
  // Main wing. Traced planform: LE root (.453, .118) → LE tip (.667, .360) at 41.5°, tip chord to .733,
  // then a TE KINK at (.771, .320) — the flaperon/aileron break — before the main TE runs forward-swept
  // to the root at (.823, .161). That kink is a 1.8%-L departure from a straight TE, so the wing needs a
  // 5-point outline, not a simple 4-corner prism. Root ends extended inboard to y=.105, inside the body.
  // 3.2° anhedral from the front view: the tip sits 0.0115 L below the root.
  const wingPts = [
    { s: 0.4417, y: 0.105, t: 0.030 }, { s: 0.6671, y: 0.3599, t: 0.008 }, { s: 0.7329, y: 0.3602, t: 0.004 },
    { s: 0.7707, y: 0.3199, t: 0.006 }, { s: 0.8411, y: 0.105, t: 0.011 },
  ];
  for (const sg of [1, -1]) {
    const out = wingPts.map(({ s, y, t }) => ({
      x: X(s), y: sg * Y(y), z: -0.008 - 0.0115 * ((y - 0.105) / (0.3602 - 0.105)), thickness: t,
    }));
    b.prism(sg > 0 ? out : out.reverse());
  }
  // All-moving stabilators. Traced: LE root (.836, .161) → LE tip (.902, .236) at 40.9° — parallel to the
  // wing LE, the planform-alignment signature — tip chord to .976, TE root at (.999, .144), the aftmost
  // point of the aircraft. The inboard edge is RAKED forward-inboard (the traced diagonal from the TE root
  // to the nozzle's outer corner), so a 5-point outline is what actually lands inside the tapering boom;
  // a constant-y root chord would burst out of the fuselage side around s=.89.
  const stabPts = [
    { s: 0.8364, y: 0.135, t: 0.020 }, { s: 0.9021, y: 0.2363, t: 0.007 }, { s: 0.9757, y: 0.2350, t: 0.004 },
    { s: 0.9993, y: 0.1435, t: 0.006 }, { s: 0.9150, y: 0.050, t: 0.018 },
  ];
  for (const sg of [1, -1]) {
    const out = stabPts.map(({ s, y, t }) => ({ x: X(s), y: sg * Y(y), z: 0.008, thickness: t }));
    b.prism(sg > 0 ? out : out.reverse());
  }
  // Twin canted vertical tails. Side view: root LE s=.691 on the spine, tip chord .761–.833 at z=.167,
  // root TE s=.906. Front view: root y=.0935 → tip y=.1623 ⇒ 28° cant. Both root corners are sunk ~.011
  // below the upper deck so the plate's root edge is inside the fuselage solid, not sitting on the skin.
  for (const sg of [1, -1]) {
    const rootLE = [X(0.6907), sg * Y(0.088), 0.033], tipLE = [X(0.7614), sg * Y(0.155), 0.167];
    const tipTE = [X(0.8329), sg * Y(0.155), 0.167], rootTE = [X(0.9000), sg * Y(0.088), 0.014];
    b.plate(sg > 0 ? [rootLE, rootTE, tipTE, tipLE] : [rootLE, tipLE, tipTE, rootTE],
      sg > 0 ? [0.009, 0.005, 0.002, 0.003] : [0.009, 0.003, 0.002, 0.005]);
  }
  // Two-dimensional thrust-vectoring nozzles, CONVERGING. Traced planform puts the nozzle outer edge at
  // |y|=.057 over s .879–.921 with a notch between them reaching s=.938, and the traced side view has the
  // lower line sweeping up from z=−.020 at s=.889 to +.002 at s=.934 while the exit is only .012 tall.
  // So the fuselage sections above taper into that (zBot −.033 → −.008, zTop .037 → .019 over s .823–.905)
  // and each nozzle is a TAPERING loft whose inlet matches the local fuselage interior and whose exit is
  // the small rectangle — a parallel-sided box left the deck and belly standing proud of it like plates.
  for (const sg of [1, -1]) {
    b.boxLoft([
      { x: X(0.860), y: sg * Y(0.033), z: 0.001, hy: Y(0.030), hz: 0.017 },
      { x: X(0.935), y: sg * Y(0.030), z: 0.008, hy: Y(0.026), hz: 0.007 },
    ]);
  }
  // Canopy — side view: peak z .078 over s .208–.260, then the spine falls away to .046 only by s=.442,
  // so the canopy has to run that far aft or a wedge of the traced silhouette is left uncovered. Base and
  // both end points sit below the fuselage skin so the canopy solid is buried in the body.
  b.canopy([
    { x: X(0.128), point: true, z: 0.031 },
    { x: X(0.208), width: 0.024, base: 0.020, top: 0.078 },
    { x: X(0.290), width: 0.024, base: 0.020, top: 0.070 },
    { x: X(0.442), point: true, z: 0.040 },
  ]);
  return { ...bake(b.tris), triCount: b.tris.length, budgetNote: "the TE-kink wing + raked stabilator outlines and the flat upper deck the tails mount on" };
}

// B1 — Glider. Long slender high-aspect wings with gentle dihedral, slim fuselage (blunt rounded
// nose, blunt tailcone), clean T-tail.
function glider() {
  const b = Builder();
  b.tube([
    { x: 0.43, ry: 0, rz: 0 },
    { x: 0.42, ry: 0.018, rz: 0.022 },
    { x: 0.37, ry: 0.037, rz: 0.046 },
    { x: 0.28, ry: 0.048, rz: 0.060 },
    { x: 0.15, ry: 0.052, rz: 0.072 },
    { x: -0.05, ry: 0.042, rz: 0.050 },
    { x: -0.28, ry: 0.021, rz: 0.028 },
    { x: -0.46, ry: 0.009, rz: 0.011 },
  ], 8);
  const WT = 0.007;
  b.panel([[0.15, 0.03, 0.004], [0.01, 0.03, 0.004], [-0.01, 0.62, 0.05], [0.05, 0.62, 0.05]], "z", WT);
  b.panel([[0.15, -0.03, 0.004], [0.05, -0.62, 0.05], [-0.01, -0.62, 0.05], [0.01, -0.03, 0.004]], "z", WT);
  b.finXZ([[-0.28, 0, 0.018], [-0.46, 0, 0.0], [-0.46, 0, 0.14], [-0.38, 0, 0.155]], 0.006, 0.0012);
  // Horizontal stabilizer (T-tail on the fin top): a tapered, gently swept slab that thins to the
  // tips and trailing edge — not a flat plank. Root passes through the fin (y=0) so it welds.
  b.wingPrism({ rootLead: -0.37, rootTrail: -0.46, tipLead: -0.40, tipTrail: -0.45, rootY: 0, span: 0.17, rootZ: 0.15, tipZ: 0.15, thickness: 0.012, tipThickness: 0.004, tipTrailingThickness: 0.002, rootTrailingThickness: 0.005, closeRoot: false });
  return { ...bake(b.tris), triCount: b.tris.length };
}

// B2 — Airship. Fat ellipsoidal envelope (blunt nose & tail) with a cruciform (+) tail.
function airship() {
  const b = Builder();
  b.tube([
    { x: 0.48, ry: 0, rz: 0 },
    { x: 0.44, ry: 0.060, rz: 0.060 },
    { x: 0.28, ry: 0.130, rz: 0.130 },
    { x: 0.05, ry: 0.168, rz: 0.168 },
    { x: -0.18, ry: 0.155, rz: 0.155 },
    { x: -0.38, ry: 0.085, rz: 0.085 },
    { x: -0.50, ry: 0.012, rz: 0.012 },
  ], 8);
  const tF = 0.010, tR = 0.002;
  b.finAxis([[-0.26, 0, 0.11], [-0.46, 0, 0.02], [-0.49, 0, 0.17], [-0.34, 0, 0.22]], "y", tF, tR);       // up
  b.finAxis([[-0.26, 0, -0.11], [-0.34, 0, -0.22], [-0.49, 0, -0.17], [-0.46, 0, -0.02]], "y", tF, tR);   // down
  b.finAxis([[-0.26, 0.11, 0], [-0.34, 0.22, 0], [-0.49, 0.17, 0], [-0.46, 0.02, 0]], "z", tF, tR);       // right
  b.finAxis([[-0.26, -0.11, 0], [-0.46, -0.02, 0], [-0.49, -0.17, 0], [-0.34, -0.22, 0]], "z", tF, tR);   // left
  return { ...bake(b.tris), triCount: b.tris.length };
}

// B6 — UAV, drawn as a quadcopter. X-frame arms rise outboard to a two-blade propeller at each end,
// crossed into an X exactly like the helicopter's main rotor rather than drawn as a solid disc; a forward
// camera gimbal gives the otherwise 4-fold-symmetric airframe a readable heading. Arm ends are buried in
// the blade solids so every joint interpenetrates.
function drone() {
  const b = Builder();
  b.box([0, 0, 0], [0.075, 0.055, 0.024]);            // body shell
  b.box([0.080, 0, -0.026], [0.028, 0.020, 0.020]);   // forward camera gimbal — juts past the nose so
                                                      // the heading reads in a top-down map view
  const R = 0.159, hubZ = 0.038, propR = 0.100, bw = 0.016, bt = 0.005;
  const blade = (cx, cy, angDeg) => {
    const a = (angDeg * Math.PI) / 180, dx = Math.cos(a), dy = Math.sin(a), px = -dy, py = dx;
    // corners counter-clockwise seen from +Z so panel()'s extrusion faces outward (the reverse order
    // silently produces an inside-out solid — invisible under two-sided shading, caught by signedVolume)
    b.panel([
      [cx + propR * dx + bw * px, cy + propR * dy + bw * py, hubZ], [cx - propR * dx + bw * px, cy - propR * dy + bw * py, hubZ],
      [cx - propR * dx - bw * px, cy - propR * dy - bw * py, hubZ], [cx + propR * dx - bw * px, cy + propR * dy - bw * py, hubZ],
    ], "z", bt);
  };
  for (const sx of [1, -1]) for (const sy of [1, -1]) {
    b.bar([sx * 0.050, sy * 0.035, 0], [sx * R, sy * R, hubZ], 0.011);
    blade(sx * R, sy * R, 45); blade(sx * R, sy * R, -45);
  }
  return { ...bake(b.tris), triCount: b.tris.length };
}

// B7 — Spacecraft, directly modelled as a procedural SpaceX Starship silhouette: the ship alone, not
// the Super Heavy stack. The 5.79:1 body proportion remains readable at icon size; the nose is a true
// tangent-ogive (r = √(ρ²−(L−x)²) − (ρ−R), ρ = (R²+L²)/2R) over a 0.24 L nose section. Four flaps —
// two small forward ones and two large aft ones — are splayed symmetrically off the spine. Six Raptors
// are implied by the flat base.
function spacecraft() {
  const b = Builder();
  const X = (s) => 0.5 - s;
  const R = 0.0864, LN = 0.24;                       // 9 m / 52.1 m half-diameter, nose section length
  const rho = (R * R + LN * LN) / (2 * R);
  const ogive = (s) => Math.sqrt(rho * rho - (LN - s) ** 2) - (rho - R);
  b.tube([
    { x: X(0), ry: 0, rz: 0 },
    ...[0.055, 0.115, 0.185, LN].map((s) => ({ x: X(s), ry: ogive(s), rz: ogive(s) })),
    { x: X(1.0), ry: R, rz: R },
  ], 12);
  // Flap corners are polar: radius r off the body axis at azimuth ±FLAP_AZ from +Z, so the pair opens
  // out to 2×55° = 110° — wider than a right angle, which is how the leeward pair actually sits.
  // Both pairs are sized relative to body diameter D: forward flap chord ≈ 0.7 D and span ≈ 0.45 D;
  // aft flap chord ≈ 1.1 D and span ≈ 0.6 D. Thickness tapers from root to tip. Roots sit at r=0.075,
  // inside the R=0.0864 hull, so each flap welds into the tank wall.
  const FLAP_AZ = (55 * Math.PI) / 180;
  const flap = (sg, [sRL, sTL, sTT, sRT], rTip, thk) => {
    const ph = sg * FLAP_AZ;
    const P = (s, r) => [X(s), r * Math.sin(ph), r * Math.cos(ph)];
    const c = [P(sRL, 0.075), P(sTL, rTip), P(sTT, rTip), P(sRT, 0.075)];
    b.plate(sg > 0 ? c : [c[0], c[3], c[2], c[1]], sg > 0 ? thk : [thk[0], thk[3], thk[2], thk[1]]);
  };
  for (const sg of [1, -1]) {
    flap(sg, [0.250, 0.283, 0.360, 0.371], R + 0.45 * 0.1728, [0.0077, 0.0034, 0.0030, 0.0065]);  // forward
    flap(sg, [0.790, 0.855, 0.972, 0.980], R + 0.60 * 0.1728, [0.0090, 0.0040, 0.0034, 0.0078]);  // aft
  }
  return { ...bake(b.tris), triCount: b.tris.length };
}

// B3 — Parachutist. Round canopy built as a LATHED WALL: the profile runs up the outside to the apex and
// back down the inside, so the canopy has a real skin thickness with a scooped-out cavity underneath —
// a proper parachute, not the sealed hemisphere the first cut produced. It is still one closed solid, so
// nothing here is a zero-thickness sheet. The four risers converge on a harness block above a rounded
// jumper rather than stabbing into a bare rectangular column; their upper ends sit inside the canopy wall
// near the skirt, their lower ends inside the harness block, and the jumper's top inside it too.
function parachute() {
  const b = Builder();
  const skirtZ = 0.075;
  b.latheAxis([                                                       // traversed inner → apex → outer so
    [0.206, 0.000], [0.120, 0.158],                                   // the revolved wall faces outward.
    [0, 0.205],                                                       // apex. The INNER face gets two
    [0.095, 0.185], [0.170, 0.130], [0.215, 0.060], [0.225, 0.000],   // stations to the outer face's four
  ], 10, "z", [0, 0, skirtZ]);                                        // — it is inside the cavity, and the
  // rim you actually see stays 0.019 thick either way; the 20 triangles saved pay for the jumper's arms.
  // Risers run from inside the canopy wall to the jumper's two SHOULDERS — two per side, the way a real
  // harness is rigged — so no separate junction block is needed and the lines end somewhere that reads.
  const a = 0.210 / Math.SQRT2;
  for (const [sx, sy] of [[1, 1], [1, -1], [-1, -1], [-1, 1]]) {
    b.bar([sx * a, sy * a, skirtZ + 0.030], [0, sy * 0.026, -0.140], 0.006);
  }
  // Torso deliberately deeper fore-aft than the head so the head still reads as a head from the side,
  // and the legs hang slightly forward the way a jumper sits in the harness.
  b.box([0, 0, -0.175], [0.023, 0.028, 0.042]);  // torso — shoulder ends of the risers sit inside it
  b.box([0, 0, -0.122], [0.014, 0.015, 0.018]);  // head, overlapping the torso top
  for (const sy of [1, -1]) {
    b.bar([0, sy * 0.012, -0.205], [0.016, sy * 0.026, -0.298], 0.010);  // legs
    b.bar([0, sy * 0.020, -0.150], [0, sy * 0.055, -0.080], 0.008);      // arms, raised out to the risers
  }
  return { ...bake(b.tris), triCount: b.tris.length, budgetNote: "the canopy's inner surface + skirt rim (a hollow shell needs both faces) and the jumper figure" };
}

// C1/C2 — Surface vehicle, one mesh for both the emergency and the service category: a boxy utility
// truck (chassis + low narrow hood + taller cab + cargo box + roof light bar + four wheels). +X is the
// direction of travel — the stepped hood/cab is what makes the heading readable from straight above,
// which a uniform slab does not. Wheels are half-sunk in the chassis and the light bar into the cab
// roof; the cab-to-box gap is deliberate (a real truck has one) and both sit solidly on the chassis.
function ground() {
  const b = Builder();
  b.box([0, 0, 0], [0.260, 0.090, 0.055]);           // chassis frame — NARROWER than the bodywork, so
  b.box([0.198, 0, 0.070], [0.062, 0.092, 0.038]);   // hood            the top view shows the hood →
  b.box([0.078, 0, 0.100], [0.068, 0.112, 0.070]);   // cab             cab → box step instead of one
  b.box([-0.140, 0, 0.080], [0.120, 0.120, 0.060]);  // cargo box       featureless slab
  b.box([0.078, 0, 0.178], [0.028, 0.090, 0.013]);   // roof light bar
  for (const sx of [1, -1]) for (const sy of [1, -1]) {
    b.revolveAxis([{ t: 0.022, r: 0.072 }, { t: -0.022, r: 0.072 }], 8, "y", [sx * 0.170, sy * 0.105, -0.055]);
  }
  return { ...bake(b.tris), triCount: b.tris.length };
}

const BUILDERS = {
  small: jetSmall,
  medium: jetMedium,
  large: jetLarge,
  helicopter,
  glider,
  airship,
  fighter,
  drone,
  spacecraft,
  parachute,
  ground,
};
const BASELINE = new Set(["small", "medium", "large"]); // size-bucket jets (fallback shapes)

// ---- run: validate + write preview data --------------------------------------------------------
// Budget: aim ≤ TRI_AIM, allow up to TRI_MAX when the shape genuinely needs it, never beyond.
const TRI_AIM = 200, TRI_MAX = 250;
const out = {};
let failed = 0;
for (const [name, fn] of Object.entries(BUILDERS)) {
  const m = fn();
  let degenerate = 0;
  for (let i = 0; i < m.positions.length; i += 9) {
    const p = (k) => [m.positions[i + k * 3], m.positions[i + k * 3 + 1], m.positions[i + k * 3 + 2]];
    if (Math.hypot(...cross(sub(p(1), p(0)), sub(p(2), p(0)))) / 2 < 1e-7) degenerate += 1;
  }
  const openEdges = openEdgeCount(m.positions);
  const bb = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (let i = 0; i < m.positions.length; i += 3) for (let k = 0; k < 3; k += 1) { bb.min[k] = Math.min(bb.min[k], m.positions[i + k]); bb.max[k] = Math.max(bb.max[k], m.positions[i + k]); }
  const dims = bb.max.map((v, k) => (v - bb.min[k]).toFixed(3)).join(" × ");
  const stock = BASELINE.has(name);
  const vol = signedVolume(m.positions);
  const notes = [degenerate ? `${degenerate} degenerate` : "", openEdges ? `${openEdges} open edges` : "watertight"].filter(Boolean).join(", ");
  console.log(`${name.padEnd(12)} tris=${String(m.triCount).padStart(3)}  bbox(${dims})  vol=${vol.toFixed(5)}  ${notes}`);
  if (!stock) { // size-bucket fallbacks may retain intentional open edges; per-type meshes must be solid
    if (openEdges) { console.log(`  ✗ ${name}: not watertight (${openEdges} open edges)`); failed += 1; }
    if (vol <= 0) { console.log(`  ✗ ${name}: signed volume ${vol} — normals point inward somewhere`); failed += 1; }
    if (degenerate) { console.log(`  ✗ ${name}: ${degenerate} zero-area triangles`); failed += 1; }
    if (m.triCount > TRI_MAX) { console.log(`  ✗ ${name}: ${m.triCount} tris exceeds the ${TRI_MAX} hard cap`); failed += 1; }
    else if (m.triCount > TRI_AIM) console.log(`  ! ${name}: ${m.triCount} tris over the ${TRI_AIM} aim (allowed ≤ ${TRI_MAX}) — ${m.budgetNote || "no reason recorded"}`);
  }
  out[name] = { positions: m.positions, normals: m.normals, triCount: m.triCount, stock, watertight: openEdges === 0 };
}
if (failed) { console.error(`\n${failed} hard failure(s)`); process.exit(1); }

fs.mkdirSync(path.dirname(PREVIEW_JSON), { recursive: true });
fs.writeFileSync(PREVIEW_JSON, JSON.stringify(out));
console.log(`\nwrote preview data → ${path.relative(process.cwd(), PREVIEW_JSON)}`);

// ---- emit the module the app renders from -------------------------------------------------------
// Only positions/normals/indices are shipped: aircraft-layer.js reads exactly those three (colour is a
// uniform, not a vertex attribute), so the per-vertex colours and PBR fields the old glb bake carried
// were dead weight.
const geometry = {};
let rawVerts = 0, weldedVerts = 0;
for (const [name, m] of Object.entries(out)) {
  const w = weld(m);
  rawVerts += m.positions.length / 3;
  weldedVerts += w.positions.length / 3;
  geometry[name] = w;
}
const header = `// GENERATED by scripts/build-type-meshes.mjs — do not edit by hand.
// Per-type aircraft geometry: the three size buckets used as a fallback (small = P-51, medium, large)
// plus one mesh per ADS-B emitter category resolved by web/src/aircraft-kind.js.
// Model frame: +X nose (forward), +Y span (right/left), +Z up. Units are model units; aircraft-layer.js
// normalises each mesh by its own bbox span, so the meshes do not need a common scale.
`;
fs.writeFileSync(GEOMETRY_JS, `${header}export const AIRCRAFT_GEOMETRY = ${JSON.stringify(geometry)};\n`);
const kb = (fs.statSync(GEOMETRY_JS).size / 1024).toFixed(1);
console.log(`wrote ${path.relative(process.cwd(), GEOMETRY_JS)} (${kb} KB, ${Object.keys(geometry).length} meshes, ${rawVerts} → ${weldedVerts} verts after welding)`);
