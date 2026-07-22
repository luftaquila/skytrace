import assert from "node:assert/strict";
import test from "node:test";

import { aircraftPixelSize, selectionTransitionAmount } from "../web/src/aircraft-size.js";

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
  assert.deepEqual(sizes.map(Math.round), [64, 70, 100, 120, 120]);
  for (let index = 1; index < sizes.length; index += 1) {
    assert.ok(sizes[index] >= sizes[index - 1]);
  }
});

test("selection size eases continuously in both directions", () => {
  const growing = [0, 87.5, 175, 262.5, 350].map((elapsedMs) => (
    selectionTransitionAmount({ from: 0, to: 1, elapsedMs })
  ));
  assert.deepEqual(growing, [0, 0.15625, 0.5, 0.84375, 1]);
  assert.deepEqual(growing.map((amount) => (
    aircraftPixelSize({ worldPixels: 1000, selectionAmount: amount, zoom: 16 })
  )), [48, 59.25, 84, 108.75, 120]);
  assert.equal(selectionTransitionAmount({ from: 1, to: 0, elapsedMs: 175 }), 0.5);
});
