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

test("clearing an aircraft orbit preserves the frame and arms later grounding", () => {
  const clearOrbit = functionSource("clearOrbit", "attachOrbit");
  assert.match(clearOrbit, /beginFreeGrounding\(\)/);
  assert.doesNotMatch(clearOrbit, /setCenter|setZoom|setElevation|recalculateZoomAndCenter|calculateCenterFromCameraLngLatAlt/);
  assert.doesNotMatch(clearOrbit, /applyCameraFrame/);
});

test("releasing a free pan does not apply a second camera grounding on pointer-up", () => {
  const onUpStart = source.indexOf("const onUp = () => {");
  const onUpEnd = source.indexOf("cv.addEventListener(\"mousedown\"", onUpStart);
  assert.notEqual(onUpStart, -1, "onUp must exist");
  assert.notEqual(onUpEnd, -1, "onUp listener boundary must exist");
  assert.doesNotMatch(source.slice(onUpStart, onUpEnd), /setElevation|rebase|ground/i);
});

test("right-drag pans the current camera without repeated ground projection", () => {
  // Ends at the wheel-anchor helper: cursor-anchored wheel zoom legitimately unprojects there.
  const pan = functionSource("panCurrentCamera", "flatZoomAnchor");
  assert.match(pan, /const current = mapTransform\(map\)/);
  assert.match(pan, /const tr = current\.clone\(\)/);
  assert.match(pan, /installGlobeCenterElevation\(tr\)/);
  assert.match(pan, /const elevation = current\.elevation \|\| 0/);
  assert.match(pan, /mapCameraHelper\(map\)/);
  assert.match(pan, /handleMapControlsPan\(/);
  assert.match(pan, /tr\.setLocationAtPoint\(tr\.center, tr\.centerPoint\.add\(panDelta\)\)/);
  assert.match(pan, /applyCameraFrame\(\{ center: tr\.center, zoom: tr\.zoom, elevation \}\)/);
  assert.doesNotMatch(pan, /screenPointToLocation|map\.panBy|setElevation\(0\)/);

  const onMoveStart = source.indexOf("const onMove = (e) => {");
  const onMoveEnd = source.indexOf("const onUp = () => {", onMoveStart);
  const onMove = source.slice(onMoveStart, onMoveEnd);
  assert.match(onMove, /queueCameraPan\(e\.clientX - drag\.x, e\.clientY - drag\.y\)/);
  assert.doesNotMatch(onMove, /map\.panBy/);
});

test("raw camera input is coalesced to one transform per display frame", () => {
  const queueFrame = functionSource("queueCameraFrame", "queueCameraPan");
  const queuePan = functionSource("queueCameraPan", "cancelCameraInput");
  assert.match(queueFrame, /pendingCameraInput = \{ kind: "frame", frame \}/);
  assert.match(queueFrame, /scheduleCameraInput\(\)/);
  assert.match(queuePan, /pendingCameraInput\.dx \+= dx/);
  assert.match(queuePan, /pendingCameraInput\.dy \+= dy/);
  assert.match(queuePan, /scheduleCameraInput\(\)/);
});

test("camera redraw and source selection have separate frame cadences", () => {
  const request = functionSource("requestCameraSourceUpdate", "cancelCameraSourceUpdate");
  const apply = functionSource("applyCameraFrame", "cancelCameraAnimation");
  assert.match(source, /const CAMERA_SOURCE_FRAME_MS = 1000 \/ 60/);
  assert.match(request, /map\.triggerRepaint\(\)/);
  assert.match(request, /window\.setTimeout\(runCameraSourceUpdate, wait\)/);
  assert.match(apply, /requestCameraSourceUpdate\(Math\.abs\(tr\.zoom - previousZoom\) > 1e-9, forceSourceUpdate\)/);
});

test("camera frames synchronize MapLibre's requested clone at aircraft elevation", () => {
  const apply = functionSource("applyCameraFrame", "cancelCameraAnimation");
  assert.match(apply, /setCameraTransform\(tr, frame\)/);
  assert.match(apply, /requestedCameraTransform\(map\)/);
  assert.match(apply, /setCameraTransform\(requested, frame\)/);
  assert.doesNotMatch(apply, /elevation:\s*0/);
});

test("camera frames accept plain LngLat objects returned by transform clones", () => {
  const setter = functionSource("setCameraTransform", "runCameraSourceUpdate");
  assert.match(setter, /maplibregl\.LngLat\.convert\(center\)/);
  assert.doesNotMatch(setter, /center instanceof maplibregl\.LngLat|center\[0\]|center\[1\]/);
});

test("detached aircraft views ground only through later cursor-pinned zoom", () => {
  const clearOrbit = functionSource("clearOrbit", "attachOrbit");
  const anchor = functionSource("groundZoomAnchor", "cursorZoomAnchor");
  assert.match(clearOrbit, /beginFreeGrounding/);
  assert.doesNotMatch(clearOrbit, /applyCameraFrame/);
  assert.match(source, /freeGrounding|beginFreeGrounding|freeViewElevationForZoom/);
  assert.match(source, /pinGroundLocationAtPoint/);
  assert.match(source, /function attachOrbit\(z\) \{ freeGrounding = null;/);
  assert.match(anchor, /map\.unproject\(point\)/);
  assert.match(anchor, /map\.queryTerrainElevation\(loc\)/);
  assert.match(anchor, /surfaceElevation/);
  assert.doesNotMatch(anchor, /screenPointToMercatorCoordinate/);
});

test("mouse wheel and touch pinch lower a released pivot only with a solved ground pin", () => {
  const wheelStart = source.indexOf("const onWheel = (e) => {");
  const wheelEnd = source.indexOf("cv.addEventListener(\"wheel\"", wheelStart);
  const wheel = source.slice(wheelStart, wheelEnd);
  assert.match(wheel, /const currentElevation = mapTransform\(map\)\.elevation \|\| 0/);
  assert.match(wheel, /freeViewElevationForZoom\(\{/);
  assert.match(wheel, /const anchor = cursorZoomAnchor\(e\)/);
  assert.match(wheel, /if \(grounding && anchor\)[\s\S]*grounding\.virtualZoom/);
  assert.ok(wheel.indexOf("const anchor = cursorZoomAnchor(e)") < wheel.indexOf("grounding.virtualZoom ="));
  assert.match(wheel, /Math\.max\(elevation, surfaceElevation\)/);
  assert.match(wheel, /const targetElevation = grounding/);
  assert.match(wheel, /animateWheelZoom\(anchor, z, targetElevation/);
  assert.match(wheel, /elevation: currentElevation/);
  assert.match(wheel, /grounding resumes as soon as a valid map-surface cursor/);
  assert.doesNotMatch(wheel, /beginFreeGrounding\(\)/);

  const touchStart = source.indexOf("function applyTwoFinger()");
  const touchEnd = source.indexOf("const onTouchDown", touchStart);
  const touch = source.slice(touchStart, touchEnd);
  assert.match(touch, /freeViewElevationForZoom\(\{/);
  assert.match(touch, /if \(freeGrounding && zoom\.anchor\)/);
  assert.match(touch, /pinGroundLocationAtPoint\(probe, zoom\.anchor\)/);
  assert.match(touch, /frame\.elevation = currentElevation[\s\S]*const currentLoc = live\.screenPointToLocation\(zoom\.anchor\.point\)/);
  assert.doesNotMatch(touch, /flatLoc/);
  assert.doesNotMatch(touch, /beginFreeGrounding\(\)/);
});

test("explicit ground destinations and new tracking discard deferred grounding", () => {
  const receiver = functionSource("focusReceiver", "locateBrowser");
  const browser = functionSource("locateBrowser", "toggleTracking");
  const airfield = functionSource("startAirfieldOrbit", "flushCameraInput");
  assert.match(receiver, /clearOrbit\(\);[\s\S]*freeGrounding = null;[\s\S]*elevation: 0/);
  assert.match(browser, /clearOrbit\(\);[\s\S]*freeGrounding = null;[\s\S]*elevation: 0/);
  assert.match(airfield, /freeGrounding = null;[\s\S]*elevation: 0/);
});

test("dead reckoning is limited to selected and pinned aircraft", () => {
  const buildLayers = functionSource("buildLayers", "updateFollowingCamera");
  assert.match(buildLayers, /new Set\(deps\.getPinned\(\)\)/);
  assert.match(buildLayers, /if \(selHex\) requestedMotion\.add\(selHex\)/);
  assert.match(buildLayers, /motionTracker\.retain\(motionHexes\)/);
});

test("tracking camera follows the continuously projected target without another follow tween", () => {
  const followSelected = functionSource("followSelected", "focusReceiver");
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
  const doubleClick = functionSource("handleDoubleTap", "handleTouchTap");
  const orbitStart = source.indexOf("function startAirfieldOrbit(");
  const orbitEnd = source.indexOf("let identBlinkOn", orbitStart);
  assert.notEqual(orbitStart, -1, "airfield orbit starter must exist");
  assert.notEqual(orbitEnd, -1, "airfield orbit starter must end before render state");
  const airfieldOrbit = source.slice(orbitStart, orbitEnd);
  assert.match(source, /map\.doubleClickZoom\.disable\(\)/);
  assert.match(interaction, /const onCanvasDoubleClick = \(e\) => \{/);
  assert.match(interaction, /cv\.addEventListener\("dblclick", onCanvasDoubleClick\)/);
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
  const click = functionSource("handleTap", "handleDoubleTap");
  const doubleClick = functionSource("handleDoubleTap", "handleTouchTap");
  const mouseClick = interaction.slice(interaction.indexOf("const onCanvasClick = (e) => {"), interaction.indexOf("const onCanvasDoubleClick = (e) => {"));
  const pointerGuard = functionSource("isRepeatedTrackedPointer", "setFollowActive");
  const onDownStart = source.indexOf("const onDown = (e) => {");
  const onDownEnd = source.indexOf("const onMove = (e) => {", onDownStart);
  const onDown = source.slice(onDownStart, onDownEnd);
  assert.match(click, /deps\.onSelect\(hit\.hex\)/);
  // The guard radius is a parameter: 16 px for the mouse, the wider double-tap radius for touch.
  assert.match(pointerGuard, /radiusPx = 16/);
  assert.match(pointerGuard, /Math\.hypot\(clientX - trackedAircraftClick\.x, clientY - trackedAircraftClick\.y\) < radiusPx/);
  // The repeat-pointer guard is the first thing both the shared tap path and the mouse click
  // wrapper do, before any hit test.
  const guard = "isRepeatedTrackedPointer(clientX, clientY, tapNow, repeatRadiusPx)) return";
  assert.ok(click.includes(guard));
  assert.ok(click.indexOf(guard) < click.indexOf("const hit = pickAircraftAt"));
  assert.match(mouseClick, /if \(isRepeatedTrackedPointer\(e\.clientX, e\.clientY, clickNow\)\) return/);
  assert.ok(mouseClick.indexOf("isRepeatedTrackedPointer") < mouseClick.indexOf("if (dragMoved)"));
  assert.match(onDown, /if \(e\.button === 0 && isRepeatedTrackedPointer\(e\.clientX, e\.clientY\)\) return/);
  assert.ok(onDown.indexOf("isRepeatedTrackedPointer") < onDown.indexOf("cancelCameraAnimation()"));
  assert.match(doubleClick, /if \(repeatedTrackedClick \|\| followActive\) return/);
  assert.ok(doubleClick.indexOf("if (repeatedTrackedClick || followActive) return") < doubleClick.indexOf("const field = pickAirfieldAt"));
  assert.ok(doubleClick.indexOf("if (repeatedTrackedClick || followActive) return") < doubleClick.indexOf("const hit = pickAircraftAt"));
});

test("re-clicking the already-selected aircraft tracks it instead of deselecting", () => {
  const click = functionSource("handleTap", "handleDoubleTap");
  // A repeat click on the already-selected aircraft Tracks it (same intent as a double-click)
  // rather than toggling the selection off.
  assert.match(click, /if \(hit\.hex === deps\.getSelectedHex\(\)\) \{/);
  assert.match(click, /deps\.onTrackAircraft\?\.\(hit\.hex\)/);
  // The Track branch is evaluated before the plain select branch, so the repeat click never falls
  // through to onSelect (which would deselect).
  assert.ok(click.indexOf("deps.onTrackAircraft?.(hit.hex)") < click.indexOf("deps.onSelect(hit.hex)"));
  // The Track branch must not run clearPinned, or toggleTracking would lose the real follow state.
  const trackBranch = click.slice(click.indexOf("if (hit.hex === deps.getSelectedHex())"), click.indexOf("const wasFollowing"));
  assert.doesNotMatch(trackBranch, /clearPinned/);
  // It arms the repeat-pointer guard so the physical second click of a double-click cannot undo it.
  assert.match(trackBranch, /trackedAircraftClick = \{ x: clientX, y: clientY, at: tapNow \};/);
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
  assert.match(interaction, /const field = hex \? null : pickAirfieldAt\(point\.x, point\.y\)/);
  assert.match(interaction, /const field = pickAirfieldAt\(px, py, \{ force: true \}\)/);
  assert.match(interaction, /cv\.addEventListener\("pointermove", onCanvasPointerMove/);
  assert.doesNotMatch(interaction, /map\.on\("mousemove"/);
});

test("browser location restores a broad north-up near-vertical ground view", () => {
  const locateBrowser = functionSource("locateBrowser", "toggleTracking");
  const focus = functionSource("focusReceiver", "locateBrowser");
  // Centring on a receiver travels only: the tactical orientation the operator set is preserved.
  assert.doesNotMatch(focus, /pitch|bearing/);
  assert.match(focus, /kind: "receiver-focus"/);
  assert.match(source, /BROWSER_LOCATE_VIEW = \{ zoom: 8, pitch: 10, bearing: 0 \}/);
  assert.match(locateBrowser, /\.\.\.BROWSER_LOCATE_VIEW/);
  assert.match(locateBrowser, /elevation: 0/);
  assert.match(locateBrowser, /kind: "locate-browser"/);
  assert.doesNotMatch(locateBrowser, /Math\.max\(map\.getZoom/);
});
