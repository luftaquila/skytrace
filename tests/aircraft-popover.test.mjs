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

test("Locate uses browser geolocation only when no aircraft is selected", () => {
  const recenter = between("async function recenterView(", "function getPlaybackGhost(");
  assert.match(recenter, /if \(hasSel\)/);
  assert.match(recenter, /toggleTracking\(sel\.lon, sel\.lat, sel\.altBaro \?\? sel\.altGeom\)/);
  assert.match(recenter, /await browserLocation\(\)/);
  assert.match(recenter, /if \(selectedHex\.value\) return/);
  assert.match(recenter, /locateBrowser\(here\.lon, here\.lat\)/);
  assert.match(app, /onTrackingChange: \(active\) => \{ trackingActive\.value = active; \}/);
});

test("the application has one 3D map and no Leaflet or view-switch path", () => {
  assert.equal(webPackage.dependencies.leaflet, undefined);
  assert.doesNotMatch(main, /leaflet/i);
  assert.match(app, /<div ref="map3dEl" class="map map-3d"><\/div>/);
  assert.doesNotMatch(app, /from "leaflet"|mapEl|view3dActive|setView3d|measureMode|baseLayers|coverageBands/);
  assert.doesNotMatch(css, /leaflet|aircraft-wrap|aircraft-icon|measure-hint/i);
  assert.doesNotMatch(tactical, /setCameraFromMap|getCameraForMap|flyToView/);
});
