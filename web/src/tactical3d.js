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
import { MapboxOverlay } from "@deck.gl/mapbox";
import { ScenegraphLayer, SimpleMeshLayer } from "@deck.gl/mesh-layers";
import { PathLayer, LineLayer, ScatterplotLayer } from "@deck.gl/layers";
import { AIRFIELDS, isMinorAirfield } from "./airfields.js";

const FT_TO_M = 0.3048;
const HOME = { lon: 127.33113, lat: 36.36599 }; // Yuseong IC
const SAT_TILES = ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"];
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
    maxPitch: 85,
    pitch: 55,
    zoom: 6,
    center: [HOME.lon, HOME.lat],
    style: {
      version: 8,
      glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
      sources: {
        satellite: { type: "raster", tiles: SAT_TILES, tileSize: 256, maxzoom: 19, attribution: "Esri, Maxar, Earthstar Geographics" },
        dem: { type: "raster-dem", tiles: DEM_TILES, encoding: "terrarium", tileSize: 256, maxzoom: 15 },
        demShade: { type: "raster-dem", tiles: DEM_TILES, encoding: "terrarium", tileSize: 256, maxzoom: 15 },
        contours: { type: "vector", tiles: [contour.contourProtocolUrl({ multiplier: 1, thresholds: { 8: [500, 2000], 10: [200, 1000], 12: [100, 500], 14: [50, 250] }, elevationKey: "ele", levelKey: "level", contourLayer: "contours" })], maxzoom: 15 },
        grid: { type: "geojson", data: EMPTY_FC },
        airfields: { type: "geojson", data: EMPTY_FC },
        rings: { type: "geojson", data: EMPTY_FC },
      },
      layers: [
        { id: "bg", type: "background", paint: { "background-color": "#050a0c" } },
        { id: "hillshade", type: "hillshade", source: "demShade", paint: { "hillshade-shadow-color": "#020a0c", "hillshade-highlight-color": "#1d6f66", "hillshade-accent-color": "#0b3a38", "hillshade-exaggeration": 0.75 } },
        { id: "sat", type: "raster", source: "satellite", layout: { visibility: "none" }, paint: { "raster-saturation": -0.15 } },
        { id: "grid-line", type: "line", source: "grid", paint: { "line-color": "#48e0d1", "line-opacity": ["match", ["get", "major"], 1, 0.28, 0.12], "line-width": ["match", ["get", "major"], 1, 1, 0.6] } },
        { id: "contour-line", type: "line", source: "contours", "source-layer": "contours", paint: { "line-color": "#48e0d1", "line-opacity": ["match", ["get", "level"], 1, 0.4, 0.16], "line-width": ["match", ["get", "level"], 1, 1.1, 0.6], "line-blur": 0.6 } },
        { id: "rings-line", type: "line", source: "rings", filter: ["==", ["get", "kind"], "ring"], paint: { "line-color": "#48e0d1", "line-opacity": 0.5, "line-width": 1.3, "line-blur": 1.2 } },
        { id: "airfield-dot", type: "circle", source: "airfields", paint: { "circle-radius": ["get", "r"], "circle-color": ["get", "color"], "circle-stroke-color": "#071012", "circle-stroke-width": 1, "circle-opacity": 0.95 } },
        { id: "airfield-code", type: "symbol", source: "airfields", filter: ["==", ["get", "minor"], false], layout: { "text-field": ["get", "code"], "text-font": ["Open Sans Regular"], "text-size": 11, "text-offset": [0.9, 0], "text-anchor": "left" }, paint: { "text-color": "#cfe9e4", "text-halo-color": "#071012", "text-halo-width": 1.4 } },
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
  const cv = map.getCanvas();
  let drag = null;
  const onCtx = (e) => e.preventDefault();
  const onDown = (e) => {
    if (e.button === 0) drag = { mode: "rotate", x: e.clientX, y: e.clientY, bearing: map.getBearing(), pitch: map.getPitch() };
    else if (e.button === 2) drag = { mode: "pan", x: e.clientX, y: e.clientY };
  };
  const onMove = (e) => {
    if (!drag) return;
    if (drag.mode === "rotate") {
      map.setBearing(drag.bearing + (e.clientX - drag.x) * 0.35);
      map.setPitch(Math.max(0, Math.min(map.getMaxPitch(), drag.pitch - (e.clientY - drag.y) * 0.25)));
    } else {
      map.panBy([-(e.clientX - drag.x), -(e.clientY - drag.y)], { duration: 0 });
      drag.x = e.clientX; drag.y = e.clientY; // pan is incremental
    }
  };
  const onUp = () => { drag = null; };
  cv.addEventListener("contextmenu", onCtx);
  cv.addEventListener("mousedown", onDown);
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);

  const overlay = new MapboxOverlay({ interleaved: true, layers: [] });
  map.addControl(overlay);
  if (typeof window !== "undefined" && window.__T3D_DEBUG) { window.__t3dMap = map; window.__t3dOverlay = overlay; }

  // --- DOM overlay: data-block popovers + pins (exact old styling), airfield popover ------
  const overlayEl = document.createElement("div");
  overlayEl.className = "t3d-overlay";
  const afTooltipEl = document.createElement("div");
  afTooltipEl.className = "t3d-tt airfield-tt";
  afTooltipEl.style.display = "none";
  const loadingEl = document.createElement("div");
  loadingEl.className = "t3d-loading";
  loadingEl.textContent = "LOADING TERRAIN…";
  const hintEl = document.createElement("div");
  hintEl.className = "t3d-hint";
  hintEl.textContent = "Drag rotate · Ctrl/right-drag tilt · Scroll zoom";
  container.append(overlayEl, afTooltipEl, loadingEl, hintEl);

  let hoverHex = null;
  let hoverAf = null;
  let activeHex = null;
  let activeClearTimer = 0;
  let clickedObject = false;
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
      out.push({ hex: item.hex, lon: item.lon, lat: item.lat, z: altM * exagg, airborne, rgb, orientation: [phi, 90 - track, bank], coasting: deps.isCoasting(item), item });
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

    const layers = [
      covMesh && new SimpleMeshLayer({
        id: "coverage", data: COV_ANCHOR, mesh: covMesh, getPosition: (d) => d.position,
        getColor: [255, 255, 255, 66], sizeScale: 1,
        material: { ambient: 1, diffuse: 0, shininess: 1, specularColor: [0, 0, 0] },
        // deck 9 / luma v9 pipeline params (WebGPU-style keys). The dome must not WRITE depth,
        // or it occludes every target drawn after it; it is still depth-tested against terrain.
        pickable: false, parameters: { depthWriteEnabled: false },
      }),
      // Targets ignore the depth buffer (depthCompare 'always') so the dome/terrain never hide them.
      // Trail = a dark casing under a colour (altitude-gradient) line, exactly like the old view.
      new PathLayer({ id: "trails-casing", data: trails, getPath: (d) => d.path, getColor: [2, 9, 11, 190], widthUnits: "pixels", getWidth: 4, widthMinPixels: 3.4, jointRounded: true, capRounded: true, parameters: { depthCompare: "always" } }),
      new PathLayer({ id: "trails", data: trails, getPath: (d) => d.path, getColor: (d) => d.color, widthUnits: "pixels", getWidth: 2.3, widthMinPixels: 2, jointRounded: true, capRounded: true, parameters: { depthCompare: "always" } }),
      new LineLayer({ id: "sticks", data: sticks, getSourcePosition: (d) => d.source, getTargetPosition: (d) => d.target, getColor: (d) => d.color, widthUnits: "pixels", getWidth: 1.6, widthMinPixels: 1.2, parameters: { depthCompare: "always" } }),
      new ScenegraphLayer({
        id: "aircraft", data: list, scenegraph: MODEL_URI, getPosition: (d) => [d.lon, d.lat, d.z], getOrientation: (d) => d.orientation,
        getColor: (d) => [d.rgb.r, d.rgb.g, d.rgb.b, d.coasting ? 140 : 255], sizeScale: 130, sizeMinPixels: 34, sizeMaxPixels: 46, _lighting: "pbr",
        pickable: false, parameters: { depthCompare: "always" },
      }),
      ghostData.length && new ScenegraphLayer({ id: "ghost", data: ghostData, scenegraph: MODEL_URI, getPosition: (d) => [d.lon, d.lat, d.z], getOrientation: (d) => d.orientation, getColor: (d) => [d.rgb.r, d.rgb.g, d.rgb.b, 150], sizeScale: 120, sizeMinPixels: 30, sizeMaxPixels: 42, parameters: { depthCompare: "always" } }),
      // Invisible, generous click/hover target (like the old hit sphere): a constant ~44px disc
      // per aircraft so selecting never needs pixel-perfect aim on the small model.
      new ScatterplotLayer({
        id: "hit", data: list, getPosition: (d) => [d.lon, d.lat, d.z], radiusUnits: "pixels", getRadius: 22, radiusMinPixels: 22, radiusMaxPixels: 22,
        filled: true, stroked: false, getFillColor: [0, 0, 0, 0], pickable: true, onClick: onAircraftClick, onHover: onAircraftHover, parameters: { depthCompare: "always" },
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
  }

  // --- Interaction ------------------------------------------------------------------------
  function onAircraftClick(info) { if (info.object) { clickedObject = true; deps.onSelect(info.object.hex); } }
  function onAircraftHover(info) {
    const hex = info.object?.hex || null;
    if (hex !== hoverHex) { hoverHex = hex; deps.onHover(hex); map.getCanvas().style.cursor = hex ? "pointer" : ""; scheduleActive(hex); }
  }
  const airfieldByKey = new Map();
  function positionAfTooltip() { if (!hoverAf) return; const p = map.project([hoverAf.field.lon, hoverAf.field.lat]); afTooltipEl.style.transform = `translate3d(${p.x.toFixed(1)}px, ${(p.y - 12).toFixed(1)}px, 0) translate(-50%, -100%)`; }
  map.on("render", () => { positionAfTooltip(); syncBlocks(); });
  map.on("mousemove", "airfield-dot", (e) => {
    const key = e.features?.[0]?.properties?.key;
    const field = key && airfieldByKey.get(key);
    if (field && field !== hoverAf?.field) { hoverAf = { field }; afTooltipEl.innerHTML = deps.airfieldTooltip(field); afTooltipEl.style.display = ""; positionAfTooltip(); map.getCanvas().style.cursor = "pointer"; }
  });
  map.on("mouseleave", "airfield-dot", () => { hoverAf = null; afTooltipEl.style.display = "none"; if (!hoverHex) map.getCanvas().style.cursor = ""; });
  map.on("click", () => { if (clickedObject) { clickedObject = false; return; } deps.onMapClick(); });

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
      const color = minor ? "#8b98a5" : f.kind === "large" ? "#ffd23f" : f.kind === "medium" ? "#ff9f45" : "#c3ccd6";
      features.push({ type: "Feature", properties: { key, code: f.code, minor, r: minor ? 4 : f.kind === "large" ? 6 : 5, color }, geometry: { type: "Point", coordinates: [f.lon, f.lat] } });
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
  function dataPass() { buildLayers(); }
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
  function setCameraFromMap(center, zoom) { map.jumpTo({ center: [center.lng ?? center.lon, center.lat], zoom: zoom - 1, pitch: 55 }); }
  function getCameraForMap() { const c = map.getCenter(); return { center: [c.lat, c.lng], zoom: Math.min(18, Math.max(3, Math.round(map.getZoom() + 1))) }; }
  function panTo(lon, lat) { map.easeTo({ center: [lon, lat], duration: 700 }); }
  function flyToView(lon, lat, zoom) { map.flyTo({ center: [lon, lat], zoom: zoom - 1, pitch: 55, duration: 900 }); }
  function fitAircraft(points) { if (!points.length) return; const b = new maplibregl.LngLatBounds(); for (const p of points) b.extend([p.lon, p.lat]); map.fitBounds(b, { padding: 80, maxZoom: 9, pitch: 55, duration: 900 }); }
  function destroy() {
    disposed = true;
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    try { map.removeControl(overlay); } catch { /* gone */ }
    map.remove();
    for (const el of [overlayEl, afTooltipEl, loadingEl, hintEl]) el.remove();
  }

  map.on("load", () => {
    if (disposed) return;
    ready = true;
    map.setTerrain({ source: "dem", exaggeration: exagg });
    loadingEl.style.display = "none";
    refreshSources();
    buildLayers();
  });
  setCameraFromMap({ lat: HOME.lat, lng: HOME.lon }, 7);

  return { setActive, resize, dataPass, drawCoverage, applySettings, setHoverClass, panTo, flyToView, fitAircraft, setCameraFromMap, getCameraForMap, destroy };
}
