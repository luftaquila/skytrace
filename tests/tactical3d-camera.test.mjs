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
