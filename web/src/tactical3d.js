// 3D satellite view on MapLibre GL v6 (raster-DEM terrain + LOD imagery, no key). All GPU
// objects — the altitude-gradient coverage dome, aircraft with altitude sticks/trails, and
// conflict links — are drawn by a MapLibre custom WebGL layer (web/src/aircraft-layer.js) so
// they follow the real camera in globe; HTML data-block popovers with pins overlay the canvas.
//
// Loaded via dynamic import from App.vue. All app state and formatting comes through `deps`.
import maplibregl from "./maplibre-runtime.js";
import "maplibre-gl/dist/maplibre-gl.css";
import { createAirfieldsFeed, isMinorAirfield } from "./airfields-live.js";
import { createAircraftLayer } from "./aircraft-layer.js";
import { domeCentre } from "./coverage-centre.js";
import { createAircraftMotionTracker } from "./aircraft-motion.js";
import {
  freeViewElevationForZoom,
  pinGroundLocationAtPoint,
} from "./camera-grounding.js";
import {
  installGlobeCenterElevation,
  installGlobeTerrainFogMatrix,
} from "./globe-center-elevation.js";
import {
  MAP_FONT_STACK,
  MAP_REFERENCE_SOURCE_ID,
  MAP_REFERENCE_SOURCE_URL,
  createMapReferenceLayers,
  createMapReferenceSource,
  syncMapReferenceOverlay,
} from "./map-reference-style.js";
import { SATELLITE_CREDIT, TERRAIN_CREDIT } from "./credits.js";
import {
  createRetainedSymbolPlacement,
  installSingleTerrainSourceUpdate,
  installViewportSymbolSize,
} from "./maplibre-performance.js";
import {
  mapCameraHelper,
  mapHandlerRegistry,
  mapTransform,
  requestedCameraTransform,
} from "./maplibre-internals.js";
import { loadMapView, saveMapView } from "./map-view.js";
import { FALLBACK_SITE } from "./site.js";
import {
  createEsriTileProtocol,
  createMapterhornTileProtocol,
} from "./tile-protocols.js";
import { currentTrackRun } from "./track-runs.js";

const FT_TO_M = 0.3048;
const NM_TO_KM = 1.852;
const MI_TO_KM = 1.609344;
const DISTANCE_UNIT_LABELS = { nm: "NM", km: "km", mi: "mi" };
const DISTANCE_UNIT_TO_KM = { nm: NM_TO_KM, km: 1, mi: MI_TO_KM };
// Pre-coverage starting point only; site() below is the live, coverage-derived reference.
const HOME = FALLBACK_SITE;
const BROWSER_LOCATE_VIEW = { zoom: 8, pitch: 10, bearing: 0 };
// Satellite and terrain use resilient protocols. Missing Esri detail is generated from the nearest
// real ancestor, and missing Mapterhorn ocean tiles become exact sea-level DEM. MapLibre therefore
// receives a complete tile set instead of alternating errored children with coarser parents while a
// tracked target moves the camera.
const SAT_TILES = ["esrisat://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"];
const MAPTERHORN_TILES = ["mapterhorn://tiles.mapterhorn.com/{z}/{x}/{y}.webp"];
let resilientProtocolsAdded = false;
function ensureResilientTileProtocols() {
  if (resilientProtocolsAdded) return;
  resilientProtocolsAdded = true;
  maplibregl.addProtocol("esrisat", createEsriTileProtocol());
  maplibregl.addProtocol("mapterhorn", createMapterhornTileProtocol());
}
// Terrain relief comes from Mapterhorn (higher-quality open DEM, terrarium-encoded webp, CORS *,
// maxzoom 12 over Korea).
const EMPTY_FC = { type: "FeatureCollection", features: [] };
const M_PER_DEG_LAT = 111320;
// Camera matrices still follow the native display cadence. Expensive satellite/vector/DEM tile
// selection runs at most once per 60 Hz interval while the retained set is reprojected between
// passes. A forced update at gesture/animation completion gives the settled view its exact tile set.
const CAMERA_SOURCE_FRAME_MS = 1000 / 60;
// IMPORTANT: zero makes MapLibre force a complete, non-pauseable symbol placement on every render.
// Raster tile cross-fades remain disabled independently on the raster layer below.
const SYMBOL_PLACEMENT_FADE_MS = 300;
const AIRFIELD_SOURCE_BATCH_MS = 50;
const AIRFIELD_HIT_REFRESH_MS = 100;
const REFERENCE_SOURCE_RETRY_MIN_MS = 1000;
const REFERENCE_SOURCE_RETRY_MAX_MS = 30000;
const FREE_GROUNDING_ZOOM_SPAN = 5;

