// 3D tactical view on MapLibre GL v5 (raster-DEM terrain + LOD imagery, no key) with a
// deck.gl overlay for the GPU objects. It reproduces the old three.js "Top Gun" look on top
// of MapLibre: dark terrain with a glowing teal grid + topo contours + hillshade relief
// (satellite is a toggle), a solid altitude-gradient coverage dome, glTF aircraft with
// altitude sticks / trails, and HTML data-block popovers with pins.
//
// Loaded only via dynamic import from App.vue. All app state/formatting comes through
// `deps`; the exported factory keeps the API the 2D integration already calls.
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import mlcontour from "maplibre-contour";
import { WebMercatorViewport } from "@deck.gl/core";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { ScenegraphLayer, SimpleMeshLayer } from "@deck.gl/mesh-layers";
import { PathLayer, LineLayer, ScatterplotLayer } from "@deck.gl/layers";
import { AIRFIELDS, isMinorAirfield } from "./airfields.js";

const FT_TO_M = 0.3048;
const HOME = { lon: 127.33113, lat: 36.36599 }; // Yuseong IC
const SAT_TILES = ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"];
// Terrain relief comes from Mapterhorn (higher-quality open DEM, terrarium-encoded webp, CORS *,
// maxzoom 12 over Korea). AWS Terrarium is kept only for the maplibre-contour source.
const MAPTERHORN_TILES = ["https://tiles.mapterhorn.com/{z}/{x}/{y}.webp"];
const DEM_TILES = ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"];
const MODEL_URI = `${import.meta.env.BASE_URL}aircraft.glb`;
const EMPTY_FC = { type: "FeatureCollection", features: [] };
const M_PER_DEG_LAT = 111320;
const COV_ANCHOR = [{ position: [127.33113, 36.36599, 0] }]; // dome anchored at HOME (mesh verts are metre offsets)
// Vertical exaggeration for ALTITUDE (aircraft z, sticks, trails, coverage dome). Independent of the
// terrain relief exaggeration (which stays on the Terrain × setting) so altitudes read tall & clearly
// separated over gentler terrain.
const ALT_EXAGG = 5;

// One shared contour tile source (registers the maplibre-contour protocol once).
let demSource = null;
function ensureContourSource() {
  if (!demSource) {
    demSource = new mlcontour.DemSource({ url: DEM_TILES[0], encoding: "terrarium", maxzoom: 15, worker: true });
    demSource.setupMaplibre(maplibregl);
  }
  return demSource;
}

// deps colors are `hsl(H S% L%)` or hex; parse to {r,g,b} 0-255.
function parseRgb(css) {
  const m = /hsl\(\s*([\d.]+)[ ,]+([\d.]+)%[ ,]+([\d.]+)%\s*\)/.exec(css);
  if (m) {
    const h = Number(m[1]) / 360;
    const s = Number(m[2]) / 100;
    const l = Number(m[3]) / 100;
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const hue = (t) => { t = (t + 1) % 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; };
    return { r: Math.round(hue(h + 1 / 3) * 255), g: Math.round(hue(h) * 255), b: Math.round(hue(h - 1 / 3) * 255) };
  }
  const hex = css.replace("#", "");
  const n = hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex;
  return { r: parseInt(n.slice(0, 2), 16), g: parseInt(n.slice(2, 4), 16), b: parseInt(n.slice(4, 6), 16) };
}

// The coverage shell uses its own perceptually uniform altitude palette. Colour is
// calculated per fragment from interpolated altitude instead of interpolating a few
// sRGB vertex colours, which avoids the apparent cyan-to-blue brightness cliff.
const coverageAltitudeShader = {
  name: "coverageAltitude",
  inject: {
    "vs:#decl": /* glsl */ `
out float coverageAltitudeFt;
`,
    "vs:#main-end": /* glsl */ `
coverageAltitudeFt = max(positions.z / 0.3048, 0.0);
`,
    "fs:#decl": /* glsl */ `
in float coverageAltitudeFt;

float coverageLinearToSrgb(float value) {
  value = max(value, 0.0);
  return value <= 0.0031308
    ? value * 12.92
    : 1.055 * pow(value, 1.0 / 2.4) - 0.055;
}

vec3 coverageOklchToSrgb(float lightness, float chroma, float hueDegrees) {
  float hue = radians(hueDegrees);
  float a = chroma * cos(hue);
  float b = chroma * sin(hue);
  float lRoot = lightness + 0.3963377774 * a + 0.2158037573 * b;
  float mRoot = lightness - 0.1055613458 * a - 0.0638541728 * b;
  float sRoot = lightness - 0.0894841775 * a - 1.2914855480 * b;
  float l = lRoot * lRoot * lRoot;
  float m = mRoot * mRoot * mRoot;
  float s = sRoot * sRoot * sRoot;
  vec3 linearRgb = vec3(
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
  );
  return clamp(vec3(
    coverageLinearToSrgb(linearRgb.r),
    coverageLinearToSrgb(linearRgb.g),
    coverageLinearToSrgb(linearRgb.b)
  ), 0.0, 1.0);
}

vec3 coverageAltitudeColor(float altitudeFt) {
  float t = clamp(altitudeFt / 40000.0, 0.0, 1.0);
  // Preserve the existing low-orange to high-violet meaning while keeping
  // perceptual lightness and chroma constant throughout the sweep.
  return coverageOklchToSrgb(0.72, 0.18, mix(50.0, 300.0, t));
}
`,
    "fs:#main-end": /* glsl */ `
fragColor.rgb = coverageAltitudeColor(coverageAltitudeFt);
`,
  },
};

class CoverageMeshLayer extends SimpleMeshLayer {
  getShaders() {
    const shaders = super.getShaders();
    return { ...shaders, modules: [...(shaders.modules || []), coverageAltitudeShader] };
  }
}

