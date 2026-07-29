import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  AIRFIELDS_CREDIT,
  REFERENCE_CREDIT,
  SATELLITE_CREDIT,
  TERRAIN_CREDIT,
  areaTrafficCredit,
  mapCredits,
} from "../web/src/credits.js";

const tactical = await readFile(new URL("../web/src/tactical3d.js", import.meta.url), "utf8");
const app = await readFile(new URL("../web/src/App.vue", import.meta.url), "utf8");

test("every credit names its provider and links out safely", () => {
  for (const credit of mapCredits({ areaFeedHost: "api.adsb.lol" })) {
    assert.ok(credit.role.length > 0);
    assert.match(credit.html, /<a href="https:\/\//);
    // An attribution link opening in a new tab must not hand the opener over with it.
    for (const anchor of credit.html.matchAll(/<a [^>]*>/g)) {
      assert.match(anchor[0], /rel="noopener noreferrer"/);
      assert.match(anchor[0], /target="_blank"/);
    }
  }
});

test("the imagery credit tracks Esri's current suppliers, not the pre-rebrand list", () => {
  assert.match(SATELLITE_CREDIT.html, /Esri/);
  assert.match(SATELLITE_CREDIT.html, /Vantor/);
  assert.match(SATELLITE_CREDIT.html, /Earthstar Geographics/);
  // Maxar became Vantor; the live service's copyrightText no longer says Maxar and neither may we.
  assert.doesNotMatch(SATELLITE_CREDIT.html, /Maxar/);
});

test("the terrain credit links Mapterhorn's own source list rather than inlining 134 entries", () => {
  assert.match(TERRAIN_CREDIT.html, /Mapterhorn/);
  assert.match(TERRAIN_CREDIT.html, /mapterhorn\.com\/attribution/);
});

test("the reference credit carries the providers OpenFreeMap requires", () => {
  for (const provider of ["OpenFreeMap", "OpenMapTiles", "OpenStreetMap"]) {
    assert.match(REFERENCE_CREDIT.html, new RegExp(provider));
  }
  // The ODbL notice is satisfied by reference, so the link has to be the copyright page itself.
  assert.match(REFERENCE_CREDIT.html, /openstreetmap\.org\/copyright/);
});

test("the airfield credit is a courtesy, and names the public-domain terms as such", () => {
  assert.match(AIRFIELDS_CREDIT.html, /OurAirports/);
  assert.match(AIRFIELDS_CREDIT.html, /public domain/);
  assert.match(AIRFIELDS_CREDIT.html, /ourairports\.com\/data/);
});

test("the area traffic credit names whichever aggregator the operator configured", () => {
  // ODbL requires identifying the source database, and the operator picks it — so hardcoding a
  // provider would credit a database a differently-configured deployment never touched.
  assert.match(areaTrafficCredit("api.adsb.lol").html, /api\.adsb\.lol/);
  assert.match(areaTrafficCredit("opendata.adsb.fi").html, /opendata\.adsb\.fi/);
  assert.doesNotMatch(areaTrafficCredit("opendata.adsb.fi").html, /adsb\.lol/);
});

test("an absent or unusable host credits nobody in particular rather than guessing", () => {
  for (const host of [null, undefined, "", "   "]) {
    assert.match(areaTrafficCredit(host).html, /operator's configured aggregator/);
    assert.doesNotMatch(areaTrafficCredit(host).html, /<a /);
  }
});

test("the host cannot inject markup, since the credit reaches the DOM through v-html", () => {
  for (const hostile of ['x"><img src=x onerror=alert(1)>', "evil.test/</a><script>", "a b", "javascript:alert(1)"]) {
    const { html } = areaTrafficCredit(hostile);
    assert.doesNotMatch(html, /<(?:img|script)/i);
    assert.match(html, /operator's configured aggregator/);
  }
});

test("every source is credited, tied to no layer toggle", () => {
  // Crediting a switched-off source is not a licence problem; failing to credit a switched-on one
  // is. So nothing here is filtered by a setting — only the aggregator's identity varies, because
  // only that is decided outside this code.
  const roles = ["Imagery", "Terrain", "Labels", "Airfields", "Traffic"];
  assert.deepEqual(mapCredits().map((c) => c.role), roles);
  assert.deepEqual(mapCredits({ areaFeedHost: "api.adsb.lol" }).map((c) => c.role), roles);
});

test("App.vue credits the host the server reports", () => {
  assert.match(app, /const credits = computed\(\(\) => mapCredits\(\{ areaFeedHost: areaFeedHost\.value \}\)\);/);
  assert.match(app, /live\.features\?\.areaFeedHost/);
});

test("the map sources carry the same credits the popover renders", () => {
  // One definition, two consumers: the style and the UI. A source that inlined its own string could
  // drift from the popover, which is how "Maxar" survived a rebrand.
  assert.match(tactical, /attribution: SATELLITE_CREDIT\.html/);
  assert.match(tactical, /attribution: TERRAIN_CREDIT\.html/);
  assert.doesNotMatch(tactical, /attribution: ['"]/);
});
