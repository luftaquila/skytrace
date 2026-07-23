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
  const aircraftBranch = functionSource("toggleTracking", "fitAircraft");
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

test("browser location restores a broad north-up near-vertical ground view", () => {
  const locateBrowser = functionSource("locateBrowser", "toggleTracking");
  assert.match(source, /BROWSER_LOCATE_VIEW = \{ zoom: 8, pitch: 10, bearing: 0 \}/);
  assert.match(locateBrowser, /\.\.\.BROWSER_LOCATE_VIEW/);
  assert.match(locateBrowser, /elevation: 0/);
  assert.match(locateBrowser, /kind: "locate-browser"/);
  assert.doesNotMatch(locateBrowser, /Math\.max\(map\.getZoom/);
});
