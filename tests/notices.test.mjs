import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { collectNotices } from "../scripts/notices.mjs";

const repoRoot = new URL("../", import.meta.url);
const webManifest = JSON.parse(await readFile(new URL("web/package.json", repoRoot), "utf8"));

const web = collectNotices([{ root: new URL("web/", repoRoot).pathname, scope: "web" }]);
const both = collectNotices([
  { root: new URL("web/", repoRoot).pathname, scope: "web" },
  { root: repoRoot.pathname, scope: "server" },
]);

test("every shipped package carries a licence id and its notice text", () => {
  // MIT, BSD and ISC each make retaining the copyright notice a condition of redistribution, so an
  // entry without text is a package we would be shipping without its notice.
  assert.deepEqual(both.filter((pkg) => !pkg.text).map((pkg) => pkg.name), []);
  assert.deepEqual(both.filter((pkg) => !pkg.license).map((pkg) => pkg.name), []);
  assert.deepEqual(both.filter((pkg) => !pkg.version).map((pkg) => pkg.name), []);
});

test("the closure is production-only and covers both shipped trees", () => {
  const names = new Set(both.map((pkg) => pkg.name));
  // Bundled into web/dist, and installed into the image respectively.
  assert.ok(names.has("maplibre-gl"), "web runtime dep must be covered");
  assert.ok(names.has("express"), "server runtime dep must be covered");
  // devDependencies never reach the artifact, so they must not appear.
  for (const dev of Object.keys(webManifest.devDependencies || {})) {
    assert.ok(!names.has(dev), `${dev} is a devDependency and must not be listed`);
  }
  assert.ok(both.length > web.length, "the server tree must add packages the web tree does not have");
});

test("scopes say which artifact a package ships in, and merging unions them", () => {
  assert.deepEqual(web.find((pkg) => pkg.name === "maplibre-gl").scopes, ["web"]);
  assert.deepEqual(both.find((pkg) => pkg.name === "express").scopes, ["server"]);
  // Re-collecting the same tree must not duplicate an entry or lose the other tree's scope.
  const again = collectNotices([{ root: repoRoot.pathname, scope: "server" }], { packages: both });
  assert.equal(again.length, both.length);
});

test("a package whose licence lives only in its README is still captured", () => {
  // murmurhash-js ships no LICENSE file; the full MIT text is a README section.
  const pkg = web.find((entry) => entry.name === "murmurhash-js");
  assert.match(pkg.text, /Copyright \(c\) 2011 Gary Court/);
  assert.match(pkg.text, /Permission is hereby granted/);
});
