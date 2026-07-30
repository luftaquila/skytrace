export const MAP_VIEW_KEY = "skytrace.mapView";

const MIN_ZOOM = 0;
const MAX_ZOOM = 22;

export function normalizeMapView(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { lon, lat, zoom } = value;
  if (!Number.isFinite(lon) || lon < -180 || lon > 180
    || !Number.isFinite(lat) || lat < -90 || lat > 90
    || !Number.isFinite(zoom) || zoom < MIN_ZOOM || zoom > MAX_ZOOM) return null;
  return { lon, lat, zoom };
}

export function loadMapView(storage = globalThis.localStorage) {
  try {
    const stored = storage.getItem(MAP_VIEW_KEY);
    return stored == null ? null : normalizeMapView(JSON.parse(stored));
  } catch {
    return null;
  }
}

export function saveMapView(value, storage = globalThis.localStorage, logger = console) {
  const normalized = normalizeMapView(value);
  if (!normalized) return false;
  const serializable = {
    lon: Number(normalized.lon.toFixed(6)),
    lat: Number(normalized.lat.toFixed(6)),
    zoom: Number(normalized.zoom.toFixed(4)),
  };
  try {
    storage.setItem(MAP_VIEW_KEY, JSON.stringify(serializable));
    return true;
  } catch (error) {
    logger.warn("Unable to persist map view", error);
    return false;
  }
}