// Aircraft self-glow: a fresnel RIM added in the target's OWN colour, computed per fragment from the
// PBR world normal (pbr_vNormal) and the view direction (project.cameraPosition − pbr_vPosition).
// Grazing edges (normal ⟂ view) light up, so the target reads as a luminous contact — a real glow
// with NO extra geometry and NO second draw (just a few fragment ops on the existing model).
// Whole-volume self-glow: a soft, UNIFORM emissive added in the fragment's OWN colour across the
// entire model (not a fresnel rim — an edge-only glow reads as a silly bright outline). It lifts the
// whole aircraft so it looks gently luminous against the dark scene while keeping its hue (additive
// of its own colour, not a wash toward white).
const aircraftGlowShader = {
  name: "aircraftGlow",
  inject: {
    "fs:#main-end": /* glsl */ `
  float glowLum = dot(fragColor.rgb, vec3(0.299, 0.587, 0.114));
  fragColor.rgb += fragColor.rgb * (0.5 + (1.0 - glowLum) * 0.7);
`,
  },
};
class GlowScenegraphLayer extends ScenegraphLayer {
  getShaders() {
    const shaders = super.getShaders();
    return { ...shaders, modules: [...(shaders.modules || []), aircraftGlowShader] };
  }
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
  let exagg = Math.max(1, Math.min(4, Number(deps.getSettings().terrainExaggeration) || 2));
  let disposed = false;
  let running = false;
  let ready = false;
  const contour = ensureContourSource();

  // Shared airfield symbol layout/paint. Split into per-class layers (below) so the worldwide
  // dataset (~48k) declutters by zoom: large always, medium from z5, small from z7. allow-overlap
  // is off so MapLibre thins out overlapping icons instead of drawing tens of thousands at once.
  const afLayout = {
    "icon-image": ["case", ["get", "minor"], "af-minor", ["match", ["get", "kind"], "large", "af-large", "medium", "af-medium", "af-small"]],
    "icon-size": ["case", ["get", "minor"], 0.5, ["match", ["get", "kind"], "large", 0.92, "medium", 0.76, 0.62]],
    "icon-allow-overlap": false, "icon-optional": false,
    "text-field": ["case", ["get", "minor"], "", ["get", "code"]],
    "text-font": ["Open Sans Regular"], "text-size": ["match", ["get", "kind"], "large", 12, 11],
    "text-letter-spacing": 0.08, "text-offset": [0, 1.15], "text-anchor": "top", "text-optional": true,
  };
  const afPaint = { "text-color": "#8ff0e4", "text-halo-color": "#04211f", "text-halo-width": 1.7, "text-halo-blur": 0.6 };

