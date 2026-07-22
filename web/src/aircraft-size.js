const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export const SELECTION_SIZE_TRANSITION_MS = 350;

export function selectionTransitionAmount({ from, to, elapsedMs, durationMs = SELECTION_SIZE_TRANSITION_MS }) {
  const t = clamp(durationMs > 0 ? elapsedMs / durationMs : 1, 0, 1);
  const eased = t * t * (3 - 2 * t);
  return from + (to - from) * eased;
}

export function aircraftPixelSize({ worldPixels, classMultiplier = 1, selected = false, selectionAmount, zoom = 0 }) {
  const cls = Number.isFinite(classMultiplier) && classMultiplier > 0 ? classMultiplier : 1;
  const world = Number.isFinite(worldPixels) && worldPixels > 0 ? worldPixels : 0;
  const regularPixels = clamp(world, 34 * cls, 48 * cls);

  // The selected contact is easier to read at the normal tracking zoom, then starts growing only
  // after z11. The smooth ramp avoids a threshold pop and remains bounded even at maximum zoom.
  const t = clamp((zoom - 11) / 5, 0, 1);
  const growth = t * t * (3 - 2 * t);
  const minPixels = (48 + 4 * growth) * cls;
  const maxPixels = (64 + 56 * growth) * cls;
  const selectedPixels = clamp(world * 1.25, minPixels, maxPixels);
  const amount = clamp(selectionAmount ?? (selected ? 1 : 0), 0, 1);
  return regularPixels + (selectedPixels - regularPixels) * amount;
}
