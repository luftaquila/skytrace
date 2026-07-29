// Fallback site reference. The real one is DERIVED from live coverage (the mean of each receiver's
// reception centroid) so that anyone who attaches their own receiver gets range rings, the range
// filter and the opening view around THEIR coverage instead of someone else's. This constant is only
// the pre-coverage starting point, and the receiver positions themselves stay private: /api/coverage
// publishes reception centroids, never receiver locations.
export const FALLBACK_SITE = { lon: 127.33113, lat: 36.36599 }; // Yuseong IC

// Mean of the reception centroids reported by /api/coverage, or the fallback when none are known.
export function deriveSite(areas) {
  const origins = (areas || [])
    .map((area) => area?.volumeMesh?.origin)
    .filter((origin) => Array.isArray(origin) && origin.length === 2
      && Number.isFinite(origin[0]) && Number.isFinite(origin[1]));
  if (!origins.length) return FALLBACK_SITE;
  return {
    lon: origins.reduce((sum, origin) => sum + origin[0], 0) / origins.length,
    lat: origins.reduce((sum, origin) => sum + origin[1], 0) / origins.length,
  };
}
