const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function aircraftPixelSize({ worldPixels, classMultiplier = 1, selected = false, zoom = 0 }) {
  const cls = Number.isFinite(classMultiplier) && classMultiplier > 0 ? classMultiplier : 1;
  const world = Number.isFinite(worldPixels) && worldPixels > 0 ? worldPixels : 0;
  if (!selected) return clamp(world, 34 * cls, 48 * cls);

  // The selected contact is easier to read at the normal tracking zoom, then starts growing only
  // after z11. The smooth ramp avoids a threshold pop and tops out before it dominates the screen.
  const t = clamp((zoom - 11) / 5, 0, 1);
  const growth = t * t * (3 - 2 * t);
  const minPixels = (48 + 4 * growth) * cls;
  const maxPixels = (64 + 32 * growth) * cls;
  return clamp(world * 1.25, minPixels, maxPixels);
}
