import { MercatorCoordinate } from "maplibre-gl";

export const MAPLIBRE_EARTH_RADIUS_M = 6371008.8;

function multiply(a, b) {
  const out = new Float64Array(16);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      out[column * 4 + row] = (
        a[row] * b[column * 4]
        + a[4 + row] * b[column * 4 + 1]
        + a[8 + row] * b[column * 4 + 2]
        + a[12 + row] * b[column * 4 + 3]
      );
    }
  }
  return out;
}

function translation(x, y, z) {
  return new Float64Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    x, y, z, 1,
  ]);
}

function rotationX(radians) {
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return new Float64Array([
    1, 0, 0, 0,
    0, cosine, sine, 0,
    0, -sine, cosine, 0,
    0, 0, 0, 1,
  ]);
}

function rotationY(radians) {
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return new Float64Array([
    cosine, 0, -sine, 0,
    0, 1, 0, 0,
    sine, 0, cosine, 0,
    0, 0, 0, 1,
  ]);
}

function rotationZ(radians) {
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return new Float64Array([
    cosine, sine, 0, 0,
    -sine, cosine, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ]);
}

function scale(x, y, z) {
  return new Float64Array([
    x, 0, 0, 0,
    0, y, 0, 0,
    0, 0, z, 0,
    0, 0, 0, 1,
  ]);
}

export function mercatorModelFrame(location, altitude = 0) {
  const mercator = MercatorCoordinate.fromLngLat(location, altitude);
  const meterScale = mercator.meterInMercatorCoordinateUnits();
  return multiply(
    multiply(
      multiply(
        translation(mercator.x, mercator.y, mercator.z),
        rotationZ(Math.PI),
      ),
      rotationX(Math.PI / 2),
    ),
    scale(-meterScale, meterScale, meterScale),
  );
}

export function globeModelFrame(location, altitude = 0) {
  const [longitude, latitude] = location;
  const meterScale = 1 / MAPLIBRE_EARTH_RADIUS_M;
  return multiply(
    multiply(
      multiply(
        multiply(
          rotationY(longitude * Math.PI / 180),
          rotationX(-latitude * Math.PI / 180),
        ),
        translation(0, 0, 1 + altitude / MAPLIBRE_EARTH_RADIUS_M),
      ),
      rotationX(Math.PI / 2),
    ),
    scale(meterScale, meterScale, meterScale),
  );
}

// MapLibre's public custom-layer projection data is the source of truth. A globe style renders in
// Mercator coordinates after its high-zoom transition reaches zero, so the style's declared type
// alone is not sufficient here.
export function modelFrameForProjection(location, altitude, projectionTransition = 0) {
  return Number(projectionTransition) > 0
    ? globeModelFrame(location, altitude)
    : mercatorModelFrame(location, altitude);
}
