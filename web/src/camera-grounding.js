function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

// After an elevated aircraft orbit is released, keep the view perfectly still until the user zooms
// in. Each added zoom level halves both map scale and pivot elevation, which makes the descent feel
// attached to the zoom rather than like a separate camera move. A smooth maximum-zoom term guarantees
// that even an orbit released close to max zoom reaches the ground exactly at the zoom limit.
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