function settingExaggeration(settings, key, max, fallback, min = 1) {
  const value = Number(settings?.[key]);
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

// deps colors are `hsl(H S% L%)` or hex; parse to {r,g,b} 0-255.
const RGB_CACHE = new Map();
function parseRgb(css) {
  const cached = RGB_CACHE.get(css);
  if (cached) return cached;
  const m = /hsl\(\s*([\d.]+)[ ,]+([\d.]+)%[ ,]+([\d.]+)%\s*\)/.exec(css);
  if (m) {
    const h = Number(m[1]) / 360;
    const s = Number(m[2]) / 100;
    const l = Number(m[3]) / 100;
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const hue = (t) => { t = (t + 1) % 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; };
    const color = { r: Math.round(hue(h + 1 / 3) * 255), g: Math.round(hue(h) * 255), b: Math.round(hue(h - 1 / 3) * 255) };
    RGB_CACHE.set(css, color);
    return color;
  }
  const hex = css.replace("#", "");
  const n = hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex;
  const color = { r: parseInt(n.slice(0, 2), 16), g: parseInt(n.slice(2, 4), 16), b: parseInt(n.slice(4, 6), 16) };
  RGB_CACHE.set(css, color);
  return color;
}

// Tactical airfield glyph (aeronautical style): a glowing ring with crossed runways and a core,
// drawn to a canvas so MapLibre can use it as a symbol icon (constant screen size, hit-testable).
const AF_ICON_COLORS = { "af-large": "#ffd23f", "af-medium": "#ff9f45", "af-small": "#c3ccd6", "af-minor": "#8b98a5" };
function makeAirfieldIcon(color) {
  const S = 44;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const ctx = c.getContext("2d");
  const cx = S / 2, r = 13, k = r * 0.72;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.6;
  ctx.lineCap = "round";
  ctx.shadowColor = color;
  ctx.shadowBlur = 5;
  ctx.beginPath(); ctx.arc(cx, cx, r, 0, Math.PI * 2); ctx.stroke();               // ring
  ctx.beginPath(); ctx.moveTo(cx - k, cx - k); ctx.lineTo(cx + k, cx + k);
  ctx.moveTo(cx - k, cx + k); ctx.lineTo(cx + k, cx - k); ctx.stroke();             // crossed runways
  ctx.shadowBlur = 0;
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc(cx, cx, 2.4, 0, Math.PI * 2); ctx.fill();               // core
  return ctx.getImageData(0, 0, S, S);
}

export function createTactical3d({ container, deps }) {
  const initialSettings = deps.getSettings();
  const restoredMapView = loadMapView();
  const referenceLanguage = window.navigator.language;
  const referenceLabelsEnabled = initialSettings.mapReferenceLabels !== false;
  let terrainExagg = settingExaggeration(initialSettings, "terrainExaggeration", 5, 2);
  let altitudeExagg = settingExaggeration(initialSettings, "altitudeExaggeration", 10, 5);
  let pitchExagg = settingExaggeration(initialSettings, "aircraftPitchExaggeration", 5, 3);
  let rollExagg = settingExaggeration(initialSettings, "aircraftRollExaggeration", 5, 2);
  // Operator appearance scales. iconScale multiplies the on-screen model size only; the mesh size
  // bucket stays derived from the ADS-B category class so scaling never swaps a model.
  let iconScale = settingExaggeration(initialSettings, "aircraftScale", 2.5, 1, 0.5);
  let trailWidthPx = settingExaggeration(initialSettings, "trailWidth", 5, 2.1, 1);
  const trailGeometryCache = new WeakMap();
  let disposed = false;
  let ready = false;
  // The live site reference (mean reception centroid). Rings, the coverage tangent plane and the
  // opening view all follow it, so a deployment with its own receivers is centred on its own sky.
  function site() {
    const value = deps.getSite?.();
    return value && Number.isFinite(value.lon) && Number.isFinite(value.lat) ? value : HOME;
  }
  let appliedSiteKey = null;
  // A restored view is operator-owned too: live coverage must not replace it on reload.
  let userMovedCamera = restoredMapView != null;
  // A fresh page must first complete the existing coverage/default opening path. Otherwise the
  // temporary pre-coverage HOME frame could be persisted and suppress that opening next visit.
  let mapViewPersistenceReady = restoredMapView != null;
  function claimMapView() {
    userMovedCamera = true;
    mapViewPersistenceReady = true;
  }
  ensureResilientTileProtocols();

  // Shared airfield symbol layout/paint. Split into per-class layers (below) so the worldwide
  // dataset (~48k) declutters by zoom: large always, medium from z5, small from z7. allow-overlap
  // is off so MapLibre thins out overlapping icons instead of drawing tens of thousands at once.
  const afLayout = {
    "icon-image": ["case", ["get", "minor"], "af-minor", ["match", ["get", "kind"], "large", "af-large", "medium", "af-medium", "af-small"]],
    "icon-size": ["case", ["get", "minor"], 0.5, ["match", ["get", "kind"], "large", 0.92, "medium", 0.76, 0.62]],
    "icon-allow-overlap": false, "icon-optional": false,
    "icon-rotation-alignment": "viewport", "icon-pitch-alignment": "viewport",
    "text-field": ["case", ["get", "minor"], "", ["get", "code"]],
    "text-font": MAP_FONT_STACK, "text-size": ["match", ["get", "kind"], "large", 12, 11],
    "text-letter-spacing": 0.08, "text-offset": [0, 1.15], "text-anchor": "top", "text-optional": true,
    "text-rotation-alignment": "viewport", "text-pitch-alignment": "viewport", "text-keep-upright": true,
  };
  const afPaint = { "text-color": "#8ff0e4", "text-halo-color": "#04211f", "text-halo-width": 1.7, "text-halo-blur": 0.6 };

  // --- MapLibre map. Satellite imagery is the sole basemap; terrain relief comes from the
  // DEM beneath it. ------------------------------------------------------------------------
  const map = new maplibregl.Map({
    container,
    // Disabled at the operator's request. No source carries an attribution string either, so
    // restoring the control means reinstating provider credits alongside it.
    attributionControl: false,
    bearingSnap: 0, // never auto-snap the bearing to north (camera moves were rotating it unbidden)
    // Operational airfields and geographic place labels must not randomly evict one another from
    // the shared collision grid. Each source still declutters internally.
    crossSourceCollisions: false,
    // MapLibre treats fadeDuration:0 as "force full symbol placement every render". Keep its
    // retained/incremental placement alive; the raster layer's own fade duration below is still 0,
    // so complete imagery tiles continue to swap immediately without exposing parent/child seams.
    fadeDuration: SYMBOL_PLACEMENT_FADE_MS,
    // v6 defaults this to 4, which changes dense-label placement and queryRenderedFeatures.
    // Preserve the v5 visual/picking contract for this engine-only migration.
    zoomLevelsToOverscale: undefined,
    // A moving pitched view can briefly expose the vertical skirts that MapLibre extrudes down
    // from terrain-tile edges while an adjacent DEM tile is loading. They appear as jagged walls
    // and disappear when panning stops. The opaque background layer below catches any hairline
    // stitch that disabling those walls may reveal.
    terrainSkirtLength: "none",
    maxPitch: 150, // globe projection allows pitch > 90° — tilt past vertical for a bottom (look-up) view.
    // Do NOT clamp the map centre's elevation to terrain. setTerrain still seeds one DEM elevation
    // once (cleared after style load below), but subsequent renders must leave our explicit 3D orbit
    // elevation alone. This also avoids recalculateZoomAndCenter fly-aways at very high pitch.
    centerClampedToGround: false,
    pitch: 55,
    zoom: restoredMapView?.zoom ?? 8,
    center: restoredMapView
      ? [restoredMapView.lon, restoredMapView.lat]
      : [HOME.lon, HOME.lat],
    style: {
      version: 8,
      // Globe projection so the camera can tilt past vertical (pitch > 90°) for a bottom view.
      projection: { type: "globe" },
      // No glyphs endpoint: MapLibre builds SDF glyphs from the browser's system sans-serif stack.
      sources: {
        // z19 (~0.3 m/px) is where real imagery actually stops across Korea, Japan and most of
        // Europe; only a handful of US cities and Zurich carry z20+. Esri answers a missing tile
        // with HTTP 200 and a 2521-byte placeholder rather than a 404, so asking for z20 spends a
        // wasted round trip per tile before the protocol falls back to the z19 parent anyway.
        // Capping here lets MapLibre overzoom past z19 for free, producing the identical image.
        satellite: { type: "raster", tiles: SAT_TILES, tileSize: 256, maxzoom: 19, attribution: SATELLITE_CREDIT.html },
        dem: { type: "raster-dem", tiles: MAPTERHORN_TILES, encoding: "terrarium", tileSize: 512, maxzoom: 12, attribution: TERRAIN_CREDIT.html },
        ...(referenceLabelsEnabled
          ? { [MAP_REFERENCE_SOURCE_ID]: createMapReferenceSource() }
          : {}),
        airfields: { type: "geojson", data: EMPTY_FC },
        rings: { type: "geojson", data: EMPTY_FC },
      },
      layers: [
        { id: "bg", type: "background", paint: { "background-color": "#050a0c" } },
        { id: "sat", type: "raster", source: "satellite", paint: { "raster-saturation": -0.2, "raster-brightness-max": 0.9, "raster-contrast": 0.04, "raster-fade-duration": 0 } },
        // Geographic reference only: administrative boundaries and place names sit below every
        // operational overlay. Roads, buildings, POIs and OpenFreeMap's basemap styling stay out.
        ...(referenceLabelsEnabled
          ? createMapReferenceLayers({ language: referenceLanguage })
          : []),
        // Ring lines and distance labels in the cyan family; the cardinal marks stay amber so
        // N/E/S/W can never be mistaken for airfield codes. The dark casing under the line is the
        // stroke's halo (visibility over bright terrain), and the stroke itself stays SOLID — a
        // soft translucent line on top of a dark casing reads as a faint smudge.
        { id: "rings-casing", type: "line", source: "rings", filter: ["==", ["get", "kind"], "ring"], paint: { "line-color": "#03110f", "line-opacity": 0.38, "line-width": 3.2, "line-blur": 0.8 } },
        { id: "rings-line", type: "line", source: "rings", filter: ["==", ["get", "kind"], "ring"], paint: { "line-color": "#48e0d1", "line-opacity": 0.62, "line-width": 1.4, "line-blur": 0.4 } },
        // Cardinal marks render amber, bright and larger so N/E/S/W can never be mistaken for
        // airfield codes; the distance labels ride the ring cyan at a quieter weight.
        { id: "ring-label", type: "symbol", source: "rings", filter: ["in", ["get", "kind"], ["literal", ["ringlabel", "compass"]]], layout: { "text-field": ["get", "label"], "text-font": MAP_FONT_STACK, "text-size": ["case", ["==", ["get", "kind"], "compass"], 17, 11], "text-allow-overlap": true }, paint: { "text-color": ["case", ["==", ["get", "kind"], "compass"], "#f8d36c", "#7fe6da"], "text-opacity": ["case", ["==", ["get", "kind"], "compass"], 0.95, 0.65], "text-halo-color": ["case", ["==", ["get", "kind"], "compass"], "#0a0f10", "#050a0c"], "text-halo-width": ["case", ["==", ["get", "kind"], "compass"], 2.4, 1.2] } },
        // Tactical airfield: an aeronautical glyph icon (ring + crossed runways, class colour/size,
        // constant screen size) with the code below it. Split into three per-class layers so the
        // worldwide dataset declutters by zoom (large always, medium from z5, small/minor from z7)
        // and MapLibre gives placement priority to the biggest airports. Hit-testable for hover/click.
        { id: "airfield-large", type: "symbol", source: "airfields", minzoom: 0, filter: ["all", ["!", ["get", "minor"]], ["==", ["get", "kind"], "large"]], layout: { ...afLayout }, paint: { ...afPaint } },
        { id: "airfield-medium", type: "symbol", source: "airfields", minzoom: 5, filter: ["all", ["!", ["get", "minor"]], ["==", ["get", "kind"], "medium"]], layout: { ...afLayout }, paint: { ...afPaint } },
        { id: "airfield-small", type: "symbol", source: "airfields", minzoom: 7, filter: ["any", ["get", "minor"], ["==", ["get", "kind"], "small"]], layout: { ...afLayout }, paint: { ...afPaint } },
      ],
      // atmosphere-blend 0 kills MapLibre globe's bright horizon atmosphere glow (a hazy white/orange
      // glare that washed the view near-horizontal at high pitch); keep a neutral dark horizon.
      sky: { "sky-color": "#0a1a2b", "horizon-color": "#0d1618", "fog-color": "#0b1416", "sky-horizon-blend": 0.6, "horizon-fog-blend": 0.6, "atmosphere-blend": 0 },
    },
  });
  function persistMapView() {
    if (!mapViewPersistenceReady) return;
    const centre = map.getCenter();
    saveMapView({
      lon: centre.lng,
      lat: centre.lat,
      zoom: map.getZoom(),
    });
  }
  window.addEventListener("pagehide", persistMapView);
  let referenceSourceErrorLogged = false;
  let referenceSourceRetryTimer = 0;
  let referenceSourceRetryCount = 0;
  function resetReferenceSourceRetry() {
    if (referenceSourceRetryTimer) clearTimeout(referenceSourceRetryTimer);
    referenceSourceRetryTimer = 0;
    referenceSourceRetryCount = 0;
    referenceSourceErrorLogged = false;
  }
  function scheduleReferenceSourceRetry() {
    if (referenceSourceRetryTimer || disposed) return;
    const retryInMs = Math.min(
      REFERENCE_SOURCE_RETRY_MAX_MS,
      REFERENCE_SOURCE_RETRY_MIN_MS * (2 ** Math.min(referenceSourceRetryCount, 10)),
    );
    referenceSourceRetryCount++;
    referenceSourceRetryTimer = window.setTimeout(() => {
      referenceSourceRetryTimer = 0;
      const source = map.getSource(MAP_REFERENCE_SOURCE_ID);
      if (disposed
        || deps.getSettings().mapReferenceLabels === false
        || typeof source?.setUrl !== "function") return;
      try {
        source.setUrl(MAP_REFERENCE_SOURCE_URL);
      } catch (error) {
        console.warn("Administrative map reference retry failed", error);
        scheduleReferenceSourceRetry();
      }
    }, retryInMs);
  }
  map.on("error", (event) => {
    const message = String(event?.error?.message || "");
    const isReferenceError = event?.sourceId === MAP_REFERENCE_SOURCE_ID
      || message.includes("tiles.openfreemap.org");
    // Registering an error listener suppresses MapLibre's default console path, so preserve it for
    // every unrelated error.
    if (!isReferenceError) {
      console.error(event.error);
      return;
    }
    scheduleReferenceSourceRetry();
    if (!referenceSourceErrorLogged) {
      referenceSourceErrorLogged = true;
      console.warn("Administrative map reference unavailable; retrying in the background", event.error);
    }
  });
  map.on("sourcedata", (event) => {
    if (event?.sourceId === MAP_REFERENCE_SOURCE_ID && event.isSourceLoaded) {
      resetReferenceSourceRetry();
    }
  });
  // MapLibre deliberately constructs Map with a temporary MercatorTransform and replaces it with a
  // GlobeTransform while parsing the style. Installing against its initial transform here would
  // fail and, more importantly, must never abort creation of the satellite/trail/coverage layers.
  // Install after style.load, before the first terrain/camera operation.
  let globeCenterElevationInstalled = false;
  // Swapped mouse drag (per request): LEFT-drag rotates & tilts, RIGHT-drag pans. MapLibre has no
  // button-swap option in this release, so drive both by hand off the canvas mouse events.
  map.dragPan.disable();
  map.dragRotate.disable();
  map.doubleClickZoom.disable();
  // Wheel zoom is hand-driven below: cursor-anchored while free (with a horizon guard — native
  // cursor zoom can choose an absurdly distant pivot on a pitched globe), target-anchored while
  // tracking.
  map.scrollZoom.disable();
  map.touchZoomRotate.enableRotation();
  const cv = map.getCanvas();
  cv.addEventListener("contextmenu", (e) => e.preventDefault());
  // Stop the browser from starting a native image/text drag of the canvas (the "whole canvas drags
  // as a ghost image" effect) — our own handlers drive the camera.
  cv.addEventListener("dragstart", (e) => e.preventDefault());
  cv.style.userSelect = "none";
  let tacticalRepaintRaf = 0;
  let restoreMapInputEvents = null;
  const restoreViewportSymbolSize = installViewportSymbolSize(map);
  const retainedSymbolPlacement = createRetainedSymbolPlacement(map);
  const restoreTerrainSourceUpdate = installSingleTerrainSourceUpdate(map);

  // Disabling MapLibre's camera handlers does not disable its always-on public mouse/touch event
  // adapters. Those adapters eagerly construct lngLat for every pointer event; with terrain that
  // unprojection synchronously reads the depth buffer. This view owns all pointer, touch and wheel
  // input, so bypass only those public event adapters and keep MapLibre's render/camera lifecycle.
  function installRawInputEventAdapter() {
    restoreMapInputEvents?.();
    restoreMapInputEvents = null;
    const handlers = mapHandlerRegistry(map);
    const mapEvent = handlers?.mapEvent;
    const blockableMapEvent = handlers?.blockableMapEvent;
    if (!mapEvent || !blockableMapEvent) return false;
    const originals = [];
    const bypass = (handler, names) => {
      for (const name of names) {
        if (typeof handler[name] !== "function") continue;
        originals.push([handler, name, handler[name]]);
        handler[name] = () => undefined;
      }
    };
    bypass(mapEvent, [
      "wheel",
      "mousedown", "mouseup", "click", "dblclick", "mouseover", "mouseout",
      "touchstart", "touchmove", "touchend", "touchcancel",
    ]);
    bypass(blockableMapEvent, ["mousemove", "mousedown", "mouseup", "contextmenu"]);
    restoreMapInputEvents = () => {
      for (const [handler, name, original] of originals) handler[name] = original;
    };
    return true;
  }

  // A tactical-only frame still passes through MapLibre because the aircraft layer deliberately
  // shares its depth buffer with terrain. Separate its SCHEDULING and symbol-placement ownership:
  // custom-layer mutations are coalesced to the next display frame, and a clean, settled map reuses
  // the last symbol placement instead of re-running collisions for unchanged administrative and
  // airfield labels.
  function requestTacticalRepaint() {
    if (disposed || !ready || tacticalRepaintRaf) return;
    tacticalRepaintRaf = requestAnimationFrame(() => {
      tacticalRepaintRaf = 0;
      retainedSymbolPlacement.triggerTacticalRepaint();
    });
  }

  function cancelTacticalRepaint() {
    if (tacticalRepaintRaf) cancelAnimationFrame(tacticalRepaintRaf);
    tacticalRepaintRaf = 0;
    retainedSymbolPlacement.invalidate();
  }
  if (!installRawInputEventAdapter()) {
    console.warn("Skytrace raw input adapter unavailable; continuing with MapLibre pointer events");
  }
  let drag = null;
  let dragMoved = false; // set once a gesture actually drags, so the trailing map "click" is ignored
  let followActive = false; // camera tracking is explicit: only the Locate toggle may enable it
  let orbitZ = 0; // exaggerated target altitude; the camera's real 3D pivot while orbit-attached
  let orbitAttached = false; // rotate/zoom re-centre on the active aircraft or airfield pivot while attached
  let airfieldOrbit = null; // { lon, lat } fixed ground pivot created by an airfield double-click
  // A free pan (right-drag) detaches so rotate/zoom then pivot on the current view, not teleport back.
  let cameraAnimation = null;
  let freeGrounding = null; // released elevated pivot, lowered only by cursor-pinned free zoom
  let trackedAircraftClick = null;
  let lastTap = null; // previous completed touch tap, for double-tap detection

  function isRepeatedTrackedPointer(clientX, clientY, now = performance.now(), radiusPx = 16) {
    return Boolean(
      trackedAircraftClick
      && now - trackedAircraftClick.at < 700
      && Math.hypot(clientX - trackedAircraftClick.x, clientY - trackedAircraftClick.y) < radiusPx
    );
  }

  function setFollowActive(active) {
    if (followActive === active) return;
    followActive = active;
    deps.onTrackingChange?.(followActive || Boolean(airfieldOrbit));
  }

  const EASE_OUT = (t) => 1 - Math.pow(1 - t, 3);
  const EASE_IN_OUT = (t) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  const lerp = (a, b, t) => a + (b - a) * t;
  const wrapDelta = (delta) => ((delta + 540) % 360) - 180;
  function interpolateCenter(from, to, t) {
    return new maplibregl.LngLat(from.lng + wrapDelta(to.lng - from.lng) * t, lerp(from.lat, to.lat, t));
  }
  function interpolateAngle(from, to, t) { return from + wrapDelta(to - from) * t; }

  function setCameraTransform(tr, { center, zoom, bearing, pitch, elevation }) {
    if (!tr) return;
    installGlobeCenterElevation(tr);
    // Transform clones can return a structurally valid {lng, lat} from MapLibre's internal module
    // realm that is not instanceof the public maplibregl.LngLat constructor. The old array fallback
    // turned that object into (undefined, undefined) and aborted every released-tracking wheel frame.
    if (center) tr.setCenter(maplibregl.LngLat.convert(center));
    if (zoom != null) tr.setZoom(Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), zoom)));
    if (bearing != null) tr.setBearing(bearing);
    if (pitch != null) tr.setPitch(Math.max(map.getMinPitch(), Math.min(map.getMaxPitch(), pitch)));
    if (elevation != null) tr.setElevation(elevation);
  }

  let cameraSourceTimer = 0;
  let lastCameraSourceUpdateAt = -Infinity;
  let pendingCameraStyleUpdate = false;
  function runCameraSourceUpdate() {
    cameraSourceTimer = 0;
    if (disposed) return;
    const updateStyle = pendingCameraStyleUpdate;
    pendingCameraStyleUpdate = false;
    lastCameraSourceUpdateAt = performance.now();
    if (typeof map._update === "function") map._update(updateStyle);
    else map.triggerRepaint();
  }
  function requestCameraSourceUpdate(updateStyle = false, force = false) {
    pendingCameraStyleUpdate ||= updateStyle;
    if (force) {
      if (cameraSourceTimer) clearTimeout(cameraSourceTimer);
      cameraSourceTimer = 0;
      runCameraSourceUpdate();
      return;
    }
    const wait = CAMERA_SOURCE_FRAME_MS - (performance.now() - lastCameraSourceUpdateAt);
    if (wait <= 1) {
      runCameraSourceUpdate();
      return;
    }
    // Reproject the already retained source tiles at native display cadence. The pending source
    // selection runs no later than the next 60 Hz boundary, even if input stops before another rAF.
    map.triggerRepaint();
    if (!cameraSourceTimer) cameraSourceTimer = window.setTimeout(runCameraSourceUpdate, wait);
  }
  function cancelCameraSourceUpdate() {
    if (cameraSourceTimer) clearTimeout(cameraSourceTimer);
    cameraSourceTimer = 0;
    pendingCameraStyleUpdate = false;
  }

  // Direct transform updates avoid Camera._getTransformForUpdate(), whose terrain path starts from
  // a clone. Keep MapLibre's requested state synchronized as well as the rendered transform so the
  // next native operation cannot resurrect an older surface-centred camera.
  function applyCameraFrame({ center, zoom, bearing, pitch, elevation }, { forceSourceUpdate = false } = {}) {
    const tr = mapTransform(map);
    const previousZoom = tr.zoom;
    const frame = { center, zoom, bearing, pitch, elevation };
    setCameraTransform(tr, frame);
    const requested = requestedCameraTransform(map);
    if (requested && requested !== tr) {
      setCameraTransform(requested, frame);
    }
    invalidateAirfieldHitIndex();
    retainedSymbolPlacement.invalidate();
    // Matrix redraws follow the display, while source/tile selection is coalesced independently.
    // This removes throw-away source walks on high-refresh displays without capping camera motion.
    requestCameraSourceUpdate(Math.abs(tr.zoom - previousZoom) > 1e-9, forceSourceUpdate);
  }

  function cancelCameraAnimation() {
    if (northAnimation) {
      cancelAnimationFrame(northAnimation.raf);
      northAnimation = null;
    }
    if (!cameraAnimation) return;
    cancelAnimationFrame(cameraAnimation.raf);
    cameraAnimation = null;
  }

  // Open consoles cover part of the scene; padding re-defines where "centre" is so a tracked
  // target rides the middle of the VISIBLE map — the strip above a phone sheet, the span between
  // the desktop consoles — not the middle of the covered viewport. Applied straight on the
  // transforms (never via jumpTo, whose terrain path resurrects a surface-centred camera), so
  // every applyCameraFrame centre lands at the padded point. The padding itself is ANIMATED:
  // snapping it re-anchors the whole view in one frame, which read as the camera "jumping".
  let paddingAnimation = null;
  let pendingViewPadding = null;
  const PADDING_KEYS = ["top", "bottom", "left", "right"];
  function applyPaddingFrame(padding) {
    const tr = mapTransform(map);
    tr.setPadding(padding);
    invalidateAirfieldHitIndex();
    // The requested camera state appears lazily during native gestures and can be an
    // uninitialised shell: its setPadding recalculates matrices from fields that do not exist
    // yet and throws deep inside EdgeInsets. Skip it when that happens — the rendered transform
    // above is the one that matters, and every applyCameraFrame keeps re-asserting the pose.
    const rcs = requestedCameraTransform(map);
    if (rcs && rcs !== tr && typeof rcs.setPadding === "function") {
      try { rcs.setPadding(padding); } catch { /* shell transform without initialised insets */ }
    }
    if (followActive) followSelected();
    else if (orbitAttached) focusOrbitTarget(activeOrbitTarget());
    requestCameraSourceUpdate();
  }
  function setViewPadding(padding) {
    // Before style.load the transform is a half-initialised shell: a setPadding mid-init corrupts
    // it and every later matrix calculation throws. Park the request; style.load replays it.
    if (!ready) {
      pendingViewPadding = padding;
      return;
    }
    const raw = typeof padding === "number" ? { bottom: padding } : padding || {};
    const target = Object.fromEntries(PADDING_KEYS.map((key) => [key, Math.max(0, Math.round(raw[key] || 0))]));
    if (paddingAnimation) {
      cancelAnimationFrame(paddingAnimation.raf);
      paddingAnimation = null;
    }
    const current = mapTransform(map).padding || {};
    const from = Object.fromEntries(PADDING_KEYS.map((key) => [key, current[key] || 0]));
    if (PADDING_KEYS.every((key) => Math.abs(from[key] - target[key]) < 1)) {
      applyPaddingFrame(target);
      return;
    }
    const started = performance.now();
    const anim = { raf: 0 };
    paddingAnimation = anim;
    const tick = (now) => {
      if (paddingAnimation !== anim) return;
      const t = Math.min(1, (now - started) / 420);
      const k = EASE_IN_OUT(t);
      applyPaddingFrame(Object.fromEntries(PADDING_KEYS.map((key) => [key, Math.round(from[key] + (target[key] - from[key]) * k)])));
      if (t < 1) anim.raf = requestAnimationFrame(tick);
      else {
        paddingAnimation = null;
        requestCameraSourceUpdate(false, true);
      }
    };
    anim.raf = requestAnimationFrame(tick);
    // An idle map produces no frames, and rAF rides the frame clock: kick one so the animation
    // starts now instead of at the next incidental repaint.
    map.triggerRepaint();
  }

  // The compass action, staged like a real map compass: rotate back to north about the current
  // (padded) view centre first; clicked again while already north, level the view straight down.
  // Single-property frames, so an active track keeps driving the centre while the view swings;
  // any new camera action cancels it through cancelCameraAnimation.
  let northAnimation = null;
  function resetNorth() {
    const startBearing = map.getBearing();
    const startPitch = map.getPitch();
    const leveling = Math.abs(startBearing) < 0.1;
    if (leveling && startPitch < 0.1) return;
    cancelCameraAnimation();
    map.stop();
    claimMapView();
    const started = performance.now();
    const anim = { raf: 0 };
    northAnimation = anim;
    const tick = (now) => {
      if (northAnimation !== anim) return;
      const t = Math.min(1, (now - started) / 500);
      const k = EASE_IN_OUT(t);
      applyCameraFrame(leveling
        ? { pitch: startPitch * (1 - k) }
        : { bearing: interpolateAngle(startBearing, 0, k) });
      if (t < 1) anim.raf = requestAnimationFrame(tick);
      else {
        northAnimation = null;
        requestCameraSourceUpdate(false, true);
      }
    };
    anim.raf = requestAnimationFrame(tick);
    map.triggerRepaint(); // see setViewPadding: rAF rides the frame clock
  }

  function animateCamera(target, { duration = 640, easing = EASE_IN_OUT, kind = "camera", onComplete } = {}) {
    cancelCameraAnimation();
    map.stop();
    const startCenter = map.getCenter();
    const endCenter = target.center
      ? (target.center instanceof maplibregl.LngLat ? target.center : new maplibregl.LngLat(target.center[0], target.center[1]))
      : startCenter;
    const start = {
      center: startCenter,
      zoom: map.getZoom(),
      bearing: map.getBearing(),
      pitch: map.getPitch(),
      elevation: mapTransform(map).elevation || 0,
    };
    const end = {
      center: endCenter,
      zoom: target.zoom ?? start.zoom,
      bearing: target.bearing ?? start.bearing,
      pitch: target.pitch ?? start.pitch,
      elevation: target.elevation ?? start.elevation,
    };
    if (duration <= 0) {
      applyCameraFrame(end, { forceSourceUpdate: true });
      onComplete?.();
      return;
    }
    const started = performance.now();
    const animation = { raf: 0, kind, end };
    cameraAnimation = animation;
    const tick = (now) => {
      if (cameraAnimation !== animation) return;
      const raw = Math.min(1, Math.max(0, (now - started) / duration));
      const k = easing(raw);
      applyCameraFrame({
        center: interpolateCenter(start.center, end.center, k),
        zoom: lerp(start.zoom, end.zoom, k),
        bearing: interpolateAngle(start.bearing, end.bearing, k),
        pitch: lerp(start.pitch, end.pitch, k),
        elevation: lerp(start.elevation, end.elevation, k),
      });
      if (raw < 1) animation.raf = requestAnimationFrame(tick);
      else {
        cameraAnimation = null;
        applyCameraFrame(end, { forceSourceUpdate: true });
        onComplete?.();
      }
    };
    animation.raf = requestAnimationFrame(tick);
  }

  // Orbit the selected aircraft by making its lon/lat/exaggerated altitude MapLibre's actual camera
  // center. The globe matrix adapter above makes this the same physical pivot in globe and mercator.
  function focusOnSelected(sel) {
    airfieldOrbit = null;
    orbitZ = sel.z;
    applyCameraFrame({ center: [sel.lon, sel.lat], elevation: sel.z });
  }
  function activeOrbitTarget() {
    if (!orbitAttached) return null;
    if (airfieldOrbit) return { ...airfieldOrbit, z: 0 };
    const selHex = deps.getSelectedHex();
    return selHex ? lastList.find((d) => d.hex === selHex) || null : null;
  }
  function focusOrbitTarget(target) {
    if (!target) return;
    orbitZ = target.z || 0;
    applyCameraFrame({ center: [target.lon, target.lat], elevation: target.z || 0 });
  }
  function beginFreeGrounding() {
    const elevation = Math.max(0, mapTransform(map).elevation || 0);
    if (!freeGrounding && elevation >= 0.5) {
      const anchorZoom = map.getZoom();
      freeGrounding = {
        anchorElevation: elevation,
        anchorZoom,
        virtualZoom: anchorZoom,
        groundZoomLimit: anchorZoom + FREE_GROUNDING_ZOOM_SPAN,
      };
    }
  }
  function clearOrbit() {
    const hadOrbit = orbitAttached || orbitZ !== 0 || airfieldOrbit || ["track-start", "track-switch", "wheel-orbit", "airfield-orbit"].includes(cameraAnimation?.kind);
    const wasTracking = followActive || Boolean(airfieldOrbit);
    followActive = false;
    airfieldOrbit = null;
    if (wasTracking) deps.onTrackingChange?.(false);
    if (!hadOrbit) return;
    cancelCameraAnimation();
    map.stop();
    beginFreeGrounding();
    orbitAttached = false;
    orbitZ = 0;
    // Preserve the exact camera frame at release. Free zoom lowers the elevated pivot later, while
    // solving the centre on each frame so the ground point under the cursor remains fixed.
  }
  function attachOrbit(z) { freeGrounding = null; airfieldOrbit = null; orbitAttached = true; orbitZ = z; } // orbit → aircraft-centred zoom
  function startAirfieldOrbit(field) {
    if (!field) return;
    claimMapView();
    followingSelectionHex = null;
    // An airport orbit is a tracking state for the UI, but it is deliberately not an aircraft
    // follow: selecting an airport alone must not move the camera.
    followActive = false;
    freeGrounding = null;
    orbitAttached = true;
    orbitZ = 0;
    airfieldOrbit = { lon: field.lon, lat: field.lat };
    deps.onTrackingChange?.(true);
    animateCamera(
      { center: [field.lon, field.lat], elevation: 0 },
      { duration: 700, easing: EASE_OUT, kind: "airfield-orbit" },
    );
  }
  let identBlinkOn = false; // toggled by a timer while any aircraft squawks IDENT (gold body flash)
  let identBlinkTimer = 0;
  let cameraInputRaf = 0;
  let pendingCameraInput = null;
  function flushCameraInput() {
    if (cameraInputRaf) cancelAnimationFrame(cameraInputRaf);
    cameraInputRaf = 0;
    const pending = pendingCameraInput;
    pendingCameraInput = null;
    if (!pending) return;
    if (pending.kind === "pan") panCurrentCamera(pending.dx, pending.dy);
    else applyCameraFrame(pending.frame);
  }
  function scheduleCameraInput() {
    if (cameraInputRaf) return;
    cameraInputRaf = requestAnimationFrame(() => {
      cameraInputRaf = 0;
      flushCameraInput();
    });
  }
  function queueCameraFrame(frame) {
    // Gesture modes do not normally overlap. Preserve the final incremental pan if a second finger
    // changes the mode between two display frames.
    if (pendingCameraInput?.kind === "pan") flushCameraInput();
    pendingCameraInput = { kind: "frame", frame };
    scheduleCameraInput();
  }
  function queueCameraPan(dx, dy) {
    if (!dx && !dy) return;
    if (pendingCameraInput?.kind === "frame") flushCameraInput();
    if (pendingCameraInput?.kind === "pan") {
      pendingCameraInput.dx += dx;
      pendingCameraInput.dy += dy;
    } else {
      pendingCameraInput = { kind: "pan", dx, dy };
    }
    scheduleCameraInput();
  }
  function cancelCameraInput() {
    if (cameraInputRaf) cancelAnimationFrame(cameraInputRaf);
    cameraInputRaf = 0;
    pendingCameraInput = null;
  }
  const onDown = (e) => {
    // Browsers replay a touch as a mousedown; the touch layer already drives that gesture.
    if (isTouchCompatibilityEvent()) return;
    e.preventDefault(); // no native drag-image / text selection while manipulating the camera
    // The first click of a tracked-aircraft double-click has already started the normal 900 ms
    // transfer. Its second mousedown must not cancel that animation; the matching mouseup would
    // otherwise call followSelected() and snap straight to the new aircraft.
    if (e.button === 0 && isRepeatedTrackedPointer(e.clientX, e.clientY)) return;
    flushCameraInput();
    clearCanvasHoverForCamera();
    cancelCameraAnimation();
    map.stop();
    claimMapView();
    dragMoved = false;
    if (e.button === 0) drag = { mode: "rotate", x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, bearing: map.getBearing(), pitch: map.getPitch() };
    else if (e.button === 2) {
      // A free pan intentionally detaches tracking. Rotation does not: it keeps orbiting and
      // following the selected aircraft while only changing bearing/pitch.
      clearOrbit();
      drag = { mode: "pan", x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY };
    }
  };
  const onMove = (e) => {
    if (!drag) return;
    if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 3) dragMoved = true;
    if (drag.mode === "rotate") {
      const target = activeOrbitTarget();
      queueCameraFrame({
        center: target ? [target.lon, target.lat] : null,
        bearing: drag.bearing + (e.clientX - drag.x) * 0.35,
        pitch: drag.pitch - (e.clientY - drag.y) * 0.25,
        elevation: target ? target.z || 0 : mapTransform(map).elevation,
      });
      if (target) orbitZ = target.z || 0;
    } else {
      queueCameraPan(e.clientX - drag.x, e.clientY - drag.y);
      drag.x = e.clientX; drag.y = e.clientY; // pan is incremental
    }
  };
  const onUp = () => {
    const wasRotate = drag?.mode === "rotate";
    const hadDrag = Boolean(drag);
    if (hadDrag) flushCameraInput();
    drag = null;
    if (wasRotate && followActive) followSelected();
    if (hadDrag) requestCameraSourceUpdate(false, true);
  };
  cv.addEventListener("mousedown", onDown);
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
  // Pan a detached aircraft view on a clone of the CURRENT elevated transform. Globe controls use
  // angular pixel deltas directly; Mercator places the current elevated centre at the dragged pixel.
  // Neither path intersects a ray with the ground or substitutes a zero-elevation pivot.
  function panCurrentCamera(dx, dy) {
    if (!dx && !dy) return;
    const current = mapTransform(map);
    const tr = current.clone();
    installGlobeCenterElevation(tr);
    const elevation = current.elevation || 0;
    const panDelta = new maplibregl.Point(dx, dy);
    const cameraHelper = mapCameraHelper(map);
    if (cameraHelper.useGlobeControls) {
      cameraHelper.handleMapControlsPan({
        panDelta,
        zoomDelta: undefined,
        bearingDelta: undefined,
        pitchDelta: undefined,
        rollDelta: undefined,
        around: tr.centerPoint,
      }, tr, tr.center);
    } else {
      tr.setLocationAtPoint(tr.center, tr.centerPoint.add(panDelta));
    }
    tr.setElevation(elevation);
    applyCameraFrame({ center: tr.center, zoom: tr.zoom, elevation });
  }

  // Free wheel zoom anchors on the cursor. The anchor is resolved ONCE per gesture and reused
  // across chained wheel ticks — re-unprojecting mid-animation would re-pin whatever had already
  // drifted under the cursor, and at high zoom deltas that error compounds into a visible slide.
  // Whole-globe and past-horizon points have no usable ground intersection and stay centre-anchored.
  let wheelAnchor = null;
  const CURSOR_ANCHOR_MIN_ZOOM = 4;
  const ELEVATED_PIVOT_M = 2000;
  function flatZoomAnchor(point) {
    const tr = mapTransform(map);
    if ((tr.elevation || 0) > ELEVATED_PIVOT_M || tr.zoom < CURSOR_ANCHOR_MIN_ZOOM) return null;
    try {
      if (!tr.isPointOnMapSurface(point)) return null;
      const loc = tr.screenPointToLocation(point);
      if (!loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lng)) return null;
      const centre = tr.center;
      const degPerPx = 360 / (tr.worldSize || 512);
      const span = Math.max(tr.height || 0, tr.width || 0) * degPerPx;
      const dLon = Math.abs(loc.lng - centre.lng) * Math.cos((centre.lat * Math.PI) / 180);
      if (Math.hypot(dLon, loc.lat - centre.lat) > span * 2) return null;
      return { loc, point, surfaceElevation: 0, grounding: false };
    } catch {
      return null;
    }
  }
  function groundZoomAnchor(point) {
    const tr = mapTransform(map);
    if (tr.zoom < CURSOR_ANCHOR_MIN_ZOOM) return null;
    try {
      if (!tr.isPointOnMapSurface(point)) return null;
      // Map.unproject() passes MapLibre's terrain object into the transform, so this is the
      // rendered DEM hit under the cursor rather than the sea-level ray intersection. Keep its
      // exaggerated elevation too: the pin solver must project the same physical surface point
      // after the aircraft-height camera pivot starts descending.
      const loc = map.unproject(point);
      const surfaceElevation = map.queryTerrainElevation(loc);
      if (!loc
        || !Number.isFinite(loc.lat)
        || !Number.isFinite(loc.lng)
        || !Number.isFinite(surfaceElevation)) return null;
      return { loc, point, surfaceElevation, grounding: true };
    } catch {
      return null; // a half-initialised transform mid-load: centre is always safe
    }
  }
  function cursorZoomAnchor(e) {
    const rect = cv.getBoundingClientRect();
    const point = new maplibregl.Point(e.clientX - rect.left, e.clientY - rect.top);
    if (cameraAnimation?.kind === "wheel-free" && wheelAnchor
      && wheelAnchor.grounding === Boolean(freeGrounding)
      && Math.hypot(wheelAnchor.point.x - point.x, wheelAnchor.point.y - point.y) < 8) {
      return wheelAnchor;
    }
    return (wheelAnchor = freeGrounding ? groundZoomAnchor(point) : flatZoomAnchor(point));
  }

  // The pin is solved every frame after both zoom and elevation change. setLocationAtPoint() cannot
  // do this: it treats the location as if it were on the descending pivot plane rather than on the
  // ground, which is the source of the historic high-altitude camera jump.
  function animateWheelZoom(anchor, zoom, elevation, { onComplete } = {}) {
    cancelCameraAnimation();
    map.stop();
    const startZoom = map.getZoom();
    const startElevation = mapTransform(map).elevation || 0;
    const endElevation = elevation ?? startElevation;
    const started = performance.now();
    const animation = { raf: 0, kind: "wheel-free", end: { zoom, elevation: endElevation }, groundingBlocked: false };
    cameraAnimation = animation;
    const tick = (now) => {
      if (cameraAnimation !== animation) return;
      const raw = Math.min(1, Math.max(0, (now - started) / 150));
      const k = EASE_OUT(raw);
      const zk = lerp(startZoom, zoom, k);
      const ek = lerp(startElevation, endElevation, k);
      const live = mapTransform(map);
      let appliedElevation = ek;
      let probe = live.clone();
      setCameraTransform(probe, { zoom: zk, elevation: appliedElevation });
      if (!anchor.grounding) {
        probe.setLocationAtPoint(anchor.loc, anchor.point);
      } else if (animation.groundingBlocked || !pinGroundLocationAtPoint(probe, anchor)) {
        // A grazing ray can make the terrain solve singular. Keep wheel zoom responsive, but freeze
        // descent at the last valid frame rather than reverting to a vertical or cursor-plane drop.
        animation.groundingBlocked = true;
        appliedElevation = live.elevation || 0;
        const currentLoc = live.screenPointToLocation(anchor.point);
        probe = live.clone();
        setCameraTransform(probe, { zoom: zk, elevation: appliedElevation });
        probe.setLocationAtPoint(currentLoc, anchor.point);
      }
      applyCameraFrame({ center: probe.center, zoom: zk, elevation: appliedElevation });
      if (raw < 1) {
        animation.raf = requestAnimationFrame(tick);
      } else {
        cameraAnimation = null;
        requestCameraSourceUpdate(false, true);
        onComplete?.(mapTransform(map).elevation || 0);
      }
    };
    animation.raf = requestAnimationFrame(tick);
    map.triggerRepaint(); // see setViewPadding: rAF rides the frame clock
  }

  // Zoom around the aircraft while attached — the target stays pinned. Detached, the zoom anchors
  // on the mouse cursor instead, like a chart plotter; the centre is only the fallback pivot.
  const onWheel = (e) => {
    e.preventDefault();
    claimMapView();
    const step = (e.deltaMode === 1 ? e.deltaY * 0.04 : e.deltaY * 0.0018);
    const baseZoom = cameraAnimation?.kind?.startsWith("wheel") ? cameraAnimation.end.zoom : map.getZoom();
    const z = Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), baseZoom - step));
    if (orbitAttached) {
      const target = activeOrbitTarget();
      if (!target) { clearOrbit(); return; }
      orbitZ = target.z || 0;
      animateCamera({ center: [target.lon, target.lat], zoom: z, elevation: target.z || 0 }, { duration: 150, easing: EASE_OUT, kind: "wheel-orbit" });
      return;
    }
    const grounding = freeGrounding;
    const currentElevation = mapTransform(map).elevation || 0;
    const anchor = cursorZoomAnchor(e);
    if (grounding && anchor) {
      // Keep accepting zoom-in intent after MapLibre reaches maxZoom. Releasing an aircraft while
      // already at the limit must descend over several wheel steps, not attempt one impossible
      // aircraft-height-to-ground jump that leaves both zoom and elevation unchanged.
      grounding.virtualZoom = Math.max(
        grounding.anchorZoom,
        (grounding.virtualZoom ?? grounding.anchorZoom) - step,
      );
    }
    const elevation = grounding
      ? freeViewElevationForZoom({
        ...grounding,
        currentElevation,
        targetZoom: grounding.virtualZoom,
        maxZoom: grounding.groundZoomLimit,
      })
      : currentElevation;
    const finishGrounding = (actualElevation) => {
      if (actualElevation <= Math.max(0, anchor?.surfaceElevation || 0) + 0.5
        && freeGrounding === grounding) freeGrounding = null;
    };
    if (anchor) {
      // Transform.elevation is an altitude above sea level. On raised DEM, zero would put the
      // released pivot below the rendered ground and make a high-pitch cursor pin impossible.
      const surfaceElevation = Math.max(0, Number(anchor.surfaceElevation) || 0);
      const targetElevation = grounding
        ? Math.max(elevation, surfaceElevation)
        : currentElevation;
      animateWheelZoom(anchor, z, targetElevation, {
        onComplete: finishGrounding,
      });
    } else {
      // Off-surface and whole-globe cursors have no ground point to preserve. Zoom safely without
      // changing elevation; grounding resumes as soon as a valid map-surface cursor is available.
      animateCamera({
        center: map.getCenter(),
        zoom: z,
        elevation: currentElevation,
      }, { duration: 150, easing: EASE_OUT, kind: "wheel-free" });
    }
  };
  cv.addEventListener("wheel", onWheel, { passive: false });

  // --- Touch gestures ---------------------------------------------------------------------
  // MapLibre's touch handlers are disabled alongside its mouse handlers: dragPan (which owns the
  // one-finger touch pan) was already off, which left phones with no way to pan at all. The camera
  // is hand-driven here so an elevated 3D orbit pivot survives every gesture.
  //
  //   1 finger  drag   → pan (a free pan, so it detaches an orbit exactly like the mouse right-drag)
  //   2 fingers pinch  → zoom, centred on the orbit target when attached
  //   2 fingers twist  → rotate (bearing)
  //   2 fingers slide  → tilt (pitch), when both fingers travel the same way vertically
  //   tap / double tap → the same select / track / airfield-orbit actions as click / double-click
  //
  // Finger count separates pan from the two-finger gestures, and the first threshold crossed locks
  // the two-finger mode for the rest of the gesture, so a pinch can never slide into a tilt (or the
  // reverse) halfway through.
  map.touchZoomRotate.disable();
  map.touchPitch.disable();
  container.style.touchAction = "none";

  const TAP_SLOP_PX = 12; // a tap may drift this far before it becomes a pan
  const TAP_MAX_MS = 400; // longer than this is a press, not a tap
  // Finger jitter between the taps of a double-tap routinely exceeds the 16 px mouse repeat radius.
  // This MUST match the double-tap radius below: a second tap that counts as a double-tap but
  // escapes the repeat guard re-runs handleTap and toggles tracking straight back off.
  const TOUCH_REPEAT_RADIUS_PX = 36;
  const PINCH_THRESHOLD_PX = 12;
  const TWIST_THRESHOLD_DEG = 7;
  const TILT_THRESHOLD_PX = 16;
  const TILT_RATE = 0.4; // deg of pitch per pixel of parallel travel; maxPitch is 150 here, so a
  // slower rate than MapLibre's native 0.5 keeps the wide range controllable.
  const SYNTHETIC_MOUSE_MS = 700; // window in which a mouse event is a touch compatibility event

  const touchPoints = new Map(); // pointerId -> { x, y } in client coordinates, insertion-ordered
  let touchPan = null;
  let twoFinger = null;
  let touchMoved = false;
  let lastTouchAt = 0;

  // Browsers replay a touch as mousedown/mousemove/mouseup/click for compatibility. The touch layer
  // has already acted on those, so the mouse handlers must ignore them.
  function isTouchCompatibilityEvent() {
    return performance.now() - lastTouchAt < SYNTHETIC_MOUSE_MS;
  }

  function orderedTouches() {
    return [...touchPoints.values()];
  }
  function touchSpread([a, b]) {
    return Math.hypot(b.x - a.x, b.y - a.y);
  }
  function touchTwistDeg([a, b]) {
    return (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
  }

  function beginTwoFinger() {
    const points = orderedTouches();
    const twist = touchTwistDeg(points);
    twoFinger = {
      start: points.map((point) => ({ ...point })),
      spread: touchSpread(points),
      twist,
      // Zoom, bearing and pitch each engage on their own threshold and then stay engaged, so one
      // two-finger gesture drives all three at once. `base`/`camera` are captured at the moment an
      // axis engages so it never jumps, and bearing accumulates incrementally so a twist past 180°
      // keeps going instead of folding back.
      zoom: { on: false, base: 0, camera: 0, anchor: null, groundingZoom: null },
      bearing: { on: false, prev: twist, total: 0, camera: 0 },
      pitch: { on: false, base: 0, camera: 0 },
    };
  }

  function applyTwoFinger() {
    const points = orderedTouches();
    if (points.length !== 2) return;
    const spread = touchSpread(points);
    const twist = touchTwistDeg(points);
    // Tilt reads the CENTROID's vertical travel, which is the exact parallel component of the
    // gesture: a rotation moves the fingers in opposite vertical directions and a pinch moves them
    // apart, so both contribute zero to the centroid. Only a genuine two-finger slide moves it. This
    // is what lets tilt run at full strength while a twist or pinch is live — taking the smaller of
    // the two fingers' travel instead reported barely a degree of tilt during a combined gesture.
    const parallelY = (points[0].y - twoFinger.start[0].y + points[1].y - twoFinger.start[1].y) / 2;

    // Per-axis engagement, not an exclusive mode: an earlier mode lock meant horizontal rotation and
    // vertical rotation could never be combined in one gesture.
    const { zoom, bearing, pitch } = twoFinger;
    if (!zoom.on && Math.abs(spread - twoFinger.spread) > PINCH_THRESHOLD_PX) {
      zoom.on = true;
      zoom.base = spread;
      zoom.camera = map.getZoom();
      zoom.groundingZoom = freeGrounding?.virtualZoom ?? null;
      const rect = cv.getBoundingClientRect();
      const point = new maplibregl.Point(
        (points[0].x + points[1].x) / 2 - rect.left,
        (points[0].y + points[1].y) / 2 - rect.top,
      );
      zoom.anchor = freeGrounding
        ? groundZoomAnchor(point)
        : flatZoomAnchor(point);
    }
    if (!bearing.on && Math.abs(wrapDelta(twist - twoFinger.twist)) > TWIST_THRESHOLD_DEG) {
      bearing.on = true;
      bearing.prev = twist;
      bearing.total = 0;
      bearing.camera = map.getBearing();
    }
    if (!pitch.on && Math.abs(parallelY) > TILT_THRESHOLD_PX) {
      pitch.on = true;
      pitch.base = parallelY;
      pitch.camera = map.getPitch();
    }
    if (!zoom.on && !bearing.on && !pitch.on) return;
    touchMoved = true;
    claimMapView();

    // Zoom and rotation stay anchored on the active orbit pivot, matching the mouse rotate path;
    // only a pan detaches it.
    const target = activeOrbitTarget();
    const live = mapTransform(map);
    const currentElevation = live.elevation || 0;
    const frame = {
      center: target ? [target.lon, target.lat] : null,
      elevation: target ? target.z || 0 : currentElevation,
    };
    if (zoom.on) {
      frame.zoom = zoom.camera + Math.log2(spread / Math.max(1, zoom.base));
      if (!target) {
        if (freeGrounding && zoom.anchor) {
          const virtualZoom = Math.max(
            freeGrounding.anchorZoom,
            zoom.groundingZoom + frame.zoom - zoom.camera,
          );
          freeGrounding.virtualZoom = virtualZoom;
          frame.elevation = freeViewElevationForZoom({
            ...freeGrounding,
            currentElevation,
            targetZoom: virtualZoom,
            maxZoom: freeGrounding.groundZoomLimit,
          });
        }
      }
    }
    if (bearing.on) {
      // Accumulated per frame: fingers turning clockwise decrease the bearing, matching MapLibre's
      // own touch rotate.
      bearing.total += wrapDelta(twist - bearing.prev);
      bearing.prev = twist;
      frame.bearing = bearing.camera - bearing.total;
    }
    if (pitch.on) frame.pitch = pitch.camera - (parallelY - pitch.base) * TILT_RATE;
    if (zoom.on && !target) {
      if (zoom.anchor) {
        if (zoom.anchor.grounding) {
          frame.elevation = Math.max(
            frame.elevation,
            Math.max(0, zoom.anchor.surfaceElevation),
          );
        }
        let probe = live.clone();
        setCameraTransform(probe, frame);
        if (!zoom.anchor.grounding) {
          probe.setLocationAtPoint(zoom.anchor.loc, zoom.anchor.point);
          frame.center = probe.center;
        } else if (pinGroundLocationAtPoint(probe, zoom.anchor)) {
          frame.center = probe.center;
        } else {
          frame.elevation = currentElevation;
          const currentLoc = live.screenPointToLocation(zoom.anchor.point);
          probe = live.clone();
          setCameraTransform(probe, frame);
          probe.setLocationAtPoint(currentLoc, zoom.anchor.point);
          frame.center = probe.center;
        }
      } else {
        // As with a wheel past the horizon, never lower the camera without a surface point to pin.
        frame.elevation = currentElevation;
      }
    }
    if (freeGrounding && zoom.anchor?.grounding
      && frame.elevation <= Math.max(0, zoom.anchor.surfaceElevation) + 0.5) {
      freeGrounding = null;
    }
    queueCameraFrame(frame);
    if (target) orbitZ = target.z || 0;
  }

  const onTouchDown = (e) => {
    if (e.pointerType !== "touch") return;
    // Only the pin control itself is not the camera's — and only when no gesture is already running.
    // Skipping every touch that landed on a data block meant a second finger coming down on a label
    // was never tracked, so the two-finger gesture silently degraded into a one-finger pan, which
    // detaches tracking. The rest of a label is map surface as far as the camera is concerned.
    if (!touchPoints.size && e.target?.closest?.(".tt-pin, .tt-close")) {
      // Leave the browser's compatibility click alone (it drives the pin/close controls), but
      // stamp the touch time so the replayed mouseover cannot arm the hover label on a phone.
      lastTouchAt = performance.now();
      return;
    }
    // Cancels the browser's compatibility mouse events for this touch as well as any scrolling.
    e.preventDefault();
    lastTouchAt = performance.now();
    // The first tap of a tracked-aircraft double-tap has already started the 900 ms transfer
    // animation. The second tap's pointerdown must not cancel it (the mouse path carries the same
    // guard on mousedown); ignoring the pointer outright also keeps its trailing tap inert.
    if (!touchPoints.size && isRepeatedTrackedPointer(e.clientX, e.clientY, lastTouchAt, TOUCH_REPEAT_RADIUS_PX)) return;
    if (!touchPoints.size) {
      flushCameraInput();
      clearCanvasHoverForCamera();
    }
    touchPoints.set(e.pointerId, { x: e.clientX, y: e.clientY });
    cancelCameraAnimation();
    map.stop();
    if (touchPoints.size === 1) {
      touchMoved = false;
      twoFinger = null;
      touchPan = {
        x: e.clientX,
        y: e.clientY,
        sx: e.clientX,
        sy: e.clientY,
        at: performance.now(),
        // A tap that lands on a data block is a read, not a map action (see onTouchUp).
        onBlock: Boolean(e.target?.closest?.(".t3d-block")),
      };
    } else if (touchPoints.size === 2) {
      touchPan = null;
      beginTwoFinger();
    } else {
      // Three or more fingers drive nothing; the gesture resumes when the count drops back to two.
      touchPan = null;
      twoFinger = null;
      touchMoved = true;
    }
  };

  const onTouchMove = (e) => {
    if (e.pointerType !== "touch" || !touchPoints.has(e.pointerId)) return;
    touchPoints.set(e.pointerId, { x: e.clientX, y: e.clientY });
    lastTouchAt = performance.now();
    if (touchPoints.size === 1 && touchPan) {
      if (!touchMoved) {
        if (Math.hypot(e.clientX - touchPan.sx, e.clientY - touchPan.sy) <= TAP_SLOP_PX) return;
        touchMoved = true;
        claimMapView();
        clearOrbit(); // a free pan detaches tracking, exactly like the mouse right-drag
      }
      queueCameraPan(e.clientX - touchPan.x, e.clientY - touchPan.y);
      touchPan.x = e.clientX;
      touchPan.y = e.clientY;
      return;
    }
    if (touchPoints.size === 2 && twoFinger) applyTwoFinger();
  };

  const onTouchUp = (e) => {
    if (e.pointerType !== "touch" || !touchPoints.has(e.pointerId)) return;
    flushCameraInput();
    const released = touchPoints.get(e.pointerId);
    const pan = touchPan;
    touchPoints.delete(e.pointerId);
    lastTouchAt = performance.now();
    twoFinger = null;
    if (!touchPoints.size) {
      touchPan = null;
      requestCameraSourceUpdate(false, true);
      if (pan && !touchMoved && e.type === "pointerup" && performance.now() - pan.at < TAP_MAX_MS) {
        // A label body swallows the tap (its target must not deselect itself, nor select whatever
        // sits underneath) exactly like the desktop click it mirrors — gestures that start there
        // still fly the camera. The pin never reaches here: its pointerdown was left to the
        // browser, so it arrives as a compatibility click on the overlay's click handler.
        if (pan.onBlock) lastTap = null;
        else handleTouchTap(released);
      }
      return;
    }
    // Fingers remain, so a multi-finger gesture is degrading. Re-anchor on what is still down (never
    // as a tap) so lifting one finger cannot make the camera jump.
    touchMoved = true;
    if (touchPoints.size >= 2) {
      touchPan = null;
      beginTwoFinger();
      return;
    }
    const [survivor] = orderedTouches();
    touchPan = { x: survivor.x, y: survivor.y, sx: survivor.x, sy: survivor.y, at: 0 };
  };

  container.addEventListener("pointerdown", onTouchDown);
  window.addEventListener("pointermove", onTouchMove);
  window.addEventListener("pointerup", onTouchUp);
  window.addEventListener("pointercancel", onTouchUp);

  // Native touch gestures still emit `move`; reassert the active 3D pivot synchronously before the
  // next render. Our own rAF animations are excluded because they already interpolate that pivot.
  map.on("move", () => {
    invalidateAirfieldHitIndex();
    if (orbitAttached && !cameraAnimation) {
      focusOrbitTarget(activeOrbitTarget());
    }
  });
  // v6 awaits this resolver before it snapshots images for the worker request. The legacy
  // styleimagemissing event now fires too late to resolve that request and produces a warning.
  map.setMissingStyleImageResolver((id) => {
    const color = AF_ICON_COLORS[id];
    if (color && !map.hasImage(id)) map.addImage(id, makeAirfieldIcon(color), { pixelRatio: 2 });
  });
  // Aircraft are drawn by a MapLibre custom WebGL layer (NOT deck) so they follow the map's real
  // camera — rotating & tilting with the globe, incl. pitch > 90° (bottom view). buildLayers keeps
  // `aircraftRenderList` in sync; the layer just reads it each frame.
  let aircraftRenderList = [];
  let aircraftStickSegments = [];
  let aircraftTrailSegments = [];
  let aircraftOverlaySegments = [];
  let aircraftDots = [];     // stick ground feet, as {p,color,sizePx}
  let aircraftCoverage = null; // coverage dome mesh: {positions, anchor, altExagg}
  let trailRenderState = { inputs: [], altitudeExagg: null, trailWidthPx: null };
  let aircraftTrailAnchors = new Map();
  const motionTracker = createAircraftMotionTracker();
  let motionHexes = new Set();
  let motionRaf = 0;
  let aircraftRenderByHex = new Map();
  let aircraftStickByHex = new Map();
  let motionStickByHex = new Map();
  let motionTrailByHex = new Map();
  const aircraftLayer = createAircraftLayer({
    getData: () => aircraftRenderList,
    // Keep the usually huge trail array separate and identity-stable while live aircraft/sticks
    // update. aircraft-layer caches globe model positions by each group identity.
    getSegments: () => [aircraftStickSegments, aircraftTrailSegments, aircraftOverlaySegments],
    getDots: () => aircraftDots,
    getCoverage: () => aircraftCoverage,
  });
  if (typeof window !== "undefined" && window.__T3D_DEBUG) {
    window.__t3dMap = map;
    window.__t3dAircraftLayer = aircraftLayer;
    // Range-ring and coverage geometry as the layer actually receives it, so the display can be
    // asserted on rather than eyeballed.
    window.__t3dRings = () => ringsFC();
    // How many airfields the last source rebuild carried (index tier + streamed cells).
    window.__t3dAirfields = () => airfieldByKey.size;
    window.__t3dCoverage = () => (aircraftCoverage
      ? { vertices: aircraftCoverage.positions.length / 3, altExagg: aircraftCoverage.altExagg }
      : null);
    // Which mesh each contact actually resolved to (emitter-category shape axis + size-bucket fallback).
    window.__t3dMeshKinds = () => aircraftRenderList.map((d) => ({ hex: d.hex, cls: d.cls, clsMul: d.clsMul }));
    window.__t3dCameraState = () => ({
      center: map.getCenter().toArray(),
      zoom: map.getZoom(),
      bearing: map.getBearing(),
      pitch: map.getPitch(),
      elevation: mapTransform(map).elevation,
      orbitAttached,
      orbitZ,
      orbit: airfieldOrbit ? "airfield" : orbitAttached ? "aircraft" : null,
      animation: cameraAnimation?.kind || null,
      globeCenterElevationInstalled,
    });
  }

  // --- DOM overlay: data-block popovers + pins (exact old styling), airfield popover ------
  const overlayEl = document.createElement("div");
  overlayEl.className = "t3d-overlay";
  // Two airfield popovers: one PINNED by a click (stays put) and one that follows the HOVERED
  // airfield. Kept separate so hovering other airfields still shows their popover while one is pinned.
  const afPinEl = document.createElement("div");
  afPinEl.className = "t3d-tt airfield-tt";
  afPinEl.style.display = "none";
  const afHoverEl = document.createElement("div");
  afHoverEl.className = "t3d-tt airfield-tt";
  afHoverEl.style.display = "none";
  // Tactical target-lock reticle (HUD corner brackets) around the selected aircraft.
  const lockEl = document.createElement("div");
  lockEl.className = "t3d-lock";
  lockEl.style.display = "none";
  lockEl.innerHTML = '<svg viewBox="0 0 48 48" width="48" height="48" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="square"><path d="M3 15V3H15"/><path d="M33 3H45V15"/><path d="M45 33V45H33"/><path d="M15 45H3V33"/></svg>';
  const loadingEl = document.createElement("div");
  loadingEl.className = "t3d-loading";
  loadingEl.textContent = "LOADING TERRAIN…";
  container.append(overlayEl, afPinEl, afHoverEl, lockEl, loadingEl);

  const OVERLAY_MARGIN_PX = 6; // keep every overlay card this far inside the map viewport
  const ANCHOR_SLACK_PX = 24; // how far off-screen a target may sit and still show its label
  const RESERVED_GAP_PX = 4;
  let reservedCache = null;

  // Reserved chrome is ONLY the small always-on-top clusters (the condition strip and the corner
  // legend/locate cluster). The station consoles and the phone tab row are deliberately NOT
  // reserved: a label near one simply layers underneath the glass, which reads far better than
  // being shoved down the screen — and on a phone the shove landed labels on top of their own
  // aircraft. Measured once per frame, before any overlay style is written.
  function reservedRects() {
    const now = performance.now();
    if (reservedCache && now - reservedCache.at < 250) return reservedCache.rects;
    const stage = container.closest(".map-stage") || container.parentElement;
    const base = cv.getBoundingClientRect();
    const rects = [];
    for (const el of stage?.querySelectorAll(".alert-strip, .map-chrome") || []) {
      if (!el.offsetWidth || !el.offsetHeight) continue;
      const r = el.getBoundingClientRect();
      rects.push({ x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height });
    }
    reservedCache = { at: now, rects };
    return rects;
  }

  const overlapping = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

  // Placed labels live in a coarse grid, not a flat list. Testing each candidate against every label
  // already placed is O(n^2) per frame, which at the label-everything cap is millions of comparisons;
  // bucketing makes each test proportional to the handful of labels actually nearby.
  const LABEL_CELL_PX = 64;
  function makeLabelIndex() {
    const cells = new Map();
    const keys = (box) => {
      const out = [];
      const c0 = Math.floor(box.x / LABEL_CELL_PX);
      const c1 = Math.floor((box.x + box.w) / LABEL_CELL_PX);
      const r0 = Math.floor(box.y / LABEL_CELL_PX);
      const r1 = Math.floor((box.y + box.h) / LABEL_CELL_PX);
      for (let r = r0; r <= r1; r += 1) for (let c = c0; c <= c1; c += 1) out.push(`${c}:${r}`);
      return out;
    };
    return {
      hits(box) {
        for (const key of keys(box)) {
          for (const other of cells.get(key) || []) if (overlapping(box, other)) return true;
        }
        return false;
      },
      add(box) {
        for (const key of keys(box)) {
          const bucket = cells.get(key);
          if (bucket) bucket.push(box);
          else cells.set(key, [box]);
        }
      },
    };
  }

  // Find a spot for one label. Candidates sit BESIDE the target first (right then left, vertically
  // centred on it, walking outwards row by row), then directly above or below it. A side candidate
  // that does not fit inside the viewport is SKIPPED, never clamped back toward the target —
  // clamping was exactly how an edge target ended up buried under its own label. Side candidates
  // keep a horizontal gap and above/below candidates a vertical one, so no candidate can ever
  // cover the aircraft. `droppable` labels (ordinary traffic) are hidden when nothing fits; the
  // selected, hovered and pinned labels are never dropped.
  function placeLabel(p, size, gap, droppable, placed, reserved, viewW, viewH) {
    // Rows walking outwards from the vertically-centred natural spot. A handful of candidates was
    // not enough: once the chrome pushes several anchors into the same band they all collide and
    // only the first survives, which read as "labels randomly missing".
    const step = size.h + 7;
    const rowOffsets = [0, -step, step, -2 * step, 2 * step, -3 * step, 3 * step, -4 * step, 4 * step];
    const centerY = p[1] - size.h / 2;
    const candidates = [];
    for (const dy of rowOffsets) {
      const rightX = p[0] + gap;
      const leftX = p[0] - gap - size.w;
      candidates.push({ x: rightX, y: centerY + dy, fits: rightX >= OVERLAY_MARGIN_PX && rightX + size.w <= viewW - OVERLAY_MARGIN_PX });
      candidates.push({ x: leftX, y: centerY + dy, fits: leftX >= OVERLAY_MARGIN_PX && leftX + size.w <= viewW - OVERLAY_MARGIN_PX });
    }
    // Below / above the target, horizontally centred — BELOW first: on a narrow phone, where the
    // side spots rarely fit, a block hanging under the aircraft reads better than one sitting on
    // its flight path. Sliding these along x (the clamp) is safe: they are fully clear of the
    // target vertically.
    const xCentered = Math.max(OVERLAY_MARGIN_PX, Math.min(p[0] - size.w / 2, viewW - size.w - OVERLAY_MARGIN_PX));
    for (const dy of [0, step, 2 * step]) {
      const belowY = p[1] + gap + dy;
      const aboveY = p[1] - gap - size.h - dy;
      candidates.push({ x: xCentered, y: belowY, fits: belowY + size.h <= viewH - OVERLAY_MARGIN_PX, noClampY: true });
      candidates.push({ x: xCentered, y: aboveY, fits: aboveY >= OVERLAY_MARGIN_PX, noClampY: true });
    }
    let fallback = null;
    let clearOfTarget = null;
    for (const c of candidates) {
      if (!c.fits) continue;
      // Side candidates may still clamp vertically — the horizontal gap keeps them off the target.
      // Above/below candidates must not (a vertical clamp would slide them onto it).
      const rawY = c.noClampY ? c.y : Math.max(OVERLAY_MARGIN_PX, Math.min(c.y, viewH - size.h - OVERLAY_MARGIN_PX));
      // The first in-view spot clear of the target: the last resort for a never-drop label when
      // chrome or other labels block every candidate — overlapping chrome beats overlapping the
      // aircraft, and both beat invisible.
      clearOfTarget ??= { x: c.x, y: rawY, w: size.w, h: size.h };
      const y = avoidReserved(c.x, rawY, size.w, size.h, reserved, viewH);
      if (y == null) continue;
      const box = { x: c.x, y, w: size.w, h: size.h };
      if (!placed.hits(box)) return box;
      fallback ??= box;
    }
    return droppable ? null : (fallback ?? clearOfTarget);
  }

  // The offset from the target scales with zoom (the mesh grows toward its pixel cap as you zoom in)
  // and with the model's actual on-screen footprint, so the label clears the body at any range.
  function labelGap(hex) {
    const modelPixels = aircraftLayer.screenSize(aircraftRenderByHex.get(hex));
    const zoomOffset = Math.max(34, Math.min(64, (map.getZoom() - 9) * 6 + 40));
    return Math.round(Math.max(zoomOffset, modelPixels / 2 + 14));
  }

  // Slide a card vertically out of any chrome it overlaps; null means there is nowhere it fits.
  function avoidReserved(x, y, w, h, rects, viewH) {
    let next = y;
    for (let pass = 0; pass < 2; pass += 1) {
      let moved = false;
      for (const r of rects) {
        if (x + w <= r.x || x >= r.x + r.w || next + h <= r.y || next >= r.y + r.h) continue;
        const below = r.y + r.h + RESERVED_GAP_PX;
        const above = r.y - h - RESERVED_GAP_PX;
        if (below + h <= viewH - OVERLAY_MARGIN_PX) next = below;
        else if (above >= OVERLAY_MARGIN_PX) next = above;
        else return null;
        moved = true;
      }
      if (!moved) return next;
    }
    return next;
  }
  let hoverHex = null;
  let hoverAf = null;
  let activeHex = null;
  let activeClearTimer = 0;
  const blocks = new Map(); // hex -> { el, sig }

  function scheduleActive(hex) {
    clearTimeout(activeClearTimer);
    if (hex == null) activeClearTimer = setTimeout(() => { activeHex = null; syncBlocks(); }, 320);
    else { activeHex = hex; syncBlocks(); }
  }
  // Guarded against touch compatibility events: a phone replays a tap as mouseover with no
  // mouseout ever following, which armed activeHex once and left that label up forever.
  overlayEl.addEventListener("mouseover", (e) => { if (isTouchCompatibilityEvent()) return; const b = e.target.closest(".t3d-block"); if (b?.dataset.hex) scheduleActive(b.dataset.hex); });
  overlayEl.addEventListener("mouseout", (e) => { if (isTouchCompatibilityEvent()) return; const b = e.target.closest(".t3d-block"); if (b && !b.contains(e.relatedTarget)) scheduleActive(null); });
  overlayEl.addEventListener("click", (e) => {
    const pin = e.target.closest(".tt-pin");
    const pinHex = pin?.closest(".t3d-block")?.dataset.hex;
    if (pinHex) {
      e.stopPropagation();
      mutedLabels.delete(pinHex); // pinning something is asking to SEE it
      deps.togglePin(pinHex);
      buildLayers();
      syncBlocks();
      return;
    }
    // The popover's own close: dismiss just this label. A pinned target unpins (its pin means
    // "keep the label up", which this click just revoked); selection and tracking survive, and
    // selecting the target again brings the label back.
    const close = e.target.closest(".tt-close");
    const closeHex = close?.closest(".t3d-block")?.dataset.hex;
    if (closeHex) {
      e.stopPropagation();
      mutedLabels.add(closeHex);
      if (deps.getPinned().has(closeHex)) deps.togglePin(closeHex);
      buildLayers();
      syncBlocks();
    }
  });
  overlayEl.addEventListener("wheel", (e) => {
    e.preventDefault();
    cv.dispatchEvent(new WheelEvent("wheel", {
      deltaY: e.deltaY,
      deltaX: e.deltaX,
      deltaMode: e.deltaMode,
      clientX: e.clientX,
      clientY: e.clientY,
      cancelable: true,
    }));
  }, { passive: false });
  // A data block is map surface for the mouse as well: a drag that starts on a label rotates or
  // pans the camera (onMove/onUp already listen on window), matching the touch path. Only the pin
  // is the label's own control. Plain clicks stay swallowed by the label — a click on a reading
  // surface must not act on whatever sits underneath it. Without this, a sky full of pinned
  // labels turns into mouse-dead camera area.
  overlayEl.addEventListener("mousedown", (e) => { if (!e.target?.closest?.(".tt-pin")) onDown(e); });
  overlayEl.addEventListener("contextmenu", (e) => e.preventDefault());

  // --- Derived render data ----------------------------------------------------------------
  function aircraftList() {
    const out = [];
    for (const item of deps.getAircraft()) {
      if (item.lat == null || item.lon == null) continue;
      if (!deps.passesFilters(item)) continue;
      if (deps.isDropped(item)) continue;
      const altFt = item.altBaro ?? item.altGeom;
      const airborne = !item.onGround && altFt != null;
      const altM = airborne ? altFt * FT_TO_M : 0;
      const rgb = parseRgb(deps.altitudeColor(item));
      let phi = 0;
      if (airborne) {
        const vs = item.baroRate ?? item.geomRate;
        const gs = (item.gs ?? 0) * 0.514444;
        if (vs != null && gs > 5) phi = (Math.atan2(vs * 0.00508, gs) * pitchExagg * 180) / Math.PI;
        phi = Math.max(-40, Math.min(40, phi));
      }
      const reportedBank = airborne && Number.isFinite(item.roll)
        ? Math.max(-45, Math.min(45, item.roll))
        : 0;
      const bank = Math.max(-75, Math.min(75, reportedBank * rollExagg));
      const track = Number.isFinite(item.track) ? item.track : 0;
      const cls = deps.planeSizeScale(item.category); // 0.85 light · 1 · 1.18 heavy
      // Shape axis, independent of the size axis above: a dedicated mesh key for the categories that
      // have one (A6/A7/B1–B4/B6/B7/C1/C2), null for everything else so it falls back to the size bucket.
      const meshKind = deps.planeMeshKind ? deps.planeMeshKind(item.category) : null;
      // The model is right-handed: +X nose, +Y left wing, +Z up. Positive Rx raises the left wing
      // and lowers the physical right wing (-Y), matching positive ADS-B bank. Pitch still needs
      // negation because positive Ry sends the nose towards -Z.
      const z = altM * altitudeExagg;
      const motion = {
        lon: item.lon,
        lat: item.lat,
        z,
        gs: item.gs,
        track: Number.isFinite(item.track) ? item.track : null,
        trackRate: item.trackRate,
        roll: bank,
        pitch: phi,
        verticalSpeed: airborne ? (item.baroRate ?? item.geomRate ?? 0) * 0.00508 * altitudeExagg : 0,
        onGround: !airborne,
        // The clock-driven dataPass runs every second. Only a genuinely new receiver sample may
        // reset the extrapolation clock or start a correction toward a new observed position.
        key: [item.positionAt, item.observedAt, item.lon, item.lat, z, item.gs, item.track, item.trackRate, bank, item.baroRate, item.geomRate].join("|"),
      };
      const coasting = deps.isCoasting(item);
      out.push({
        hex: item.hex,
        lon: item.lon,
        lat: item.lat,
        z,
        airborne,
        rgb,
        cls,
        meshKind,
        orientation: [-phi, 90 - track, bank],
        motion,
        coasting,
        coastOpacity: coasting ? deps.coastOpacity?.(item) ?? 0.42 : 1,
        spi: !!item.spi,
        item,
      });
    }
    return out;
  }

  function applyMotionState(target, state) {
    if (!state) return;
    target.lon = state.lon;
    target.lat = state.lat;
    target.z = state.z;
    target.orientation = [-state.pitch, 90 - state.track, state.roll];
  }

  // --- deck layers ------------------------------------------------------------------------
  let lastList = [];
  function buildLayers() {
    if (!ready) return;
    syncSiteReference();
    const list = aircraftList();
    const selHex = deps.getSelectedHex();
    const requestedMotion = new Set(deps.getPinned());
    if (selHex) requestedMotion.add(selHex);
    motionHexes = new Set(list.filter((d) => requestedMotion.has(d.hex)).map((d) => d.hex));
    motionTracker.retain(motionHexes);
    const motionNow = performance.now();
    for (const d of list) {
      if (!motionHexes.has(d.hex)) continue;
      applyMotionState(d, motionTracker.observe(d.hex, d.motion, motionNow));
    }
    lastList = list;
    // IDENT (SPI): flash the whole body gold. Run a blink toggle only while some aircraft squawks
    // ident (rare/brief); each toggle rebuilds so the aircraft getColor re-evaluates.
    const hasIdent = list.some((d) => d.spi);
    if (hasIdent && !identBlinkTimer) identBlinkTimer = setInterval(() => { identBlinkOn = !identBlinkOn; buildLayers(); }, 480);
    else if (!hasIdent && identBlinkTimer) { clearInterval(identBlinkTimer); identBlinkTimer = 0; identBlinkOn = false; }
    // Proximity/collision alert: draw a red tip-to-tip link at altitude and redden both aircraft.
    const conflicts = deps.getConflicts?.() || [];
    const conflictHexes = new Set();
    for (const p of conflicts) { conflictHexes.add(p.a.hex); conflictHexes.add(p.b.hex); }
    const conflictLines = conflicts.map((p) => ({
      source: [p.a.lon, p.a.lat, ((p.a.altBaro ?? p.a.altGeom) || 0) * FT_TO_M * altitudeExagg],
      target: [p.b.lon, p.b.lat, ((p.b.altBaro ?? p.b.altGeom) || 0) * FT_TO_M * altitudeExagg],
    }));

    const sticks = list.filter((d) => d.airborne).map((d) => ({
      hex: d.hex,
      source: [d.lon, d.lat, d.z],
      target: [d.lon, d.lat, 0],
      color: [d.rgb.r, d.rgb.g, d.rgb.b, Math.round(200 * d.coastOpacity)],
      mutable: d.coasting,
    }));

    const trailInputs = [];
    const seen = new Set();
    const selTrack = deps.getSelectedTrack();
    // The selected track is already reduced to either the current run or this aircraft's
    // explicitly enabled historic range by App.vue. Do not apply a global trail mode here.
    if (selHex && selTrack.length) {
      trailInputs.push({ hex: selHex, points: selTrack, historic: true });
      seen.add(selHex);
    }
    for (const { hex, points, historic } of deps.getPinnedTracks()) {
      if (!seen.has(hex) && points?.length) {
        seen.add(hex);
        trailInputs.push({ hex, points, historic });
      }
    }

    const sameTrailInputs = trailRenderState.altitudeExagg === altitudeExagg
      && trailRenderState.trailWidthPx === trailWidthPx
      && trailRenderState.inputs.length === trailInputs.length
      && trailInputs.every((input, index) => {
        const previous = trailRenderState.inputs[index];
        return previous?.hex === input.hex
          && previous.points === input.points
          && previous.historic === input.historic;
      });
    if (!sameTrailInputs) {
      const trails = [];
      const trailAnchors = new Map();
      const addTrail = (hex, allPoints, historic = false) => {
        const cacheKey = `${historic ? 1 : 0}:${altitudeExagg}`;
        let variants = trailGeometryCache.get(allPoints);
        const cached = variants?.get(cacheKey);
        if (cached) {
          trails.push(...cached.runs);
          if (cached.anchor) trailAnchors.set(hex, cached.anchor);
          return;
        }
        const pts = historic ? allPoints : currentTrackRun(allPoints);
        const runs = [];
        let run = null;
        let runColor = null;
        let prevT = null;
        let lastAlt = 0;
        for (const p of pts) {
          if (p.lat == null || p.lon == null) continue;
          const t = Date.parse(p.positionAt);
          const gap = run && Number.isFinite(t) && Number.isFinite(prevT) && t - prevT > 600000;
          const altFt = p.altBaro ?? p.altGeom;
          const altM = altFt != null ? altFt * FT_TO_M : lastAlt;
          lastAlt = altM;
          const c = parseRgb(deps.trackSegmentColor(p));
          const col = [c.r, c.g, c.b];
          const pt = [p.lon, p.lat, altM * altitudeExagg];
          trailAnchors.set(hex, { point: pt, color: col });
          if (!run || gap || (runColor && (col[0] !== runColor[0] || col[1] !== runColor[1] || col[2] !== runColor[2]))) {
            if (run && run.path.length >= 2) runs.push(run);
            const start = !gap && run && run.path.length ? [run.path[run.path.length - 1]] : [];
            run = { path: [...start, pt], color: col };
            runColor = col;
          } else run.path.push(pt);
          prevT = t;
        }
        if (run && run.path.length >= 2) runs.push(run);
        trails.push(...runs);
        variants ||= new Map();
        variants.set(cacheKey, { runs, anchor: trailAnchors.get(hex) || null });
        trailGeometryCache.set(allPoints, variants);
      };
      for (const input of trailInputs) addTrail(input.hex, input.points, input.historic);
      aircraftTrailSegments = [];
      for (const trail of trails) {
        for (let i = 0; i + 1 < trail.path.length; i += 1) {
          aircraftTrailSegments.push({
            a: trail.path[i],
            b: trail.path[i + 1],
            color: [trail.color[0], trail.color[1], trail.color[2], 255],
            widthPx: trailWidthPx,
          });
        }
      }
      aircraftTrailAnchors = trailAnchors;
      trailRenderState = { inputs: trailInputs, altitudeExagg, trailWidthPx };
    }
    const trailAnchors = aircraftTrailAnchors;

    const ghost = deps.getPlaybackGhost();
    const ghostData = ghost && ghost.lat != null ? [{ lon: ghost.lon, lat: ghost.lat, z: ((ghost.altBaro ?? ghost.altGeom) || 0) * FT_TO_M * altitudeExagg, rgb: parseRgb(deps.altitudeColor(ghost)), orientation: [0, 90 - (Number.isFinite(ghost.track) ? ghost.track : 0), 0] }] : [];

    const covMesh = coverageMesh();
    // Aircraft grouped by size class so per-category size differences survive the pixel clamp
    // (constant on-screen size per class). One solid model per target in its TRUE altitude colour,
    // with a whole-volume self-glow — all drawn by the custom WebGL layer, no extra geometry.
    // Aircraft render list for the MapLibre custom WebGL layer (drawn with the map's real camera,
    // so it rotates/tilts with the globe incl. pitch > 90°). Colour resolves exactly as the old deck
    // getColor did: IDENT gold flash > conflict pink > true altitude colour. Coasting targets
    // desaturate and fade progressively together with their altitude projection.
    aircraftRenderList = list.map((d) => {
      const gold = d.spi && identBlinkOn;
      const conflict = conflictHexes.has(d.hex);
      // Dedicated per-category mesh when the emitter category has one, otherwise the size bucket.
      const cls = d.meshKind || (d.cls < 0.95 ? "small" : d.cls < 1.1 ? "medium" : "large");
      const [baseR, baseG, baseB] = gold ? [255, 215, 0] : conflict ? [251, 113, 133] : [d.rgb.r, d.rgb.g, d.rgb.b];
      const luma = Math.round(baseR * 0.299 + baseG * 0.587 + baseB * 0.114);
      const desaturate = d.coasting ? 0.52 : 0;
      const r = Math.round(baseR * (1 - desaturate) + luma * desaturate);
      const g = Math.round(baseG * (1 - desaturate) + luma * desaturate);
      const b = Math.round(baseB * (1 - desaturate) + luma * desaturate);
      return {
        hex: d.hex,
        lon: d.lon,
        lat: d.lat,
        z: d.z,
        r,
        g,
        b,
        a: Math.round(255 * d.coastOpacity),
        pitch: d.orientation[0],
        yaw: d.orientation[1],
        roll: d.orientation[2],
        cls,
        clsMul: d.cls * iconScale,
        dynamic: motionHexes.has(d.hex) || d.coasting,
      };
    });
    aircraftRenderByHex = new Map(aircraftRenderList.map((d) => [d.hex, d]));
    // Sticks (aircraft→ground), altitude-gradient trails, and conflict links as line segments; the
    // stick ground feet as dots — all drawn by the custom layer (widths/colours match the old deck).
    const stickSegments = [];
    aircraftStickByHex = new Map();
    motionStickByHex = new Map();
    for (const s of sticks) {
      const dynamic = motionHexes.has(s.hex);
      const segment = {
        a: s.source,
        b: s.target,
        color: s.color,
        widthPx: 1.6,
        dynamic,
        mutable: s.mutable,
      };
      stickSegments.push(segment);
      aircraftStickByHex.set(s.hex, segment);
      if (dynamic) motionStickByHex.set(s.hex, segment);
    }
    // The stored trail remains authoritative. Add only one transient final segment from its latest
    // real point to the screen-space dead-reckoned target, then mutate that endpoint each frame.
    const overlaySegments = [];
    motionTrailByHex = new Map();
    for (const d of list) {
      if (!motionHexes.has(d.hex)) continue;
      const anchor = trailAnchors.get(d.hex);
      const a = anchor?.point || [d.motion.lon, d.motion.lat, d.motion.z];
      const color = anchor?.color || [d.rgb.r, d.rgb.g, d.rgb.b];
      const segment = {
        a,
        b: [d.lon, d.lat, d.z],
        color: [...color, Math.round(255 * d.coastOpacity)],
        widthPx: trailWidthPx,
        dynamic: true,
      };
      overlaySegments.push(segment);
      motionTrailByHex.set(d.hex, segment);
    }
    for (const c of conflictLines) {
      overlaySegments.push({
        a: c.source,
        b: c.target,
        color: [251, 113, 133, 235],
        widthPx: 2.6,
      });
    }
    aircraftStickSegments = stickSegments;
    aircraftOverlaySegments = overlaySegments;
    aircraftDots = sticks.map((s) => ({
      p: s.target,
      color: s.color,
      sizePx: 3,
      dynamic: motionHexes.has(s.hex),
      mutable: s.mutable,
    }));
    aircraftCoverage = covMesh ? {
      positions: covMesh.attributes.positions.value,
      normals: covMesh.attributes.normals.value,
      indices: covMesh.indices || null,
      anchor: [site().lon, site().lat],
      altExagg: altitudeExagg,
      // Dome translucency is the operator's: alpha rides alongside the cached mesh so changing it
      // never forces a mesh rebuild.
      alpha: settingExaggeration(deps.getSettings(), "coverageOpacity", 0.8, 0.3, 0),
    } : null;
    // Playback ghost (a dim, semi-transparent aircraft at the replayed position).
    for (const g of ghostData) aircraftRenderList.push({
      lon: g.lon,
      lat: g.lat,
      z: g.z,
      r: g.rgb.r,
      g: g.rgb.g,
      b: g.rgb.b,
      a: 150,
      pitch: g.orientation[0],
      yaw: g.orientation[1],
      roll: g.orientation[2],
      cls: "medium",
      clsMul: iconScale,
      dynamic: true,
    });
    if (ready) requestTacticalRepaint();
    requestMotionFrame();
    syncBlocks();
  }

  function updateFollowingCamera(target) {
    if (!followActive || !orbitAttached || airfieldOrbit || !target) return false;
    orbitZ = target.z;
    // Selection fly-in and wheel zoom own the camera timeline. Retarget their shared endpoint as
    // the aircraft advances instead of starting a competing animation on every display frame.
    if (["track-start", "track-switch", "wheel-orbit"].includes(cameraAnimation?.kind)) {
      cameraAnimation.end.center = new maplibregl.LngLat(target.lon, target.lat);
      cameraAnimation.end.elevation = target.z;
      return false;
    }
    if (!cameraAnimation) {
      focusOnSelected(target);
      return true;
    }
    return false;
  }

  function applyMotionFrame(now) {
    let animateAgain = false;
    for (const d of lastList) {
      if (!motionHexes.has(d.hex)) continue;
      const state = motionTracker.sample(d.hex, now);
      if (!state) continue;
      applyMotionState(d, state);
      const rendered = aircraftRenderByHex.get(d.hex);
      if (rendered) {
        rendered.lon = d.lon;
        rendered.lat = d.lat;
        rendered.z = d.z;
        rendered.pitch = d.orientation[0];
        rendered.yaw = d.orientation[1];
        rendered.roll = d.orientation[2];
      }
      const stick = motionStickByHex.get(d.hex);
      if (stick) {
        stick.a[0] = d.lon; stick.a[1] = d.lat; stick.a[2] = d.z;
        stick.b[0] = d.lon; stick.b[1] = d.lat;
      }
      const trail = motionTrailByHex.get(d.hex);
      if (trail) { trail.b[0] = d.lon; trail.b[1] = d.lat; trail.b[2] = d.z; }
      if (motionTracker.isAnimating(d.hex, now)) animateAgain = true;
    }
    const selectedHex = deps.getSelectedHex();
    const selected = selectedHex && lastList.find((d) => d.hex === selectedHex);
    const cameraUpdated = updateFollowingCamera(selected);
    if (!cameraUpdated && ready) requestTacticalRepaint();
    return animateAgain;
  }

  function requestMotionFrame() {
    if (motionRaf || disposed || !ready || !motionHexes.size) return;
    motionRaf = requestAnimationFrame((now) => {
      motionRaf = 0;
      if (applyMotionFrame(now)) requestMotionFrame();
    });
  }

  function cancelMotionFrame() {
    if (motionRaf) cancelAnimationFrame(motionRaf);
    motionRaf = 0;
  }

  // Solid altitude-gradient reception dome: the server sends a pre-built translucent triangle mesh
  // (area.volumeMesh, quantized-uint16 or float32 vertices). Decode it into local metre offsets from
  // HOME and compute normals so the MapLibre custom WebGL layer can draw it as a real 3D volume.
  let coverageMeshSource = null;
  let coverageHiddenKey = null;
  let cachedCoverageMesh = null;

  function decodeBase64Bytes(encoded) {
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function decodeFloat32Base64(encoded) {
    return new Float32Array(decodeBase64Bytes(encoded).buffer);
  }

  function decodeUnsignedBase64(encoded, bits) {
    const bytes = decodeBase64Bytes(encoded);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const values = bits === 16 ? new Uint16Array(bytes.byteLength / 2) : new Uint32Array(bytes.byteLength / 4);
    for (let i = 0; i < values.length; i += 1) {
      values[i] = bits === 16 ? view.getUint16(i * 2, true) : view.getUint32(i * 4, true);
    }
    return values;
  }

  function coverageMesh() {
    const settings = deps.getSettings();
    const coverage = deps.getCoverage();
    // Per-receiver visibility is part of the mesh's identity: hiding one receiver's dome must
    // rebuild the merged mesh, not serve the cached one that still contains it.
    const hidden = new Set(settings.coverageHidden || []);
    // The mesh is decoded into metre offsets from the site, so the site is part of its identity too.
    const HOME = site();
    const M_PER_DEG_LON = M_PER_DEG_LAT * Math.cos((HOME.lat * Math.PI) / 180);
    const hiddenKey = `${[...hidden].sort().join("|")}@${siteKey(HOME)}`;
    if (coverage === coverageMeshSource && hiddenKey === coverageHiddenKey) return cachedCoverageMesh;
    coverageMeshSource = coverage;
    coverageHiddenKey = hiddenKey;
    const positions = [];
    const indices = [];
    for (const area of coverage?.areas || []) {
      if (hidden.has(area.receiverName)) continue;
      const observed = area.volumeMesh;
      if (observed?.encoding === "quantized-uint16-le-base64"
        && observed.positions && observed.indices && observed.positionBounds?.length === 6
        && observed.origin?.length === 2) {
        const quantized = decodeUnsignedBase64(observed.positions, 16);
        const bounds = observed.positionBounds;
        const spans = [bounds[3] - bounds[0], bounds[4] - bounds[1], bounds[5] - bounds[2]];
        const eastOffset = (observed.origin[0] - HOME.lon) * M_PER_DEG_LON;
        const northOffset = (observed.origin[1] - HOME.lat) * M_PER_DEG_LAT;
        const vertexBase = positions.length / 3;
        for (let i = 0; i < quantized.length; i += 3) {
          positions.push(
            bounds[0] + spans[0] * quantized[i] / 65535 + eastOffset,
            bounds[1] + spans[1] * quantized[i + 1] / 65535 + northOffset,
            bounds[2] + spans[2] * quantized[i + 2] / 65535,
          );
        }
        const decodedIndices = decodeUnsignedBase64(observed.indices, observed.indexEncoding === "uint16-le-base64" ? 16 : 32);
        for (const index of decodedIndices) indices.push(vertexBase + index);
        continue;
      }
      if (observed?.encoding === "float32-le-base64" && observed.positions && observed.origin?.length === 2) {
        const decoded = decodeFloat32Base64(observed.positions);
        const eastOffset = (observed.origin[0] - HOME.lon) * M_PER_DEG_LON;
        const northOffset = (observed.origin[1] - HOME.lat) * M_PER_DEG_LAT;
        for (let i = 0; i < decoded.length; i += 3) {
          positions.push(decoded[i] + eastOffset, decoded[i + 1] + northOffset, decoded[i + 2]);
        }
        continue;
      }
    }
    if (!positions.length) {
      cachedCoverageMesh = null;
      return null;
    }
    const positionArray = new Float32Array(positions);
    const indexArray = indices.length
      ? (positions.length / 3 <= 65535 ? Uint16Array.from(indices) : Uint32Array.from(indices))
      : null;
    const normals = new Float32Array(positionArray.length);
    const addNormal = (ia, ib, ic) => {
      const ax = positionArray[ia * 3]; const ay = positionArray[ia * 3 + 1]; const az = positionArray[ia * 3 + 2] * altitudeExagg;
      const bx = positionArray[ib * 3]; const by = positionArray[ib * 3 + 1]; const bz = positionArray[ib * 3 + 2] * altitudeExagg;
      const cx = positionArray[ic * 3]; const cy = positionArray[ic * 3 + 1]; const cz = positionArray[ic * 3 + 2] * altitudeExagg;
      const abx = bx - ax; const aby = by - ay; const abz = bz - az;
      const acx = cx - ax; const acy = cy - ay; const acz = cz - az;
      const nx = aby * acz - abz * acy;
      const ny = abz * acx - abx * acz;
      const nz = abx * acy - aby * acx;
      normals[ia * 3] += nx; normals[ia * 3 + 1] += ny; normals[ia * 3 + 2] += nz;
      normals[ib * 3] += nx; normals[ib * 3 + 1] += ny; normals[ib * 3 + 2] += nz;
      normals[ic * 3] += nx; normals[ic * 3 + 1] += ny; normals[ic * 3 + 2] += nz;
    };
    if (indexArray) {
      for (let i = 0; i < indexArray.length; i += 3) addNormal(indexArray[i], indexArray[i + 1], indexArray[i + 2]);
    } else {
      for (let i = 0; i < positionArray.length / 3; i += 3) addNormal(i, i + 1, i + 2);
    }
    for (let i = 0; i < normals.length; i += 3) {
      const length = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
      normals[i] /= length; normals[i + 1] /= length; normals[i + 2] /= length;
    }
    cachedCoverageMesh = {
      attributes: {
        positions: { value: positionArray, size: 3 },
        normals: { value: normals, size: 3 },
      },
      indices: indexArray,
    };
    return cachedCoverageMesh;
  }

  // --- HTML data blocks (pinned / selected / hovered) — positioned with the SAME map matrix the
  // custom aircraft layer draws with, so they track the aircraft in globe (rotate/tilt/pitch>90).
  // The old deck-viewport project froze in globe. Returns null when behind the camera (cw<=0).
  function project(lon, lat, z) {
    const p = aircraftLayer.project(lon, lat, z);
    return p && Number.isFinite(p[0]) && p[2] > 0 ? p : null;
  }
  // A data block belongs to the pinned / selected / hovered target. The cap is a DOM guard so an
  // absurd pinned set cannot stall the frame; past it the first N labels in declutter order
  // survive rather than every label vanishing at once.
  const LABEL_ALL_LIMIT = 400;
  // Labels dismissed by their own popover close; a NEW selection of that target lifts the mute.
  const mutedLabels = new Set();
  let mutedLastSelHex = null;
  function syncBlocks() {
    if (!ready) return;
    const reserved = reservedRects();
    const pinned = deps.getPinned();
    const selHex = deps.getSelectedHex();
    if (selHex !== mutedLastSelHex) {
      mutedLastSelHex = selHex;
      if (selHex) mutedLabels.delete(selHex);
    }
    const viewW = cv.clientWidth;
    const viewH = cv.clientHeight;
    // Declutter order. The target the operator asked about is placed first and is never dropped;
    // everything else is placed in a stable hex order, so the surviving label set does not reshuffle
    // frame to frame (a flickering label set is worse than a sparse one).
    const candidates = lastList
      .filter((d) => !mutedLabels.has(d.hex) && (pinned.has(d.hex) || d.hex === selHex || d.hex === activeHex))
      .map((d) => ({
        d,
        rank: d.hex === selHex ? 0 : d.hex === activeHex ? 1 : pinned.has(d.hex) ? 2 : 3,
      }))
      .sort((a, b) => a.rank - b.rank || (a.d.hex < b.d.hex ? -1 : 1))
      .slice(0, LABEL_ALL_LIMIT);
    const placed = makeLabelIndex();
    const shown = new Set();
    for (const { d, rank } of candidates) {
      shown.add(d.hex);
      let b = blocks.get(d.hex);
      if (!b) {
        const el = document.createElement("div");
        el.className = "t3d-marker";
        const block = document.createElement("span");
        block.className = "t3d-block";
        block.dataset.hex = d.hex;
        el.appendChild(block);
        overlayEl.appendChild(el);
        b = { el, block, sig: "", size: null };
        blocks.set(d.hex, b);
      }
      const sig = deps.datablockHtml(d.item);
      // The measured size is cached with the content: syncBlocks runs every rendered frame, and
      // reading offsetWidth after writing styles would thrash layout on every one of them.
      if (b.sig !== sig) { b.block.innerHTML = sig; b.sig = sig; b.size = null; }
      b.block.classList.toggle("selected", d.hex === selHex);
      const p = project(d.lon, d.lat, d.z);
      // A target off the side of the viewport takes its label with it, rather than leaving it pinned
      // to an edge with nothing to point at.
      if (!p || p[0] < -ANCHOR_SLACK_PX || p[1] < -ANCHOR_SLACK_PX
        || p[0] > viewW + ANCHOR_SLACK_PX || p[1] > viewH + ANCHOR_SLACK_PX) {
        b.el.style.display = "none";
        continue;
      }
      b.el.style.display = "";
      b.el.style.transform = `translate3d(${p[0].toFixed(1)}px, ${p[1].toFixed(1)}px, 0)`;
      if (!b.size) b.size = { w: b.block.offsetWidth || 180, h: b.block.offsetHeight || 44 };
      const box = placeLabel(p, b.size, labelGap(d.hex), rank === 3, placed, reserved, viewW, viewH);
      if (!box) { b.el.style.display = "none"; continue; }
      placed.add(box);
      b.block.style.left = `${Math.round(box.x - p[0])}px`;
      b.block.style.top = `${Math.round(box.y - p[1])}px`;
    }
    for (const [hex, b] of blocks) if (!shown.has(hex)) { b.el.remove(); blocks.delete(hex); }
    // Position the tactical target-lock on the selected aircraft.
    const sel = selHex && lastList.find((d) => d.hex === selHex);
    const lp = sel && project(sel.lon, sel.lat, sel.z);
    if (lp) {
      const modelPixels = aircraftLayer.screenSize(aircraftRenderByHex.get(selHex)) || 48;
      const lockPixels = Math.round(Math.max(62, Math.min(156, modelPixels + 14)));
      const lockSvg = lockEl.firstElementChild;
      if (lockSvg && lockSvg.getAttribute("width") !== String(lockPixels)) {
        lockSvg.setAttribute("width", String(lockPixels));
        lockSvg.setAttribute("height", String(lockPixels));
      }
      lockEl.style.display = "";
      lockEl.style.transform = `translate3d(${lp[0].toFixed(1)}px, ${lp[1].toFixed(1)}px, 0) translate(-50%, -50%)`;
    }
    else lockEl.style.display = "none";
  }

  // --- Interaction ------------------------------------------------------------------------
  // Pick the nearest aircraft to a screen point using the SAME globe-correct projection the models
  // are drawn with (deck's pickObject froze in globe). ~40px tolerance, like the old invisible disc.
  function pickAircraftAt(x, y, radius = 40) {
    let best = null;
    let bestD = radius;
    for (const d of lastList) {
      const p = project(d.lon, d.lat, d.z);
      if (!p) continue;
      const dist = Math.hypot(p[0] - x, p[1] - y);
      if (dist < bestD) { bestD = dist; best = d; }
    }
    return best;
  }
  const airfieldByKey = new Map();
  // Airfields use the same projected-screen hit testing as aircraft.  MapLibre's symbol-event
  // hit boxes are tied to its placement/collision result and can become unreliable at steep
  // pitches, even while the icon or label is plainly visible.  The geographic grid keeps the
  // projection work local to the viewport rather than walking the worldwide data set per hover.
  const AIRFIELD_GRID_DEGREES = 4;
  const AIRFIELD_GRID_COLUMNS = 360 / AIRFIELD_GRID_DEGREES;
  const AIRFIELD_HIT_CELL_PIXELS = 64;
  const airfieldHitGrid = new Map();
  let airfieldHitCells = new Map();
  let airfieldHitDirty = true;
  let airfieldHitReady = false;
  let airfieldHitBuiltAt = -Infinity;
  let afPinned = null; // airfield popover pinned by a click; stays until a click elsewhere

  function airfieldGridKey(latCell, lonCell) { return `${latCell}:${(lonCell % AIRFIELD_GRID_COLUMNS + AIRFIELD_GRID_COLUMNS) % AIRFIELD_GRID_COLUMNS}`; }
  function airfieldGridCell(field) {
    return {
      lat: Math.max(0, Math.min(44, Math.floor((field.lat + 90) / AIRFIELD_GRID_DEGREES))),
      lon: Math.floor((field.lon + 180) / AIRFIELD_GRID_DEGREES),
    };
  }
  function invalidateAirfieldHitIndex({ drop = false } = {}) {
    airfieldHitDirty = true;
    if (!drop) return;
    airfieldHitCells = new Map();
    airfieldHitReady = false;
  }
  function airfieldVisibleAtZoom(field, zoom) {
    const minor = isMinorAirfield(field);
    if (minor || field.kind === "small") return zoom >= 7;
    if (field.kind === "medium") return zoom >= 5;
    return true;
  }
  function addAirfieldHitEntry(entry) {
    const minX = Math.floor((entry.x - entry.labelHalfWidth) / AIRFIELD_HIT_CELL_PIXELS);
    const maxX = Math.floor((entry.x + entry.labelHalfWidth) / AIRFIELD_HIT_CELL_PIXELS);
    const minY = Math.floor((entry.y - entry.iconRadius) / AIRFIELD_HIT_CELL_PIXELS);
    const maxY = Math.floor((entry.y + entry.labelBottom) / AIRFIELD_HIT_CELL_PIXELS);
    for (let row = minY; row <= maxY; row += 1) {
      for (let col = minX; col <= maxX; col += 1) {
        const key = `${col}:${row}`;
        const entries = airfieldHitCells.get(key);
        if (entries) entries.push(entry);
        else airfieldHitCells.set(key, [entry]);
      }
    }
  }
  function rebuildAirfieldHitIndex() {
    airfieldHitCells = new Map();
    airfieldHitDirty = false;
    airfieldHitReady = true;
    airfieldHitBuiltAt = performance.now();
    const bounds = map.getBounds();
    if (!bounds || !airfieldHitGrid.size) return;
    const west = bounds.getWest();
    const east = bounds.getEast() < west ? bounds.getEast() + 360 : bounds.getEast();
    const latSpan = Math.max(0.01, bounds.getNorth() - bounds.getSouth());
    const lngSpan = Math.max(0.01, east - west);
    // A tilted camera can show a little beyond the nominal ground bounds near its horizon.
    const latPad = Math.max(1, latSpan * 0.22);
    const lngPad = Math.max(2, lngSpan * 0.22);
    const latStart = Math.max(0, Math.floor((bounds.getSouth() - latPad + 90) / AIRFIELD_GRID_DEGREES));
    const latEnd = Math.min(44, Math.floor((bounds.getNorth() + latPad + 90) / AIRFIELD_GRID_DEGREES));
    const rawLonStart = Math.floor((west - lngPad + 180) / AIRFIELD_GRID_DEGREES);
    const rawLonEnd = Math.floor((east + lngPad + 180) / AIRFIELD_GRID_DEGREES);
    const allLongitudes = rawLonEnd - rawLonStart + 1 >= AIRFIELD_GRID_COLUMNS;
    const width = cv.clientWidth;
    const height = cv.clientHeight;
    const seen = new Set();
    for (let lat = latStart; lat <= latEnd; lat += 1) {
      const lonStart = allLongitudes ? 0 : rawLonStart;
      const lonEnd = allLongitudes ? AIRFIELD_GRID_COLUMNS - 1 : rawLonEnd;
      for (let lon = lonStart; lon <= lonEnd; lon += 1) {
        for (const field of airfieldHitGrid.get(airfieldGridKey(lat, lon)) || []) {
          const key = field.icao || field.code;
          if (seen.has(key) || !airfieldVisibleAtZoom(field, map.getZoom())) continue;
          seen.add(key);
          const point = map.project([field.lon, field.lat]);
          const iconRadius = field.kind === "large" ? 15 : field.kind === "medium" ? 13 : 11;
          const labelHalfWidth = Math.max(iconRadius, String(field.code || "").length * 4.6 + 7);
          const labelBottom = isMinorAirfield(field) ? iconRadius : 34;
          if (point.x < -labelHalfWidth || point.x > width + labelHalfWidth || point.y < -iconRadius || point.y > height + labelBottom) continue;
          addAirfieldHitEntry({ field, x: point.x, y: point.y, iconRadius, labelHalfWidth, labelBottom });
        }
      }
    }
  }
  function ensureAirfieldHitIndex(force = false) {
    if (!airfieldHitReady
      || (airfieldHitDirty && (force || performance.now() - airfieldHitBuiltAt >= AIRFIELD_HIT_REFRESH_MS))) {
      rebuildAirfieldHitIndex();
    }
  }
  function pickAirfieldAt(x, y, { force = false } = {}) {
    ensureAirfieldHitIndex(force);
    const entries = airfieldHitCells.get(`${Math.floor(x / AIRFIELD_HIT_CELL_PIXELS)}:${Math.floor(y / AIRFIELD_HIT_CELL_PIXELS)}`) || [];
    let best = null;
    let bestDistance = Infinity;
    for (const entry of entries) {
      const dx = x - entry.x;
      const dy = y - entry.y;
      const iconHit = Math.hypot(dx, dy) <= entry.iconRadius;
      // The MapLibre label is centered beneath its icon (text-offset [0, 1.15]).  Treat its
      // visible code as part of the same target, rather than requiring a symbol-layer hit.
      const labelHit = Math.abs(dx) <= entry.labelHalfWidth && dy >= 6 && dy <= entry.labelBottom;
      if (!iconHit && !labelHit) continue;
      const distance = iconHit ? Math.hypot(dx, dy) : Math.hypot(Math.max(0, Math.abs(dx) - entry.labelHalfWidth), Math.max(0, dy - 20));
      if (distance < bestDistance) { bestDistance = distance; best = entry.field; }
    }
    return best;
  }
  function setHoverAirfield(field) {
    if (field === hoverAf?.field) return;
    hoverAf = field ? { field } : null;
    if (!field) {
      if (!hoverHex) map.getCanvas().style.cursor = "";
      afHoverEl.style.display = "none";
      return;
    }
    map.getCanvas().style.cursor = "pointer";
    // The hover popover shows any airfield EXCEPT the one already pinned (its own popover stays up).
    if (field !== afPinned) { afHoverEl.innerHTML = deps.airfieldTooltip(field); afHoverEl.style.display = ""; positionAf(afHoverEl, field); }
    else afHoverEl.style.display = "none";
  }
  // Sits centred above the glyph, drops below it when there is no room above, and is clamped to the
  // viewport in both axes so an airfield near an edge still shows its whole card.
  function positionAf(el, field) {
    if (!field) return;
    const p = map.project([field.lon, field.lat]);
    const w = el.offsetWidth || 200;
    const h = el.offsetHeight || 80;
    const viewW = cv.clientWidth;
    const viewH = cv.clientHeight;
    let y = p.y - 12 - h;
    if (y < OVERLAY_MARGIN_PX) y = p.y + 18;
    const x = Math.max(OVERLAY_MARGIN_PX, Math.min(p.x - w / 2, viewW - w - OVERLAY_MARGIN_PX));
    y = Math.max(OVERLAY_MARGIN_PX, Math.min(y, viewH - h - OVERLAY_MARGIN_PX));
    const clear = avoidReserved(x, y, w, h, reservedRects(), viewH);
    el.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(clear ?? y)}px, 0)`;
  }
  function airfieldOrbitMatches(field) { return Boolean(field && airfieldOrbit && field.lon === airfieldOrbit.lon && field.lat === airfieldOrbit.lat); }
  function showPinned(field) {
    // Changing selected airports ends an existing airport track without changing the camera.
    if (airfieldOrbit && !airfieldOrbitMatches(field)) clearOrbit();
    const changed = afPinned !== field;
    afPinned = field;
    afPinEl.innerHTML = deps.airfieldTooltip(field);
    afPinEl.style.display = "";
    positionAf(afPinEl, field);
    if (hoverAf?.field === field) afHoverEl.style.display = "none";
    if (changed) deps.onAirfieldSelection?.(field);
  }
  function clearPinned({ releaseOrbit = false } = {}) {
    const hadPinned = Boolean(afPinned);
    afPinned = null;
    afPinEl.style.display = "none";
    if (releaseOrbit && airfieldOrbit) clearOrbit();
    if (hadPinned) deps.onAirfieldSelection?.(null);
  }
  let lastBearingNotified = null;
  let lastPitchNotified = null;
  map.on("render", () => {
    if (afPinned) positionAf(afPinEl, afPinned);
    if (hoverAf?.field && hoverAf.field !== afPinned) positionAf(afHoverEl, hoverAf.field);
    syncBlocks();
    // Custom transform writes never fire MapLibre's move events, so the compass is fed from the
    // render loop instead — one callback per actual attitude change.
    const bearing = map.getBearing();
    const pitch = map.getPitch();
    if (bearing !== lastBearingNotified || pitch !== lastPitchNotified) {
      lastBearingNotified = bearing;
      lastPitchNotified = pitch;
      deps.onCameraChange?.(bearing, pitch);
    }
  });
  // Viewport-driven data wants live on a TIMER, not the render loop: MapLibre stops rendering
  // once a view is idle and its tiles are in, so a render-driven check can miss the very state
  // it is supposed to settle on (the camera stops, renders stop, the 1.2 s test never runs).
  const viewportWantsTimer = setInterval(() => {
    if (disposed || !ready) return;
    airfieldsFeed.ensureViewport(map.getBounds(), map.getZoom(), Boolean(deps.getSettings().airfields));
    // View-settle for the on-demand area feed and persisted location. The feed key is QUANTIZED
    // (~1 km, 0.1 zoom): a slow drift — a followed aircraft carrying the camera — still settles
    // between key steps, so the area keeps refreshing instead of never settling.
    const now = performance.now();
    const centre = map.getCenter();
    const key = `${centre.lng.toFixed(2)}:${centre.lat.toFixed(2)}:${map.getZoom().toFixed(1)}`;
    if (key !== viewSettleKey) {
      viewSettleKey = key;
      viewSettleAt = now;
    } else if (now - viewSettleAt > 700 && viewSettleNotified !== key) {
      viewSettleNotified = key;
      persistMapView();
      deps.onViewSettled?.(viewArea());
    }
  }, 300);
  let viewSettleKey = null;
  let viewSettleAt = 0;
  let viewSettleNotified = null;
  // The viewport as an area query: centre plus the half-diagonal in nautical miles.
  function viewArea() {
    const bounds = map.getBounds();
    const centre = map.getCenter();
    const east = bounds.getEast() < bounds.getWest() ? bounds.getEast() + 360 : bounds.getEast();
    const halfLatNm = Math.abs(bounds.getNorth() - bounds.getSouth()) / 2 * 60;
    const halfLonNm = Math.abs(east - bounds.getWest()) / 2 * 60 * Math.cos((centre.lat * Math.PI) / 180);
    return { lat: centre.lat, lon: centre.lng, radiusNm: Math.hypot(halfLatNm, halfLonNm) };
  }
  // Primary select, shared by a mouse click and a touch tap. (px, py) are canvas-relative; the
  // client point feeds the repeat-pointer guard, which is keyed on the physical screen position.
  function handleTap(px, py, clientX, clientY, tapNow = performance.now(), repeatRadiusPx = 16) {
    if (isRepeatedTrackedPointer(clientX, clientY, tapNow, repeatRadiusPx)) return;
    // Aircraft: pick synchronously off MapLibre's (immediate) click instead of deck's onClick,
    // which waits ~300ms to disambiguate single- vs double-click — that lag was the select delay.
    const hit = pickAircraftAt(px, py, 40);
    if (hit) {
      // Re-clicking the already-selected aircraft Tracks it (like a double-click) instead of
      // deselecting. Skip clearPinned so toggleTracking reads the true follow state and toggles it,
      // and arm the repeat-pointer guard so the physical second click can't undo the toggle.
      if (hit.hex === deps.getSelectedHex()) {
        // A tracked target whose popover was closed: this click REOPENS the popover instead of
        // releasing the track — only a click with the popover already up releases, as before.
        if (followActive && mutedLabels.has(hit.hex)) {
          mutedLabels.delete(hit.hex);
          syncBlocks();
          trackedAircraftClick = { x: clientX, y: clientY, at: tapNow };
          return;
        }
        deps.onTrackAircraft?.(hit.hex);
        trackedAircraftClick = { x: clientX, y: clientY, at: tapNow };
        return;
      }
      const wasFollowing = followActive;
      clearPinned({ releaseOrbit: true });
      deps.onSelect(hit.hex);
      trackedAircraftClick = wasFollowing
        ? { x: clientX, y: clientY, at: tapNow }
        : null;
      return;
    }
    trackedAircraftClick = null;
    const field = pickAirfieldAt(px, py, { force: true });
    if (field) { showPinned(field); return; } // clicking an airfield pins its popover
    if (afPinned) clearPinned({ releaseOrbit: true }); // click elsewhere clears it
    deps.onMapClick();
  }

  // Second half of a double-click / double-tap: the airport ground orbit, or Track on an aircraft.
  function handleDoubleTap(px, py) {
    // While following, the first click already selects the new aircraft and dataPass starts the
    // established smooth tracked-target transfer. Ignore the double-click action entirely: by now
    // the camera may have moved the pointer over empty space or another aircraft, so re-picking the
    // second coordinate would replace that transfer with a new camera action.
    const repeatedTrackedClick = trackedAircraftClick
      && performance.now() - trackedAircraftClick.at < 700;
    if (repeatedTrackedClick || followActive) return;
    // A visible airport glyph wins over a nearby aircraft's generous hit radius, so double-clicking
    // the airport still creates its ground orbit when traffic is passing directly overhead.
    const field = pickAirfieldAt(px, py, { force: true });
    if (field) {
      showPinned(field);
      startAirfieldOrbit(field);
      return;
    }
    const hit = pickAircraftAt(px, py, 40);
    if (hit) deps.onTrackAircraft?.(hit.hex);
  }

  // A touch tap runs the single-tap action immediately (no double-tap disambiguation delay, so
  // selecting a target on a phone is as instant as clicking one), then offers the same point to the
  // double-tap action. The second tap's own handleTap already arms trackedAircraftClick when it
  // toggles Track, which is exactly what makes handleDoubleTap a no-op there instead of undoing it.
  function handleTouchTap(point) {
    const rect = cv.getBoundingClientRect();
    const px = point.x - rect.left;
    const py = point.y - rect.top;
    const isSecondTap = lastTap
      && lastTap.at > performance.now() - 400
      && Math.hypot(point.x - lastTap.x, point.y - lastTap.y) < TOUCH_REPEAT_RADIUS_PX;
    // The repeat guard runs at the touch radius: a second tap loose enough to still count as a
    // double-tap must also be caught here, or it would re-run the Track toggle and undo itself.
    handleTap(px, py, point.x, point.y, performance.now(), TOUCH_REPEAT_RADIUS_PX);
    if (isSecondTap) {
      lastTap = null;
      handleDoubleTap(px, py);
      return;
    }
    lastTap = { x: point.x, y: point.y, at: performance.now() };
  }

  function canvasPoint(event) {
    const rect = cv.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  const onCanvasClick = (e) => {
    if (isTouchCompatibilityEvent()) return; // already handled as a tap
    const clickNow = performance.now();
    const point = canvasPoint(e);
    // Catch the second click of a rapid double-click by time + physical screen position before
    // hit-testing:
    // the first click may already have moved the aircraft away from this coordinate.
    if (isRepeatedTrackedPointer(e.clientX, e.clientY, clickNow)) return;
    if (dragMoved) { dragMoved = false; return; } // ignore the click that trails a rotate/pan drag
    if (e.detail > 1) return; // the second half of a double-click is handled below
    handleTap(point.x, point.y, e.clientX, e.clientY, clickNow);
  };
  const onCanvasDoubleClick = (e) => {
    e.preventDefault();
    if (isTouchCompatibilityEvent()) return; // touch double taps are driven by handleTouchTap
    const point = canvasPoint(e);
    handleDoubleTap(point.x, point.y);
  };
  // Aircraft and airfields share projected-screen hit testing.  Neither depends on deck or
  // MapLibre symbol mouse events, both of which can lose their hit target in globe/tilted views.
  // Read the raw DOM point: constructing MapLibre's mouse event also constructs lngLat, whose
  // terrain unprojection synchronously calls WebGL readPixels even though this handler never uses it.
  let hoverPointerRaf = 0;
  let pendingHoverPoint = null;
  function suspendCanvasHover() {
    if (hoverPointerRaf) cancelAnimationFrame(hoverPointerRaf);
    hoverPointerRaf = 0;
    pendingHoverPoint = null;
  }
  function clearCanvasHoverForCamera() {
    suspendCanvasHover();
    if (hoverHex) {
      hoverHex = null;
      deps.onHover(null);
      scheduleActive(null);
    }
    setHoverAirfield(null);
  }
  function flushCanvasHover() {
    hoverPointerRaf = 0;
    const point = pendingHoverPoint;
    pendingHoverPoint = null;
    if (!point) return;
    const hex = pickAircraftAt(point.x, point.y, 40)?.hex || null;
    if (hex !== hoverHex) { hoverHex = hex; deps.onHover(hex); scheduleActive(hex); }
    const field = hex ? null : pickAirfieldAt(point.x, point.y);
    setHoverAirfield(field);
    if (hex) cv.style.cursor = "pointer";
  }
  function scheduleCanvasHover() {
    if (hoverPointerRaf) return;
    hoverPointerRaf = requestAnimationFrame(flushCanvasHover);
  }
  const onCanvasPointerMove = (e) => {
    // A touch also replays one mousemove; acting on it would leave a phone with a stuck hover
    // popover that nothing can clear.
    if (e.pointerType === "touch" || isTouchCompatibilityEvent() || drag || touchPoints.size) {
      suspendCanvasHover();
      return;
    }
    pendingHoverPoint = canvasPoint(e);
    scheduleCanvasHover();
  };
  cv.addEventListener("click", onCanvasClick);
  cv.addEventListener("dblclick", onCanvasDoubleClick);
  cv.addEventListener("pointermove", onCanvasPointerMove, { passive: true });

  // --- Native GeoJSON sources -------------------------------------------------------------
  // The worldwide dataset streams in from the server by viewport (index tier + 10-degree cells);
  // arrivals are coalesced before one source rebuild so a burst of neighbouring cells does not
  // serialize and re-place the complete loaded set once per response.
  let airfieldSourceTimer = 0;
  let airfieldDataDirty = true;
  let cachedAirfieldSettingsKey = "";
  let cachedAirfieldFC = EMPTY_FC;
  let appliedAirfieldFC = null;
  const airfieldFeedErrorScopes = new Set();
  const airfieldsFeed = createAirfieldsFeed({
    onUpdate: () => {
      airfieldFeedErrorScopes.clear();
      airfieldDataDirty = true;
      if (!ready || airfieldSourceTimer) return;
      airfieldSourceTimer = window.setTimeout(() => {
        airfieldSourceTimer = 0;
        refreshAirfields();
      }, AIRFIELD_SOURCE_BATCH_MS);
    },
    onError: ({ error, scope, id, retryInMs }) => {
      if (airfieldFeedErrorScopes.has(scope)) return;
      airfieldFeedErrorScopes.add(scope);
      const target = id ? `${scope} ${id}` : scope;
      console.warn(`Airfield ${target} unavailable; retrying in ${retryInMs} ms`, error);
    },
  });
  function airfieldSettingsKey(settings) {
    return `${settings.airfields !== false}:${Boolean(settings.airfieldsMinor)}`;
  }
  function airfieldsFC() {
    const s = deps.getSettings();
    const settingsKey = airfieldSettingsKey(s);
    if (!airfieldDataDirty && settingsKey === cachedAirfieldSettingsKey) return cachedAirfieldFC;
    airfieldByKey.clear();
    airfieldHitGrid.clear();
    invalidateAirfieldHitIndex({ drop: true });
    cachedAirfieldSettingsKey = settingsKey;
    airfieldDataDirty = false;
    if (!s.airfields) {
      cachedAirfieldFC = EMPTY_FC;
      return cachedAirfieldFC;
    }
    const features = [];
    for (const f of airfieldsFeed.all()) {
      const minor = isMinorAirfield(f);
      if (minor && !s.airfieldsMinor) continue;
      const key = f.icao || f.code;
      airfieldByKey.set(key, f);
      const cell = airfieldGridCell(f);
      const cellKey = airfieldGridKey(cell.lat, cell.lon);
      const fields = airfieldHitGrid.get(cellKey);
      if (fields) fields.push(f);
      else airfieldHitGrid.set(cellKey, [f]);
      // icon-image/size + text pick their own per-class values from kind/minor in the style.
      features.push({ type: "Feature", properties: { key, code: f.code, minor, kind: f.kind }, geometry: { type: "Point", coordinates: [f.lon, f.lat] } });
    }
    cachedAirfieldFC = { type: "FeatureCollection", features };
    return cachedAirfieldFC;
  }
  function refreshAirfields({ force = false } = {}) {
    const source = map.getSource("airfields");
    if (!source) return;
    const next = airfieldsFC();
    if (!force && next === appliedAirfieldFC) return;
    appliedAirfieldFC = next;
    source.setData(next);
  }
  // Range rings around each receiver's dome-estimated centre — the same anchor the focus button
  // uses, never the published origin (see coverage-centre.js). Which receivers carry rings is a
  // per-receiver toggle next to the dome toggle; only the ring geometry (spacing, count, unit,
  // cardinals) lives in Settings.
  function ringsFC() {
    const s = deps.getSettings();
    const hidden = new Set(s.ringsHidden || []);
    const centres = [];
    for (const area of deps.getCoverage()?.areas || []) {
      if (hidden.has(area.receiverName)) continue;
      const centre = domeCentre(area.volumeMesh);
      if (centre) centres.push(centre);
    }
    if (!centres.length) return EMPTY_FC;
    const unit = DISTANCE_UNIT_LABELS[s.ringUnit] ? s.ringUnit : "nm";
    const unitLabel = DISTANCE_UNIT_LABELS[unit];
    const spacing = Math.max(5, Math.min(1000, Number(s.ringSpacing) || 100));
    const count = Math.max(1, Math.min(8, Math.round(Number(s.ringCount) || 3)));
    const feats = [];
    for (const centre of centres) {
      const cosLat = Math.cos((centre.lat * Math.PI) / 180) || 1;
      const ringOffsets = (distance) => {
        const dLat = (distance * DISTANCE_UNIT_TO_KM[unit]) / 111.32;
        return { dLat, dLon: dLat / cosLat };
      };
      for (let ring = 1; ring <= count; ring += 1) {
        const distance = spacing * ring;
        const { dLat, dLon } = ringOffsets(distance);
        const coords = [];
        for (let i = 0; i <= 72; i += 1) { const a = (i / 72) * Math.PI * 2; coords.push([centre.lon + dLon * Math.sin(a), centre.lat + dLat * Math.cos(a)]); }
        feats.push({ type: "Feature", properties: { kind: "ring" }, geometry: { type: "LineString", coordinates: coords } });
        feats.push({ type: "Feature", properties: { kind: "ringlabel", label: `${distance} ${unitLabel}` }, geometry: { type: "Point", coordinates: [centre.lon + dLon * Math.SQRT1_2, centre.lat + dLat * Math.SQRT1_2] } });
      }
      if (!s.ringCompass) continue;
      // Cardinal marks sit ON the outermost ring: their dark halo punches the line out underneath,
      // so each letter reads as a deliberate break in the ring.
      const outer = ringOffsets(spacing * count);
      for (const [label, dx, dy] of [["N", 0, 1], ["E", 1, 0], ["S", 0, -1], ["W", -1, 0]]) {
        feats.push({ type: "Feature", properties: { kind: "compass", label }, geometry: { type: "Point", coordinates: [centre.lon + outer.dLon * dx, centre.lat + outer.dLat * dy] } });
      }
    }
    return { type: "FeatureCollection", features: feats };
  }
  function refreshRings() {
    map.getSource("rings")?.setData(ringsFC());
  }
  function refreshSources() {
    refreshAirfields();
    refreshRings();
  }

  function siteKey(value) { return `${value.lon.toFixed(5)},${value.lat.toFixed(5)}`; }
  // Called on every data pass. When the derived site moves (the first coverage snapshot, or a
  // receiver joining/leaving) the rings follow it and the coverage mesh is re-decoded around it.
  // The CAMERA, while the operator has not touched it, opens on the merged coverage BOUNDS —
  // several receivers far apart would otherwise open on the empty mean point between them. A
  // deployment with no receiver coverage at all (network feed only, or nothing yet) opens on a
  // world view instead of a hardcoded somewhere, so the operator picks their own region. A saved
  // location returns before this function, leaving the operator's last centre and zoom untouched.
  let appliedViewKey = null;
  function syncSiteReference() {
    const key = siteKey(site());
    if (key !== appliedSiteKey) {
      appliedSiteKey = key;
      coverageMeshSource = null;
      cachedCoverageMesh = null;
      if (ready) refreshRings();
    }
    if (!ready || userMovedCamera) return;
    const cov = deps.getCoverage();
    if (!cov?.type) return; // no snapshot answered yet: hold the pre-coverage view
    const viewKey = cov.bounds ? JSON.stringify(cov.bounds) : "world";
    if (viewKey === appliedViewKey) return;
    const opening = appliedViewKey === null;
    appliedViewKey = viewKey;
    let frame = null;
    if (cov.bounds) {
      try {
        // The snapshot serializes bounds LAT-first; MapLibre wants [lng, lat] corners.
        const [[minLat, minLon], [maxLat, maxLon]] = cov.bounds;
        const cam = map.cameraForBounds([[minLon, minLat], [maxLon, maxLat]], { padding: 90 });
        if (cam) frame = { center: [cam.center.lng, cam.center.lat], zoom: Math.max(2.2, Math.min(8.5, cam.zoom)) };
      } catch { /* degenerate bounds: fall through to the site point */ }
      if (!frame) frame = { center: [site().lon, site().lat] };
    } else {
      frame = { center: [15, 25], zoom: 2.3, pitch: 0 };
    }
    if (opening) applyCameraFrame(frame);
    else animateCamera(frame, { duration: 600, easing: EASE_OUT, kind: "site-recentre" });
    mapViewPersistenceReady = true;
  }

  // --- Public API -------------------------------------------------------------------------
  let followingSelectionHex = null;
  function transitionTrackedSelection(target, kind = "track-switch") {
    if (!target) return false;
    claimMapView();
    followingSelectionHex = target.hex;
    setFollowActive(true);
    attachOrbit(target.z);
    animateCamera(
      {
        center: [target.lon, target.lat],
        zoom: Math.max(map.getZoom(), 10.5),
        elevation: target.z,
      },
      { duration: 900, easing: EASE_OUT, kind, onComplete: followSelected },
    );
    requestMotionFrame();
    return true;
  }
  function dataPass() {
    buildLayers();
    const selectedHex = deps.getSelectedHex();
    if (!followActive) {
      if (!selectedHex) followingSelectionHex = null;
      return;
    }
    if (!selectedHex) {
      followingSelectionHex = null;
      clearOrbit();
      return;
    }
    // Track is a mode, not ownership by one hex. Switching selection while it is active keeps the
    // mode enabled and moves the same orbit smoothly to the newly selected aircraft.
    if (selectedHex !== followingSelectionHex) {
      const next = lastList.find((d) => d.hex === selectedHex);
      if (next) transitionTrackedSelection(next);
      return;
    }
    followSelected();
  }
  // The one-second wall clock updates DOM ages and the cheap alpha-only portion of the coast
  // animation. Coast/drop boundaries still get a full data pass in App.vue so desaturation and
  // target membership change exactly once; no trail geometry or globe projection is rebuilt here.
  function clockPass() {
    let changed = false;
    for (const d of lastList) {
      const nextOpacity = deps.isCoasting(d.item)
        ? deps.coastOpacity?.(d.item) ?? 0.42
        : 1;
      if (Math.abs(nextOpacity - d.coastOpacity) < 0.001) continue;
      d.coastOpacity = nextOpacity;
      const rendered = aircraftRenderByHex.get(d.hex);
      if (rendered) rendered.a = Math.round(255 * nextOpacity);
      const stick = aircraftStickByHex.get(d.hex);
      if (stick) stick.color[3] = Math.round(200 * nextOpacity);
      const trail = motionTrailByHex.get(d.hex);
      if (trail) trail.color[3] = Math.round(255 * nextOpacity);
      changed = true;
    }
    if (changed && ready) requestTacticalRepaint();
    syncBlocks();
  }
  // Rings anchor on the coverage centroids, so a fresh coverage snapshot re-anchors them too.
  function drawCoverage() { buildLayers(); refreshRings(); }
  function applySettings() {
    const settings = deps.getSettings();
    const nextTerrainExagg = settingExaggeration(settings, "terrainExaggeration", 5, 2);
    const nextAltitudeExagg = settingExaggeration(settings, "altitudeExaggeration", 10, 5);
    const nextPitchExagg = settingExaggeration(settings, "aircraftPitchExaggeration", 5, 3);
    const nextRollExagg = settingExaggeration(settings, "aircraftRollExaggeration", 5, 2);
    const altitudeScaleChanged = nextAltitudeExagg !== altitudeExagg;
    terrainExagg = nextTerrainExagg;
    altitudeExagg = nextAltitudeExagg;
    pitchExagg = nextPitchExagg;
    rollExagg = nextRollExagg;
    iconScale = settingExaggeration(settings, "aircraftScale", 2.5, 1, 0.5);
    trailWidthPx = settingExaggeration(settings, "trailWidth", 5, 2.1, 1);
    if (altitudeScaleChanged) {
      // Normals are calculated in exaggerated space, so a new coverage scale invalidates only
      // the decoded browser mesh. The server snapshot and network payload remain unchanged.
      coverageMeshSource = null;
      cachedCoverageMesh = null;
    }
    if (ready) {
      const currentElevation = mapTransform(map).elevation || 0;
      map.setTerrain({ source: "dem", exaggeration: terrainExagg });
      // Imagery brightness is a display preference: dim satellite imagery makes the overlaid
      // tactical symbology read better at night, bright imagery makes terrain read better by day.
      map.setPaintProperty("sat", "raster-brightness-max", settingExaggeration(settings, "imageryBrightness", 1.2, 0.9, 0.4));
      syncMapReferenceOverlay(map, settings.mapReferenceLabels !== false, referenceLanguage);
      if (settings.mapReferenceLabels === false) resetReferenceSourceRetry();
      refreshSources();
      buildLayers();
      const target = activeOrbitTarget();
      if (target) focusOrbitTarget(target);
      else applyCameraFrame({ elevation: currentElevation });
    }
  }
  function setHoverClass(next) { hoverHex = next; scheduleActive(next); }
  function resize() {
    map.resize();
    invalidateAirfieldHitIndex();
  }
  // The aircraft itself now absorbs sparse receiver ticks through the motion tracker. Once selection
  // fly-in finishes, keep the camera on that continuously moving visual target instead of layering a
  // second 600 ms follow animation on top of the correction.
  function followSelected() {
    if (!followActive) return;
    const selHex = deps.getSelectedHex();
    if (!selHex || selHex !== followingSelectionHex) { followingSelectionHex = null; clearOrbit(); return; }
    const d = lastList.find((x) => x.hex === selHex);
    if (!d) return;
    attachOrbit(d.z);
    updateFollowingCamera(d);
    requestMotionFrame();
  }
  // Centre on one receiver's reception area. Unlike Locate this keeps the current bearing and pitch,
  // so the operator stays in the same tactical orientation and only travels.
  function focusReceiver(lon, lat) {
    claimMapView();
    followingSelectionHex = null;
    clearOrbit();
    freeGrounding = null;
    orbitAttached = false;
    orbitZ = 0;
    animateCamera(
      { center: [lon, lat], zoom: Math.min(map.getZoom(), 8.5), elevation: 0 },
      { duration: 700, easing: EASE_OUT, kind: "receiver-focus" },
    );
  }

  // Browser location is a broad, near-vertical north-up ground view. It may zoom out, so locating
  // from a close aircraft view restores geographic context instead of retaining that close zoom.
  function locateBrowser(lon, lat) {
    claimMapView();
    followingSelectionHex = null;
    clearOrbit();
    freeGrounding = null;
    orbitAttached = false;
    orbitZ = 0;
    animateCamera(
      { center: [lon, lat], ...BROWSER_LOCATE_VIEW, elevation: 0 },
      { duration: 900, easing: EASE_IN_OUT, kind: "locate-browser" },
    );
  }
  // Locate is a tracking toggle for a selected aircraft. Starting preserves the current bearing
  // and pitch, changing only centre/zoom/elevated pivot; stopping preserves the camera exactly.
  function toggleTracking(lon, lat, altFt) {
    const selectedHex = deps.getSelectedHex();
    if (!selectedHex) return false;
    if (followActive && selectedHex && followingSelectionHex === selectedHex) {
      followingSelectionHex = null;
      clearOrbit();
      return false;
    }
    const z = (altFt ?? 0) * FT_TO_M * altitudeExagg;
    return transitionTrackedSelection({ hex: selectedHex, lon, lat, z }, "track-start");
  }
  function toggleAirfieldTracking(field) {
    if (!field) return false;
    if (airfieldOrbitMatches(field)) {
      clearOrbit();
      return false;
    }
    startAirfieldOrbit(field);
    return true;
  }
  function clearAirfieldSelection() { clearPinned({ releaseOrbit: true }); }
  function destroy() {
    persistMapView();
    disposed = true;
    clearInterval(viewportWantsTimer);
    if (airfieldSourceTimer) clearTimeout(airfieldSourceTimer);
    suspendCanvasHover();
    airfieldSourceTimer = 0;
    cancelTacticalRepaint();
    cancelCameraInput();
    cancelCameraSourceUpdate();
    retainedSymbolPlacement.destroy();
    restoreMapInputEvents?.();
    restoreMapInputEvents = null;
    resetReferenceSourceRetry();
    restoreViewportSymbolSize();
    restoreTerrainSourceUpdate();
    airfieldsFeed.dispose();
    cancelCameraAnimation();
    cancelMotionFrame();
    motionTracker.clear();
    if (identBlinkTimer) clearInterval(identBlinkTimer);
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    window.removeEventListener("pointermove", onTouchMove);
    window.removeEventListener("pointerup", onTouchUp);
    window.removeEventListener("pointercancel", onTouchUp);
    window.removeEventListener("pagehide", persistMapView);
    container.removeEventListener("pointerdown", onTouchDown);
    cv.removeEventListener("click", onCanvasClick);
    cv.removeEventListener("dblclick", onCanvasDoubleClick);
    cv.removeEventListener("pointermove", onCanvasPointerMove);
    cv.removeEventListener("wheel", onWheel);
    container.style.touchAction = "";
    map.remove();
    for (const el of [overlayEl, afPinEl, afHoverEl, lockEl, loadingEl]) el.remove();
  }

  const hideLoading = () => { loadingEl.style.display = "none"; };
  // Initialise on "style.load" (fires as soon as the style JSON is parsed) rather than "load"
  // (which also waits on terrain/imagery tiles and can hang on a slow network — leaving the view
  // stuck on "LOADING TERRAIN"). Sources are declared by style.load, so setTerrain works here.
  map.on("style.load", () => {
    if (disposed) return;
    retainedSymbolPlacement.installStyle();
    if (!globeCenterElevationInstalled) {
      globeCenterElevationInstalled = installGlobeCenterElevation(mapTransform(map));
      if (!globeCenterElevationInstalled) {
        // Degrade only the elevated orbit pivot. A MapLibre internals change must never blank the
        // satellite map, aircraft, trails, or coverage volume again.
        console.error("Skytrace globe center-elevation adapter unavailable; continuing with the standard globe camera");
      }
    }
    installGlobeTerrainFogMatrix(mapTransform(map));
    if (ready) return;
    ready = true;
    map.setTerrain({ source: "dem", exaggeration: terrainExagg });
    // applySettings() runs before style.load on a cold start, when setPaintProperty has no layer to
    // touch yet, so the persisted imagery brightness has to be (re)applied here.
    map.setPaintProperty("sat", "raster-brightness-max", settingExaggeration(deps.getSettings(), "imageryBrightness", 1.2, 0.9, 0.4));
    syncMapReferenceOverlay(map, deps.getSettings().mapReferenceLabels !== false, referenceLanguage);
    if (deps.getSettings().mapReferenceLabels === false) resetReferenceSourceRetry();
    // setTerrain seeds center elevation from the DEM even with centerClampedToGround:false.
    // The free camera uses sea-level/ground pivot until an aircraft orbit is explicitly attached.
    applyCameraFrame({ elevation: 0 });
    if (!map.getLayer(aircraftLayer.id)) map.addLayer(aircraftLayer);
    hideLoading();
    refreshSources();
    dataPass();
    // Replay a view padding requested before the style (and the transform) was ready.
    if (pendingViewPadding != null) {
      const parked = pendingViewPadding;
      pendingViewPadding = null;
      setViewPadding(parked);
    }
  });
  return { resize, dataPass, clockPass, drawCoverage, applySettings, setHoverClass, locateBrowser, focusReceiver, toggleTracking, toggleAirfieldTracking, clearAirfieldSelection, setViewPadding, resetNorth, destroy };
}
