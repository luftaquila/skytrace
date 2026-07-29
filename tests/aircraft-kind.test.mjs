import assert from "node:assert/strict";
import test from "node:test";

import { AIRCRAFT_GEOMETRY } from "../web/src/aircraft-geometry.js";
import { MESH_BY_CATEGORY, planeMeshKind, planeSizeScale } from "../web/src/aircraft-kind.js";

test("every mapped emitter category resolves to a mesh that actually exists", () => {
  // The one failure mode that would silently fall back to an airliner for a whole category.
  for (const [category, kind] of Object.entries(MESH_BY_CATEGORY)) {
    assert.ok(AIRCRAFT_GEOMETRY[kind], `${category} → ${kind} missing from AIRCRAFT_GEOMETRY`);
  }
});

test("the size buckets the shape axis falls back to are always present", () => {
  for (const bucket of ["small", "medium", "large"]) assert.ok(AIRCRAFT_GEOMETRY[bucket], bucket);
});

test("dedicated silhouettes are resolved per category", () => {
  assert.equal(planeMeshKind("A6"), "fighter");
  assert.equal(planeMeshKind("A7"), "helicopter");
  assert.equal(planeMeshKind("B1"), "glider");
  assert.equal(planeMeshKind("B2"), "airship");
  assert.equal(planeMeshKind("B3"), "parachute");
  assert.equal(planeMeshKind("B4"), "glider");
  assert.equal(planeMeshKind("B6"), "drone");
  assert.equal(planeMeshKind("B7"), "spacecraft");
  assert.equal(planeMeshKind("C1"), "ground");
  assert.equal(planeMeshKind("C2"), "ground");
});

test("categories without a dedicated shape fall back to the size bucket", () => {
  // Ordinary aeroplanes, no-info and reserved codes, and obstacles must NOT get a vehicle silhouette.
  for (const cat of ["A0", "A1", "A2", "A3", "A4", "A5", "B0", "B5", "C0", "C3", "C4", "C5"]) {
    assert.equal(planeMeshKind(cat), null, cat);
  }
  assert.equal(planeMeshKind(null), null);
  assert.equal(planeMeshKind(undefined), null);
  assert.equal(planeMeshKind(""), null);
  assert.equal(planeMeshKind("nonsense"), null);
});

test("category letters are case-insensitive on both axes", () => {
  assert.equal(planeMeshKind("a7"), "helicopter");
  assert.equal(planeSizeScale("a1"), 0.85);
});

test("the size axis is unchanged by the shape axis", () => {
  assert.equal(planeSizeScale("A1"), 0.85);
  assert.equal(planeSizeScale("A2"), 0.85);
  assert.equal(planeSizeScale("B1"), 0.85);
  assert.equal(planeSizeScale("A4"), 1.18);
  assert.equal(planeSizeScale("A5"), 1.18);
  assert.equal(planeSizeScale("A7"), 1);
  assert.equal(planeSizeScale("A3"), 1);
  assert.equal(planeSizeScale(null), 1);
});

test("every shipped mesh is a well-formed indexed triangle mesh", () => {
  for (const [name, g] of Object.entries(AIRCRAFT_GEOMETRY)) {
    assert.equal(g.positions.length % 3, 0, `${name} positions`);
    assert.equal(g.normals.length, g.positions.length, `${name} normals`);
    assert.equal(g.indices.length % 3, 0, `${name} indices`);
    const verts = g.positions.length / 3;
    assert.ok(verts < 65536, `${name} exceeds the Uint16 index range`);
    assert.equal(Math.max(...g.indices) < verts, true, `${name} index out of range`);
    assert.ok(g.indices.length / 3 <= 250, `${name} over the 250-triangle cap`);
  }
});
