// Viewport-driven airfield feed. The server maintains the OurAirports-derived dataset (see
// src/airfields-store.mjs) as a two-tier static layout:
//
//   tier 1  index.json  every open large/medium airport — always loaded, they are what the low
//                        zooms draw
//   tier 2  cell-<lat>-<lon>.json  open small airports per 10-degree cell — fetched only for
//                        the cells under the viewport, and only past the zoom where the style
//                        shows small airfields at all (their runways ride along, so a click
//                        needs no extra request)
//
// Payload URLs carry the dataset version and are immutable; only the manifest revalidates.

/**
 * @typedef {Object} Runway
 * @property {?string} ends Reciprocal runway identifiers, for example 16L/34R.
 * @property {?number} lengthM Published runway length, rounded to metres.
 */

/**
 * @typedef {Object} Airfield
 * @property {string} code Best display code: IATA, else ICAO, else OurAirports ident.
 * @property {?string} icao Official ICAO code or null.
 * @property {?string} iata Official IATA code or null.
 * @property {string} name
 * @property {"large"|"medium"|"small"} kind
 * @property {?string} city
 * @property {number} lat
 * @property {number} lon
 * @property {Runway[]} runways All published open runways.
 */

/** True for fields with no official ICAO/IATA code. */
export const isMinorAirfield = (airfield) => !airfield.icao && !airfield.iata;

const KINDS = { l: "large", m: "medium", s: "small" };
// The style shows small airfields from zoom 7; prefetch a little before that so they are there
// when the layer fades in.
export const CELL_FETCH_MIN_ZOOM = 6.4;
export const AIRFIELD_RETRY_MIN_MS = 1000;
const AIRFIELD_RETRY_MAX_MS = 30000;
const CELL_SIZE_DEG = 10;

function retryDelay(failureCount) {
  return Math.min(AIRFIELD_RETRY_MAX_MS, AIRFIELD_RETRY_MIN_MS * (2 ** Math.min(failureCount, 10)));
}

function decodeFields(rows) {
  return (Array.isArray(rows) ? rows : []).map(([code, icao, iata, name, kind, city, lat, lon, runways]) => ({
    code,
    icao,
    iata,
    name,
    kind: KINDS[kind] || "small",
    city,
    lat,
    lon,
    runways: (runways || []).map(([ends, lengthM]) => ({ ends, lengthM })),
  }));
}

export function createAirfieldsFeed({
  onUpdate,
  onError,
  fetchImpl = (...args) => fetch(...args),
  nowImpl = () => performance.now(),
} = {}) {
  let manifest = null;
  let indexFields = [];
  const cellFields = new Map(); // cellId -> Airfield[]
  const inflight = new Set();
  const cellFailures = new Map(); // cellId -> { count, retryAt }
  let manifestPromise = null;
  let manifestFailureCount = 0;
  let manifestRetryAt = -Infinity;
  let disposed = false;

  function reportError(error, details) {
    try {
      onError?.({ error, ...details });
    } catch {
      // A diagnostics callback must never disable the feed's own recovery.
    }
  }

  async function fetchJson(url) {
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
    return res.json();
  }

  // The manifest and the always-on index tier load together. Transient startup/network failures
  // retry quickly with a bounded backoff so one missed response cannot leave every airport absent
  // until the page is reloaded.
  function ensureManifest() {
    if (manifest || disposed) return;
    if (manifestPromise || nowImpl() < manifestRetryAt) return;
    manifestPromise = (async () => {
      try {
        const next = await fetchJson("/api/airfields/manifest");
        if (typeof next?.version !== "string" || !next.cells) throw new Error("malformed airfields manifest");
        const index = await fetchJson(`/api/airfields/${next.version}/index.json`);
        if (disposed) return;
        manifest = next;
        indexFields = decodeFields(index.fields);
        manifestFailureCount = 0;
        manifestRetryAt = -Infinity;
        onUpdate?.();
      } catch (error) {
        if (disposed) return;
        const retryInMs = retryDelay(manifestFailureCount);
        manifestFailureCount++;
        manifestRetryAt = nowImpl() + retryInMs;
        reportError(error, { scope: "manifest", retryInMs });
      } finally {
        manifestPromise = null;
      }
    })();
  }

  function loadCell(id) {
    const failure = cellFailures.get(id);
    if (cellFields.has(id)
      || inflight.has(id)
      || !manifest?.cells?.[id]
      || (failure && nowImpl() < failure.retryAt)) return;
    inflight.add(id);
    fetchJson(`/api/airfields/${manifest.version}/cell-${id}.json`)
      .then((payload) => {
        if (disposed) return;
        cellFailures.delete(id);
        cellFields.set(id, decodeFields(payload.fields));
        onUpdate?.();
      })
      .catch((error) => {
        if (disposed) return;
        const count = failure?.count || 0;
        const retryInMs = retryDelay(count);
        cellFailures.set(id, { count: count + 1, retryAt: nowImpl() + retryInMs });
        reportError(error, { scope: "cell", id, retryInMs });
      })
      .finally(() => inflight.delete(id));
  }

  // Fetch whatever the current viewport needs. Called from the camera loop (throttled there):
  // it re-checks the manifest while none is loaded, and past the small-airfield zoom it loads
  // the 10-degree cells under (and slightly around) the view.
  function ensureViewport(bounds, zoom, enabled) {
    if (!enabled || disposed) return;
    ensureManifest();
    if (!manifest || !bounds || zoom < CELL_FETCH_MIN_ZOOM) return;
    const south = bounds.getSouth() - 1;
    const north = bounds.getNorth() + 1;
    const west = bounds.getWest() - 1;
    const rawEast = bounds.getEast() + 1;
    const east = rawEast < west ? rawEast + 360 : rawEast;
    const latStart = Math.max(0, Math.floor((south + 90) / CELL_SIZE_DEG));
    const latEnd = Math.min(17, Math.floor((north + 90) / CELL_SIZE_DEG));
    const lonStart = Math.floor((west + 180) / CELL_SIZE_DEG);
    const lonEnd = Math.floor((east + 180) / CELL_SIZE_DEG);
    for (let lat = latStart; lat <= latEnd; lat += 1) {
      for (let lon = lonStart; lon <= lonEnd; lon += 1) {
        loadCell(`${lat}-${((lon % 36) + 36) % 36}`);
      }
    }
  }

  function* all() {
    yield* indexFields;
    for (const fields of cellFields.values()) yield* fields;
  }

  return {
    ensureViewport,
    all,
    manifest: () => manifest,
    dispose: () => { disposed = true; },
  };
}
