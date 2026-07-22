import assert from "node:assert/strict";
import test from "node:test";

import {
  EARTH_RADIUS_M,
  applyGlobeCenterElevation,
  installGlobeCenterElevation,
  invertMatrix4,
} from "../web/src/globe-center-elevation.js";

const identity = (Type = Float64Array) => new Type([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

function multiply(a, b) {
  const out = new Float64Array(16);
  for (let col = 0; col < 4; col += 1) {
    for (let row = 0; row < 4; row += 1) {
      let value = 0;
      for (let k = 0; k < 4; k += 1) value += a[k * 4 + row] * b[col * 4 + k];
      out[col * 4 + row] = value;
    }
  }
  return out;
}

function transformPoint(matrix, point) {
  return [0, 1, 2, 3].map((row) => (
    matrix[row] * point[0] + matrix[4 + row] * point[1]
    + matrix[8 + row] * point[2] + matrix[12 + row] * point[3]
  ));
}

function surfaceVector({ lng, lat }) {
  const lambda = lng * Math.PI / 180;
  const phi = lat * Math.PI / 180;
  return [Math.sin(lambda) * Math.cos(phi), Math.sin(phi), Math.cos(lambda) * Math.cos(phi)];
}

function close(actual, expected, epsilon = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);
}

test("globe center elevation translates an elevated target onto the same camera pivot", () => {
  const center = { lng: 127.33113, lat: 36.36599 };
  const elevation = 18000 * 0.3048 * 5;
  const radial = surfaceVector(center);
  // Any projection/view/rotation may be on the left. If the adapter maps the elevated target to
  // the original surface pivot before that matrix, the result is invariant across zoom and pitch.
  const view = new Float64Array([
    1.2, 0.2, -0.1, 0.03,
    -0.3, 0.8, 0.15, -0.02,
    0.05, -0.25, 1.1, 0.01,
    2, -4, 0.5, 1,
  ]);
  const transform = {
    center,
    elevation,
    _globeViewProjMatrix32f: new Float32Array(view),
    _globeViewProjMatrixNoCorrection: view,
    _globeViewProjMatrixNoCorrectionInverted: identity(),
    _cameraPosition: new Float64Array(radial.map((value) => value * 2)),
    _cachedClippingPlane: [0, 0, 1, -0.5],
  };

  applyGlobeCenterElevation(transform);

  const radius = 1 + elevation / EARTH_RADIUS_M;
  const elevatedTarget = [...radial.map((value) => value * radius), 1];
  const projected = transformPoint(transform._globeViewProjMatrixNoCorrection, elevatedTarget);
  const expectedPivot = transformPoint(view, [...radial, 1]);
  expectedPivot.forEach((value, index) => close(projected[index], value));
});

test("globe elevation keeps the forward and inverse view matrices consistent", () => {
  const base = new Float64Array([
    1.2, 0.1, 0.2, 0,
    -0.2, 0.9, 0.05, 0,
    0.1, -0.1, 1.1, 0,
    3, -2, 5, 1,
  ]);
  const inverse = invertMatrix4(base);
  assert.ok(inverse);
  const product = multiply(base, inverse);
  for (let i = 0; i < 16; i += 1) close(product[i], i % 5 === 0 ? 1 : 0, 1e-8);
});

test("installer wraps MapLibre's vertical transform exactly once", () => {
  let calculations = 0;
  const vertical = {
    center: { lng: 0, lat: 0 },
    elevation: 1000,
    _globeViewProjMatrix32f: identity(Float32Array),
    _globeViewProjMatrixNoCorrection: identity(),
    _globeViewProjMatrixNoCorrectionInverted: identity(),
    _cameraPosition: new Float64Array([0, 0, 2]),
    _calcMatrices() {
      calculations += 1;
      this._globeViewProjMatrix32f = identity(Float32Array);
      this._globeViewProjMatrixNoCorrection = identity();
      this._globeViewProjMatrixNoCorrectionInverted = identity();
      this._cameraPosition = new Float64Array([0, 0, 2]);
    },
  };
  const globe = { _verticalPerspectiveTransform: vertical };
  assert.equal(installGlobeCenterElevation(globe), true);
  const installed = vertical._calcMatrices;
  assert.equal(installGlobeCenterElevation(globe), true);
  assert.equal(vertical._calcMatrices, installed);
  vertical._calcMatrices();
  assert.equal(calculations, 2); // one rebuild at install, one explicit call
  close(vertical._globeViewProjMatrixNoCorrection[14], -1000 / EARTH_RADIUS_M);
});
