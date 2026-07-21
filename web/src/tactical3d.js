// 3D tactical view on MapLibre GL v5 (globe + raster-DEM terrain + satellite, all LOD, no
// key, reusing the same Terrarium DEM the app already uses) with a deck.gl overlay for the
// GPU bits: glTF aircraft (ScenegraphLayer), altitude sticks, trails, labels and pins.
// Coverage/runways ride as MapLibre native layers so they follow the terrain.
//
// Loaded only via dynamic import from App.vue, so these libs stay out of the 2D bundle. All
// app state/formatting comes through `deps`; the exported factory keeps the same API the 2D
// integration already calls.
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { ScenegraphLayer } from "@deck.gl/mesh-layers";
import { PathLayer, LineLayer, TextLayer, IconLayer } from "@deck.gl/layers";
import { AIRFIELDS, isMinorAirfield } from "./airfields.js";
import { RUNWAYS } from "./runways.js";

const FT_TO_M = 0.3048;
const HOME = { lon: 127.33113, lat: 36.36599 }; // Yuseong IC
const SAT_TILES = ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"];
const DEM_TILES = ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"];
const MODEL_URI = `${import.meta.env.BASE_URL}aircraft.glb`;
const EMPTY_FC = { type: "FeatureCollection", features: [] };
const PIN_SVG = "data:image/svg+xml;base64," + btoa(
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="white"><path d="M12 2a5 5 0 0 0-5 5c0 3 5 9 5 9s5-6 5-9a5 5 0 0 0-5-5zm0 7a2 2 0 1 1 0-4 2 2 0 0 1 0 4z"/></svg>');

// deps colors are `hsl(H S% L%)` or hex; parse to {r,g,b} 0-255 once.
function parseRgb(css) {
  const m = /hsl\(\s*([\d.]+)[ ,]+([\d.]+)%[ ,]+([\d.]+)%\s*\)/.exec(css);
  if (m) {
    const h = Number(m[1]) / 360;
    const s = Number(m[2]) / 100;
    const l = Number(m[3]) / 100;
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const hue = (t) => {
      t = (t + 1) % 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    return { r: Math.round(hue(h + 1 / 3) * 255), g: Math.round(hue(h) * 255), b: Math.round(hue(h - 1 / 3) * 255) };
  }
  const hex = css.replace("#", "");
  const n = hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex;
  return { r: parseInt(n.slice(0, 2), 16), g: parseInt(n.slice(2, 4), 16), b: parseInt(n.slice(4, 6), 16) };
}
const rgbHex = (c) => `#${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;

export function createTactical3d({ container, deps }) {
  let exagg = Math.max(1, Math.min(4, Number(deps.getSettings().terrainExaggeration) || 2));
  let disposed = false;
  let running = false;
  let ready = false;

  // --- MapLibre map: mercator (NOT globe — deck.gl overlay only aligns in mercator),
  // satellite raster + raster-DEM terrain + sky, plus tactical range rings / compass /
  // airfields as native layers so they drape on the terrain and match exactly ------------
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
        runways: { type: "geojson", data: EMPTY_FC },
        airfields: { type: "geojson", data: EMPTY_FC },
        rings: { type: "geojson", data: EMPTY_FC },
      },
      layers: [
        { id: "bg", type: "background", paint: { "background-color": "#050a0c" } },
        { id: "sat", type: "raster", source: "satellite", paint: { "raster-saturation": -0.25, "raster-brightness-max": 0.92 } },
        { id: "rings-line", type: "line", source: "rings", filter: ["==", ["get", "kind"], "ring"], paint: { "line-color": "#48e0d1", "line-opacity": 0.45, "line-width": 1.3, "line-blur": 1.2 } },
        { id: "runway-fill", type: "fill", source: "runways", paint: { "fill-color": "#262b31", "fill-opacity": 0.95 } },
        { id: "runway-line", type: "line", source: "runways", paint: { "line-color": "#e8edf2", "line-width": 1, "line-opacity": 0.85 } },
        { id: "airfield-dot", type: "circle", source: "airfields", paint: { "circle-radius": ["get", "r"], "circle-color": ["get", "color"], "circle-stroke-color": "#071012", "circle-stroke-width": 1, "circle-opacity": 0.95 } },
        { id: "airfield-code", type: "symbol", source: "airfields", filter: ["==", ["get", "minor"], false], layout: { "text-field": ["get", "code"], "text-font": ["Open Sans Regular"], "text-size": 11, "text-offset": [0.9, 0], "text-anchor": "left", "text-allow-overlap": false }, paint: { "text-color": "#cfe9e4", "text-halo-color": "#071012", "text-halo-width": 1.4 } },
        { id: "ring-label", type: "symbol", source: "rings", filter: ["in", ["get", "kind"], ["literal", ["ringlabel", "compass"]]], layout: { "text-field": ["get", "label"], "text-font": ["Open Sans Regular"], "text-size": ["case", ["==", ["get", "kind"], "compass"], 15, 11], "text-allow-overlap": true }, paint: { "text-color": "#7fe6da", "text-opacity": ["case", ["==", ["get", "kind"], "compass"], 0.85, 0.5], "text-halo-color": "#050a0c", "text-halo-width": 1.2 } },
      ],
      sky: { "sky-color": "#0a1a2b", "horizon-color": "#0d1618", "fog-color": "#0d1618", "sky-horizon-blend": 0.6, "horizon-fog-blend": 0.6 },
    },
  });
  map.dragRotate.enable();
  map.touchZoomRotate.enableRotation();

  // --- deck.gl overlay (interleaved so it shares MapLibre's WebGL2 context) ---------------
  const overlay = new MapboxOverlay({ interleaved: true, layers: [] });
  map.addControl(overlay);

  // --- DOM overlay for the airfield hover popover, loading + hint -------------------------
  const afTooltipEl = document.createElement("div");
  afTooltipEl.className = "t3d-tt airfield-tt";
  afTooltipEl.style.display = "none";
  const loadingEl = document.createElement("div");
  loadingEl.className = "t3d-loading";
  loadingEl.textContent = "LOADING GLOBE…";
  const hintEl = document.createElement("div");
  hintEl.className = "t3d-hint";
  hintEl.textContent = "Drag rotate · Ctrl/right-drag tilt · Scroll zoom";
  container.append(afTooltipEl, loadingEl, hintEl);

  let hoverHex = null;
  let hoverAf = null;
  let clickedObject = false; // set by deck layer onClick so the map click doesn't also deselect

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
        if (vs != null && gs > 5) phi = (Math.atan2(vs * 0.00508, gs) * 3 * 180) / Math.PI; // exaggerated climb, deg
        phi = Math.max(-40, Math.min(40, phi));
      }
      const bank = airborne && Number.isFinite(item.roll) ? Math.max(-45, Math.min(45, item.roll)) : 0;
      const track = Number.isFinite(item.track) ? item.track : 0;
      out.push({
        hex: item.hex,
        lon: item.lon,
        lat: item.lat,
        z: altM * exagg,
        airborne,
        rgb,
        // deck ScenegraphLayer getOrientation = [pitch, yaw, roll] deg. Model nose +X; yaw
        // is measured CCW so track (CW from north) maps to (90 - track).
        orientation: [phi, 90 - track, bank],
        coasting: deps.isCoasting(item),
        label: deps.labelText(item),
        item,
      });
    }
    return out;
  }

  // --- deck layers ------------------------------------------------------------------------
  function buildLayers() {
    if (!ready) return;
    const list = aircraftList();
    const byHex = new Map(list.map((d) => [d.hex, d]));
    const pinned = deps.getPinned();
    const selHex = deps.getSelectedHex();
    const labelHexes = new Set([...pinned, selHex, hoverHex].filter(Boolean));

    // Sticks (airborne only): aircraft -> ground.
    const sticks = list.filter((d) => d.airborne).map((d) => ({
      source: [d.lon, d.lat, d.z], target: [d.lon, d.lat, 0], color: [d.rgb.r, d.rgb.g, d.rgb.b, 200],
    }));

    // Trails: selected + pinned, altitude-coloured runs.
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
        } else {
          run.path.push(pt);
        }
        prevT = t;
      }
      if (run && run.path.length >= 2) trails.push(run);
    };
    const selTrack = deps.getSelectedTrack();
    if (selHex && selTrack.length) { addTrail(selTrack); seen.add(selHex); }
    for (const { hex, points } of deps.getPinnedTracks()) if (!seen.has(hex) && points?.length) { seen.add(hex); addTrail(points); }

    // Labels + pins for the relevant aircraft.
    const labelData = list.filter((d) => labelHexes.has(d.hex));
    const ghost = deps.getPlaybackGhost();
    const ghostData = ghost && ghost.lat != null ? [{
      hex: "__ghost__", lon: ghost.lon, lat: ghost.lat,
      z: ((ghost.altBaro ?? ghost.altGeom) || 0) * FT_TO_M * exagg,
      rgb: parseRgb(deps.altitudeColor(ghost)),
      orientation: [0, 90 - (Number.isFinite(ghost.track) ? ghost.track : 0), 0],
    }] : [];

    // Coverage as a clean altitude-coloured wireframe dome (ring per layer), not a
    // translucent extrusion (which stacked into an ugly patchwork up close).
    const covPaths = [];
    if (deps.getSettings().coverage) {
      for (const area of deps.getCoverage()?.areas || []) {
        for (const layer of area.volume?.layers || []) {
          if (!layer.ring || layer.ring.length < 4) continue;
          const c = parseRgb(deps.altitudeColorFeet(layer.midAltitude));
          covPaths.push({ path: layer.ring.map(([lon, lat]) => [lon, lat, layer.midAltitude * FT_TO_M * exagg]), color: [c.r, c.g, c.b, 150] });
        }
      }
    }

    const layers = [
      covPaths.length && new PathLayer({
        id: "coverage", data: covPaths, getPath: (d) => d.path, getColor: (d) => d.color,
        widthUnits: "pixels", getWidth: 1.4, widthMinPixels: 1, jointRounded: true, parameters: { depthTest: false },
      }),
      new PathLayer({
        id: "trails", data: trails, getPath: (d) => d.path, getColor: (d) => d.color,
        widthUnits: "pixels", getWidth: 3, widthMinPixels: 2, jointRounded: true, capRounded: true, parameters: { depthTest: false },
      }),
      new LineLayer({
        id: "sticks", data: sticks, getSourcePosition: (d) => d.source, getTargetPosition: (d) => d.target,
        getColor: (d) => d.color, widthUnits: "pixels", getWidth: 1.6, widthMinPixels: 1,
      }),
      new ScenegraphLayer({
        id: "aircraft", data: list, scenegraph: MODEL_URI,
        getPosition: (d) => [d.lon, d.lat, d.z], getOrientation: (d) => d.orientation,
        getColor: (d) => [d.rgb.r, d.rgb.g, d.rgb.b, d.coasting ? 140 : 255],
        sizeScale: 220, sizeMinPixels: 26, sizeMaxPixels: 90, _lighting: "pbr",
        pickable: true, onClick: onAircraftClick, onHover: onAircraftHover,
        updateTriggers: { getColor: [Date.now() >> 11] }, // repaint-ish for blink cadence
        parameters: { depthTest: true },
      }),
      ghostData.length && new ScenegraphLayer({
        id: "ghost", data: ghostData, scenegraph: MODEL_URI,
        getPosition: (d) => [d.lon, d.lat, d.z], getOrientation: (d) => d.orientation,
        getColor: (d) => [d.rgb.r, d.rgb.g, d.rgb.b, 150], sizeScale: 200, sizeMinPixels: 22, sizeMaxPixels: 80,
        parameters: { depthTest: true },
      }),
      labelData.length && new TextLayer({
        id: "labels", data: labelData, getPosition: (d) => [d.lon, d.lat, d.z], getText: (d) => d.label,
        getSize: 11, getColor: [159, 232, 223, 255], getPixelOffset: [16, 2], getTextAnchor: "start",
        fontFamily: "ui-monospace, monospace", fontWeight: 600, lineHeight: 1.3, background: true,
        getBackgroundColor: [5, 10, 12, 190], backgroundPadding: [5, 3], parameters: { depthTest: false },
      }),
      labelData.length && new IconLayer({
        id: "pins", data: labelData, getPosition: (d) => [d.lon, d.lat, d.z],
        getIcon: () => ({ url: PIN_SVG, width: 24, height: 24, mask: true }), getSize: 15,
        getColor: (d) => (deps.getPinned().has(d.hex) ? [72, 224, 209, 255] : [150, 163, 164, 220]),
        getPixelOffset: [8, -12], pickable: true, onClick: onPinClick, parameters: { depthTest: false },
      }),
    ].filter(Boolean);
    overlay.setProps({ layers });
    void byHex;
  }

  // --- Interaction callbacks --------------------------------------------------------------
  function onAircraftClick(info) { if (info.object) { clickedObject = true; deps.onSelect(info.object.hex); } }
  function onPinClick(info) { if (info.object) { clickedObject = true; deps.togglePin(info.object.hex); buildLayers(); } }
  function onAircraftHover(info) {
    const hex = info.object?.hex || null;
    if (hex !== hoverHex) { hoverHex = hex; deps.onHover(hex); map.getCanvas().style.cursor = hex ? "pointer" : ""; buildLayers(); }
  }
  // Airfield hover: query the native circle layer (terrain-aligned) and show the popover.
  const airfieldByKey = new Map();
  function positionAfTooltip() {
    if (!hoverAf) return;
    const p = map.project([hoverAf.field.lon, hoverAf.field.lat]);
    afTooltipEl.style.transform = `translate3d(${p.x.toFixed(1)}px, ${(p.y - 12).toFixed(1)}px, 0) translate(-50%, -100%)`;
  }
  map.on("render", positionAfTooltip);
  map.on("mousemove", "airfield-dot", (e) => {
    const key = e.features?.[0]?.properties?.key;
    const field = key && airfieldByKey.get(key);
    if (field && field !== hoverAf?.field) {
      hoverAf = { field };
      afTooltipEl.innerHTML = deps.airfieldTooltip(field);
      afTooltipEl.style.display = "";
      positionAfTooltip();
      map.getCanvas().style.cursor = "pointer";
    }
  });
  map.on("mouseleave", "airfield-dot", () => { hoverAf = null; afTooltipEl.style.display = "none"; if (!hoverHex) map.getCanvas().style.cursor = ""; });
  map.on("click", () => { if (clickedObject) { clickedObject = false; return; } deps.onMapClick(); });

  // --- MapLibre native sources (terrain-aware) --------------------------------------------
  function runwayFC() {
    if (!deps.getSettings().airfields) return EMPTY_FC;
    const features = RUNWAYS.map((rwy) => {
      const midLat = (rwy.le[1] + rwy.he[1]) / 2;
      const mLat = 111320;
      const mLon = 111320 * Math.cos((midLat * Math.PI) / 180);
      let ex = (rwy.he[0] - rwy.le[0]) * mLon;
      let ez = (rwy.he[1] - rwy.le[1]) * mLat;
      const len = Math.hypot(ex, ez) || 1;
      ex /= len; ez /= len;
      const hw = (rwy.width * FT_TO_M) / 2;
      const dLon = (-ez * hw) / mLon;
      const dLat = (ex * hw) / mLat;
      const ring = [
        [rwy.le[0] + dLon, rwy.le[1] + dLat], [rwy.le[0] - dLon, rwy.le[1] - dLat],
        [rwy.he[0] - dLon, rwy.he[1] - dLat], [rwy.he[0] + dLon, rwy.he[1] + dLat],
        [rwy.le[0] + dLon, rwy.le[1] + dLat],
      ];
      return { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ring] } };
    });
    return { type: "FeatureCollection", features };
  }
  function airfieldsFC() {
    airfieldByKey.clear();
    const settings = deps.getSettings();
    if (!settings.airfields) return EMPTY_FC;
    const features = [];
    for (const f of AIRFIELDS) {
      const minor = isMinorAirfield(f);
      if (minor && !settings.airfieldsMinor) continue;
      const key = f.icao || f.code;
      airfieldByKey.set(key, f);
      const color = minor ? "#8b98a5" : f.kind === "large" ? "#ffd23f" : f.kind === "medium" ? "#ff9f45" : "#c3ccd6";
      features.push({ type: "Feature", properties: { key, code: f.code, minor, r: minor ? 4 : f.kind === "large" ? 6 : 5, color }, geometry: { type: "Point", coordinates: [f.lon, f.lat] } });
    }
    return { type: "FeatureCollection", features };
  }
  // Tactical range rings (100/200/300 km) + km labels + N/E/S/W compass, around the receiver.
  function ringsFC() {
    const cosLat = Math.cos((HOME.lat * Math.PI) / 180) || 1;
    const feats = [];
    for (const km of [100, 200, 300]) {
      const coords = [];
      for (let i = 0; i <= 72; i += 1) {
        const a = (i / 72) * Math.PI * 2;
        coords.push([HOME.lon + (km / 111.32 / cosLat) * Math.sin(a), HOME.lat + (km / 111.32) * Math.cos(a)]);
      }
      feats.push({ type: "Feature", properties: { kind: "ring" }, geometry: { type: "LineString", coordinates: coords } });
      feats.push({ type: "Feature", properties: { kind: "ringlabel", label: `${km} km` }, geometry: { type: "Point", coordinates: [HOME.lon + (km / 111.32 / cosLat) * Math.SQRT1_2, HOME.lat + (km / 111.32) * Math.SQRT1_2] } });
    }
    const cr = 340;
    for (const [label, dx, dy] of [["N", 0, 1], ["E", 1, 0], ["S", 0, -1], ["W", -1, 0]]) {
      feats.push({ type: "Feature", properties: { kind: "compass", label }, geometry: { type: "Point", coordinates: [HOME.lon + (cr / 111.32 / cosLat) * dx, HOME.lat + (cr / 111.32) * dy] } });
    }
    return { type: "FeatureCollection", features: feats };
  }
  function refreshSources() {
    map.getSource("runways")?.setData(runwayFC());
    map.getSource("airfields")?.setData(airfieldsFC());
    map.getSource("rings")?.setData(ringsFC());
  }

  // --- Public API -------------------------------------------------------------------------
  function dataPass() { buildLayers(); }
  function drawCoverage() { buildLayers(); } // coverage is a deck layer now
  function applySettings() {
    exagg = Math.max(1, Math.min(4, Number(deps.getSettings().terrainExaggeration) || 2));
    if (ready) { map.setTerrain(deps.getSettings().terrainSatellite === false ? null : { source: "dem", exaggeration: exagg }); refreshSources(); buildLayers(); }
  }
  function setHoverClass(prev, next) { hoverHex = next; buildLayers(); }
  function setActive(active) {
    running = active;
    if (active) { map.resize(); hintEl.style.display = ""; setTimeout(() => { hintEl.style.display = "none"; }, 8000); }
    else { hoverHex = null; hoverAf = null; afTooltipEl.style.display = "none"; }
  }
  function resize() { map.resize(); }

  // zoom sync: MapLibre zoom = Leaflet zoom - 1 (512 vs 256 tiles).
  function setCameraFromMap(center, zoom) { map.jumpTo({ center: [center.lng ?? center.lon, center.lat], zoom: zoom - 1, pitch: 55 }); }
  function getCameraForMap() { const c = map.getCenter(); return { center: [c.lat, c.lng], zoom: Math.min(18, Math.max(3, Math.round(map.getZoom() + 1))) }; }
  function panTo(lon, lat) { map.easeTo({ center: [lon, lat], duration: 700 }); }
  function flyToView(lon, lat, zoom) { map.flyTo({ center: [lon, lat], zoom: zoom - 1, pitch: 55, duration: 900 }); }
  function fitAircraft(points) {
    if (!points.length) return;
    const b = new maplibregl.LngLatBounds();
    for (const p of points) b.extend([p.lon, p.lat]);
    map.fitBounds(b, { padding: 80, maxZoom: 9, pitch: 55, duration: 900 });
  }

  function destroy() {
    disposed = true;
    try { map.removeControl(overlay); } catch { /* already gone */ }
    map.remove();
    for (const el of [afTooltipEl, loadingEl, hintEl]) el.remove();
  }

  map.on("load", () => {
    if (disposed) return;
    ready = true;
    map.setTerrain({ source: "dem", exaggeration: exagg });
    map.setSky?.({ "sky-color": "#0a1a2b", "horizon-color": "#0d1618", "fog-color": "#0d1618", "sky-horizon-blend": 0.6, "horizon-fog-blend": 0.6 });
    loadingEl.style.display = "none";
    refreshSources();
    buildLayers();
    // Re-place labels/pins each frame; deck handles the projection, but blink cadence needs a nudge.
    map.on("move", () => { if (hoverAf) positionAfTooltip(); });
  });

  setCameraFromMap({ lat: HOME.lat, lng: HOME.lon }, 7);

  return { setActive, resize, dataPass, drawCoverage, applySettings, setHoverClass, panTo, flyToView, fitAircraft, setCameraFromMap, getCameraForMap, destroy };
}
