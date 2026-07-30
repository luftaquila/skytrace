import assert from "node:assert/strict";
import test from "node:test";

import {
  createAircraftMotionTracker,
  extrapolateMotion,
  normalizeMotionObservation,
} from "../web/src/aircraft-motion.js";

const base = {
  lon: 127,
  lat: 36,
  z: 1000,
  gs: 400,
  track: 90,
  trackRate: 0,
  roll: 0,
  pitch: 3,
  verticalSpeed: 5,
  onGround: false,
  key: "a",
};

function distanceMetres(a, b) {
  const meanLat = (a.lat + b.lat) * Math.PI / 360;
  const north = (b.lat - a.lat) * 111195;
  const east = (b.lon - a.lon) * 111195 * Math.cos(meanLat);
  return Math.hypot(east, north);
}

test("projects groundspeed and vertical rate continuously between receiver updates", () => {
  const state = normalizeMotionObservation(base);
  const projected = extrapolateMotion(state, 5000);
  assert.ok(Math.abs(distanceMetres(base, projected) - 1028.888) < 1);
  assert.ok(projected.lon > base.lon);
  assert.ok(Math.abs(projected.lat - base.lat) < 1e-9);
  assert.equal(projected.z, 1025);
});

test("uses reported track rate to follow a curved maneuver", () => {
  const state = normalizeMotionObservation({ ...base, track: 0, trackRate: 3, verticalSpeed: 0 });
  const projected = extrapolateMotion(state, 5000);
  assert.ok(projected.lat > base.lat);
  assert.ok(projected.lon > base.lon);
  assert.equal(projected.track, 15);
});

test("derives a coordinated turn rate from roll and speed when track rate is absent", () => {
  const state = normalizeMotionObservation({ ...base, gs: 200, track: 0, trackRate: null, roll: 30 });
  const projected = extrapolateMotion(state, 5000);
  assert.ok(projected.track > 10 && projected.track < 20);
  assert.ok(projected.lon > base.lon);
});

test("caps dead reckoning when the next observation is late", () => {
  const state = normalizeMotionObservation(base);
  assert.deepEqual(extrapolateMotion(state, 8000), extrapolateMotion(state, 30000));
});

test("a new sample starts at the current visual position and converges without a jump", () => {
  const tracker = createAircraftMotionTracker({ correctionMs: 750, maxExtrapolationMs: 8000 });
  tracker.observe("abc123", base, 0);
  const beforeUpdate = tracker.sample("abc123", 5000);
  const newObservation = { ...base, key: "b", lon: base.lon + 0.02, track: 100 };
  const atUpdate = tracker.observe("abc123", newObservation, 5000);
  assert.deepEqual(atUpdate, beforeUpdate);
  // Correction is an error that decays on top of the new trajectory, so the target does not
  // momentarily stop at the receiver tick as it would when lerping from a frozen old point.
  assert.ok(distanceMetres(atUpdate, tracker.sample("abc123", 5001)) > 0.15);

  const midway = tracker.sample("abc123", 5375);
  const newPathMidway = extrapolateMotion(normalizeMotionObservation(newObservation), 375);
  assert.ok(midway.lon > beforeUpdate.lon && midway.lon < newPathMidway.lon);

  const settled = tracker.sample("abc123", 5750);
  const expected = extrapolateMotion(normalizeMotionObservation(newObservation), 750);
  assert.deepEqual(settled, expected);
});

test("clock-only redraws do not restart extrapolation for an unchanged sample", () => {
  const tracker = createAircraftMotionTracker();
  tracker.observe("abc123", base, 0);
  const redraw = tracker.observe("abc123", base, 2000);
  assert.deepEqual(redraw, tracker.sample("abc123", 2000));
  assert.deepEqual(tracker.sample("abc123", 3000), extrapolateMotion(normalizeMotionObservation(base), 3000));
});
