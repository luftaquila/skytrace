import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const app = await readFile(new URL("../web/src/App.vue", import.meta.url), "utf8");
const css = await readFile(new URL("../web/src/styles.css", import.meta.url), "utf8");
const tactical = await readFile(new URL("../web/src/tactical3d.js", import.meta.url), "utf8");
const main = await readFile(new URL("../web/src/main.js", import.meta.url), "utf8");
const webPackage = JSON.parse(await readFile(new URL("../web/package.json", import.meta.url), "utf8"));

function between(startText, endText) {
  const start = app.indexOf(startText);
  const end = app.indexOf(endText, start + startText.length);
  assert.notEqual(start, -1, `${startText} must exist`);
  assert.notEqual(end, -1, `${endText} must follow ${startText}`);
  return app.slice(start, end);
}

test("aircraft popovers place update age immediately before the pin", () => {
  const source = between("function datablockHtml(", "function airfieldTooltip(");
  assert.match(source, /tt-top-actions/);
  assert.ok(source.indexOf("tt-age") < source.indexOf("pinIcon"));
  assert.match(source, /targetLine\(item, true\)/);
  assert.match(css, /\.tt-top-actions\s*\{[^}]*justify-content:\s*flex-end/s);
  assert.match(css, /\.tt-top-actions \.tt-age\s*\{[^}]*text-align:\s*right/s);
});

test("historic is selected-aircraft state while all-aircraft trails remain a display setting", () => {
  const source = between("function datablockHtml(", "function airfieldTooltip(");
  const refresh = between("async function refreshAllAircraftTracks(", "async function refreshTrackRange(");
  assert.match(app, /allAircraftTracks:\s*false/);
  assert.doesNotMatch(source, /historic|tt-historic/i);
  assert.match(app, /const historicTrackHexes = ref\(new Set\(\)\)/);
  assert.match(app, /const selectedHistoric = computed\(/);
  assert.match(app, /v-model="selectedHistoric"[^>]*\/>[\s\S]*<span>Historic<\/span>/);
  assert.doesNotMatch(app, /settings\.historicTracks/);
  assert.match(app, /v-model="settings\.allAircraftTracks"[^>]*\/> All aircraft trails/);
  assert.match(tactical, /historic \? allPoints : currentTrackRun\(allPoints\)/);
  assert.match(tactical, /addTrail\(selHex, selTrack, true\)/);
  assert.match(tactical, /deps\.getAllAircraftTracks\(\)/);
  assert.doesNotMatch(tactical, /tt-historic-toggle|setHistoricTracks/);
  assert.match(refresh, /if \(!settings\.value\.allAircraftTracks\)/);
  assert.match(refresh, /index \+= 250/);
  assert.match(refresh, /afterId: previousCursors\.get\(hex\) \?\? null/);
  assert.match(refresh, /historic: false/);
  assert.match(refresh, /mergeTrackPoints\(current, track\?\.points \|\| \[\]\)/);
  assert.match(refresh, /method: "POST"/);
});

test("switching aircraft invalidates stale requests and clears the old trail before changing hex", () => {
  const beginSelection = between("function beginAircraftSelection(", "async function selectAircraft(");
  const select = between("async function selectAircraft(", "function clearSelection(");
  const refresh = between("async function refreshTrack(", "async function fetchTrackPoints(");

  const invalidate = beginSelection.indexOf("selectedTrackRequestVersion += 1");
  const clear = beginSelection.indexOf("selectedTrackRaw.value = []");
  const assign = beginSelection.indexOf("selectedHex.value = hex");
  const redraw = select.indexOf("tac3d?.dataPass()");
  assert.ok(invalidate >= 0 && invalidate < clear);
  assert.ok(clear < assign);
  assert.ok(redraw >= 0);
  assert.match(select, /if \(!beginAircraftSelection\(hex\)\) return/);
  assert.match(refresh, /const hex = selectedHex\.value/);
  assert.match(refresh, /const requestVersion = \+\+selectedTrackRequestVersion/);
  assert.match(refresh, /requestVersion !== selectedTrackRequestVersion \|\| selectedHex\.value !== hex/);
  assert.match(refresh, /selectedTrackRaw\.value = result\.points \|\| \[\]/);
});

test("track control and altitude legend share the lower-right map corner", () => {
  assert.match(app, /<div class="map-corner-controls">[\s\S]*map-track-button[\s\S]*<div class="map-legend"/);
  assert.match(app, /class="icon-button map-track-button"[\s\S]*<LocateFixed :size="17" \/>[\s\S]*<\/button>/);
  assert.doesNotMatch(app, /trackingButtonText/);
  assert.match(app, /<div class="legend-title">Altitude<\/div>/);
  assert.match(app, /frac === 0 \? `\$\{label\} \(\$\{unit\}\)` : label/);
  assert.doesNotMatch(app, /Altitude \(\{\{ altitudeLegend\.unit \}\}\)/);
  assert.match(css, /\.map-corner-controls\s*\{[^}]*right:\s*18px[^}]*bottom:\s*18px/s);
  assert.match(css, /\.map-corner-controls\s*\{[^}]*align-items:\s*flex-end/s);
  assert.match(css, /\.map-track-button\s*\{\s*pointer-events:\s*auto;\s*\}/s);
  assert.doesNotMatch(css, /\.map-legend\s*\{[^}]*left:/s);
});

