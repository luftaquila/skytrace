import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Sheet switching, visibility and physical hit sizes run in Chromium in tests/e2e. Only the
// platform and pointer-routing contracts that cannot be emulated by a fixed desktop viewport live
// here.
const css = await readFile(new URL("../web/src/styles.css", import.meta.url), "utf8");
const html = await readFile(new URL("../web/index.html", import.meta.url), "utf8");

function rule(selector) {
  const start = css.indexOf(`\n${selector} {`) + 1;
  assert.notEqual(start, 0, `${selector} must exist in styles.css`);
  return css.slice(start, css.indexOf("}", start));
}

test("the document and fixed chrome account for notched-screen safe areas", () => {
  assert.match(html, /viewport-fit=cover/);
  assert.match(html, /user-scalable=no/);
  assert.match(rule(".cbar"), /env\(safe-area-inset-top, 0px\)/);
  assert.match(css, /padding-bottom:\s*env\(safe-area-inset-bottom, 0px\)/);
});

test("the 3D overlay passes gestures through except on interactive data blocks", () => {
  const overlay = rule(".t3d-overlay");
  assert.match(overlay, /position:\s*absolute/);
  assert.match(overlay, /pointer-events:\s*none/);
  assert.match(rule(".t3d-block"), /pointer-events:\s*auto/);
  assert.match(rule(".map-3d"), /position:\s*relative/);
});
