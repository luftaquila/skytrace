import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  DEFAULT_SETTINGS,
  RATE_UNITS,
  SETTINGS_KEY,
  UNIT_PRESETS,
} from "../web/src/settings.js";

const app = await readFile(new URL("../web/src/App.vue", import.meta.url), "utf8");
const tactical = await readFile(new URL("../web/src/tactical3d.js", import.meta.url), "utf8");

function between(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `${startMarker} must exist`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `${endMarker} must follow ${startMarker}`);
  return source.slice(start, end);
}

test("altitude, speed and distance units are independent", () => {
  assert.equal(DEFAULT_SETTINGS.unitAltitude, "ft");
  assert.equal(DEFAULT_SETTINGS.unitSpeed, "kt");
  assert.equal(DEFAULT_SETTINGS.unitDistance, "nm");
  // The single `units` enum is gone from every consumer, not just the defaults.
  assert.equal(app.includes("settings.value.units"), false);
  assert.equal(app.includes('v-model="settings.units"'), false);
  assert.equal(tactical.includes('s.units === "metric"'), false);
  // Presets stay available as a convenience over the three independent units.
  assert.deepEqual(UNIT_PRESETS.metric, {
    unitAltitude: "m",
    unitSpeed: "kmh",
    unitDistance: "km",
    unitTemperature: "c",
  });
  assert.match(app, /function applyUnitPreset\(name\)/);
  assert.match(app, /const unitPreset = computed\(/);
});

test("a vertical rate follows the altitude unit", () => {
  assert.equal(RATE_UNITS.ft.label, "ft/min");
  assert.equal(RATE_UNITS.m.label, "m/s");
  assert.match(app, /const rateUnit = computed\(\(\) => RATE_UNITS\[settings\.value\.unitAltitude\]/);
});

test("filter inputs are read in the units the panel displays", () => {
  const limits = between(app, "const trafficLimits = computed(", "// Shared predicate");
  assert.match(limits, /parseLimit\(settings\.value\.altMin, altitudeUnit\.value\.toFeet\)/);
  assert.match(limits, /parseLimit\(settings\.value\.speedMin, speedUnit\.value\.toKnots\)/);
  assert.match(limits, /parseLimit\(settings\.value\.maxRange, distanceUnitSpec\.value\.toNm\)/);
  // The unit renders inside the input (right-aligned), never in the label.
  assert.match(app, /<span>Min altitude<\/span><span class="unit-input"><input v-model="settings\.altMin"[^>]*\/><i>\{\{ altitudeUnit\.label \}\}<\/i><\/span>/);
  assert.match(app, /<span>Min speed<\/span><span class="unit-input"><input v-model="settings\.speedMin"[^>]*\/><i>\{\{ speedUnit\.label \}\}<\/i><\/span>/);
  assert.match(app, /<span>Max range<\/span><span class="unit-input"><input v-model="settings\.maxRange"[^>]*\/><i>\{\{ distanceUnit \}\}<\/i><\/span>/);
  // Source leads the filter grid.
  const filters = between(app, "<span>Filters</span>", "</section>");
  assert.ok(filters.indexOf("<span>Source</span>") < filters.indexOf("<span>Min altitude</span>"));
});

test("range measures from the nearest receiver and the view opens on the coverage bounds", () => {
  // Range readouts and the max-range filter take the NEAREST dome-estimated receiver centre —
  // the anchors the rings use — never the mean point between receivers.
  assert.match(app, /const receiverCentres = computed\(\(\) => \(coverage\.value\.areas \|\| \[\]\)/);
  assert.match(app, /function nearestReceiverNm\(item\)/);
  assert.match(app, /if \(limits\.maxRangeNm != null && receiverCentres\.value\.length\)/);
  assert.doesNotMatch(app, /distanceNm\(\{ lat: siteRef\.value\.lat/);
  assert.match(app, /getSite: \(\) => siteRef\.value/);
  // The mesh datum still rides the derived site; the fallback constant only pre-dates coverage.
  assert.match(tactical, /import \{ FALLBACK_SITE \} from "\.\/site\.js"/);
  assert.match(tactical, /const HOME = FALLBACK_SITE;/);
  // The untouched camera opens on the merged coverage BOUNDS (several receivers far apart must
  // not open on the empty mean point), and with no coverage at all on a world view.
  assert.match(tactical, /map\.cameraForBounds\(\[\[minLon, minLat\], \[maxLon, maxLat\]\], \{ padding: 90 \}\)/);
  // The snapshot serializes bounds LAT-first; feeding them raw would throw on lat > 90.
  assert.match(tactical, /const \[\[minLat, minLon\], \[maxLat, maxLon\]\] = cov\.bounds/);
  assert.match(tactical, /frame = \{ center: \[15, 25\], zoom: 2\.3, pitch: 0 \}/);
  assert.match(tactical, /if \(!cov\?\.type\) return;/);
  // Once the operator has touched the camera the derived view must never yank it.
  assert.match(tactical, /if \(!ready \|\| userMovedCamera\) return;/);
});

test("the staleness window cannot invert, on load or on a live edit", () => {
  const coastWatch = between(app, "watch(() => settings.value.coastSeconds,", "watch(() => settings.value.dropSeconds,");
  assert.match(coastWatch, /settings\.value\.dropSeconds = clampSetting\(value \+ 5/);
  const dropWatch = between(app, "watch(() => settings.value.dropSeconds,", "\n});");
  assert.match(dropWatch, /settings\.value\.coastSeconds = clampSetting\(value - 5/);
  // A field emptied mid-edit ("" from v-model.number) must not stomp the other end of the window.
  assert.match(coastWatch, /if \(!Number\.isFinite\(value\) \|\| coast === ""/);
  assert.match(dropWatch, /if \(!Number\.isFinite\(value\) \|\| drop === ""/);
  // Consumers read the ages bounded, so an empty field can never blank the display.
  assert.match(app, /const coastAgeSec = computed\(\(\) => boundedSetting\("coastSeconds"\)\)/);
  assert.match(app, /const dropAgeSec = computed\(\(\) => Math\.max\(boundedSetting\("dropSeconds"\), coastAgeSec\.value \+ 5\)\)/);
});

test("only the unversioned settings contract is loaded", () => {
  assert.equal(SETTINGS_KEY, "skytrace.settings");
  assert.doesNotMatch(app, /migrateLegacySettings|LEGACY_SETTINGS_KEY|skytrace\.settings\.v\d/);
});

test("the operator icon scale never changes which model mesh is drawn", () => {
  // Shape comes from the emitter category (dedicated mesh or size bucket from d.cls); the user
  // scale rides on the separate screen-size multiplier, so scaling up a light aircraft keeps the
  // light silhouette and a helicopter stays a helicopter.
  assert.match(tactical, /const cls = d\.meshKind \|\| \(d\.cls < 0\.95 \? "small" : d\.cls < 1\.1 \? "medium" : "large"\)/);
  assert.match(tactical, /clsMul: d\.cls \* iconScale/);
  // planeSizeScale lives in aircraft-kind.js and never reads the operator scale.
  assert.match(app, /import \{ planeMeshKind, planeSizeScale \} from "\.\/aircraft-kind\.js"/);
  assert.equal(app.includes("function planeSizeScale"), false);
});

test("the icon scale can go below 1x", () => {
  // settingExaggeration clamped to >= 1, which would have made a 0.5x icon scale impossible.
  assert.match(tactical, /function settingExaggeration\(settings, key, max, fallback, min = 1\)/);
  assert.match(tactical, /Math\.max\(min, Math\.min\(max, value\)\)/);
  assert.match(tactical, /settingExaggeration\(settings, "aircraftScale", 2\.5, 1, 0\.5\)/);
});

test("imagery brightness is applied on a cold start as well as on a change", () => {
  // applySettings() runs before style.load, when setPaintProperty has no layer to touch yet.
  const styleLoad = between(tactical, 'map.on("style.load"', "hideLoading();");
  assert.match(styleLoad, /setPaintProperty\("sat", "raster-brightness-max"/);
  const applySettings = between(tactical, "function applySettings() {", "function setHoverClass");
  assert.match(applySettings, /setPaintProperty\("sat", "raster-brightness-max"/);
});

test("labels belong to the pinned/selected/hovered target and stay capped", () => {
  const sync = between(tactical, "const LABEL_ALL_LIMIT", "for (const [hex, b] of blocks)");
  assert.match(sync, /LABEL_ALL_LIMIT = 400/);
  assert.match(sync, /pinned\.has\(d\.hex\) \|\| d\.hex === selHex \|\| d\.hex === activeHex/);
  // The label-everything mode left with the Target labels card; no consumer may read it.
  assert.equal(tactical.includes("labelMode"), false);
  // The cap trims the tail of the declutter order; it must not blank every label at once.
  assert.match(sync, /\.slice\(0, LABEL_ALL_LIMIT\)/);
  assert.doesNotMatch(sync, /lastList\.length <= LABEL_ALL_LIMIT/);
});

test("a data block always carries callsign, age, pin, altitude and speed", () => {
  const block = between(app, "function datablockHtml(item)", "function airfieldTooltip");
  assert.match(block, /formatAge\(item\.observedAt\)/);
  assert.match(block, /formatFlight\(item\)/);
  assert.match(block, /pinIcon\(item\.hex\)/);
  // An empty data line must not leave a stray empty row in the block.
  assert.match(block, /line \? `<span>\$\{line\}<\/span>` : ""/);
  // The per-line label settings are gone along with their card.
  for (const legacy of ["labelMode", "labelAltitude", "labelSpeed", "labelAge", "uiScale"]) {
    assert.equal(app.includes(legacy), false, `${legacy} must not remain in App.vue`);
  }
});

test("the fallback poll cadence is a fixed constant, not an operator knob", () => {
  assert.match(app, /function startRefreshTimer\(\) \{\s*clearInterval\(refreshTimer\);/);
  assert.match(app, /const REFRESH_MS = 10000/);
  assert.match(app, /setInterval\(\(\) => liveRefresher\.schedule\(0\), REFRESH_MS\)/);
  assert.equal(app.includes("refreshSeconds"), false);
});

test("proximity thresholds are settings; the history range knob is gone", () => {
  assert.equal(app.includes("const PROXIMITY_NM ="), false);
  assert.equal(app.includes("const PROXIMITY_FT ="), false);
  assert.equal(app.includes("const COAST_AGE_SEC ="), false);
  assert.equal(app.includes("const DROP_AGE_SEC ="), false);
  // Bounded reads: an emptied threshold field must not silently disable the conflict scan.
  assert.match(app, /const maxVertFt = boundedSetting\("proximityFt"\)/);
  assert.match(app, /const maxDistNm = boundedSetting\("proximityNm"\)/);
  assert.match(app, /spatialConflictPairs\(rows, maxDistNm, maxVertFt\)/);
  // Track requests always ask for the full recorded history; there is no range setting left.
  assert.equal(app.includes("trackHours"), false);
  assert.match(app, /\/api\/aircraft\/\$\{hex\}\/history\?\$\{params\}/);
  assert.match(app, /params\.set\("olderCursor", olderCursor\)/);
  assert.match(app, /const hasLatestArchivePage = computed\(\(\) => archivePages\.value\.has\("latest"\)\)/);
  assert.match(app, /@click="loadLatestHistory"/);
});

test("incremental track refresh requests selected detail and rejects stale pin responses", () => {
  assert.match(
    app,
    /detail: pending\.some\(\(item\) => item\.hex === selectedHex\.value\) \? selectedHex\.value : null/,
  );
  assert.doesNotMatch(app, /pending\.includes\(selectedHex\.value\)/);
  assert.match(app, /const pinRequestVersions = new Map\(\)/);
  assert.match(
    app,
    /pinRequestVersions\.get\(hex\) !== requestVersion \|\| !pinned\.value\.has\(hex\)/,
  );
  assert.match(app, /pinRequestControllers\.get\(hex\)\?\.abort\(\)/);
});

test("a configuration can be exported, imported and reset", () => {
  assert.match(app, /function exportSettings\(\)/);
  assert.match(app, /download = "skytrace-settings\.json"/);
  assert.match(app, /async function importSettings\(event\)/);
  // Only the exact first-release wrapper is accepted, and oversized files are rejected before
  // file.text() reads them.
  assert.match(app, /parsed\.app !== "skytrace"/);
  assert.match(app, /parsed\.settings !== SETTINGS_KEY/);
  assert.match(app, /if \(file\.size > MAX_SETTINGS_IMPORT_BYTES\)/);
  assert.ok(app.indexOf("file.size > MAX_SETTINGS_IMPORT_BYTES") < app.indexOf("await file.text()"));
  // An arbitrary JSON object must not "import" as every default and report success.
  assert.match(app, /Object\.keys\(DEFAULT_SETTINGS\)\.some\(\(key\) => Object\.hasOwn\(values, key\)\)/);
  assert.match(app, /@click="exportSettings"/);
  assert.match(app, /@click="settingsFileEl\?\.click\(\)"/);
  assert.match(app, /@click="resetSettings"/);
  assert.match(app, /accept="application\/json,\.json" hidden @change="importSettings"/);
});
