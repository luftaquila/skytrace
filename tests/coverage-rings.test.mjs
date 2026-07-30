import assert from "node:assert/strict";
import test from "node:test";
import { domeCentre, M_PER_DEG_LAT } from "../web/src/coverage-centre.js";
import { DEFAULT_SETTINGS, normalizeSettings } from "../web/src/settings.js";

test("coverage and range-ring visibility defaults normalize receiver lists", () => {
  assert.deepEqual(DEFAULT_SETTINGS.coverageHidden, []);
  assert.deepEqual(DEFAULT_SETTINGS.ringsHidden, []);
  assert.deepEqual(
    normalizeSettings({ coverageHidden: ["rx-a", 4], ringsHidden: ["rx-b", false] }),
    {
      ...normalizeSettings({}),
      coverageHidden: ["rx-a"],
      ringsHidden: ["rx-b"],
    },
  );
});

test("range-ring settings have independent bounded defaults", () => {
  assert.equal(DEFAULT_SETTINGS.ringSpacing, 100);
  assert.equal(DEFAULT_SETTINGS.ringCount, 3);
  assert.equal(DEFAULT_SETTINGS.ringCompass, true);
  assert.equal(DEFAULT_SETTINGS.ringUnit, "nm");
  assert.equal(normalizeSettings({ ringCount: 500 }).ringCount, 8);
});

test("receiver anchors are estimated from mesh vertices and bounds", () => {
  const quantized = Uint16Array.from([0, 0, 0, 65535, 65535, 0, 65535, 0, 0]);
  const vertexMean = domeCentre({
    encoding: "quantized-uint16-le-base64",
    positions: Buffer.from(quantized.buffer).toString("base64"),
    positionBounds: [0, 0, 0, 30000, 15000, 9000],
    origin: [127, 36],
  });
  assert.ok(Math.abs(vertexMean.lat - (36 + 5000 / M_PER_DEG_LAT)) < 1e-9);
  assert.ok(
    Math.abs(
      vertexMean.lon
        - (127 + 20000 / (M_PER_DEG_LAT * Math.cos((vertexMean.lat * Math.PI) / 180))),
    ) < 1e-9,
  );

  const boundsMidpoint = domeCentre({
    origin: [127, 36],
    positionBounds: [-20000, -10000, 0, 60000, 30000, 12000],
  });
  assert.ok(Math.abs(boundsMidpoint.lat - (36 + 10000 / M_PER_DEG_LAT)) < 1e-9);
  assert.ok(
    Math.abs(
      boundsMidpoint.lon
        - (127 + 20000 / (M_PER_DEG_LAT * Math.cos((boundsMidpoint.lat * Math.PI) / 180))),
    ) < 1e-9,
  );

  assert.deepEqual(domeCentre({ origin: [127, 36] }), { lon: 127, lat: 36 });
  assert.equal(domeCentre({ positionBounds: [0, 0, 0, 1, 1, 1] }), null);
});
