import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const app = await readFile(new URL("../web/src/App.vue", import.meta.url), "utf8");
const css = await readFile(new URL("../web/src/styles.css", import.meta.url), "utf8");
const tactical = await readFile(new URL("../web/src/tactical3d.js", import.meta.url), "utf8");

function between(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `${startMarker} must exist`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `${endMarker} must follow ${startMarker}`);
  return source.slice(start, end);
}

function rule(selector) {
  const start = css.indexOf(`\n${selector} {`) + 1;
  assert.notEqual(start, 0, `${selector} must exist`);
  return css.slice(start, css.indexOf("}", start));
}

test("TARGET and TRAFFIC coexist as independent stations", () => {
  // The old panel used v-show="!selectedAircraft" on the list, so selecting a target hid it.
  assert.equal(app.includes('v-show="!selectedAircraft"'), false);
  assert.match(app, /<aside v-if="selectedAircraft && stationOpen\.target" class="station station-target">/);
  assert.match(app, /<aside v-show="stationOpen\.traffic" class="station station-traffic">/);
  assert.match(app, /<aside v-show="stationOpen\.systems" class="station station-systems">/);
  // Each console scrolls its own body; none reshapes another.
  assert.match(rule(".station-body"), /overflow-y:\s*auto/);
});

test("desktop persists the open consoles; the settings console never persists open", () => {
  assert.match(app, /const STATIONS_KEY = "skytrace\.stations"/);
  assert.match(app, /const systemsOpen = ref\(false\)/);
  // saveStations writes only the stations ref (target/traffic) — systems stays session state.
  const save = between(app, "function saveStations()", "\n}");
  assert.match(save, /JSON\.stringify\(stations\.value\)/);
  assert.doesNotMatch(save, /systems/);
});

test("only a FIRST selection reopens the target console, and only on a desktop", () => {
  const begin = between(app, "function beginAircraftSelection(hex)", "\n}");
  // Switching targets while the console was deliberately hidden must respect that choice;
  // the state is captured BEFORE the new hex is assigned.
  assert.match(begin, /const hadSelection = Boolean\(selectedHex\.value\)/);
  assert.ok(begin.indexOf("hadSelection") < begin.indexOf("selectedHex.value = hex"));
  assert.match(begin, /if \(!viewportMobile\.value && !stations\.value\.target && !hadSelection\)/);
});

test("clicking a tracked target with a closed popover reopens the popover, not the track toggle", () => {
  const tap = between(tactical, "function handleTap(", "function handleDoubleTap(");
  assert.match(tap, /if \(followActive && mutedLabels\.has\(hit\.hex\)\)/);
  assert.ok(tap.indexOf("mutedLabels.delete(hit.hex)") < tap.indexOf("deps.onTrackAircraft?.(hit.hex)"));
});

test("Escape unwinds the systems console before the selection", () => {
  const keydown = between(app, "function onGlobalKeydown(event)", "\n}");
  assert.ok(
    keydown.indexOf("stationOpen.value.systems") < keydown.indexOf("clearSelection()"),
    "the systems console must close before the selection clears",
  );
});

