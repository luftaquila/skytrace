import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DEFAULT_SETTINGS, normalizeSettings } from "../web/src/settings.js";

const app = await readFile(new URL("../web/src/App.vue", import.meta.url), "utf8");
const tactical = await readFile(new URL("../web/src/tactical3d.js", import.meta.url), "utf8");

const { domeCentre, M_PER_DEG_LAT } = await import("../web/src/coverage-centre.js");

function between(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `${startMarker} must exist`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `${endMarker} must follow ${startMarker}`);
  return source.slice(start, end);
}

test("map labels render from a local system font without a remote glyph endpoint", () => {
  const styleHeader = between(tactical, "style: {", "sources: {");
  assert.doesNotMatch(styleHeader, /\bglyphs\s*:/);
  assert.doesNotMatch(tactical, /demotiles\.maplibre\.org|Open Sans Regular|mapGlyphsUrl/);
  assert.ok((tactical.match(/"text-font": MAP_FONT_STACK/g)?.length || 0) >= 2);
});

test("coverage visibility stores the hidden receivers, so a new one is visible by default", () => {
  assert.deepEqual(DEFAULT_SETTINGS.coverageHidden, []);
  assert.match(app, /function coverageVisible\(receiverName\) \{\s*return !coverageHidden\.value\.has\(receiverName\);/);
  assert.deepEqual(normalizeSettings({ coverageHidden: ["rx-a", 4] }).coverageHidden, ["rx-a"]);
});

test("hiding a receiver rebuilds the merged coverage mesh instead of serving the cached one", () => {
  const mesh = between(tactical, "function coverageMesh() {", "function project(");
  assert.match(mesh, /const hidden = new Set\(settings\.coverageHidden \|\| \[\]\)/);
  // The site the mesh is decoded around is part of its identity too, alongside the hidden set.
  assert.match(mesh, /const hiddenKey = `\$\{\[\.\.\.hidden\]\.sort\(\)\.join\("\|"\)\}@\$\{siteKey\(HOME\)\}`/);
  assert.match(mesh, /coverage === coverageMeshSource && hiddenKey === coverageHiddenKey/);
  assert.match(mesh, /if \(hidden\.has\(area\.receiverName\)\) continue;/);
});

test("range rings are configurable, with visibility owned per receiver", () => {
  // The old global rings switch is gone: a new receiver shows rings until switched off.
  assert.equal(Object.hasOwn(DEFAULT_SETTINGS, "rings"), false);
  assert.deepEqual(DEFAULT_SETTINGS.ringsHidden, []);
  assert.equal(DEFAULT_SETTINGS.ringSpacing, 100);
  assert.equal(DEFAULT_SETTINGS.ringCount, 3);
  assert.equal(DEFAULT_SETTINGS.ringCompass, true);
  assert.deepEqual(normalizeSettings({ ringsHidden: ["rx-a", false] }).ringsHidden, ["rx-a"]);
  const rings = between(tactical, "function ringsFC() {", "function refreshSources()");
  assert.match(rings, /const hidden = new Set\(s\.ringsHidden \|\| \[\]\)/);
  assert.match(rings, /if \(hidden\.has\(area\.receiverName\)\) continue;/);
  assert.match(rings, /if \(!s\.ringCompass\) continue;/);
  // Clamped in the renderer too: a hand-edited localStorage value must not produce 500 rings.
  assert.match(rings, /Math\.max\(5, Math\.min\(1000, Number\(s\.ringSpacing\) \|\| 100\)\)/);
  assert.match(rings, /Math\.max\(1, Math\.min\(8, Math\.round\(Number\(s\.ringCount\) \|\| 3\)\)\)/);
});

test("the rings carry their own unit, independent of the numeric readout unit", () => {
  const rings = between(tactical, "function ringsFC() {", "function refreshSources()");
  assert.match(rings, /const unit = DISTANCE_UNIT_LABELS\[s\.ringUnit\] \? s\.ringUnit : "nm"/);
  assert.match(rings, /distance \* DISTANCE_UNIT_TO_KM\[unit\]/);
  assert.match(rings, /label: `\$\{distance\} \$\{unitLabel\}`/);
  // The Range rings card owns the unit select; a readout unit change never rescales the rings.
  assert.equal(DEFAULT_SETTINGS.ringUnit, "nm");
  assert.match(app, /v-model="settings\.ringUnit"/);
  const setDistance = between(app, "function setDistanceUnit(next)", "\n}");
  assert.doesNotMatch(setDistance, /settings\.value\.ring/);
});

test("the client's receiver anchor is estimated from the dome, never the published origin", () => {
  const rings = between(tactical, "function ringsFC() {", "function refreshSources()");
  assert.match(rings, /deps\.getCoverage\(\)\?\.areas/);
  assert.match(rings, /domeCentre\(area\.volumeMesh\)/);
  assert.doesNotMatch(rings, /\.origin|HOME\./);
  // The focus button rides the same estimate.
  assert.match(app, /center: domeCentre\(area\?\.volumeMesh\)/);
  // Functional: the estimate is the MEAN of the mesh vertices — a reception-centroid stand-in
  // that one long-range lobe barely moves (it would drag a bounds midpoint a long way).
  const quantized = Uint16Array.from([0, 0, 0, 65535, 65535, 0, 65535, 0, 0]);
  const vm = domeCentre({
    encoding: "quantized-uint16-le-base64",
    positions: Buffer.from(quantized.buffer).toString("base64"),
    positionBounds: [0, 0, 0, 30000, 15000, 9000],
    origin: [127, 36],
  });
  // Mean east = 2/3 of the 30 km span = 20 km; mean north = 1/3 of the 15 km span = 5 km.
  assert.ok(Math.abs(vm.lat - (36 + 5000 / M_PER_DEG_LAT)) < 1e-9);
  assert.ok(Math.abs(vm.lon - (127 + 20000 / (M_PER_DEG_LAT * Math.cos((vm.lat * Math.PI) / 180)))) < 1e-9);
  // Without vertices the bounds midpoint stands in, offset from the datum in metres.
  const mesh = { origin: [127, 36], positionBounds: [-20000, -10000, 0, 60000, 30000, 12000] };
  const centre = domeCentre(mesh);
  assert.ok(Math.abs(centre.lat - (36 + 10000 / M_PER_DEG_LAT)) < 1e-9);
  assert.ok(Math.abs(centre.lon - (127 + 20000 / (M_PER_DEG_LAT * Math.cos((centre.lat * Math.PI) / 180)))) < 1e-9);
  // Without bounds the datum is all there is; without a datum there is no anchor at all.
  assert.deepEqual(domeCentre({ origin: [127, 36] }), { lon: 127, lat: 36 });
  assert.equal(domeCentre({ positionBounds: [0, 0, 0, 1, 1, 1] }), null);
  // A fresh coverage snapshot must re-anchor the rings, not only the domes.
  assert.match(tactical, /function drawCoverage\(\) \{ buildLayers\(\); refreshRings\(\); \}/);
});

test("the console exposes per-receiver coverage and ring controls", () => {
  // The dome toggle lives in the receiver's own row, not in a second list in another block.
  assert.match(app, /v-for="row in receiverRows"/);
  assert.match(app, /@click="toggleCoverageReceiver\(row\.name\)"/);
  assert.match(app, /@click="focusReceiver\(row\)"/);
  assert.equal(app.includes('v-for="area in coverageReceivers"'), false);
  // The Coverage card is gone: the per-receiver dome toggle is the only coverage control.
  assert.equal(app.includes("setAllCoverageReceivers"), false);
  assert.match(app, /@click="toggleRingsReceiver\(row\.name\)"/);
  assert.equal(app.includes('v-model="settings.rings"'), false);
  assert.match(app, /v-model\.number="settings\.ringSpacing"/);
  assert.match(app, /v-model\.number="settings\.ringCount"/);
  assert.match(app, /v-model="settings\.ringCompass"/);
  // The old duplicate Coverage/Airfields checkboxes in Filters are gone; each lives in its block.
  const filters = between(app, "<span>Filters</span>", "</section>");
  assert.equal(filters.includes('v-model="settings.coverage"'), false);
  assert.equal(filters.includes('v-model="settings.airfields"'), false);
});