test("receiver uploads and server track storage default to a three-second cadence", async () => {
  const { loadConfig } = await import("../src/config.mjs");
  const agent = await readFile(new URL("../bin/skytrace-agent.mjs", import.meta.url), "utf8");
  const config = loadConfig({});
  assert.equal(config.trackMinIntervalSeconds, 3);
  assert.equal(config.coverageRefreshSeconds, 180);
  assert.equal(config.coverageWindowHours, 24 * 30);
  assert.equal(config.coverageBearingStepDegrees, undefined);
  assert.equal(config.coverageMaxPoints, undefined);
  assert.match(agent, /SKYTRACE_INTERVAL_MS \|\| "3000"/);
  assert.match(app, /setInterval\(\(\) => liveRefresher\.schedule\(0\), 10000\)/);
  assert.match(app, /setTimeout\(connectEvents, 5000\)/);
  assert.match(app, /coverageTimer = setInterval\(\(\) => coverageRefresher\.schedule\(0\), 180000\)/);
});

test("coasting targets progressively ghost on the map without redundant status text", () => {
  const coast = between("const COAST_AGE_SEC = 30;", "// Proximity (STCA-style)");
  assert.match(coast, /function coastOpacity\(item\)/);
  assert.match(coast, /return 0\.46 - progress \* 0\.24/);
  assert.doesNotMatch(app, /COAST ·/);
  assert.match(tactical, /coastOpacity: coasting \? deps\.coastOpacity\?\.\(item\) \?\? 0\.42 : 1/);
  assert.match(tactical, /Math\.round\(200 \* d\.coastOpacity\)/);
  assert.match(tactical, /const desaturate = d\.coasting \? 0\.52 : 0/);
  assert.match(tactical, /a: Math\.round\(255 \* d\.coastOpacity\)/);
  assert.match(css, /\.aircraft-row\.coasting\s*\{[^}]*opacity:\s*0\.56[^}]*filter:\s*saturate\(0\.5\)/s);
});

