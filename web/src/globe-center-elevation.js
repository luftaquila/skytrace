// MapLibre's vertical-perspective (globe) transform currently ignores the map center's
// elevation when it builds the globe view matrix. Mercator honors it, which is why a
// high-altitude orbit is exact only after the globe-to-mercator transition. This adapter
// supplies the missing radial translation to the globe matrices so the same center/elevation
// camera contract works at every zoom. Terrain and custom layers continue to share MapLibre's
// one camera matrix; this is not a screen-space correction applied only to aircraft.

export const EARTH_RADIUS_M = 6371008.8;

function translatedMatrix(matrix, x, y, z) {
  const out = new matrix.constructor(matrix);
  out[12] = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
  out[13] = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
  out[14] = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
  out[15] = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
  return out;
}

// Small, allocation-friendly inverse used only when center elevation is non-zero. Keeping the
// inverse in sync matters for globe hit testing and touch gestures while an aircraft is orbited.
export function invertMatrix4(a) {
  const out = new a.constructor(16);
  const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
  const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
  const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
  const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return null;
  const invDet = 1 / det;
  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * invDet;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * invDet;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * invDet;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * invDet;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * invDet;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * invDet;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * invDet;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * invDet;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * invDet;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * invDet;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * invDet;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * invDet;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * invDet;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * invDet;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * invDet;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * invDet;
  return out;
}

function centerSurfaceVector(center) {
  const lng = center.lng * Math.PI / 180;
  const lat = center.lat * Math.PI / 180;
  const cosLat = Math.cos(lat);
  return [Math.sin(lng) * cosLat, Math.sin(lat), Math.cos(lng) * cosLat];
}

export function applyGlobeCenterElevation(verticalTransform) {
  const elevation = Number(verticalTransform?.elevation) || 0;
  if (!elevation) return;
  const main = verticalTransform._globeViewProjMatrix32f;
  const noCorrection = verticalTransform._globeViewProjMatrixNoCorrection;
  const camera = verticalTransform._cameraPosition;
  if (!main || !noCorrection || !camera || !verticalTransform.center) return;

  const radial = centerSurfaceVector(verticalTransform.center);
  const normalizedElevation = elevation / EARTH_RADIUS_M;
  const tx = -radial[0] * normalizedElevation;
  const ty = -radial[1] * normalizedElevation;
  const tz = -radial[2] * normalizedElevation;
  verticalTransform._globeViewProjMatrix32f = translatedMatrix(main, tx, ty, tz);
  verticalTransform._globeViewProjMatrixNoCorrection = translatedMatrix(noCorrection, tx, ty, tz);

  const inverse = invertMatrix4(verticalTransform._globeViewProjMatrixNoCorrection);
  if (inverse) verticalTransform._globeViewProjMatrixNoCorrectionInverted = inverse;

  // The inverse view shift moves the camera outward along the selected point's radial axis.
  // Keep ray casting and the globe's horizon clipping plane consistent with that camera.
  camera[0] += radial[0] * normalizedElevation;
  camera[1] += radial[1] * normalizedElevation;
  camera[2] += radial[2] * normalizedElevation;
  const cameraLength = Math.hypot(camera[0], camera[1], camera[2]);
  if (cameraLength > 1) {
    verticalTransform._cachedClippingPlane = [
      camera[0] / cameraLength,
      camera[1] / cameraLength,
      camera[2] / cameraLength,
      -1 / cameraLength,
    ];
  }
}

export function installGlobeCenterElevation(transform) {
  const verticalTransform = transform?._verticalPerspectiveTransform;
  if (!verticalTransform || typeof verticalTransform._calcMatrices !== "function") return false;
  if (verticalTransform.__skytraceCenterElevationInstalled) return true;
  const originalCalcMatrices = verticalTransform._calcMatrices;
  verticalTransform._calcMatrices = function skytraceGlobeMatrices() {
    originalCalcMatrices.call(this);
    applyGlobeCenterElevation(this);
  };
  verticalTransform.__skytraceCenterElevationInstalled = true;
  // Rebuild once so installation is correct even if the initial center elevation is non-zero.
  verticalTransform._calcMatrices();
  return true;
}
