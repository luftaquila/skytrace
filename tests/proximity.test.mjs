import assert from "node:assert/strict";
import test from "node:test";
import { spatialConflictPairs } from "../web/src/proximity.js";

const EARTH_RADIUS_NM = 3440.065;
const radians = (value) => value * Math.PI / 180;

function distanceNm(a, b) {
  const lat1 = radians(a.lat);
  const lat2 = radians(b.lat);
  const dLat = lat2 - lat1;
  const dLon = radians(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_NM * Math.asin(Math.min(1, Math.sqrt(h)));
}

function brute(rows, maxDistNm, maxVertFt) {
  const pairs = [];
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      const vertFt = Math.abs(rows[i].alt - rows[j].alt);
      const distNm = distanceNm(rows[i].pos, rows[j].pos);
      if (vertFt <= maxVertFt && distNm <= maxDistNm) {
        pairs.push(`${rows[i].item.hex}:${rows[j].item.hex}`);
      }
    }
  }
  return pairs.sort();
}

function hashed(rows, maxDistNm, maxVertFt) {
  return spatialConflictPairs(rows, maxDistNm, maxVertFt)
    .map((pair) => `${pair.a.hex}:${pair.b.hex}`)
    .sort();
}

test("the spatial hash matches brute force at the antimeridian and high latitudes", () => {
  const rows = [
    { item: { hex: "a" }, alt: 10000, pos: { lat: 0, lng: 179.99 } },
    { item: { hex: "b" }, alt: 10500, pos: { lat: 0, lng: -179.99 } },
    { item: { hex: "c" }, alt: 10000, pos: { lat: 89.9, lng: 0 } },
    { item: { hex: "d" }, alt: 10050, pos: { lat: 89.9, lng: 90 } },
    { item: { hex: "e" }, alt: 30000, pos: { lat: 45, lng: 45 } },
  ];
  assert.deepEqual(hashed(rows, 20, 1000), brute(rows, 20, 1000));
});

test("the spatial hash has exact pair-set parity across deterministic random traffic", () => {
  let state = 0x12345678;
  const random = () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  for (let sample = 0; sample < 30; sample += 1) {
    const rows = Array.from({ length: 150 }, (_, index) => ({
      item: { hex: `${sample}-${index}` },
      alt: Math.round(random() * 45000),
      pos: {
        lat: random() * 179.8 - 89.9,
        lng: random() * 360 - 180,
      },
    }));
    const maxDistNm = 1 + random() * 500;
    const maxVertFt = Math.round(100 + random() * 10000);
    assert.deepEqual(
      hashed(rows, maxDistNm, maxVertFt),
      brute(rows, maxDistNm, maxVertFt),
      `sample ${sample}`,
    );
  }
});
