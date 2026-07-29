import assert from "node:assert/strict";
import test from "node:test";
import {
  currentTrackRun,
  mergeTrackPoints,
  reconcilePlaybackIndex,
  TRACK_BREAK_MS,
} from "../web/src/track-runs.js";

function point(minute, lat = 37) {
  return { lat, lon: 127, positionAt: new Date(Date.UTC(2026, 6, 23, 0, minute)).toISOString() };
}

test("current track hides every run before the latest ten-minute break", () => {
  const previousFlight = [point(0), point(5)];
  const currentFlight = [point(20), point(25), point(30)];

  assert.deepEqual(currentTrackRun([...previousFlight, ...currentFlight]), currentFlight);
});

test("a gap at the threshold remains part of the current flight", () => {
  const points = [point(0), point(10)];
  assert.deepEqual(currentTrackRun(points), points);
  assert.equal(TRACK_BREAK_MS, 600000);
});

test("points without positions do not leak into the rendered run", () => {
  const current = [point(20), point(25)];
  assert.deepEqual(currentTrackRun([point(0), { positionAt: point(5).positionAt }, ...current]), current);
});

test("incremental points replace the cached flight after a new break", () => {
  const cached = [
    { ...point(0), id: 1 },
    { ...point(5), id: 2 },
  ];
  const incoming = [
    { ...point(20), id: 3 },
    { ...point(25), id: 4 },
  ];
  assert.deepEqual(mergeTrackPoints(cached, incoming), incoming);
  assert.deepEqual(mergeTrackPoints(cached, incoming, true), [...cached, ...incoming]);
});

test("incremental merges deduplicate a repeated database row", () => {
  const cached = [{ ...point(0), id: 1 }];
  const incoming = [{ ...point(0), id: 1 }, { ...point(5), id: 2 }];
  assert.deepEqual(mergeTrackPoints(cached, incoming, true), [cached[0], incoming[1]]);
});

test("incremental merges preserve array identity when no positioned point changes", () => {
  const cached = [{ ...point(0), id: 1 }, { ...point(5), id: 2 }];
  assert.strictEqual(mergeTrackPoints(cached, []), cached);
  assert.strictEqual(mergeTrackPoints(cached, [{ positionAt: point(10).positionAt }], true), cached);
  assert.strictEqual(mergeTrackPoints(cached, cached, true), cached);
});

test("playback at the live edge follows newly appended track points", () => {
  const previous = [{ ...point(0), id: 1 }, { ...point(5), id: 2 }];
  const next = [...previous, { ...point(10), id: 3 }, { ...point(15), id: 4 }];

  assert.equal(reconcilePlaybackIndex(previous, next, 1), 3);
});

test("scrubbed playback remains anchored to the selected database point", () => {
  const previous = [{ ...point(0), id: 1 }, { ...point(5), id: 2 }, { ...point(10), id: 3 }];
  const next = [{ ...point(-5), id: 0 }, ...previous, { ...point(15), id: 4 }];

  assert.equal(reconcilePlaybackIndex(previous, next, 1), 2);
});
