import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const app = await readFile(new URL("../web/src/App.vue", import.meta.url), "utf8");
const css = await readFile(new URL("../web/src/styles.css", import.meta.url), "utf8");

function between(startText, endText) {
  const start = app.indexOf(startText);
  const end = app.indexOf(endText, start + startText.length);
  assert.notEqual(start, -1, `${startText} must exist`);
  assert.notEqual(end, -1, `${endText} must follow ${startText}`);
  return app.slice(start, end);
}

test("aircraft popovers place update age immediately before the pin", () => {
  for (const source of [between("function tooltipHtml(", "function targetLine("), between("function datablockHtml(", "function labelText(")]) {
    assert.match(source, /tt-top-actions/);
    assert.ok(source.indexOf("tt-age") < source.indexOf("pinIcon"));
    assert.match(source, /targetLine\(item, (?:false|true), false\)/);
  }
  assert.match(css, /\.tt-top-actions\s*\{[^}]*justify-content:\s*flex-end/s);
  assert.match(css, /\.tt-top-actions \.tt-age\s*\{[^}]*text-align:\s*right/s);
});

test("Locate uses browser geolocation only when no aircraft is selected", () => {
  const recenter = between("async function recenterView(", "function applyBaseLayer(");
  assert.match(recenter, /if \(hasSel\)/);
  assert.match(recenter, /flyToView\(sel\.lon, sel\.lat, 9, sel\.altBaro \?\? sel\.altGeom, true\)/);
  assert.match(recenter, /await browserLocation\(\)/);
  assert.match(recenter, /if \(selectedHex\.value\) return/);
  assert.match(app, /onTrackingChange: \(active\) => \{ trackingActive\.value = active; \}/);
});
