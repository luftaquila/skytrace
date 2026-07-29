import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DEFAULT_SETTINGS, SETTING_BOUNDS } from "../web/src/settings.js";

const app = await readFile(new URL("../web/src/App.vue", import.meta.url), "utf8");
const css = await readFile(new URL("../web/src/styles.css", import.meta.url), "utf8");
const tactical = await readFile(new URL("../web/src/tactical3d.js", import.meta.url), "utf8");
const eventStream = await readFile(new URL("../web/src/event-stream.js", import.meta.url), "utf8");
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

test("historic is selected-aircraft state, and the all-aircraft trails feature is fully gone", () => {
  const source = between("function datablockHtml(", "function airfieldTooltip(");
  assert.doesNotMatch(source, /historic|tt-historic/i);
  assert.match(app, /const archivePages = shallowRef\(new Map\(\)\)/);
  assert.match(app, /const selectedHistoric = ref\(false\)/);
  // One control for the track scope: current flight or the full history.
  assert.match(app, /const trackScope = computed\(\{/);
  assert.match(app, /v-model="trackScope"[\s\S]*?<option value="current">Current flight<\/option>[\s\S]*?<option value="full">Full history<\/option>/);
  // The date-jump widget is gone, and so is the `at` plumbing that only it used.
  for (const legacy of ["jumpHistoryDate", "historyDate", "historyCutoff", "requestAt", "datetime-local"]) {
    assert.equal(app.includes(legacy), false, `${legacy} must not remain in App.vue`);
  }
  assert.doesNotMatch(app, /settings\.historicTracks/);
  assert.match(tactical, /historic \? allPoints : currentTrackRun\(allPoints\)/);
  assert.match(tactical, /trailInputs\.push\(\{ hex: selHex, points: selTrack, historic: true \}\)/);
  assert.doesNotMatch(tactical, /tt-historic-toggle|setHistoricTracks/);
  // The all-trails option was removed from the console, so no dead machinery may survive it.
  for (const legacy of ["allAircraftTracks", "refreshAllAircraftTracks", "allTrackCache", "getAllAircraftTracks", "trailFilterKey"]) {
    assert.equal(app.includes(legacy), false, `${legacy} must not remain in App.vue`);
    assert.equal(tactical.includes(legacy), false, `${legacy} must not remain in tactical3d.js`);
  }
});

test("switching aircraft invalidates stale requests and clears the old trail before changing hex", () => {
  const beginSelection = between("function beginAircraftSelection(", "async function selectAircraft(");
  const select = between("async function selectAircraft(", "function clearSelection(");
  const refresh = between("async function refreshTrack(", "async function initializePinnedTrack(");

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
  assert.match(refresh, /selectedTrackRaw\.value = \(result\.points \|\| \[\]\)\.slice\(-MAX_LIVE_TRACK_POINTS\)/);
});

test("track control and altitude legend share the lower-right map corner", () => {
  assert.match(app, /<div class="map-chrome">[\s\S]*map-track-button[\s\S]*<div class="map-legend"/);
  assert.match(app, /class="icon-button map-track-button"[\s\S]*<LocateFixed :size="17" \/>[\s\S]*<\/button>/);
  assert.doesNotMatch(app, /trackingButtonText/);
  // Full words on the legend, not abbreviations.
  assert.match(app, /<div class="legend-title">Altitude<\/div>/);
  assert.match(app, /frac === 0 \? `\$\{label\} \(\$\{unit\}\)` : label/);
  assert.doesNotMatch(app, /Altitude \(\{\{ altitudeLegend\.unit \}\}\)/);
  // Pinned to the very corner ALWAYS, layered above the consoles — it never dodges them.
  assert.match(css, /\.map-chrome\s*\{[^}]*right:\s*12px[^}]*bottom:\s*12px/s);
  assert.doesNotMatch(css, /--chrome-shift/);
  assert.equal(app.includes("mapChromeShift"), false);
  const chromeRule = css.slice(css.indexOf("\n.map-chrome {") + 1);
  const stationRule = css.slice(css.indexOf("\n.station {") + 1);
  const zOf = (rule) => Number((rule.slice(0, rule.indexOf("}")).match(/z-index:\s*(\d+)/) || [])[1]);
  assert.ok(zOf(chromeRule) > 40, "map chrome must layer above the consoles");
  assert.ok(zOf(stationRule) < zOf(chromeRule));
  assert.match(css, /\.map-chrome\s*\{[^}]*align-items:\s*flex-end/s);
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
  assert.match(agent, /value == null \|\| value === "" \? "3000" : String\(value\)/);
  // The fallback poll is a fixed 10 s cadence — the SSE stream is the fast path, so this is not
  // an operator knob.
  assert.match(app, /const REFRESH_MS = 10000/);
  assert.match(app, /setInterval\(\(\) => liveRefresher\.schedule\(0\), REFRESH_MS\)/);
  assert.equal(app.includes("refreshSeconds"), false);
  assert.match(app, /createEventStream\(\{/);
  assert.match(eventStream, /retryMs = 5000/);
  assert.match(app, /coverageTimer = setInterval\(\(\) => coverageRefresher\.schedule\(0\), 180000\)/);
});

test("coasting targets progressively ghost on the map without redundant status text", () => {
  const coast = between("const coastAgeSec = computed", "// Proximity (STCA-style)");
  assert.match(coast, /function coastOpacity\(item\)/);
  assert.match(coast, /return 0\.46 - progress \* 0\.24/);
  // The ages are settings now, and the drop age is forced to stay above the coasting age.
  assert.equal(DEFAULT_SETTINGS.coastSeconds, 20);
  assert.equal(DEFAULT_SETTINGS.dropSeconds, 60);
  assert.doesNotMatch(app, /COAST ·/);
  assert.match(tactical, /coastOpacity: coasting \? deps\.coastOpacity\?\.\(item\) \?\? 0\.42 : 1/);
  assert.match(tactical, /Math\.round\(200 \* d\.coastOpacity\)/);
  assert.match(tactical, /const desaturate = d\.coasting \? 0\.52 : 0/);
  assert.match(tactical, /a: Math\.round\(255 \* d\.coastOpacity\)/);
  assert.match(css, /\.target-row\.coasting\s*\{[^}]*opacity:\s*0\.56[^}]*filter:\s*saturate\(0\.5\)/s);
});

test("satellite is the only basemap and one bounded altitude scale keeps aircraft and coverage aligned", () => {
  assert.doesNotMatch(app, /terrainSatellite|Satellite terrain/);
  assert.equal(DEFAULT_SETTINGS.terrainExaggeration, 2);
  assert.equal(DEFAULT_SETTINGS.altitudeExaggeration, 5);
  assert.equal(DEFAULT_SETTINGS.aircraftPitchExaggeration, 3);
  assert.equal(DEFAULT_SETTINGS.aircraftRollExaggeration, 2);
  assert.deepEqual(SETTING_BOUNDS.aircraftRollExaggeration, [1, 5, 2]);
  assert.match(tactical, /settingExaggeration\(initialSettings, "aircraftRollExaggeration", 5, 2\)/);
  assert.match(tactical, /settingExaggeration\(settings, "aircraftRollExaggeration", 5, 2\)/);
  // One-decimal multipliers step by 0.5; the two-decimal ones stepped to 0.1 and display 1dp too.
  assert.match(app, /settings\.terrainExaggeration" type="range" min="1" max="5" step="0\.5"/);
  assert.match(app, /settings\.altitudeExaggeration" type="range" min="1" max="10" step="0\.5"/);
  assert.match(app, /settings\.aircraftPitchExaggeration" type="range" min="1" max="5" step="0\.5"/);
  assert.match(app, /settings\.aircraftRollExaggeration" type="range" min="1" max="5" step="0\.5"/);
  assert.match(app, /settings\.aircraftScale" type="range" min="0\.5" max="2\.5" step="0\.1"/);
  assert.match(app, /settings\.imageryBrightness" type="range" min="0\.4" max="1\.2" step="0\.1"/);
  assert.match(app, /settings\.coverageOpacity" type="range" min="0" max="0\.8" step="0\.05"/);
  assert.doesNotMatch(app, /toFixed\(2\)/);
  assert.doesNotMatch(app, /v-model\.number="settings\.(?:aircraft|coverage)AltitudeExaggeration"/);
  assert.doesNotMatch(tactical, /maplibre-contour|terrainSatellite|hillshade|grid-line|contour-line|applyTerrainMode/);
  assert.match(tactical, /\{ id: "sat", type: "raster", source: "satellite", paint:/);
  assert.match(tactical, /altExagg:\s*altitudeExagg/);
  assert.match(tactical, /const z = altM \* altitudeExagg/);
  assert.match(tactical, /Math\.atan2\(vs \* 0\.00508, gs\) \* pitchExagg \* 180/);
  assert.match(tactical, /reportedBank \* rollExagg/);
  assert.match(tactical, /orientation: \[-phi, 90 - track, bank\]/);
  assert.match(tactical, /target\.orientation = \[-state\.pitch, 90 - state\.track, state\.roll\]/);
  assert.doesNotMatch(tactical, /90 - track, -bank|90 - state\.track, -state\.roll/);
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

test("map and traffic-list double-clicks share selection-before-Track behavior", () => {
  const trackFromMap = between("function trackAircraftFromMap(", "function onGlobalKeydown(");
  assert.match(trackFromMap, /const selectionChanged = beginAircraftSelection\(hex\)/);
  assert.match(trackFromMap, /tac3d\?\.toggleTracking\(item\.lon, item\.lat, item\.altBaro \?\? item\.altGeom\)/);
  assert.match(trackFromMap, /if \(selectionChanged\) void refreshTrack\(\)/);
  assert.match(app, /onTrackAircraft: trackAircraftFromMap/);
  assert.match(app, /@dblclick\.stop="trackAircraftFromMap\(item\.hex\)"/);
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

test("wheel zoom anchors on the cursor when free and on the target while tracking", () => {
  const start = tactical.indexOf("const onWheel = (e) => {");
  const end = tactical.indexOf("cv.addEventListener(\"wheel\"", start);
  assert.notEqual(start, -1, "wheel handler must exist");
  assert.notEqual(end, -1, "wheel listener must follow the target helper");
  assert.match(tactical, /cv\.addEventListener\("wheel", onWheel, \{ passive: false \}\)/);
  assert.match(tactical, /overlayEl\.addEventListener\("wheel"[\s\S]*cv\.dispatchEvent\(new WheelEvent\("wheel"/);
  assert.doesNotMatch(tactical, /wheelSurface|capture: true/);
  const source = tactical.slice(start, end);

  assert.match(source, /if \(orbitAttached\)[\s\S]*const target = activeOrbitTarget\(\)[\s\S]*center: \[target\.lon, target\.lat\]/);
  // Free zoom pivots on the cursor, with the centre anchor as the guarded horizon fallback.
  assert.match(source, /const anchor = cursorZoomAnchor\(e\)/);
  assert.match(source, /const targetElevation = grounding[\s\S]*animateWheelZoom\(anchor, z, targetElevation/);
  assert.match(source, /center: map\.getCenter\(\)/);
  assert.match(source, /freeViewElevationForZoom\(\{/);
  assert.match(source, /elevation: currentElevation/);
  assert.doesNotMatch(source, /beginFreeGrounding\(\)/);
  assert.doesNotMatch(source, /freeWheelCameraTarget/);

  // One anchor per gesture, reused across chained ticks: re-unprojecting mid-animation compounds
  // into a visible slide at high zoom deltas. Off-surface / past-horizon cursors resolve to null.
  const helper = tactical.slice(tactical.indexOf("function groundZoomAnchor("), tactical.indexOf("function animateWheelZoom("));
  assert.match(helper, /cameraAnimation\?\.kind === "wheel-free" && wheelAnchor/);
  assert.match(helper, /if \(!tr\.isPointOnMapSurface\(point\)\) return null/);
  // An elevated aircraft pivot is allowed to resolve the real ground point under the cursor. Only
  // whole-globe and past-horizon points fall back to a centre zoom without lowering elevation.
  assert.match(helper, /if \(tr\.zoom < CURSOR_ANCHOR_MIN_ZOOM\) return null/);
  assert.match(helper, /const loc = map\.unproject\(point\)/);
  assert.match(helper, /const surfaceElevation = map\.queryTerrainElevation\(loc\)/);
  assert.match(helper, /return \{ loc, point, surfaceElevation, grounding: true \}/);
  assert.doesNotMatch(helper, /flatZoomAnchor\(point, \{ grounding: true \}\)|flatLoc/);
  assert.doesNotMatch(helper, /screenPointToMercatorCoordinate/);
  assert.doesNotMatch(helper, /setElevation|setZoom\(|applyCameraFrame/);

  // The pin is exact every frame: the centre is DERIVED by re-pinning on a clone, never lerped,
  // and the cursor solver runs after the clone receives both zoom and descending elevation.
  const anim = tactical.slice(tactical.indexOf("function animateWheelZoom("), start);
  assert.match(anim, /const live = mapTransform\(map\)/);
  assert.match(anim, /let probe = live\.clone\(\)/);
  assert.match(anim, /setCameraTransform\(probe, \{ zoom: zk, elevation: appliedElevation \}\)/);
  assert.match(anim, /if \(!anchor\.grounding\)[\s\S]*probe\.setLocationAtPoint\(anchor\.loc, anchor\.point\)/);
  assert.match(anim, /pinGroundLocationAtPoint\(probe, anchor\)/);
  assert.match(anim, /animation\.groundingBlocked[\s\S]*appliedElevation = live\.elevation \|\| 0/);
  assert.match(anim, /const currentLoc = live\.screenPointToLocation\(anchor\.point\)/);
  assert.match(anim, /applyCameraFrame\(\{ center: probe\.center, zoom: zk, elevation: appliedElevation \}\)/);
  assert.doesNotMatch(anim, /nativePinFallback|flatLoc/);
  assert.doesNotMatch(anim, /interpolateCenter/);
});
