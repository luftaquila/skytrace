import assert from "node:assert/strict";
import test from "node:test";

import { aircraftPixelSize } from "../web/src/aircraft-size.js";

test("aircraft grow with projected zoom up to the common pixel cap", () => {
  assert.equal(aircraftPixelSize({ worldPixels: 1 }), 34);
  assert.equal(aircraftPixelSize({ worldPixels: 60 }), 60);
  assert.equal(aircraftPixelSize({ worldPixels: 1000 }), 120);
  assert.equal(aircraftPixelSize({ worldPixels: 1000, classMultiplier: 1.18 }), 120 * 1.18);
});

test("selection and zoom flags cannot change size for the same projection", () => {
  const regular = aircraftPixelSize({ worldPixels: 76, selected: false, zoom: 8 });
  const selected = aircraftPixelSize({ worldPixels: 76, selected: true, selectionAmount: 1, zoom: 18 });
  assert.equal(selected, regular);
});

test("a relaxed floor shrinks far-out icons but never inflates anything", () => {
  // Zoomed far out the caller relaxes the readability floor, so tiny projected aircraft may
  // shrink below 34 px instead of piling on top of each other.
  assert.equal(aircraftPixelSize({ worldPixels: 1, minScale: 0.32 }), 34 * 0.32);
  // A floor is a floor: projections above it are untouched, and the cap still binds.
  assert.equal(aircraftPixelSize({ worldPixels: 60, minScale: 0.32 }), 60);
  assert.equal(aircraftPixelSize({ worldPixels: 1000, minScale: 0.32 }), 120);
  // Bogus scales fall back to the full floor.
  assert.equal(aircraftPixelSize({ worldPixels: 1, minScale: Number.NaN }), 34);
  assert.equal(aircraftPixelSize({ worldPixels: 1, minScale: 2 }), 34);
});
