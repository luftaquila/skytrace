function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

// After an elevated aircraft orbit is released, keep the view still until the user zooms in. Each
// added zoom-intent level halves both map scale and pivot elevation. Callers may keep this intent
// moving beyond the renderer's maxZoom so an orbit released at the limit still descends gradually.
export function freeViewElevationForZoom({ anchorElevation, anchorZoom, currentElevation, targetZoom, maxZoom }) {
  const anchor = Math.max(0, Number(anchorElevation) || 0);
  const current = Math.max(0, Number(currentElevation) || 0);
  const startZoom = Number(anchorZoom) || 0;
  const zoom = Number(targetZoom) || 0;
  const limit = Math.max(startZoom, Number(maxZoom) || startZoom);
  if (anchor < 0.5 || current < 0.5) return 0;
  if (zoom >= limit - 1e-6) return 0;
  if (zoom <= startZoom) return Math.min(anchor, current);

  const zoomDelta = zoom - startZoom;
  const scaleMatchedElevation = anchor * Math.pow(0.5, zoomDelta);
  const progress = clamp01(zoomDelta / Math.max(limit - startZoom, 1e-6));
  const smoothProgress = progress * progress * (3 - 2 * progress);
  const target = scaleMatchedElevation * (1 - smoothProgress);
  return target < 0.5 ? 0 : Math.min(current, target);
}

function finitePoint(value) {
  return value && Number.isFinite(value.x) && Number.isFinite(value.y);
}

function finiteLngLat(value) {
  return value && Number.isFinite(value.lng) && Number.isFinite(value.lat);
}

function wrapLongitude(value) {
  return ((value + 180) % 360 + 360) % 360 - 180;
}

// MapLibre's setLocationAtPoint() assumes the pinned location lies on the transform's current
// elevation plane. The cursor points at the rendered DEM surface instead. Solve that actual pixel
// constraint after changing zoom and pivot elevation: numerically measure how small centre changes
// move the same terrain point, then invert that 2D Jacobian. This uses the transform's final,
// Skytrace-patched globe matrices rather than an unpatched sea-level Mercator approximation.
export function pinGroundLocationAtPoint(transform, anchor, { maxIterations = 8, tolerancePx = 0.1 } = {}) {
  if (!transform
    || !finitePoint(anchor?.point)
    || !finiteLngLat(anchor?.loc)
    || typeof transform.locationToScreenPoint !== "function"
    || typeof transform.setCenter !== "function") return false;
  const surfaceElevation = Number(anchor.surfaceElevation) || 0;
  const surface = {
    getElevationForLngLat: () => surfaceElevation,
    getElevationForLngLatZoom: () => surfaceElevation,
  };
  const project = () => transform.locationToScreenPoint(anchor.loc, surface);
  try {
    // Once the descending pivot reaches this terrain plane, MapLibre's native exact plane solver
    // is both cheaper and better conditioned than a Jacobian at a near-grazing pitch. It keeps
    // zoom unchanged in Mercator (including GlobeTransform's real high-zoom Mercator state).
    if (Math.abs((Number(transform.elevation) || 0) - surfaceElevation) <= 0.5
      && typeof transform.setLocationAtPoint === "function") {
      const originalCenter = transform.center;
      const originalZoom = transform.zoom;
      transform.setLocationAtPoint(anchor.loc, anchor.point);
      if (Math.abs(transform.zoom - originalZoom) <= 1e-9) {
        const projected = project();
        if (finitePoint(projected)
          && Math.hypot(projected.x - anchor.point.x, projected.y - anchor.point.y) <= tolerancePx) {
          return true;
        }
      } else {
        transform.setCenter(originalCenter);
        transform.setZoom(originalZoom);
      }
    }

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      const projected = project();
      if (!finitePoint(projected)) return false;
      const errorX = anchor.point.x - projected.x;
      const errorY = anchor.point.y - projected.y;
      const errorMagnitude = Math.hypot(errorX, errorY);
      if (errorMagnitude <= tolerancePx) return true;

      const center = transform.center;
      if (!finiteLngLat(center)) return false;
      const degreesPerPixel = 360 / Math.max(Number(transform.worldSize) || 512, 512);
      // At aircraft-height pivots a nominal four-pixel map step can project to a tiny fraction of
      // one screen pixel. Keep enough angular separation for a stable finite difference.
      const lngStep = Math.max(1e-5, degreesPerPixel * 8);
      const latStep = Math.max(
        1e-5,
        lngStep * Math.max(0.05, Math.cos(center.lat * Math.PI / 180)),
      );
      transform.setCenter({ lng: wrapLongitude(center.lng + lngStep), lat: center.lat });
      const projectedLng = project();
      transform.setCenter({
        lng: center.lng,
        lat: Math.max(-85, Math.min(85, center.lat + latStep)),
      });
      const projectedLat = project();
      if (!finitePoint(projectedLng) || !finitePoint(projectedLat)) return false;

      const j00 = (projectedLng.x - projected.x) / lngStep;
      const j10 = (projectedLng.y - projected.y) / lngStep;
      const j01 = (projectedLat.x - projected.x) / latStep;
      const j11 = (projectedLat.y - projected.y) / latStep;
      const determinant = j00 * j11 - j01 * j10;
      if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) return false;
      const deltaLng = Math.max(-45, Math.min(45, (errorX * j11 - errorY * j01) / determinant));
      const deltaLat = Math.max(-45, Math.min(45, (j00 * errorY - j10 * errorX) / determinant));
      if (!Number.isFinite(deltaLng) || !Number.isFinite(deltaLat)) return false;

      // Near the horizon the centre-to-pixel relationship is strongly nonlinear. A full Newton
      // step can jump across the globe even though a smaller step converges. Accept the first
      // damped step that actually reduces the rendered-surface pixel error.
      let improved = false;
      for (let scale = 1; scale >= 1 / 128; scale /= 2) {
        transform.setCenter({
          lng: wrapLongitude(center.lng + deltaLng * scale),
          lat: Math.max(-85, Math.min(85, center.lat + deltaLat * scale)),
        });
        const candidate = project();
        if (!finitePoint(candidate)) continue;
        const candidateError = Math.hypot(
          candidate.x - anchor.point.x,
          candidate.y - anchor.point.y,
        );
        if (candidateError <= tolerancePx) return true;
        if (candidateError < errorMagnitude) {
          improved = true;
          break;
        }
      }
      if (!improved) return false;
    }
    const projected = project();
    return finitePoint(projected)
      && Math.hypot(projected.x - anchor.point.x, projected.y - anchor.point.y) <= tolerancePx;
  } catch {
    return false;
  }
}
