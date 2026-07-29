import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const app = await readFile(new URL("../web/src/App.vue", import.meta.url), "utf8");
const tactical = await readFile(new URL("../web/src/tactical3d.js", import.meta.url), "utf8");

test("a removed selected target clears its selection, camera track and selected trail lifecycle", () => {
  assert.match(
    app,
    /return item && !isDropped\(item\) \? item : null/,
  );
  assert.match(
    app,
    /watch\(selectedAircraft,\s*\(item\)\s*=>\s*\{[\s\S]*if \(!item && selectedHex\.value\) clearSelection\(\)/,
  );
  const clearSelection = app.slice(
    app.indexOf("function clearSelection()"),
    app.indexOf("// Clicking a target toggles selection"),
  );
  assert.match(clearSelection, /selectedTrackRaw\.value = \[\]/);
  assert.match(clearSelection, /selectedHex\.value = null/);
  assert.match(clearSelection, /tac3d\?\.dataPass\(\)/);
});

test("transient history and SSE outages are handled without unhandled browser promises", () => {
  assert.doesNotMatch(app, /new EventSource\(/);
  assert.match(app, /createEventStream\(\{[\s\S]*url: "\/api\/events"/);
  assert.match(app, /error\.status === 429 \|\| error\.status === 503/);
  assert.match(app, /scheduleHistoryRetry\(hex, requestVersion, error\.retryAfterMs\)/);
});

test("tracking uses complete non-fading raster tiles", () => {
  assert.match(tactical, /ensureResilientTileProtocols\(\)/);
  // A zero map fade forces MapLibre to redo every symbol collision on every render. Keep retained
  // symbol placement while disabling only the raster layer's parent/child cross-fade.
  assert.match(tactical, /fadeDuration: SYMBOL_PLACEMENT_FADE_MS/);
  assert.match(tactical, /const SYMBOL_PLACEMENT_FADE_MS = 300/);
  assert.doesNotMatch(tactical, /^\s*fadeDuration: 0/m);
  assert.match(tactical, /"raster-fade-duration": 0/);
  assert.doesNotMatch(tactical, /throw new Error\("esri placeholder"\)/);
  assert.doesNotMatch(tactical, /https:\/\/tiles\.mapterhorn\.com\/\{z\}/);
});

test("moving terrain cannot expose vertical tile-edge skirts", () => {
  assert.match(tactical, /terrainSkirtLength:\s*"none"/);
  assert.match(
    tactical,
    /layers:\s*\[\s*\{\s*id:\s*"bg",\s*type:\s*"background",\s*paint:\s*\{\s*"background-color":/,
  );
});

test("the remote reference source retries in place and resets after a complete source load", () => {
  assert.match(tactical, /function scheduleReferenceSourceRetry\(\)/);
  assert.match(tactical, /const source = map\.getSource\(MAP_REFERENCE_SOURCE_ID\)/);
  assert.match(tactical, /typeof source\?\.setUrl !== "function"/);
  assert.match(tactical, /source\.setUrl\(MAP_REFERENCE_SOURCE_URL\)/);
  assert.doesNotMatch(tactical, /_reloadSource/);
  assert.match(tactical, /map\.on\("sourcedata", \(event\) => \{/);
  assert.match(tactical, /event\?\.sourceId === MAP_REFERENCE_SOURCE_ID && event\.isSourceLoaded/);
  assert.match(tactical, /resetReferenceSourceRetry\(\)/);
});

test("clock ticks preserve static trail geometry and rebuild only at coast/drop boundaries", () => {
  assert.match(app, /watch\(transitionEpoch,\s*\(\)\s*=>\s*\{[\s\S]*tac3d\?\.dataPass\(\)/);
  assert.match(app, /tac3d\?\.clockPass\(\)/);
  const clock = app.slice(
    app.indexOf("clockTimer = setInterval"),
    app.indexOf("connectEvents();", app.indexOf("clockTimer = setInterval")),
  );
  assert.doesNotMatch(clock, /dataPass\(\)/);
  assert.match(tactical, /getSegments: \(\) => \[aircraftStickSegments, aircraftTrailSegments, aircraftOverlaySegments\]/);
  assert.match(tactical, /previous\.points === input\.points/);
  assert.match(tactical, /function clockPass\(\) \{/);
  assert.match(tactical, /aircraftStickByHex\.get\(d\.hex\)/);
  assert.match(tactical, /if \(changed && ready\) requestTacticalRepaint\(\)/);
});

test("dynamic tactical frames retain static label placement and coalesce to display frames", () => {
  const scheduler = tactical.slice(
    tactical.indexOf("function requestTacticalRepaint()"),
    tactical.indexOf("function cancelTacticalRepaint()"),
  );
  assert.match(scheduler, /if \(disposed \|\| !ready \|\| tacticalRepaintRaf\) return/);
  assert.match(scheduler, /tacticalRepaintRaf = requestAnimationFrame/);
  assert.match(scheduler, /retainedSymbolPlacement\.triggerTacticalRepaint\(\)/);
  assert.match(tactical, /createRetainedSymbolPlacement\(map\)/);
  assert.match(tactical, /map\.on\("style\.load", \(\) => \{[\s\S]*retainedSymbolPlacement\.installStyle\(\)/);
  assert.match(tactical, /retainedSymbolPlacement\.destroy\(\)/);
});

test("pointer hit testing avoids MapLibre terrain unprojection and throttles airport projection", () => {
  const rawInput = tactical.slice(
    tactical.indexOf("function installRawInputEventAdapter()"),
    tactical.indexOf("// A tactical-only frame"),
  );
  assert.match(rawInput, /mapHandlerRegistry\(map\)/);
  assert.match(rawInput, /bypass\(mapEvent, \[[\s\S]*"click", "dblclick"[\s\S]*"touchstart", "touchmove", "touchend", "touchcancel"/);
  assert.match(rawInput, /bypass\(blockableMapEvent, \["mousemove", "mousedown", "mouseup", "contextmenu"\]\)/);
  assert.match(tactical, /if \(!installRawInputEventAdapter\(\)\)/);
  assert.match(tactical, /cv\.addEventListener\("pointermove", onCanvasPointerMove, \{ passive: true \}\)/);
  assert.match(tactical, /function canvasPoint\(event\) \{[\s\S]*event\.clientX - rect\.left[\s\S]*event\.clientY - rect\.top/);
  assert.doesNotMatch(tactical, /map\.on\("(?:click|dblclick|mousemove)"/);
  assert.match(tactical, /const AIRFIELD_HIT_REFRESH_MS = 100/);
  assert.match(tactical, /airfieldHitDirty && \(force \|\| performance\.now\(\) - airfieldHitBuiltAt >= AIRFIELD_HIT_REFRESH_MS\)/);
  assert.match(tactical, /pickAirfieldAt\(px, py, \{ force: true \}\)/);
  assert.match(tactical, /function applyCameraFrame[\s\S]*invalidateAirfieldHitIndex\(\)/);
});
