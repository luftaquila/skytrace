import assert from "node:assert/strict";
import test from "node:test";

import { aircraftPixelSize } from "../web/src/aircraft-size.js";

test("unselected aircraft keep the existing compact pixel clamp", () => {
  assert.equal(aircraftPixelSize({ worldPixels: 1, zoom: 16 }), 34);
  assert.equal(aircraftPixelSize({ worldPixels: 1000, zoom: 16 }), 48);
  assert.equal(aircraftPixelSize({ worldPixels: 1000, classMultiplier: 1.18, zoom: 16 }), 48 * 1.18);
});

test("selected aircraft are larger at the normal tracking zoom", () => {
  assert.equal(aircraftPixelSize({ worldPixels: 1, selected: true, zoom: 10.5 }), 48);
  assert.equal(aircraftPixelSize({ worldPixels: 1000, selected: true, zoom: 10.5 }), 64);
});

test("selected aircraft grow smoothly after zoom 11 and remain bounded", () => {
  const sizes = [11, 12, 14, 16, 20].map((zoom) => (
    aircraftPixelSize({ worldPixels: 1000, selected: true, zoom })
  ));
  assert.deepEqual(sizes.map(Math.round), [64, 67, 85, 96, 96]);
  for (let index = 1; index < sizes.length; index += 1) {
    assert.ok(sizes[index] >= sizes[index - 1]);
  }
});
