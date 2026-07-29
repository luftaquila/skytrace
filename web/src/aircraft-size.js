const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function aircraftPixelSize({ worldPixels, classMultiplier = 1, minScale = 1 }) {
  const cls = Number.isFinite(classMultiplier) && classMultiplier > 0 ? classMultiplier : 1;
  const world = Number.isFinite(worldPixels) && worldPixels > 0 ? worldPixels : 0;
  const floor = Number.isFinite(minScale) ? clamp(minScale, 0, 1) : 1;
  // Selection never changes model scale. Zoom changes the projected physical size naturally; this
  // clamp only keeps distant contacts readable and very close contacts bounded. minScale relaxes
  // the readability floor when the caller knows the view is zoomed far out: holding a fixed pixel
  // floor while the geography collapses piles every icon on top of its neighbours.
  return clamp(world, 34 * cls * floor, 120 * cls);
}
