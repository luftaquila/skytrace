import assert from "node:assert/strict";
import test from "node:test";

import { freeViewElevationForZoom } from "../web/src/camera-grounding.js";

const state = {
  anchorElevation: 36000 * 0.3048 * 5,
  anchorZoom: 10.5,
  currentElevation: 36000 * 0.3048 * 5,
  maxZoom: 22,
};

test("released aircraft elevation descends monotonically with free zoom", () => {
  const elevations = [10.5, 11.5, 12.5, 14.5, 18, 22].map((targetZoom) => (
    freeViewElevationForZoom({ ...state, targetZoom })
  ));
  assert.equal(elevations[0], state.anchorElevation);
  for (let index = 1; index < elevations.length; index += 1) {
    assert.ok(elevations[index] < elevations[index - 1], `${elevations[index]} must be below ${elevations[index - 1]}`);
  }
  assert.equal(elevations.at(-1), 0);
});

test("zooming back out never raises a partially grounded free pivot", () => {
  assert.equal(freeViewElevationForZoom({ ...state, currentElevation: 1500, targetZoom: 9 }), 1500);
  assert.ok(freeViewElevationForZoom({ ...state, currentElevation: 1500, targetZoom: 14 }) <= 1500);
});

test("an orbit released near max zoom still reaches ground at the limit", () => {
  const nearLimit = { anchorElevation: 50000, anchorZoom: 21.7, currentElevation: 50000, maxZoom: 22 };
  assert.ok(freeViewElevationForZoom({ ...nearLimit, targetZoom: 21.85 }) > 0);
  assert.equal(freeViewElevationForZoom({ ...nearLimit, targetZoom: 22 }), 0);
  assert.equal(freeViewElevationForZoom({ ...nearLimit, anchorZoom: 22, targetZoom: 22 }), 0);
});
