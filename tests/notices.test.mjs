import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { collectNotices } from "../scripts/notices.mjs";

const repoRoot = new URL("../", import.meta.url);
const webManifest = JSON.parse(await readFile(new URL("web/package.json", repoRoot), "utf8"));
const rootManifest = JSON.parse(await readFile(new URL("package.json", repoRoot), "utf8"));

const web = collectNotices([{ root: new URL("web/", repoRoot).pathname, scope: "web" }]);

test("every shipped package carries a licence id and its notice text", () => {
  // MIT, BSD and ISC each make retaining the copyright notice a condition of redistribution, so an
  // entry without text is a package we would be shipping without its notice.
  assert.deepEqual(web.filter((pkg) => !pkg.text).map((pkg) => pkg.name), []);
  assert.deepEqual(web.filter((pkg) => !pkg.license).map((pkg) => pkg.name), []);
  assert.deepEqual(web.filter((pkg) => !pkg.version).map((pkg) => pkg.name), []);
});

test("the npm closure is production-only and covers the shipped browser tree", () => {
  const names = new Set(web.map((pkg) => pkg.name));
  assert.ok(names.has("maplibre-gl"), "web runtime dep must be covered");
  // Root development and browser-test dependencies do not reach the image; the Docker build adds
  // notices from the linked Go binary separately.
  for (const dev of Object.keys(webManifest.devDependencies || {})) {
    assert.ok(!names.has(dev), `${dev} is a devDependency and must not be listed`);
  }
  for (const dev of Object.keys(rootManifest.devDependencies || {})) {
    assert.ok(!names.has(dev), `${dev} is a root devDependency and must not be listed`);
  }
});

test("scopes identify the browser artifact and repeated collection stays idempotent", () => {
  assert.deepEqual(web.find((pkg) => pkg.name === "maplibre-gl").scopes, ["web"]);
  const again = collectNotices(
    [{ root: new URL("web/", repoRoot).pathname, scope: "web" }],
    { packages: web },
  );
  assert.equal(again.length, web.length);
});

test("a package whose licence lives only in its README is still captured", () => {
  // murmurhash-js ships no LICENSE file; the full MIT text is a README section.
  const pkg = web.find((entry) => entry.name === "murmurhash-js");
  assert.match(pkg.text, /Copyright \(c\) 2011 Gary Court/);
  assert.match(pkg.text, /Permission is hereby granted/);
});
