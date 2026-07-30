import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const webPackage = JSON.parse(
  await readFile(new URL("../web/package.json", import.meta.url), "utf8"),
);
const webLock = JSON.parse(
  await readFile(new URL("../web/package-lock.json", import.meta.url), "utf8"),
);

test("MapLibre v6 is exact-pinned in the manifest and lockfile", () => {
  assert.equal(webPackage.dependencies["maplibre-gl"], "6.0.0");
  assert.equal(webLock.packages[""].dependencies["maplibre-gl"], "6.0.0");
  assert.equal(webLock.packages["node_modules/maplibre-gl"].version, "6.0.0");
});
