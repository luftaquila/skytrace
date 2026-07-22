const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function aircraftPixelSize({ worldPixels, classMultiplier = 1 }) {
  const cls = Number.isFinite(classMultiplier) && classMultiplier > 0 ? classMultiplier : 1;
  const world = Number.isFinite(worldPixels) && worldPixels > 0 ? worldPixels : 0;
  // Selection never changes model scale. Zoom changes the projected physical size naturally; this
  // clamp only keeps distant contacts readable and very close contacts bounded.
  return clamp(world, 34 * cls, 120 * cls);
}
