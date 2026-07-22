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

  // --- MapLibre map (mercator so the deck.gl overlay aligns). Dark tactical terrain by
  // default; satellite is a toggle. -------------------------------------------------------
  const map = new maplibregl.Map({
    container,
    attributionControl: false,
    bearingSnap: 0, // never auto-snap the bearing to north (camera moves were rotating it unbidden)
    maxPitch: 85, // essentially flat-to-the-horizon (MapLibre's practical max before looking underground)
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
        // constant screen size) with the code below it. One symbol layer, hit-testable for hover/click.
        { id: "airfield-icon", type: "symbol", source: "airfields",
          layout: {
            "icon-image": ["case", ["get", "minor"], "af-minor", ["match", ["get", "kind"], "large", "af-large", "medium", "af-medium", "af-small"]],
            "icon-size": ["case", ["get", "minor"], 0.5, ["match", ["get", "kind"], "large", 0.92, "medium", 0.76, 0.62]],
            "icon-allow-overlap": true,
            "text-field": ["case", ["get", "minor"], "", ["get", "code"]],
            "text-font": ["Open Sans Regular"], "text-size": ["match", ["get", "kind"], "large", 12, 11],
            "text-letter-spacing": 0.08, "text-offset": [0, 1.15], "text-anchor": "top", "text-optional": true,
          },
          paint: { "text-color": "#8ff0e4", "text-halo-color": "#04211f", "text-halo-width": 1.7, "text-halo-blur": 0.6 } },
        { id: "ring-label", type: "symbol", source: "rings", filter: ["in", ["get", "kind"], ["literal", ["ringlabel", "compass"]]], layout: { "text-field": ["get", "label"], "text-font": ["Open Sans Regular"], "text-size": ["case", ["==", ["get", "kind"], "compass"], 15, 11], "text-allow-overlap": true }, paint: { "text-color": "#7fe6da", "text-opacity": ["case", ["==", ["get", "kind"], "compass"], 0.85, 0.55], "text-halo-color": "#050a0c", "text-halo-width": 1.2 } },
      ],
      sky: { "sky-color": "#0a1a2b", "horizon-color": "#0d1618", "fog-color": "#0b1416", "sky-horizon-blend": 0.6, "horizon-fog-blend": 0.6 },
    },
  });
  // Swapped mouse drag (per request): LEFT-drag rotates/tilts, RIGHT-drag pans. MapLibre has
  // no button-swap option, so drive both by hand off the canvas' mouse events. Wheel-zoom,
  // keyboard and touch pinch/rotate keep working through their own handlers.
  map.dragPan.disable();
  map.dragRotate.disable();
  map.touchZoomRotate.enableRotation();
  // Generate the tactical airfield glyph icons on demand (per class colour).
  map.on("styleimagemissing", (e) => {
    const color = AF_ICON_COLORS[e.id];
    if (color && !map.hasImage(e.id)) map.addImage(e.id, makeAirfieldIcon(color), { pixelRatio: 2 });
  });
  const cv = map.getCanvas();
  let drag = null;
  let dragMoved = false; // set once a gesture actually drags, so the trailing map "click" is ignored
  let followActive = false; // camera tracks the selected aircraft until the user drags the map
  const onCtx = (e) => e.preventDefault();
  const onDown = (e) => {
    dragMoved = false;
    followActive = false; // any manual drag stops auto-tracking
    if (e.button === 0) drag = { mode: "rotate", x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, bearing: map.getBearing(), pitch: map.getPitch() };
    else if (e.button === 2) drag = { mode: "pan", x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY };
  };
  const onMove = (e) => {
    if (!drag) return;
    if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 3) dragMoved = true;
    if (drag.mode === "rotate") {
      map.setBearing(drag.bearing + (e.clientX - drag.x) * 0.35);
      map.setPitch(Math.max(0, Math.min(map.getMaxPitch(), drag.pitch - (e.clientY - drag.y) * 0.25)));
    } else {
      // At near-horizon pitch a small drag can unproject to a wild ground point; undo any step that
      // jumps the centre absurdly far so it never teleports to a garbage coordinate.
      const before = map.getCenter();
      map.panBy([-(e.clientX - drag.x), -(e.clientY - drag.y)], { duration: 0 });
      const after = map.getCenter();
      if (Math.abs(after.lng - before.lng) > 2 || Math.abs(after.lat - before.lat) > 2) map.setCenter(before);
      drag.x = e.clientX; drag.y = e.clientY; // pan is incremental
    }
  };
  const onUp = () => { drag = null; };
  cv.addEventListener("contextmenu", onCtx);
  cv.addEventListener("mousedown", onDown);
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);

  // pickingRadius widens the click/hover search around the pointer so selecting an aircraft is
  // forgiving (on top of the invisible hit disc) — no pixel-perfect aim on the small model.
  const overlay = new MapboxOverlay({ interleaved: true, pickingRadius: 16, layers: [] });
  map.addControl(overlay);
  if (typeof window !== "undefined" && window.__T3D_DEBUG) { window.__t3dMap = map; window.__t3dOverlay = overlay; window.__WMV = WebMercatorViewport; }

  // --- DOM overlay: data-block popovers + pins (exact old styling), airfield popover ------
  const overlayEl = document.createElement("div");
  overlayEl.className = "t3d-overlay";
  const afTooltipEl = document.createElement("div");
  afTooltipEl.className = "t3d-tt airfield-tt";
  afTooltipEl.style.display = "none";
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
  hintEl.textContent = "Drag rotate · Ctrl/right-drag tilt · Scroll zoom";
  container.append(overlayEl, afTooltipEl, lockEl, loadingEl, hintEl);

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
      out.push({ hex: item.hex, lon: item.lon, lat: item.lat, z: altM * exagg, airborne, rgb, cls, orientation: [-phi, 90 - track, -bank], coasting: deps.isCoasting(item), item });
    }
    return out;
  }

  // --- deck layers ------------------------------------------------------------------------
  let lastList = [];
  function buildLayers() {
    if (!ready) return;
    const list = aircraftList();
    lastList = list;
    const selHex = deps.getSelectedHex();

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
        const pt = [p.lon, p.lat, altM * exagg];
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
    const ghostData = ghost && ghost.lat != null ? [{ lon: ghost.lon, lat: ghost.lat, z: ((ghost.altBaro ?? ghost.altGeom) || 0) * FT_TO_M * exagg, rgb: parseRgb(deps.altitudeColor(ghost)), orientation: [0, 90 - (Number.isFinite(ghost.track) ? ghost.track : 0), 0] }] : [];

    const covMesh = coverageMesh();
    // Aircraft grouped by size class so per-category size differences survive the pixel clamp
    // (constant on-screen size per class). Colours are brightened toward white so the target reads
    // as a bright contact against the (translucent) coverage — no outline/ring, just luminance.
    const byCls = new Map();
    for (const d of list) { const g = byCls.get(d.cls) || []; g.push(d); byCls.set(d.cls, g); }
    const bright = (v) => Math.round(v + (255 - v) * 0.34);
    const aircraftLayers = [...byCls.entries()].map(([cls, data]) => new ScenegraphLayer({
      id: `aircraft-${cls}`, data, scenegraph: MODEL_URI, getPosition: (d) => [d.lon, d.lat, d.z], getOrientation: (d) => d.orientation,
      getColor: (d) => [bright(d.rgb.r), bright(d.rgb.g), bright(d.rgb.b), d.coasting ? 150 : 255],
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
      covMesh && new SimpleMeshLayer({
        id: "coverage-depth", data: COV_ANCHOR, mesh: covMesh, getPosition: (d) => d.position,
        getColor: [0, 0, 0, 0], sizeScale: 1, material: covMat, pickable: false,
        // alpha 0 with blending on leaves colour untouched; the point of this pass is the depth write.
        parameters: { depthWriteEnabled: true, depthCompare: "less-equal" },
      }),
      covMesh && new SimpleMeshLayer({
        id: "coverage", data: COV_ANCHOR, mesh: covMesh, getPosition: (d) => d.position,
        getColor: [255, 255, 255, 58], sizeScale: 1, material: covMat, pickable: false,
        parameters: { depthWriteEnabled: false, depthCompare: "less-equal" },
      }),
      // Targets ignore the depth buffer (depthCompare 'always') so the dome/terrain never hide them.
      // Trail: a single crisp altitude-gradient line (no glow/casing). billboard:true keeps the
      // ribbon facing the camera, so it has the same thickness from the side as from above.
      new PathLayer({ id: "trails", data: trails, getPath: (d) => d.path, getColor: (d) => d.color, widthUnits: "pixels", getWidth: 2.8, widthMinPixels: 2.2, billboard: true, jointRounded: true, capRounded: true, parameters: { depthCompare: "always" } }),
      new LineLayer({ id: "sticks", data: sticks, getSourcePosition: (d) => d.source, getTargetPosition: (d) => d.target, getColor: (d) => d.color, widthUnits: "pixels", getWidth: 1.6, widthMinPixels: 1.2, parameters: { depthCompare: "always" } }),
      // Small dot at each stick's ground foot (the old view had these).
      new ScatterplotLayer({ id: "ground-dots", data: sticks, getPosition: (d) => d.target, radiusUnits: "pixels", getRadius: 3, radiusMinPixels: 2.5, radiusMaxPixels: 4, filled: true, stroked: false, getFillColor: (d) => d.color, parameters: { depthCompare: "always" } }),
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
  // per-vertex colour carries the altitude gradient, the layer's getColor alpha the translucency.
  const M_PER_DEG_LON = M_PER_DEG_LAT * Math.cos((HOME.lat * Math.PI) / 180);
  function coverageMesh() {
    if (!deps.getSettings().coverage) return null;
    const positions = [];
    const colors = [];
    // Metre offset of a ring vertex from HOME (the SimpleMeshLayer anchor).
    const off = (pt, z) => [(pt[0] - HOME.lon) * M_PER_DEG_LON, (pt[1] - HOME.lat) * M_PER_DEG_LAT, z];
    const pushV = (p, c) => { positions.push(p[0], p[1], p[2]); colors.push(c.r / 255, c.g / 255, c.b / 255); };
    for (const area of deps.getCoverage()?.areas || []) {
      const vol = area.volume;
      if (!vol?.layers?.length) continue;
      const levels = [{ feet: 0, ring: vol.layers[0].ring }];
      for (const l of vol.layers) levels.push({ feet: l.midAltitude, ring: l.ring });
      const N = Math.min(...levels.map((lv) => lv.ring.length)) - 1; // azimuth samples (ring closes)
      if (N < 3) continue;
      const zc = levels.map((lv) => lv.feet * FT_TO_M * exagg);
      const cc = levels.map((lv) => parseRgb(deps.altitudeColorFeet(lv.feet)));
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
          pushV(p00, cc[l]); pushV(p01, cc[l]); pushV(p11, cc[l + 1]);
          pushV(p00, cc[l]); pushV(p11, cc[l + 1]); pushV(p10, cc[l + 1]);
        }
      }
    }
    if (!positions.length) return null;
    return {
      attributes: {
        positions: { value: new Float32Array(positions), size: 3 },
        colors: { value: new Float32Array(colors), size: 3 },
      },
    };
  }

  // --- HTML data blocks (pinned / selected / hovered), positioned via the deck viewport ---
  function project(lon, lat, z) {
    const vp = overlay._deck?.getViewports?.()[0];
    if (!vp) return null;
    const p = vp.project([lon, lat, z]);
    return p && Number.isFinite(p[0]) ? p : null;
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
  const AF_LAYERS = ["airfield-icon"]; // one symbol layer (icon + label) — hover/click on either
  const activeAf = () => afPinned || hoverAf?.field || null;
  function showAf(field) { afTooltipEl.innerHTML = deps.airfieldTooltip(field); afTooltipEl.style.display = ""; positionAfTooltip(); }
  function positionAfTooltip() { const f = activeAf(); if (!f) return; const p = map.project([f.lon, f.lat]); afTooltipEl.style.transform = `translate3d(${p.x.toFixed(1)}px, ${(p.y - 12).toFixed(1)}px, 0) translate(-50%, -100%)`; }
  map.on("render", () => { positionAfTooltip(); syncBlocks(); });
  map.on("mousemove", AF_LAYERS, (e) => {
    const field = airfieldByKey.get(e.features?.[0]?.properties?.key);
    if (field && field !== hoverAf?.field) { hoverAf = { field }; map.getCanvas().style.cursor = "pointer"; if (!afPinned) showAf(field); }
  });
  map.on("mouseleave", AF_LAYERS, () => { hoverAf = null; if (!hoverHex) map.getCanvas().style.cursor = ""; if (!afPinned) afTooltipEl.style.display = "none"; });
  map.on("click", (e) => {
    if (dragMoved) { dragMoved = false; return; }
    // Aircraft: pick synchronously off MapLibre's (immediate) click instead of deck's onClick,
    // which waits ~300ms to disambiguate single- vs double-click — that lag was the select delay.
    const hit = overlay._deck?.pickObject?.({ x: e.point.x, y: e.point.y, radius: 18, layerIds: ["hit"] });
    if (hit?.object?.hex) { deps.onSelect(hit.object.hex); return; }
    const field = airfieldByKey.get(map.queryRenderedFeatures(e.point, { layers: AF_LAYERS })[0]?.properties?.key);
    if (field) { afPinned = field; showAf(field); return; } // clicking an airfield pins its popover
    if (afPinned) { afPinned = null; afTooltipEl.style.display = "none"; } // click elsewhere clears it
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
    else { hoverHex = null; hoverAf = null; afTooltipEl.style.display = "none"; }
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
    followSettleUntil = performance.now() + 780;
    map.easeTo({ center: centerFor(lon, lat, (altFt != null ? altFt * FT_TO_M : 0) * exagg), duration: 750, easing: EASE_OUT });
  }
  // Continuously keep the selected aircraft centred (smooth linear glide) until the user drags the
  // map — but not until the focus/locate animation has settled, so its ease-out plays out.
  function followSelected() {
    if (!followActive) return;
    const selHex = deps.getSelectedHex();
    if (!selHex) { followActive = false; return; }
    if (performance.now() < followSettleUntil) return;
    const d = lastList.find((x) => x.hex === selHex);
    if (d) map.easeTo({ center: centerFor(d.lon, d.lat, d.z), duration: 1100, easing: (t) => t });
  }
  // Locate button: ONE ease-out easeTo that changes zoom + pan together (centred on the aircraft at
  // altitude via the geometric centre, computed for the TARGET pitch), and resumes tracking.
  function flyToView(lon, lat, zoom, altFt) {
    const z = altFt != null ? altFt * FT_TO_M * exagg : 0;
    if (altFt != null) { followActive = true; followSettleUntil = performance.now() + 980; }
    map.easeTo({ center: centerFor(lon, lat, z, 55, zoom + 1), zoom: zoom + 1, pitch: 55, duration: 900, easing: EASE_OUT });
  }
  function fitAircraft(points) { if (!points.length) return; const b = new maplibregl.LngLatBounds(); for (const p of points) b.extend([p.lon, p.lat]); map.fitBounds(b, { padding: 80, maxZoom: 9, pitch: 55, duration: 900 }); }
  function destroy() {
    disposed = true;
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    try { map.removeControl(overlay); } catch { /* gone */ }
    map.remove();
    for (const el of [overlayEl, afTooltipEl, lockEl, loadingEl, hintEl]) el.remove();
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