test("a selected row stays identifiable even while it is alerting", () => {
  // Alert rows own box-shadow, so selection must not compete for the same property.
  assert.match(rule(".target-row.active"), /outline:\s*1px solid/);
  assert.doesNotMatch(rule(".target-row.active"), /box-shadow/);
  assert.match(rule(".target-row.is-alert"), /box-shadow/);
  assert.match(rule(".target-row.is-alert-warning"), /rgb\(245 158 11/);
});

test("the altitude colour bar survives an alerting row", () => {
  assert.doesNotMatch(rule(".target-row.is-alert"), /inset 3px 0 0/);
  assert.match(rule(".row-bar"), /width:\s*3px/);
});

test("the target station exposes pin, and its X hides the console without deselecting", () => {
  const head = app.slice(app.indexOf('"station station-target"'), app.indexOf('<div class="station-body">'));
  assert.match(head, /togglePin\(selectedAircraft\.hex\)/);
  // X mirrors the bar's Target toggle: the selection and an active track survive the close.
  assert.match(head, /@click="toggleStation\('target'\)"/);
  assert.doesNotMatch(head, /@click="clearSelection"/);
  // Deselecting still exists: Escape and the empty-map click.
  assert.match(app, /if \(selectedHex\.value\) clearSelection\(\)/);
  assert.match(app, /if \(selectedHex\.value\) clearSelection\(\);/);
});

test("the settings console dismisses on an outside click, never on a drag", () => {
  assert.match(app, /function onGlobalPointerDown\(event\)/);
  assert.match(app, /\.station-systems, \.cbar-stations, \.station-tabs/);
  // A rotate/pan that starts outside must not close it: the pointer must land where it went down.
  assert.match(app, /Math\.hypot\(event\.clientX - systemsDismissDown\.x, event\.clientY - systemsDismissDown\.y\) > 6/);
  assert.match(app, /if \(!moved && stationOpen\.value\.systems\) \{/);
  // The dismissing click must not double as an empty-map click that clears the selection.
  assert.match(app, /suppressMapDeselectUntil = performance\.now\(\) \+ 300/);
  assert.match(app, /if \(performance\.now\(\) < suppressMapDeselectUntil\) return;/);
});

test("traffic totals are not duplicated between the bar and the stations", () => {
  assert.equal(app.includes("const stats = computed"), false);
  assert.match(app, /const sourceCounts = computed/);
  assert.equal(app.includes("stats.value"), false);
});

test("the traffic list carries exactly what the map carries", () => {
  // Dropped targets are excluded with the same predicate the 3D layer and the TRK count use.
  assert.match(app, /aircraft\.value\.filter\(\(item\) => passesFilters\(item\) && !isDropped\(item\)\)/);
});

test("the station chrome uses the shared tactical tokens", () => {
  const root = css.slice(0, css.indexOf("}"));
  assert.match(root, /--mono:/);
  assert.match(root, /--rule:/);
  assert.match(root, /--rule-strong:/);
  assert.match(root, /--glass:/);
  assert.match(rule(".station"), /border:\s*1px solid var\(--rule-strong\)/);
  assert.match(rule(".station-tag"), /var\(--accent\)/);
});

test("one generous type ramp drives every readout", () => {
  const root = css.slice(0, css.indexOf("}"));
  for (const token of ["--fs-tag", "--fs-micro", "--fs-small", "--fs-body", "--fs-value", "--fs-title"]) {
    assert.ok(root.includes(token), `${token} must be declared`);
  }
  // Readable at a glance: the body size must not regress into dashboard-compact territory.
  const body = Number((root.match(/--fs-body:\s*([\d.]+)px/) || [])[1]);
  assert.ok(body >= 15, `--fs-body must be at least 15px (got ${body})`);
  // Every chrome rule reads the ramp, never a hardcoded px font size. The 3D overlay section is
  // exempt: data blocks annotate the scene and deliberately sit a notch below the panel ramp.
  const chrome = css.slice(css.indexOf("* {"), css.indexOf("/* --- 3D tactical view ---"));
  const literals = chrome.match(/font(?:-size)?:[^;]*\b\d[\d.]*px/g) || [];
  assert.deepEqual(literals.filter((decl) => !decl.includes("calc(")), []);
  // Mobile browsers must not re-inflate it either.
  assert.match(root, /text-size-adjust:\s*100%/);
});

test("a receiver row answers everything about that receiver", () => {
  const rows = between(app, "const receiverRows = computed(", "function receiverRow(receiver, area)");
  assert.match(rows, /new Map\(\(coverage\.value\.areas \|\| \[\]\)\.map\(\(area\) => \[area\.receiverName, area\]\)\)/);
  // A receiver with coverage but no live row must still be listed, or its dome could not be hidden.
  assert.match(rows, /for \(const \[name, area\] of areas\)/);
  const row = between(app, "function receiverRow(receiver, area)", "\n}");
  assert.match(row, /domeCentre\(area\?\.volumeMesh\)/);
  assert.match(app, /@click="focusReceiver\(row\)"/);
  assert.match(app, /@click="toggleCoverageReceiver\(row\.name\)"/);
  assert.match(app, /No receivers reporting yet — connect a feeder/);
});

test("labels are readable or absent — never clipped, buried or overlapping", () => {
  const sync = between(tactical, "function syncBlocks() {", "for (const [hex, b] of blocks)");
  // Off-screen targets take their labels with them instead of stacking against an edge.
  assert.match(sync, /p\[0\] > viewW \+ ANCHOR_SLACK_PX/);
  // Declutter order is stable, and the selected/hovered/pinned label is never dropped.
  assert.match(sync, /rank: d\.hex === selHex \? 0 : d\.hex === activeHex \? 1 : pinned\.has\(d\.hex\) \? 2 : 3/);
  assert.match(sync, /a\.rank - b\.rank \|\| \(a\.d\.hex < b\.d\.hex \? -1 : 1\)/);
  // The label cap trims the tail of that order — it must not blank every label past the threshold.
  assert.match(sync, /\.slice\(0, LABEL_ALL_LIMIT\)/);
  assert.match(sync, /placeLabel\(p, b\.size, labelGap\(d\.hex\), rank === 3, placed, reserved, viewW, viewH\)/);

  const place = between(tactical, "function placeLabel(", "// The offset from the target scales");
  assert.match(place, /if \(!placed\.hits\(box\)\) return box/);
  assert.match(tactical, /function makeLabelIndex\(\)/);
  assert.match(tactical, /const LABEL_CELL_PX = 64/);
  // No candidate may ever cover the aircraft: unfitting side spots are skipped, never clamped
  // back toward the target, and the never-drop fallback is the first in-view spot CLEAR of it.
  assert.match(place, /if \(!c\.fits\) continue/);
  assert.match(place, /return droppable \? null : \(fallback \?\? clearOfTarget\)/);
  // Side candidates centre on the target vertically (no more "slightly below" anchor).
  assert.match(place, /const centerY = p\[1\] - size\.h \/ 2/);
  assert.doesNotMatch(place, /p\[1\] - 16/);

  // Only the small always-on-top clusters are reserved; the selector must name CURRENT chrome.
  // Stations and the phone tab row are deliberately NOT reserved: a nearby label layers under
  // the glass instead of being shoved down the screen (or onto its own aircraft on a phone).
  const reserved = between(tactical, "function reservedRects() {", "// Slide a card vertically");
  assert.match(reserved, /\.alert-strip, \.map-chrome/);
  assert.doesNotMatch(reserved, /\.station\b|\.station-tabs/);
  for (const cls of [".alert-strip", ".map-chrome"]) {
    assert.ok(css.includes(cls), `${cls} must exist in styles.css for the reserved-rect selector`);
  }
  assert.match(reserved, /reservedCache && now - reservedCache\.at < 250/);
  assert.match(sync, /const reserved = reservedRects\(\);/);
});

test("the airfield card is clamped and pushed clear of the chrome too", () => {
  const position = between(tactical, "function positionAf(el, field) {", "\n  }");
  assert.match(position, /if \(y < OVERLAY_MARGIN_PX\) y = p\.y \+ 18/);
  assert.match(position, /avoidReserved\(x, y, w, h, reservedRects\(\), viewH\)/);
});

test("settings cards fold from their headers and the fold persists", () => {
  assert.match(app, /const CARDS_KEY = "skytrace\.consoleCards"/);
  // A fresh browser starts with everything but Status folded.
  assert.match(app, /CARDS_FOLDED_FRESH = \["receivers", "filters", "units", "display", "config"\]/);
  assert.match(app, /if \(stored == null\) return new Set\(CARDS_FOLDED_FRESH\)/);
  for (const key of ["status", "receivers", "filters", "units", "display", "config"]) {
    assert.ok(app.includes(`toggleCard('${key}')`), `${key} card must fold`);
  }
  // The Filters Reset button must not double as its header's fold toggle.
  assert.match(app, /@click\.stop="resetFilters"/);
  assert.match(css, /\.cblock\.collapsed > :not\(header\)/);
});

test("import failure reports via an overlay toast, never height-shifting card text", () => {
  assert.equal(app.includes("settingsNotice"), false);
  assert.equal(app.includes("cblock-note"), false);
  assert.match(app, /importError\.value = "Import failed/);
  assert.match(app, /class="import-toast" role="alert"/);
  // The toast floats over the console instead of reshaping it.
  assert.match(rule(".import-toast"), /position:\s*absolute/);
});

test("keyboard focus is visible on the dark chrome", () => {
  assert.match(css, /:focus-visible \{\s*outline:\s*2px solid var\(--accent\)/);
});
