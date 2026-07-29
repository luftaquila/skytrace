import assert from "node:assert/strict";
import test from "node:test";

import { MercatorCoordinate } from "../web/node_modules/maplibre-gl/dist/maplibre-gl.mjs";
import {
  MAPLIBRE_EARTH_RADIUS_M,
  globeModelFrame,
  mercatorModelFrame,
  modelFrameForProjection,
} from "../web/src/maplibre-model-frame.js";

function close(actual, expected, epsilon = 1e-12) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);
}

function transformPoint(matrix, point) {
  return [0, 1, 2, 3].map((row) => (
    matrix[row] * point[0]
    + matrix[4 + row] * point[1]
    + matrix[8 + row] * point[2]
    + matrix[12 + row] * point[3]
  ));
}

function longitudeLatitudeVector(longitude, latitude) {
  const lng = longitude * Math.PI / 180;
  const lat = latitude * Math.PI / 180;
  const cosLat = Math.cos(lat);
  return [Math.sin(lng) * cosLat, Math.sin(lat), Math.cos(lng) * cosLat];
}

test("mercator model frame retains MapLibre's Y-up local metre convention", () => {
  const location = [127.33113, 36.36599];
  const altitude = 12345;
  const mercator = MercatorCoordinate.fromLngLat(location, altitude);
  const meterScale = mercator.meterInMercatorCoordinateUnits();
  const frame = mercatorModelFrame(location, altitude);

  const origin = transformPoint(frame, [0, 0, 0, 1]);
  close(origin[0], mercator.x);
  close(origin[1], mercator.y);
  close(origin[2], mercator.z);
  close(origin[3], 1);

  const east = transformPoint(frame, [1, 0, 0, 0]);
  const up = transformPoint(frame, [0, 1, 0, 0]);
  const south = transformPoint(frame, [0, 0, 1, 0]);
  close(east[0], meterScale);
  close(east[1], 0);
  close(east[2], 0);
  close(up[0], 0);
  close(up[1], 0);
  close(up[2], meterScale);
  close(south[0], 0);
  close(south[1], meterScale);
  close(south[2], 0);
});

test("globe model frame places altitude radially and keeps local axes orthogonal", () => {
  const location = [179.75, 72.5];
  const altitude = 36000 * 0.3048 * 5;
  const frame = globeModelFrame(location, altitude);
  const radial = longitudeLatitudeVector(...location);
  const radius = 1 + altitude / MAPLIBRE_EARTH_RADIUS_M;
  const origin = transformPoint(frame, [0, 0, 0, 1]);
  radial.forEach((value, index) => close(origin[index], value * radius));
  close(origin[3], 1);

  const meterScale = 1 / MAPLIBRE_EARTH_RADIUS_M;
  for (const axis of [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]]) {
    const transformed = transformPoint(frame, axis);
    close(Math.hypot(transformed[0], transformed[1], transformed[2]), meterScale);
  }
});

test("custom-layer projection transition selects the same frame as MapLibre v6", () => {
  const location = [-179.9, -64.25];
  const altitude = 2500;
  assert.deepEqual(
    modelFrameForProjection(location, altitude, 0),
    mercatorModelFrame(location, altitude),
  );
  assert.deepEqual(
    modelFrameForProjection(location, altitude, 0.000001),
    globeModelFrame(location, altitude),
  );
  assert.deepEqual(
    modelFrameForProjection(location, altitude, 1),
    globeModelFrame(location, altitude),
  );
});