test("satellite is the only basemap and one bounded altitude scale keeps aircraft and coverage aligned", () => {
  assert.doesNotMatch(app, /terrainSatellite|Satellite terrain/);
  assert.match(app, /terrainExaggeration:\s*2/);
  assert.match(app, /altitudeExaggeration:\s*5/);
  assert.match(app, /aircraftPitchExaggeration:\s*3/);
  assert.match(app, /aircraftRollExaggeration:\s*1/);
  assert.match(app, /settings\.terrainExaggeration" type="range" min="1" max="5" step="0\.1"/);
  assert.match(app, /settings\.altitudeExaggeration" type="range" min="1" max="10" step="0\.1"/);
  assert.match(app, /settings\.aircraftPitchExaggeration" type="range" min="1" max="5" step="0\.1"/);
  assert.match(app, /settings\.aircraftRollExaggeration" type="range" min="1" max="5" step="0\.1"/);
  assert.doesNotMatch(app, /v-model\.number="settings\.(?:aircraft|coverage)AltitudeExaggeration"/);
  assert.doesNotMatch(tactical, /maplibre-contour|terrainSatellite|hillshade|grid-line|contour-line|applyTerrainMode/);
  assert.match(tactical, /\{ id: "sat", type: "raster", source: "satellite", paint:/);
  assert.match(tactical, /altExagg:\s*altitudeExagg/);
  assert.match(tactical, /const z = altM \* altitudeExagg/);
  assert.match(tactical, /Math\.atan2\(vs \* 0\.00508, gs\) \* pitchExagg \* 180/);
  assert.match(tactical, /reportedBank \* rollExagg/);
});

test("Locate uses browser geolocation only when no aircraft is selected", () => {
  const recenter = between("async function recenterView(", "function getPlaybackGhost(");
  assert.match(recenter, /if \(hasSel\)/);
  assert.match(recenter, /toggleTracking\(sel\.lon, sel\.lat, sel\.altBaro \?\? sel\.altGeom\)/);
  assert.match(recenter, /await browserLocation\(\)/);
  assert.match(recenter, /if \(selectedHex\.value\) return/);
  assert.match(recenter, /locateBrowser\(here\.lon, here\.lat\)/);
  assert.match(app, /onTrackingChange: \(active\) => \{ trackingActive\.value = active; \}/);
});

test("an aircraft double-click selects the target before applying the Track toggle", () => {
  const trackFromMap = between("function trackAircraftFromMap(", "function onGlobalKeydown(");
  assert.match(trackFromMap, /const selectionChanged = beginAircraftSelection\(hex\)/);
  assert.match(trackFromMap, /tac3d\?\.toggleTracking\(item\.lon, item\.lat, item\.altBaro \?\? item\.altGeom\)/);
  assert.match(trackFromMap, /if \(selectionChanged\) void refreshTrack\(\)/);
  assert.match(app, /onTrackAircraft: trackAircraftFromMap/);
});

test("the shared Track icon follows a selected airport only when explicitly toggled", () => {
  const recenter = between("async function recenterView(", "function getPlaybackGhost(");
  const airportSelect = between("function selectAirfieldFromMap(", "function onGlobalKeydown(");
  assert.match(app, /const selectedAirfield = ref\(null\)/);
  assert.match(recenter, /const airfield = selectedAirfield\.value/);
  assert.match(recenter, /tac3d\?\.toggleAirfieldTracking\(airfield\)/);
  assert.ok(recenter.indexOf("const airfield") < recenter.indexOf("const sel"));
  assert.match(airportSelect, /selectedAirfield\.value = field \|\| null/);
  assert.match(airportSelect, /if \(field && selectedHex\.value\) clearSelection\(\)/);
  assert.match(app, /onAirfieldSelection: selectAirfieldFromMap/);
  assert.match(app, /selectedAirfield \? \(trackingActive \? 'Stop tracking airport' : 'Track selected airport'\)/);
});

test("the application has one 3D map and no Leaflet or view-switch path", () => {
  assert.equal(webPackage.dependencies.leaflet, undefined);
  assert.doesNotMatch(main, /leaflet/i);
  assert.match(app, /<div ref="map3dEl" class="map map-3d"><\/div>/);
  assert.doesNotMatch(app, /from "leaflet"|mapEl|view3dActive|setView3d|measureMode|baseLayers|coverageBands/);
  assert.doesNotMatch(css, /leaflet|aircraft-wrap|aircraft-icon|measure-hint/i);
  assert.doesNotMatch(tactical, /setCameraFromMap|getCameraForMap|flyToView/);
});

test("free wheel zoom follows the cursor while aircraft tracking keeps its orbit", () => {
  const start = tactical.indexOf("function freeWheelCameraTarget(");
  const end = tactical.indexOf("cv.addEventListener(\"wheel\"", start);
  assert.notEqual(start, -1, "free wheel target helper must exist");
  assert.notEqual(end, -1, "wheel listener must follow the target helper");
  const source = tactical.slice(start, end);

  assert.match(source, /new maplibregl\.Point\(e\.clientX - rect\.left, e\.clientY - rect\.top\)/);
  assert.match(source, /map\.transform\.clone\(\)/);
  assert.match(source, /isPointOnMapSurface\(around\)/);
  assert.match(source, /handleMapControlsRollPitchBearingZoom\(deltas, tr\)/);
  assert.match(source, /handleMapControlsPan\(deltas, tr, preZoomAroundLoc\)/);
  assert.match(source, /if \(orbitAttached\)[\s\S]*const target = activeOrbitTarget\(\)[\s\S]*center: \[target\.lon, target\.lat\]/);
  assert.match(source, /freeWheelCameraTarget\(e, z, elevation\)/);
});
