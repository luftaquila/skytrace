import assert from "node:assert/strict";
import test from "node:test";

import {
  TERRAIN_CONTACT_OFFSET_M,
  queryTerrainContactElevation,
  resolveAircraftTerrainState,
} from "../web/src/terrain-grounding.js";

test("uses MapLibre's exaggerated DEM elevation for terrain contacts", () => {
  const calls = [];
  const map = {
    queryTerrainElevation(location) {
      calls.push(location);
      return 842.5;
    },
  };

  assert.equal(
    queryTerrainContactElevation(map, 127.25, 36.4),
    842.5 + TERRAIN_CONTACT_OFFSET_M,
  );
  assert.deepEqual(calls, [[127.25, 36.4]]);
});

test("falls back safely while terrain is unavailable", () => {
  assert.equal(
    queryTerrainContactElevation({ queryTerrainElevation: () => null }, 127, 36),
    TERRAIN_CONTACT_OFFSET_M,
  );
  assert.equal(
    queryTerrainContactElevation({
      queryTerrainElevation() {
        throw new Error("style reload");
      },
    }, 127, 36),
    TERRAIN_CONTACT_OFFSET_M,
  );
});

test("places explicit ground and altitude-less targets on the DEM surface", () => {
  const groundElevation = 725.75;
  for (const item of [
    { altBaro: 0, altGeom: 700, onGround: true },
    { altBaro: null, altGeom: null, onGround: false },
    { altBaro: 0, altGeom: null, onGround: false },
  ]) {
    assert.deepEqual(
      resolveAircraftTerrainState(item, groundElevation, 5),
      {
        altitudeFt: item.altBaro ?? item.altGeom,
        grounded: true,
        airborne: false,
        z: groundElevation,
      },
    );
  }
});

test("uses a nonzero geometric altitude when an ungrounded barometric value is zero", () => {
  assert.deepEqual(
    resolveAircraftTerrainState(
      { altBaro: 0, altGeom: 1250, onGround: false },
      700,
      5,
    ),
    {
      altitudeFt: 1250,
      grounded: false,
      airborne: true,
      z: 1250 * 0.3048 * 5,
    },
  );
});