  // --- MapLibre map (mercator so the deck.gl overlay aligns). Dark tactical terrain by
  // default; satellite is a toggle. -------------------------------------------------------
  const map = new maplibregl.Map({
    container,
    attributionControl: false,
    bearingSnap: 0, // never auto-snap the bearing to north (camera moves were rotating it unbidden)
    maxPitch: 85, // essentially flat-to-the-horizon (MapLibre's practical max before looking underground)
    // Do NOT clamp the map centre's elevation to the terrain. With the default (true) the centre's
    // elevation auto-tracks the terrain under it, so panning/rotating over relief triggers MapLibre's
    // `recalculateZoomAndCenter`, which yanks the centre+zoom to a weird place (the fly-away; MapLibre
    // bug #2937, unfixed). With false the centre stays at sea level and is never recalculated, so the
    // camera no longer teleports on rotate/pan/zoom over terrain. (Docs also recommend false for high pitch.)
    centerClampedToGround: false,
    pitch: 55,
    zoom: 6,
    center: [HOME.lon, HOME.lat],
    style: {
      version: 8,
      glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
      sources: {
        satellite: { type: "raster", tiles: SAT_TILES, tileSize: 256, maxzoom: 19, attribution: "Esri, Maxar, Earthstar Geographics" },
        dem: { type: "raster-dem", tiles: MAPTERHORN_TILES, encoding: "terrarium", tileSize: 512, maxzoom: 12, attribution: "Terrain © Mapterhorn" },
        contours: { type: "vector", tiles: [contour.contourProtocolUrl({ multiplier: 1, thresholds: { 8: [500, 2000], 10: [200, 1000], 12: [100, 500], 14: [50, 250] }, elevationKey: "ele", levelKey: "level", contourLayer: "contours" })], maxzoom: 15 },
        grid: { type: "geojson", data: EMPTY_FC },
        airfields: { type: "geojson", data: EMPTY_FC },
        rings: { type: "geojson", data: EMPTY_FC },
      },
      layers: [
        { id: "bg", type: "background", paint: { "background-color": "#050a0c" } },
        { id: "hillshade", type: "hillshade", source: "dem", paint: { "hillshade-shadow-color": "#020a0c", "hillshade-highlight-color": "#1d6f66", "hillshade-accent-color": "#0b3a38", "hillshade-exaggeration": 0.75 } },
        { id: "sat", type: "raster", source: "satellite", layout: { visibility: "none" }, paint: { "raster-saturation": -0.45, "raster-brightness-max": 0.78, "raster-contrast": 0.08, "raster-hue-rotate": 8 } },
        { id: "grid-line", type: "line", source: "grid", paint: { "line-color": "#48e0d1", "line-opacity": ["match", ["get", "major"], 1, 0.28, 0.12], "line-width": ["match", ["get", "major"], 1, 1, 0.6] } },
        { id: "contour-line", type: "line", source: "contours", "source-layer": "contours", paint: { "line-color": "#48e0d1", "line-opacity": ["match", ["get", "level"], 1, 0.4, 0.16], "line-width": ["match", ["get", "level"], 1, 1.1, 0.6], "line-blur": 0.6 } },
        { id: "rings-line", type: "line", source: "rings", filter: ["==", ["get", "kind"], "ring"], paint: { "line-color": "#48e0d1", "line-opacity": 0.5, "line-width": 1.3, "line-blur": 1.2 } },
        // Tactical airfield: an aeronautical glyph icon (ring + crossed runways, class colour/size,
        // constant screen size) with the code below it. Split into three per-class layers so the
        // worldwide dataset declutters by zoom (large always, medium from z5, small/minor from z7)
        // and MapLibre gives placement priority to the biggest airports. Hit-testable for hover/click.
        { id: "airfield-large", type: "symbol", source: "airfields", minzoom: 0, filter: ["all", ["!", ["get", "minor"]], ["==", ["get", "kind"], "large"]], layout: { ...afLayout }, paint: { ...afPaint } },
        { id: "airfield-medium", type: "symbol", source: "airfields", minzoom: 5, filter: ["all", ["!", ["get", "minor"]], ["==", ["get", "kind"], "medium"]], layout: { ...afLayout }, paint: { ...afPaint } },
        { id: "airfield-small", type: "symbol", source: "airfields", minzoom: 7, filter: ["any", ["get", "minor"], ["==", ["get", "kind"], "small"]], layout: { ...afLayout }, paint: { ...afPaint } },
        { id: "ring-label", type: "symbol", source: "rings", filter: ["in", ["get", "kind"], ["literal", ["ringlabel", "compass"]]], layout: { "text-field": ["get", "label"], "text-font": ["Open Sans Regular"], "text-size": ["case", ["==", ["get", "kind"], "compass"], 15, 11], "text-allow-overlap": true }, paint: { "text-color": "#7fe6da", "text-opacity": ["case", ["==", ["get", "kind"], "compass"], 0.85, 0.55], "text-halo-color": "#050a0c", "text-halo-width": 1.2 } },
      ],
      sky: { "sky-color": "#0a1a2b", "horizon-color": "#0d1618", "fog-color": "#0b1416", "sky-horizon-blend": 0.6, "horizon-fog-blend": 0.6 },
    },
  });
  // Swapped mouse drag (per request): LEFT-drag rotates & tilts, RIGHT-drag pans. MapLibre has no
  // button-swap option in this release, so drive both by hand off the canvas mouse events. This is
  // safe over terrain ONLY because centerClampedToGround:false (above) disables MapLibre's
  // centre-elevation recalculation — the source of the old "centre flies to a weird place" lurch.
  map.dragPan.disable();
  map.dragRotate.disable();
  map.touchZoomRotate.enableRotation();
  const cv = map.getCanvas();
  cv.addEventListener("contextmenu", (e) => e.preventDefault());
  // Stop the browser from starting a native image/text drag of the canvas (the "whole canvas drags
  // as a ghost image" effect) — our own handlers drive the camera.
  cv.addEventListener("dragstart", (e) => e.preventDefault());
  cv.style.userSelect = "none";
  let drag = null;
  let dragMoved = false; // set once a gesture actually drags, so the trailing map "click" is ignored
  let followActive = false; // camera tracks the selected aircraft until the user drags/rotates it
  let identBlinkOn = false; // toggled by a timer while any aircraft squawks IDENT (gold body flash)
  let identBlinkTimer = 0;
  const onDown = (e) => {
    e.preventDefault(); // no native drag-image / text selection while manipulating the camera
    dragMoved = false;
    followActive = false; // any manual drag/rotate stops auto-tracking
    if (e.button === 0) drag = { mode: "rotate", x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, bearing: map.getBearing(), pitch: map.getPitch() };
    else if (e.button === 2) drag = { mode: "pan", x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY };
  };
  const onMove = (e) => {
    if (!drag) return;
    if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 3) dragMoved = true;
    if (drag.mode === "rotate") {
      map.setBearing(drag.bearing + (e.clientX - drag.x) * 0.35);
      map.setPitch(Math.max(0, Math.min(map.getMaxPitch(), drag.pitch - (e.clientY - drag.y) * 0.25)));
      // With an aircraft selected, keep IT under the screen centre so rotation/tilt orbits the
      // aircraft rather than the map's ground centre (which sits ahead of the target at pitch).
      const selHex = deps.getSelectedHex();
      const sel = selHex && lastList.find((d) => d.hex === selHex);
      if (sel) map.setCenter(centerFor(sel.lon, sel.lat, sel.z));
    } else {
      map.panBy([-(e.clientX - drag.x), -(e.clientY - drag.y)], { duration: 0 });
      drag.x = e.clientX; drag.y = e.clientY; // pan is incremental
    }
  };
  const onUp = () => { drag = null; };
  cv.addEventListener("mousedown", onDown);
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
  // Generate the tactical airfield glyph icons on demand (per class colour).
  map.on("styleimagemissing", (e) => {
    const color = AF_ICON_COLORS[e.id];
    if (color && !map.hasImage(e.id)) map.addImage(e.id, makeAirfieldIcon(color), { pixelRatio: 2 });
  });
  // pickingRadius widens the click/hover search around the pointer so selecting an aircraft is
  // forgiving (on top of the invisible hit disc) — no pixel-perfect aim on the small model.
  const overlay = new MapboxOverlay({ interleaved: true, pickingRadius: 16, layers: [] });
  map.addControl(overlay);
  if (typeof window !== "undefined" && window.__T3D_DEBUG) { window.__t3dMap = map; window.__t3dOverlay = overlay; window.__WMV = WebMercatorViewport; }

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
  const hintEl = document.createElement("div");
  hintEl.className = "t3d-hint";
  hintEl.textContent = "Drag rotate & tilt · Right-drag pan · Scroll zoom";
  container.append(overlayEl, afPinEl, afHoverEl, lockEl, loadingEl, hintEl);

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
  overlayEl.addEventListener("mouseover", (e) => { const b = e.target.closest(".t3d-block"); if (b?.dataset.hex) scheduleActive(b.dataset.hex); });
  overlayEl.addEventListener("mouseout", (e) => { const b = e.target.closest(".t3d-block"); if (b && !b.contains(e.relatedTarget)) scheduleActive(null); });
  overlayEl.addEventListener("click", (e) => {
    const pin = e.target.closest(".tt-pin");
    const hex = pin?.closest(".t3d-block")?.dataset.hex;
    if (hex) { e.stopPropagation(); deps.togglePin(hex); buildLayers(); syncBlocks(); }
  });
  overlayEl.addEventListener("wheel", (e) => { e.preventDefault(); map.getCanvas().dispatchEvent(new WheelEvent("wheel", { deltaY: e.deltaY, deltaX: e.deltaX, clientX: e.clientX, clientY: e.clientY, cancelable: true })); }, { passive: false });

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
        if (vs != null && gs > 5) phi = (Math.atan2(vs * 0.00508, gs) * 3 * 180) / Math.PI;
        phi = Math.max(-40, Math.min(40, phi));
      }
      const bank = airborne && Number.isFinite(item.roll) ? Math.max(-45, Math.min(45, item.roll)) : 0;
      const track = Number.isFinite(item.track) ? item.track : 0;
      const cls = deps.planeSizeScale(item.category); // 0.85 light · 1 · 1.18 heavy (matches 2D)
      // deck maps the nose (+X) to world-Z = -sin(pitch) and the right wing (+Y) to
      // world-Z = cos(pitch)*sin(roll). ADS-B roll>0 = right wing DOWN and climb phi>0 = nose UP,
      // both the opposite sign of what deck needs — so negate both pitch and roll.
      out.push({ hex: item.hex, lon: item.lon, lat: item.lat, z: altM * ALT_EXAGG, airborne, rgb, cls, orientation: [-phi, 90 - track, -bank], coasting: deps.isCoasting(item), spi: !!item.spi, item });
    }
    return out;
  }

  // --- deck layers ------------------------------------------------------------------------
  let lastList = [];
  function buildLayers() {
    if (!ready) return;
    const list = aircraftList();
    lastList = list;
    // IDENT (SPI): flash the whole body gold. Run a blink toggle only while some aircraft squawks
    // ident (rare/brief); each toggle rebuilds so the aircraft getColor re-evaluates.
    const hasIdent = list.some((d) => d.spi);
    if (hasIdent && !identBlinkTimer) identBlinkTimer = setInterval(() => { identBlinkOn = !identBlinkOn; buildLayers(); }, 480);
    else if (!hasIdent && identBlinkTimer) { clearInterval(identBlinkTimer); identBlinkTimer = 0; identBlinkOn = false; }
    const selHex = deps.getSelectedHex();

    // Proximity/collision alert (same STCA data as the 2D map): a red link between each close pair —
    // in 3D drawn tip-to-tip at altitude — and the involved aircraft reddened.
    const conflicts = deps.getConflicts?.() || [];
    const conflictHexes = new Set();
    for (const p of conflicts) { conflictHexes.add(p.a.hex); conflictHexes.add(p.b.hex); }
    const conflictLines = conflicts.map((p) => ({
      source: [p.a.lon, p.a.lat, ((p.a.altBaro ?? p.a.altGeom) || 0) * FT_TO_M * ALT_EXAGG],
      target: [p.b.lon, p.b.lat, ((p.b.altBaro ?? p.b.altGeom) || 0) * FT_TO_M * ALT_EXAGG],
    }));

    const sticks = list.filter((d) => d.airborne).map((d) => ({ source: [d.lon, d.lat, d.z], target: [d.lon, d.lat, 0], color: [d.rgb.r, d.rgb.g, d.rgb.b, 200] }));

    const trails = [];
    const seen = new Set();
    const addTrail = (pts) => {
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
        const pt = [p.lon, p.lat, altM * ALT_EXAGG];
        if (!run || gap || (runColor && (col[0] !== runColor[0] || col[1] !== runColor[1] || col[2] !== runColor[2]))) {
          if (run && run.path.length >= 2) trails.push(run);
          const start = !gap && run && run.path.length ? [run.path[run.path.length - 1]] : [];
          run = { path: [...start, pt], color: col };
          runColor = col;
        } else run.path.push(pt);
        prevT = t;
      }
      if (run && run.path.length >= 2) trails.push(run);
    };
    const selTrack = deps.getSelectedTrack();
    if (selHex && selTrack.length) { addTrail(selTrack); seen.add(selHex); }
    for (const { hex, points } of deps.getPinnedTracks()) if (!seen.has(hex) && points?.length) { seen.add(hex); addTrail(points); }

    const ghost = deps.getPlaybackGhost();
    const ghostData = ghost && ghost.lat != null ? [{ lon: ghost.lon, lat: ghost.lat, z: ((ghost.altBaro ?? ghost.altGeom) || 0) * FT_TO_M * ALT_EXAGG, rgb: parseRgb(deps.altitudeColor(ghost)), orientation: [0, 90 - (Number.isFinite(ghost.track) ? ghost.track : 0), 0] }] : [];

    const covMesh = coverageMesh();
    // Aircraft grouped by size class so per-category size differences survive the pixel clamp
    // (constant on-screen size per class). One solid glTF model per target in its TRUE altitude
    // colour, with a per-fragment fresnel rim self-glow (GlowScenegraphLayer) — no extra geometry.
    const byCls = new Map();
    for (const d of list) { const g = byCls.get(d.cls) || []; g.push(d); byCls.set(d.cls, g); }
    const aircraftLayers = [...byCls.entries()].map(([cls, data]) => new GlowScenegraphLayer({
      id: `aircraft-${cls}`, data, scenegraph: MODEL_URI, getPosition: (d) => [d.lon, d.lat, d.z], getOrientation: (d) => d.orientation,
      getColor: (d) => (d.spi && identBlinkOn) ? [255, 215, 0, 255] : conflictHexes.has(d.hex) ? [251, 113, 133, 255] : [d.rgb.r, d.rgb.g, d.rgb.b, d.coasting ? 150 : 255],
      updateTriggers: { getColor: `${identBlinkOn}|${[...conflictHexes].sort().join(",")}` },
      sizeScale: 185, sizeMinPixels: Math.round(48 * cls), sizeMaxPixels: Math.round(68 * cls), _lighting: "pbr",
      pickable: false, parameters: { depthCompare: "always" },
    }));

    const covMat = { ambient: 1, diffuse: 0, shininess: 1, specularColor: [0, 0, 0] };
    const layers = [
      // Coverage dome in TWO passes so its translucency is drawn exactly once per pixel (no
      // front+back / overlapping-band stacking into brighter/white triangles). Pass 1 writes only
      // depth (nearest surface); pass 2 colours only the fragments at that nearest depth.
      // depthWrite alone can't fix it — a nearer triangle drawn later still blends over an earlier
      // farther one. Aircraft/sticks/trails use depthCompare 'always', so the dome never hides them.
      covMesh && new CoverageMeshLayer({
        id: "coverage-depth", data: COV_ANCHOR, mesh: covMesh, getPosition: (d) => d.position,
        getColor: [0, 0, 0, 0], getScale: [1, 1, ALT_EXAGG], sizeScale: 1, material: covMat, pickable: false,
        // alpha 0 with blending on leaves colour untouched; the point of this pass is the depth write.
        parameters: { depthWriteEnabled: true, depthCompare: "less-equal" },
      }),
      covMesh && new CoverageMeshLayer({
        id: "coverage", data: COV_ANCHOR, mesh: covMesh, getPosition: (d) => d.position,
        getColor: [255, 255, 255, 58], getScale: [1, 1, ALT_EXAGG], sizeScale: 1, material: covMat, pickable: false,
        parameters: { depthWriteEnabled: false, depthCompare: "less-equal" },
      }),
      // Targets ignore the depth buffer (depthCompare 'always') so the dome/terrain never hide them.
      // Trail: a single crisp altitude-gradient line (no glow/casing). billboard:true keeps the
      // ribbon facing the camera, so it has the same thickness from the side as from above.
      new PathLayer({ id: "trails", data: trails, getPath: (d) => d.path, getColor: (d) => d.color, widthUnits: "pixels", getWidth: 2.8, widthMinPixels: 2.2, billboard: true, jointRounded: true, capRounded: true, parameters: { depthCompare: "always" } }),
      new LineLayer({ id: "sticks", data: sticks, getSourcePosition: (d) => d.source, getTargetPosition: (d) => d.target, getColor: (d) => d.color, widthUnits: "pixels", getWidth: 1.6, widthMinPixels: 1.2, parameters: { depthCompare: "always" } }),
      // Small dot at each stick's ground foot (the old view had these).
      new ScatterplotLayer({ id: "ground-dots", data: sticks, getPosition: (d) => d.target, radiusUnits: "pixels", getRadius: 3, radiusMinPixels: 2.5, radiusMaxPixels: 4, filled: true, stroked: false, getFillColor: (d) => d.color, parameters: { depthCompare: "always" } }),
      // Collision/proximity alert link between each conflicting pair (red, over everything).
      conflictLines.length && new LineLayer({ id: "conflicts", data: conflictLines, getSourcePosition: (d) => d.source, getTargetPosition: (d) => d.target, getColor: [251, 113, 133, 235], widthUnits: "pixels", getWidth: 2.6, widthMinPixels: 2, parameters: { depthCompare: "always" } }),
      ...aircraftLayers,
      ghostData.length && new ScenegraphLayer({ id: "ghost", data: ghostData, scenegraph: MODEL_URI, getPosition: (d) => [d.lon, d.lat, d.z], getOrientation: (d) => d.orientation, getColor: (d) => [d.rgb.r, d.rgb.g, d.rgb.b, 150], sizeScale: 150, sizeMinPixels: 38, sizeMaxPixels: 54, parameters: { depthCompare: "always" } }),
      // Invisible, generous click/hover target (like the old hit sphere): a constant ~80px disc
      // per aircraft — bigger than the model — so selecting never needs pixel-perfect aim.
      new ScatterplotLayer({
        id: "hit", data: list, getPosition: (d) => [d.lon, d.lat, d.z], radiusUnits: "pixels", getRadius: 40, radiusMinPixels: 40, radiusMaxPixels: 40,
        filled: true, stroked: false, getFillColor: [0, 0, 0, 0], pickable: true, onHover: onAircraftHover, parameters: { depthCompare: "always" },
      }),
    ].filter(Boolean);
    overlay.setProps({ layers });
    syncBlocks();
  }

  // Solid altitude-gradient reception dome: skin the server's per-altitude rings into a single
  // translucent triangle mesh (a real 3D volume, not a wireframe). Built in local metre offsets
  // from HOME so a SimpleMeshLayer (which reliably renders arbitrary 3D geo meshes) can draw it;
  // the fragment shader maps interpolated altitude to OKLCH colour, while getColor supplies alpha.
  const M_PER_DEG_LON = M_PER_DEG_LAT * Math.cos((HOME.lat * Math.PI) / 180);
  function coverageMesh() {
    if (!deps.getSettings().coverage) return null;
    const positions = [];
    // Metre offset of a ring vertex from HOME (the SimpleMeshLayer anchor).
    const off = (pt, z) => [(pt[0] - HOME.lon) * M_PER_DEG_LON, (pt[1] - HOME.lat) * M_PER_DEG_LAT, z];
    const pushV = (p) => { positions.push(p[0], p[1], p[2]); };
    for (const area of deps.getCoverage()?.areas || []) {
      const vol = area.volume;
      if (!vol?.layers?.length) continue;
      const levels = [{ feet: 0, ring: vol.layers[0].ring }];
      for (const l of vol.layers) levels.push({ feet: l.midAltitude, ring: l.ring });
      const N = Math.min(...levels.map((lv) => lv.ring.length)) - 1; // azimuth samples (ring closes)
      if (N < 3) continue;
      // Keep raw altitude in the mesh. CoverageMeshLayer applies visual exaggeration through
      // getScale, leaving the shader with the true altitude for its per-fragment colour lookup.
      const zc = levels.map((lv) => lv.feet * FT_TO_M);
      // Skin each altitude band into two triangles per azimuth cell (non-indexed triangle list).
      for (let l = 0; l < levels.length - 1; l += 1) {
        const r0 = levels[l].ring;
        const r1 = levels[l + 1].ring;
        for (let a = 0; a < N; a += 1) {
          const a2 = (a + 1) % N;
          const p00 = off(r0[a], zc[l]);
          const p01 = off(r0[a2], zc[l]);
          const p10 = off(r1[a], zc[l + 1]);
          const p11 = off(r1[a2], zc[l + 1]);
          pushV(p00); pushV(p01); pushV(p11);
          pushV(p00); pushV(p11); pushV(p10);
        }
      }
    }
    if (!positions.length) return null;
    return {
      attributes: {
        positions: { value: new Float32Array(positions), size: 3 },
      },
    };
  }

  // --- HTML data blocks (pinned / selected / hovered), positioned via the deck viewport ---
  function project(lon, lat, z) {
    try {
      // getViewports() asserts if deck isn't sized/ready yet (early renders) — treat as "not placeable".
      const vp = overlay._deck?.getViewports?.()[0];
      if (!vp) return null;
      const p = vp.project([lon, lat, z]);
      return p && Number.isFinite(p[0]) ? p : null;
    } catch { return null; }
  }
  function syncBlocks() {
    if (!ready) return;
    const pinned = deps.getPinned();
    const selHex = deps.getSelectedHex();
    const shown = new Set();
    for (const d of lastList) {
      if (!(pinned.has(d.hex) || d.hex === selHex || d.hex === activeHex)) continue;
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
        b = { el, block, sig: "" };
        blocks.set(d.hex, b);
      }
      const sig = deps.datablockHtml(d.item);
      if (b.sig !== sig) { b.block.innerHTML = sig; b.sig = sig; }
      b.block.classList.toggle("selected", d.hex === selHex);
      // Widen the block's offset when zoomed in (the aircraft mesh grows toward its pixel cap), so it
      // clears the body at close range too.
      b.block.style.left = `${map.getZoom() >= 11 ? 62 : 44}px`;
      const p = project(d.lon, d.lat, d.z);
      if (p) { b.el.style.display = ""; b.el.style.transform = `translate3d(${p[0].toFixed(1)}px, ${p[1].toFixed(1)}px, 0)`; }
      else b.el.style.display = "none";
    }
    for (const [hex, b] of blocks) if (!shown.has(hex)) { b.el.remove(); blocks.delete(hex); }
    // Position the tactical target-lock on the selected aircraft.
    const sel = selHex && lastList.find((d) => d.hex === selHex);
    const lp = sel && project(sel.lon, sel.lat, sel.z);
    if (lp) { lockEl.style.display = ""; lockEl.style.transform = `translate3d(${lp[0].toFixed(1)}px, ${lp[1].toFixed(1)}px, 0) translate(-50%, -50%)`; }
    else lockEl.style.display = "none";
  }

  // --- Interaction ------------------------------------------------------------------------
  function onAircraftHover(info) {
    const hex = info.object?.hex || null;
    if (hex !== hoverHex) { hoverHex = hex; deps.onHover(hex); map.getCanvas().style.cursor = hex ? "pointer" : ""; scheduleActive(hex); }
  }
  const airfieldByKey = new Map();
  let afPinned = null; // airfield popover pinned by a click; stays until a click elsewhere
  const AF_LAYERS = ["airfield-large", "airfield-medium", "airfield-small"]; // the three per-class symbol layers — hover/click on any
  function positionAf(el, field) { if (!field) return; const p = map.project([field.lon, field.lat]); el.style.transform = `translate3d(${p.x.toFixed(1)}px, ${(p.y - 12).toFixed(1)}px, 0) translate(-50%, -100%)`; }
  function showPinned(field) { afPinned = field; afPinEl.innerHTML = deps.airfieldTooltip(field); afPinEl.style.display = ""; positionAf(afPinEl, field); if (hoverAf?.field === field) afHoverEl.style.display = "none"; }
  function clearPinned() { afPinned = null; afPinEl.style.display = "none"; }
  map.on("render", () => {
    if (afPinned) positionAf(afPinEl, afPinned);
    if (hoverAf?.field && hoverAf.field !== afPinned) positionAf(afHoverEl, hoverAf.field);
    syncBlocks();
  });
  map.on("mousemove", AF_LAYERS, (e) => {
    const field = airfieldByKey.get(e.features?.[0]?.properties?.key);
    if (field && field !== hoverAf?.field) {
      hoverAf = { field };
      map.getCanvas().style.cursor = "pointer";
      // The hover popover shows any airfield EXCEPT the one already pinned (its own popover stays up).
      if (field !== afPinned) { afHoverEl.innerHTML = deps.airfieldTooltip(field); afHoverEl.style.display = ""; positionAf(afHoverEl, field); }
      else afHoverEl.style.display = "none";
    }
  });
  map.on("mouseleave", AF_LAYERS, () => { hoverAf = null; if (!hoverHex) map.getCanvas().style.cursor = ""; afHoverEl.style.display = "none"; });
  map.on("click", (e) => {
    if (dragMoved) { dragMoved = false; return; } // ignore the click that trails a rotate/pan drag
    // Aircraft: pick synchronously off MapLibre's (immediate) click instead of deck's onClick,
    // which waits ~300ms to disambiguate single- vs double-click — that lag was the select delay.
    const hit = overlay._deck?.pickObject?.({ x: e.point.x, y: e.point.y, radius: 18, layerIds: ["hit"] });
    if (hit?.object?.hex) { deps.onSelect(hit.object.hex); return; }
    const field = airfieldByKey.get(map.queryRenderedFeatures(e.point, { layers: AF_LAYERS })[0]?.properties?.key);
    if (field) { showPinned(field); return; } // clicking an airfield pins its popover
    if (afPinned) clearPinned(); // click elsewhere clears it
    deps.onMapClick();
  });

  // --- Native GeoJSON sources -------------------------------------------------------------
  function airfieldsFC() {
    airfieldByKey.clear();
    const s = deps.getSettings();
    if (!s.airfields) return EMPTY_FC;
    const features = [];
    for (const f of AIRFIELDS) {
      const minor = isMinorAirfield(f);
      if (minor && !s.airfieldsMinor) continue;
      const key = f.icao || f.code;
      airfieldByKey.set(key, f);
      // icon-image/size + text pick their own per-class values from kind/minor in the style.
      features.push({ type: "Feature", properties: { key, code: f.code, minor, kind: f.kind }, geometry: { type: "Point", coordinates: [f.lon, f.lat] } });
    }
    return { type: "FeatureCollection", features };
  }
  function ringsFC() {
    const cosLat = Math.cos((HOME.lat * Math.PI) / 180) || 1;
    const feats = [];
    for (const km of [100, 200, 300]) {
      const coords = [];
      for (let i = 0; i <= 72; i += 1) { const a = (i / 72) * Math.PI * 2; coords.push([HOME.lon + (km / 111.32 / cosLat) * Math.sin(a), HOME.lat + (km / 111.32) * Math.cos(a)]); }
      feats.push({ type: "Feature", properties: { kind: "ring" }, geometry: { type: "LineString", coordinates: coords } });
      feats.push({ type: "Feature", properties: { kind: "ringlabel", label: `${km} km` }, geometry: { type: "Point", coordinates: [HOME.lon + (km / 111.32 / cosLat) * Math.SQRT1_2, HOME.lat + (km / 111.32) * Math.SQRT1_2] } });
    }
    for (const [label, dx, dy] of [["N", 0, 1], ["E", 1, 0], ["S", 0, -1], ["W", -1, 0]]) feats.push({ type: "Feature", properties: { kind: "compass", label }, geometry: { type: "Point", coordinates: [HOME.lon + (340 / 111.32 / cosLat) * dx, HOME.lat + (340 / 111.32) * dy] } });
    return { type: "FeatureCollection", features: feats };
  }
  // Metric tactical grid (50 km major / 10 km minor) around the receiver.
  function gridFC() {
    const cosLat = Math.cos((HOME.lat * Math.PI) / 180) || 1;
    const R = 480;
    const feats = [];
    for (let d = -R; d <= R; d += 10) {
      const major = d % 50 === 0 ? 1 : 0;
      const lon = HOME.lon + d / 111.32 / cosLat;
      const lat = HOME.lat + d / 111.32;
      feats.push({ type: "Feature", properties: { major }, geometry: { type: "LineString", coordinates: [[lon, HOME.lat - R / 111.32], [lon, HOME.lat + R / 111.32]] } });
      feats.push({ type: "Feature", properties: { major }, geometry: { type: "LineString", coordinates: [[HOME.lon - R / 111.32 / cosLat, lat], [HOME.lon + R / 111.32 / cosLat, lat]] } });
    }
    return { type: "FeatureCollection", features: feats };
  }
  function refreshSources() {
    map.getSource("airfields")?.setData(airfieldsFC());
    map.getSource("rings")?.setData(ringsFC());
    map.getSource("grid")?.setData(gridFC());
    applyTerrainMode();
  }
  // Satellite toggle: show the photo OR the dark tactical terrain (grid + contours + shade).
  function applyTerrainMode() {
    const sat = deps.getSettings().terrainSatellite === true;
    const set = (id, vis) => { if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", vis ? "visible" : "none"); };
    set("sat", sat);
    set("hillshade", !sat);
    set("grid-line", !sat);
    set("contour-line", !sat);
  }

  // --- Public API -------------------------------------------------------------------------
  function dataPass() { buildLayers(); followSelected(); }
  function drawCoverage() { buildLayers(); }
  function applySettings() {
    exagg = Math.max(1, Math.min(4, Number(deps.getSettings().terrainExaggeration) || 2));
    if (ready) { map.setTerrain({ source: "dem", exaggeration: exagg }); refreshSources(); buildLayers(); }
  }
  function setHoverClass(prev, next) { hoverHex = next; scheduleActive(next); }
  function setActive(active) {
    running = active;
    if (active) { map.resize(); hintEl.style.display = ""; setTimeout(() => { hintEl.style.display = "none"; }, 8000); }
    else { hoverHex = null; hoverAf = null; afPinned = null; afPinEl.style.display = "none"; afHoverEl.style.display = "none"; }
  }
  function resize() { map.resize(); }
  // 3D sits one zoom level CLOSER than the 2D map (pitch pulls the view back), so the default
  // isn't too far out. getCameraForMap inverts this so a 2D<->3D round-trip is stable.
  function setCameraFromMap(center, zoom) { map.jumpTo({ center: [center.lng ?? center.lon, center.lat], zoom: zoom + 1, pitch: 55 }); }
  function getCameraForMap() { const c = map.getCenter(); return { center: [c.lat, c.lng], zoom: Math.min(18, Math.max(3, Math.round(map.getZoom() - 1))) }; }
  // Screen-space lift of an altitude point above its ground point (for centring the aircraft,
  // not its nadir). Cached as followOffset so follow uses a STABLE offset — recomputing it from
  // a mid-animation camera every tick is what made the view oscillate.
  // GROUND point to centre the map on so an aircraft at scene-height z lands at screen centre.
  // Solved with the real (target) projection: the map centre we want is the ground point sitting
  // under the aircraft's projected screen position; iterating converges to it. This is exact at any
  // zoom (fixes "wrong place then re-align"). Guarded so a near-horizon unproject that runs off to
  // the sky (non-finite or a huge shift) never jumps the camera to a garbage coordinate.
  function centerFor(lon, lat, z, pitchDeg = map.getPitch(), zoom = map.getZoom()) {
    if (!(z > 0)) return [lon, lat];
    const bearing = map.getBearing();
    const p = (pitchDeg * Math.PI) / 180, b = (bearing * Math.PI) / 180, cosLat = Math.cos((lat * Math.PI) / 180) || 1;
    // Analytical seed: shift z*tan(pitch) metres in the look direction. Puts the target roughly
    // on-screen even at high zoom (where the nadir-centred aircraft projects off the top), so the
    // unproject refinement below starts from a valid on-screen point instead of the sky.
    const d0 = z * Math.tan(p);
    let center = [lon + (d0 * Math.sin(b)) / (M_PER_DEG_LAT * cosLat), lat + (d0 * Math.cos(b)) / M_PER_DEG_LAT];
    const w = map.getCanvas().clientWidth || 1, h = map.getCanvas().clientHeight || 1, cx = w / 2, cy = h / 2;
    // Refine by moving the centre onto the ground point under the aircraft's screen position. Track
    // the BEST centre (smallest aircraft-off-centre) and return it, so an ill-conditioned near-horizon
    // case (very high zoom) can't diverge — it just returns the closest achievable framing.
    let best = center, bestOff = Infinity;
    for (let i = 0; i < 5; i += 1) {
      let air, g;
      try {
        const vp = new WebMercatorViewport({ width: w, height: h, longitude: center[0], latitude: center[1], zoom, pitch: pitchDeg, bearing });
        air = vp.project([lon, lat, z]);
        g = air && Number.isFinite(air[0]) && Number.isFinite(air[1]) ? vp.unproject([air[0], air[1]]) : null;
      } catch { break; }
      if (!air || !Number.isFinite(air[0]) || !Number.isFinite(air[1])) break;
      const off = Math.hypot(air[0] - cx, air[1] - cy);
      if (off < bestOff) { bestOff = off; best = center; }
      if (off < 4 || !g || !Number.isFinite(g[0]) || !Number.isFinite(g[1]) || Math.abs(g[0] - lon) > 6 || Math.abs(g[1] - lat) > 6) break;
      center = [g[0], g[1]];
    }
    return best;
  }
  const EASE_OUT = (t) => 1 - Math.pow(1 - t, 3); // fast start, slow settle
  let followSettleUntil = 0; // suspend follow until the focus/locate animation has settled
  // Called on select: ease-out focus (fast start, slow settle) to the target, then auto-track it.
  function panTo(lon, lat, altFt) {
    followActive = true;
    followSettleUntil = performance.now() + 480;
    map.easeTo({ center: centerFor(lon, lat, (altFt != null ? altFt * FT_TO_M : 0) * ALT_EXAGG), duration: 520, easing: EASE_OUT });
  }
  // Continuously keep the selected aircraft centred (smooth linear glide) until the user drags the
  // map — but not until the focus/locate animation has settled, so its ease-out plays out.
  function followSelected() {
    if (!followActive) return;
    const selHex = deps.getSelectedHex();
    if (!selHex) { followActive = false; return; }
    if (performance.now() < followSettleUntil) return;
    const d = lastList.find((x) => x.hex === selHex);
    if (!d) return;
    const target = centerFor(d.lon, d.lat, d.z);
    const cur = map.getCenter();
    // Distance-proportional duration with a MIN-SPEED floor: a small position update snaps quickly
    // (it used to crawl over a fixed 1.1s — the laggy/sluggish feel), a large one is capped so it
    // still glides. Cuts the follow lag right after a position update.
    const distDeg = Math.hypot(target[0] - cur.lng, target[1] - cur.lat);
    const dur = Math.max(90, Math.min(480, distDeg * 3500));
    map.easeTo({ center: target, duration: dur, easing: (t) => t });
  }
  // Locate button: ONE ease-out easeTo that changes zoom + pan together (centred on the aircraft at
  // altitude via the geometric centre, computed for the TARGET pitch), and resumes tracking.
  function flyToView(lon, lat, zoom, altFt) {
    const z = altFt != null ? altFt * FT_TO_M * ALT_EXAGG : 0;
    if (altFt != null) { followActive = true; followSettleUntil = performance.now() + 980; }
    map.easeTo({ center: centerFor(lon, lat, z, 55, zoom + 1), zoom: zoom + 1, pitch: 55, duration: 900, easing: EASE_OUT });
  }
  function fitAircraft(points) { if (!points.length) return; const b = new maplibregl.LngLatBounds(); for (const p of points) b.extend([p.lon, p.lat]); map.fitBounds(b, { padding: 80, maxZoom: 9, pitch: 55, duration: 900 }); }
  function destroy() {
    disposed = true;
    if (identBlinkTimer) clearInterval(identBlinkTimer);
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    try { map.removeControl(overlay); } catch { /* gone */ }
    map.remove();
    for (const el of [overlayEl, afPinEl, afHoverEl, lockEl, loadingEl, hintEl]) el.remove();
  }

  const hideLoading = () => { loadingEl.style.display = "none"; };
  // Initialise on "style.load" (fires as soon as the style JSON is parsed) rather than "load"
  // (which also waits on terrain/imagery tiles and can hang on a slow network — leaving the view
  // stuck on "LOADING TERRAIN"). Sources are declared by style.load, so setTerrain works here.
  map.on("style.load", () => {
    if (disposed || ready) return;
    ready = true;
    map.setTerrain({ source: "dem", exaggeration: exagg });
    hideLoading();
    refreshSources();
    buildLayers();
  });
  setCameraFromMap({ lat: HOME.lat, lng: HOME.lon }, 7);

  return { setActive, resize, dataPass, drawCoverage, applySettings, setHoverClass, panTo, flyToView, fitAircraft, setCameraFromMap, getCameraForMap, destroy };
}
