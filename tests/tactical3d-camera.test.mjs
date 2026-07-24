import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../web/src/tactical3d.js", import.meta.url), "utf8");

function functionSource(name, nextName) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf(`function ${nextName}(`, start + 1);
  assert.notEqual(start, -1, `${name} must exist`);
  assert.notEqual(end, -1, `${nextName} must follow ${name}`);
  return source.slice(start, end);
}

test("clearing an aircraft orbit never changes the camera transform", () => {
  const clearOrbit = functionSource("clearOrbit", "attachOrbit");
  assert.doesNotMatch(clearOrbit, /applyCameraFrame|setCenter|setZoom|setElevation|recalculateZoomAndCenter|calculateCenterFromCameraLngLatAlt/);
});

test("releasing a free pan never rebases the camera to the ground", () => {
  const onUpStart = source.indexOf("const onUp = () => {");
  const onUpEnd = source.indexOf("cv.addEventListener(\"mousedown\"", onUpStart);
  assert.notEqual(onUpStart, -1, "onUp must exist");
  assert.notEqual(onUpEnd, -1, "onUp listener boundary must exist");
  assert.doesNotMatch(source.slice(onUpStart, onUpEnd), /setElevation|rebase|ground/i);
});

test("right-drag pans the current elevated camera without a ground projection", () => {
  const pan = functionSource("panCurrentCamera", "scheduleActive");
  assert.match(pan, /const tr = map\.transform\.clone\(\)/);
  assert.match(pan, /installGlobeCenterElevation\(tr\)/);
  assert.match(pan, /const elevation = map\.transform\.elevation \|\| 0/);
  assert.match(pan, /handleMapControlsPan\(/);
  assert.match(pan, /tr\.setLocationAtPoint\(tr\.center, tr\.centerPoint\.add\(panDelta\)\)/);
  assert.match(pan, /applyCameraFrame\(\{ center: tr\.center, zoom: tr\.zoom, elevation \}\)/);
  assert.doesNotMatch(pan, /screenPointToLocation|map\.panBy|setElevation\(0\)/);

  const onMoveStart = source.indexOf("const onMove = (e) => {");
  const onMoveEnd = source.indexOf("const onUp = () => {", onMoveStart);
  const onMove = source.slice(onMoveStart, onMoveEnd);
  assert.match(onMove, /panCurrentCamera\(e\.clientX - drag\.x, e\.clientY - drag\.y\)/);
  assert.doesNotMatch(onMove, /map\.panBy/);
});

test("camera frames synchronize MapLibre's requested clone at aircraft elevation", () => {
  const apply = functionSource("applyCameraFrame", "cancelCameraAnimation");
  assert.match(apply, /setCameraTransform\(tr, frame\)/);
  assert.match(apply, /map\._requestedCameraState/);
  assert.match(apply, /setCameraTransform\(map\._requestedCameraState, frame\)/);
  assert.doesNotMatch(apply, /elevation:\s*0/);
});

test("detached aircraft views have no camera-grounding path", () => {
  assert.doesNotMatch(source, /freeGrounding|beginFreeGrounding|freeViewElevationForZoom|camera-grounding/);
});

test("dead reckoning is limited to selected and pinned aircraft", () => {
  const buildLayers = functionSource("buildLayers", "updateFollowingCamera");
  assert.match(buildLayers, /new Set\(deps\.getPinned\(\)\)/);
  assert.match(buildLayers, /if \(selHex\) requestedMotion\.add\(selHex\)/);
  assert.match(buildLayers, /motionTracker\.retain\(motionHexes\)/);
});

test("tracking camera follows the continuously projected target without another follow tween", () => {
  const followSelected = functionSource("followSelected", "locateBrowser");
  assert.match(followSelected, /updateFollowingCamera\(d\)/);
  assert.doesNotMatch(followSelected, /animateCamera/);

  const applyMotionFrame = functionSource("applyMotionFrame", "requestMotionFrame");
  assert.match(applyMotionFrame, /updateFollowingCamera\(selected\)/);
  assert.match(applyMotionFrame, /motionTrailByHex\.get\(d\.hex\)/);
});

test("aircraft selection only moves the camera when tracking mode is already active", () => {
  const dataPass = functionSource("dataPass", "drawCoverage");
  assert.match(dataPass, /if \(!followActive\)/);
  assert.match(dataPass, /selectedHex !== followingSelectionHex/);
  assert.match(dataPass, /transitionTrackedSelection\(next\)/);
  assert.doesNotMatch(dataPass, /animateCamera|beginSelectionFocus/);

  const transition = functionSource("transitionTrackedSelection", "dataPass");
  assert.match(transition, /followingSelectionHex = target\.hex/);
  assert.match(transition, /setFollowActive\(true\)/);
  assert.match(transition, /attachOrbit\(target\.z\)/);
  assert.match(transition, /kind/);
  assert.match(source, /kind = "track-switch"/);
});

test("Locate toggles tracking without changing bearing or pitch", () => {
  const aircraftBranch = functionSource("toggleTracking", "destroy");
  const transition = functionSource("transitionTrackedSelection", "dataPass");
  assert.match(aircraftBranch, /followActive && selectedHex && followingSelectionHex === selectedHex/);
  assert.match(aircraftBranch, /transitionTrackedSelection\(\{ hex: selectedHex, lon, lat, z \}, "track-start"\)/);
  assert.match(transition, /return true/);
  assert.match(aircraftBranch, /return false/);
  assert.match(aircraftBranch, /\(altFt \?\? 0\)/);
  assert.match(transition, /zoom: Math\.max\(map\.getZoom\(\), 10\.5\)/);
  assert.doesNotMatch(aircraftBranch, /\bzoom\s*\+/);
  assert.doesNotMatch(aircraftBranch, /pitch\s*:|bearing\s*:/);
});

test("an already tracked aircraft keeps its established camera transfer timing", () => {
  const transition = functionSource("transitionTrackedSelection", "dataPass");
  assert.match(transition, /duration: 900, easing: EASE_OUT/);
  assert.match(transition, /onComplete: followSelected/);
  assert.doesNotMatch(transition, /clearOrbit\(\)/);
});

test("double-click starts aircraft tracking and makes an airfield a detachable orbit pivot", () => {
  const interactionStart = source.indexOf("// --- Interaction");
  const interactionEnd = source.indexOf("// --- Native GeoJSON sources", interactionStart);
  assert.notEqual(interactionStart, -1, "interaction section must exist");
  assert.notEqual(interactionEnd, -1, "native source section must follow interaction section");
  const interaction = source.slice(interactionStart, interactionEnd);
  const doubleClickStart = interaction.indexOf('map.on("dblclick", (e) => {');
  const doubleClick = interaction.slice(doubleClickStart);
  const orbitStart = source.indexOf("function startAirfieldOrbit(");
  const orbitEnd = source.indexOf("let identBlinkOn", orbitStart);
  assert.notEqual(orbitStart, -1, "airfield orbit starter must exist");
  assert.notEqual(orbitEnd, -1, "airfield orbit starter must end before render state");
  const airfieldOrbit = source.slice(orbitStart, orbitEnd);
  assert.match(source, /map\.doubleClickZoom\.disable\(\)/);
  assert.match(interaction, /map\.on\("dblclick", \(e\) => \{/);
  assert.match(interaction, /deps\.onTrackAircraft\?\.\(hit\.hex\)/);
  assert.match(interaction, /startAirfieldOrbit\(field\)/);
  assert.ok(doubleClick.indexOf("const field = pickAirfieldAt") < doubleClick.indexOf("const hit = pickAircraftAt"));
  assert.match(airfieldOrbit, /airfieldOrbit = \{ lon: field\.lon, lat: field\.lat \}/);
  assert.match(airfieldOrbit, /kind: "airfield-orbit"/);
  assert.match(source, /else if \(e\.button === 2\) \{[\s\S]*?clearOrbit\(\);/);
  assert.match(source, /function activeOrbitTarget\(\)/);
});

test("double-clicking another aircraft while tracking is exactly one normal click", () => {
  const interactionStart = source.indexOf("// --- Interaction");
  const interactionEnd = source.indexOf("// --- Native GeoJSON sources", interactionStart);
  const interaction = source.slice(interactionStart, interactionEnd);
  const clickStart = interaction.indexOf('map.on("click", (e) => {');
  const doubleClickStart = interaction.indexOf('map.on("dblclick", (e) => {');
  const click = interaction.slice(clickStart, doubleClickStart);
  const doubleClick = interaction.slice(doubleClickStart);
  const pointerGuard = functionSource("isRepeatedTrackedPointer", "setFollowActive");
  const onDownStart = source.indexOf("const onDown = (e) => {");
  const onDownEnd = source.indexOf("const onMove = (e) => {", onDownStart);
  const onDown = source.slice(onDownStart, onDownEnd);
  assert.match(click, /deps\.onSelect\(hit\.hex\)/);
  assert.match(pointerGuard, /Math\.hypot\(clientX - trackedAircraftClick\.x, clientY - trackedAircraftClick\.y\) < 16/);
  assert.match(click, /if \(repeatedTrackedClick\) return/);
  assert.ok(click.indexOf("if (repeatedTrackedClick) return") < click.indexOf("const hit = pickAircraftAt"));
  assert.match(onDown, /if \(e\.button === 0 && isRepeatedTrackedPointer\(e\.clientX, e\.clientY\)\) return/);
  assert.ok(onDown.indexOf("isRepeatedTrackedPointer") < onDown.indexOf("cancelCameraAnimation()"));
  assert.match(doubleClick, /if \(repeatedTrackedClick \|\| followActive\) return/);
  assert.ok(doubleClick.indexOf("if (repeatedTrackedClick || followActive) return") < doubleClick.indexOf("const field = pickAirfieldAt"));
  assert.ok(doubleClick.indexOf("if (repeatedTrackedClick || followActive) return") < doubleClick.indexOf("const hit = pickAircraftAt"));
});

test("selecting an airfield is camera-neutral until its Track action is invoked", () => {
  const pinStart = source.indexOf("function showPinned(field)");
  const pinEnd = source.indexOf("function clearPinned", pinStart);
  const trackStart = source.indexOf("function toggleAirfieldTracking(field)");
  const trackEnd = source.indexOf("function clearAirfieldSelection", trackStart);
  assert.notEqual(pinStart, -1, "airfield selection must exist");
  assert.notEqual(pinEnd, -1, "airfield clear must follow selection");
  assert.notEqual(trackStart, -1, "airfield Track toggle must exist");
  const pin = source.slice(pinStart, pinEnd);
  const track = source.slice(trackStart, trackEnd);
  assert.doesNotMatch(pin, /startAirfieldOrbit|animateCamera|applyCameraFrame/);
  assert.match(pin, /deps\.onAirfieldSelection\?\.\(field\)/);
  assert.match(track, /airfieldOrbitMatches\(field\)/);
  assert.match(track, /clearOrbit\(\)/);
  assert.match(track, /startAirfieldOrbit\(field\)/);
  assert.match(source, /toggleAirfieldTracking, clearAirfieldSelection/);
});

test("airfield and aircraft interaction use the same projected-screen hit-testing path", () => {
  const interactionStart = source.indexOf("// --- Interaction");
  const interactionEnd = source.indexOf("// --- Native GeoJSON sources", interactionStart);
  const interaction = source.slice(interactionStart, interactionEnd);
  const rebuildHitIndex = functionSource("rebuildAirfieldHitIndex", "pickAirfieldAt");
  const airfieldPick = functionSource("pickAirfieldAt", "setHoverAirfield");
  assert.match(rebuildHitIndex, /map\.project\(\[field\.lon, field\.lat\]\)/);
  assert.match(airfieldPick, /AIRFIELD_HIT_CELL_PIXELS/);
  assert.match(airfieldPick, /text-offset \[0, 1\.15\]/);
  assert.doesNotMatch(interaction, /queryRenderedFeatures|AF_LAYERS|map\.on\("mouseleave", AF_/);
  assert.match(interaction, /const field = hex \? null : pickAirfieldAt\(e\.point\.x, e\.point\.y\)/);
  assert.match(interaction, /const field = pickAirfieldAt\(e\.point\.x, e\.point\.y\)/);
});

test("browser location restores a broad north-up near-vertical ground view", () => {
  const locateBrowser = functionSource("locateBrowser", "toggleTracking");
  assert.match(source, /BROWSER_LOCATE_VIEW = \{ zoom: 8, pitch: 10, bearing: 0 \}/);
  assert.match(locateBrowser, /\.\.\.BROWSER_LOCATE_VIEW/);
  assert.match(locateBrowser, /elevation: 0/);
  assert.match(locateBrowser, /kind: "locate-browser"/);
  assert.doesNotMatch(locateBrowser, /Math\.max\(map\.getZoom/);
});
