import assert from "node:assert/strict";
import test from "node:test";

import {
  MAP_VIEW_KEY,
  loadMapView,
  normalizeMapView,
  saveMapView,
} from "../web/src/map-view.js";

function storageWith(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    values,
  };
}

test("map view storage accepts only bounded numeric centre and zoom values", () => {
  assert.deepEqual(normalizeMapView({ lon: 127.1, lat: 37.5, zoom: 8.25 }), {
    lon: 127.1,
    lat: 37.5,
    zoom: 8.25,
  });
  for (const invalid of [
    null,
    [],
    { lon: "127.1", lat: 37.5, zoom: 8 },
    { lon: 181, lat: 37.5, zoom: 8 },
    { lon: 127.1, lat: -91, zoom: 8 },
    { lon: 127.1, lat: 37.5, zoom: 23 },
  ]) assert.equal(normalizeMapView(invalid), null);
});

test("map view storage round-trips and fails closed on fresh, corrupt or denied storage", () => {
  const storage = storageWith();
  assert.equal(loadMapView(storage), null, "a first visit has no restored view");
  assert.equal(saveMapView({
    lon: 129.10000000000002,
    lat: 35.20000000000001,
    zoom: 7.6000000001,
  }, storage), true);
  assert.deepEqual(loadMapView(storage), { lon: 129.1, lat: 35.2, zoom: 7.6 });

  storage.values.set(MAP_VIEW_KEY, "{broken");
  assert.equal(loadMapView(storage), null);
  assert.equal(saveMapView({ lon: 500, lat: 35.2, zoom: 7.6 }, storage), false);
  assert.doesNotThrow(() => saveMapView(
    { lon: 129.1, lat: 35.2, zoom: 7.6 },
    { setItem: () => { throw new Error("denied"); } },
    { warn: () => {} },
  ));
});
