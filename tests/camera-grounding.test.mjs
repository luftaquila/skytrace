import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createServer } from "../web/node_modules/vite/dist/node/index.js";
import {
  freeViewElevationForZoom,
  pinGroundLocationAtPoint,
} from "../web/src/camera-grounding.js";
import { installGlobeCenterElevation } from "../web/src/globe-center-elevation.js";

const state = {
  anchorElevation: 36000 * 0.3048 * 5,
  anchorZoom: 10.5,
  currentElevation: 36000 * 0.3048 * 5,
  maxZoom: 22,
};

test("released aircraft elevation stays unchanged until free zoom begins", () => {
  assert.equal(freeViewElevationForZoom({ ...state, targetZoom: state.anchorZoom }), state.anchorElevation);
  assert.equal(freeViewElevationForZoom({ ...state, targetZoom: state.anchorZoom - 2 }), state.anchorElevation);
});

test("released aircraft elevation descends monotonically with free zoom", () => {
  const elevations = [10.5, 11.5, 12.5, 14.5, 18, 22].map((targetZoom) => (
    freeViewElevationForZoom({ ...state, targetZoom })
  ));
  assert.equal(elevations[0], state.anchorElevation);
  for (let index = 1; index < elevations.length; index += 1) {
    assert.ok(elevations[index] < elevations[index - 1], `${elevations[index]} must be below ${elevations[index - 1]}`);
  }
  assert.equal(elevations.at(-1), 0);
});

test("zooming back out never raises a partially grounded free pivot", () => {
  assert.equal(freeViewElevationForZoom({ ...state, currentElevation: 1500, targetZoom: 9 }), 1500);
  assert.ok(freeViewElevationForZoom({ ...state, currentElevation: 1500, targetZoom: 14 }) <= 1500);
});

test("an orbit released at renderer max zoom descends gradually over virtual zoom intent", () => {
  const atLimit = { anchorElevation: 50000, anchorZoom: 22, currentElevation: 50000, maxZoom: 27 };
  const firstWheel = freeViewElevationForZoom({ ...atLimit, targetZoom: 22.18 });
  assert.ok(firstWheel > 0 && firstWheel < atLimit.anchorElevation);
  assert.ok(freeViewElevationForZoom({ ...atLimit, currentElevation: firstWheel, targetZoom: 24 }) < firstWheel);
  assert.equal(freeViewElevationForZoom({ ...atLimit, targetZoom: 27 }), 0);
});

function solvableTransform() {
  return {
    center: { lng: 10, lat: 20 },
    elevation: 12000,
    worldSize: 512 * 2 ** 10,
    locationToScreenPoint(location, terrain) {
      let dx = location.lng - this.center.lng;
      dx -= Math.round(dx / 360) * 360;
      const surfaceElevation = terrain?.getElevationForLngLat?.(location, this) || 0;
      return {
        x: 400 + dx * 100 + (this.elevation - surfaceElevation) * 0.01,
        y: 300 - (location.lat - this.center.lat) * 100
          + (this.elevation - surfaceElevation) * 0.005,
      };
    },
    setCenter(center) {
      this.center = center;
    },
  };
}

test("descending elevation keeps the original ground location on the same screen pixel", () => {
  const transform = solvableTransform();
  const anchor = {
    loc: { lng: 10.8, lat: 23 },
    point: { x: 510, y: 245 },
    surfaceElevation: 1000,
  };
  assert.equal(pinGroundLocationAtPoint(transform, anchor), true);
  const projected = transform.locationToScreenPoint(anchor.loc, {
    getElevationForLngLat: () => anchor.surfaceElevation,
  });
  assert.ok(Math.abs(projected.x - anchor.point.x) <= 0.1);
  assert.ok(Math.abs(projected.y - anchor.point.y) <= 0.1);
});

test("the ground-pin solver uses the shortest wrapped-world correction", () => {
  const transform = solvableTransform();
  transform.center = { lng: -179, lat: 0 };
  transform.elevation = 0;
  const anchor = {
    loc: { lng: 179, lat: 0 },
    point: { x: 400, y: 300 },
    surfaceElevation: 0,
  };
  assert.equal(pinGroundLocationAtPoint(transform, anchor), true);
  const projected = transform.locationToScreenPoint(anchor.loc);
  assert.ok(Math.hypot(projected.x - anchor.point.x, projected.y - anchor.point.y) <= 0.1);
  assert.ok(Math.abs(Math.abs(transform.center.lng) - 179) < 1e-6);
});

test("an unsolved cursor pin fails closed instead of lowering around the centre", () => {
  const transform = solvableTransform();
  transform.setCenter = () => {};
  const anchor = {
    loc: { lng: 10.8, lat: 23 },
    point: { x: 510, y: 245 },
    surfaceElevation: 1000,
  };
  assert.equal(pinGroundLocationAtPoint(transform, anchor), false);
  assert.equal(pinGroundLocationAtPoint({}, anchor), false);
  assert.equal(pinGroundLocationAtPoint(transform, null), false);
});

test("the installed MapLibre v6 transform keeps an off-centre ground cursor exact while descending", async (context) => {
  const server = await createServer({
    root: fileURLToPath(new URL("../web", import.meta.url)),
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "silent",
  });
  context.after(() => server.close());
  const { MercatorTransform } = await server.ssrLoadModule(
    "/node_modules/maplibre-gl/src/geo/projection/mercator_transform.ts",
  );
  const { GlobeTransform } = await server.ssrLoadModule(
    "/node_modules/maplibre-gl/src/geo/projection/globe_transform.ts",
  );
  const { LngLat } = await server.ssrLoadModule(
    "/node_modules/maplibre-gl/src/geo/lng_lat.ts",
  );

  const cases = [
    ["mercator", MercatorTransform, null],
    ["globe-mercator", GlobeTransform, 0],
    ["globe-vertical", GlobeTransform, 1],
  ];
  const surfaceElevation = 1200;
  const terrain = {
    getElevationForLngLat: () => surfaceElevation,
    getElevationForLngLatZoom: () => surfaceElevation,
  };
  const visibleSurfaceOffsets = new Map([
    [0, [0.0005, -0.0005]],
    [45, [0.4, 0.3]],
    [70, [0.9, 0.9]],
    [80, [1.8, 1.7]],
  ]);
  for (const [name, Transform, transition] of cases) {
    for (const pitch of [0, 45, 70, 80]) {
      const transform = new Transform({
        minZoom: 0,
        maxZoom: 22,
        minPitch: 0,
        maxPitch: 180,
        renderWorldCopies: true,
      });
      transform.resize(1000, 700);
      transform.setZoom(17);
      transform.setCenter(new LngLat(127, 37));
      transform.setPitch(pitch);
      transform.setBearing(31);
      transform.setElevation(55000);
      if (transition != null) {
        transform.setTransitionState(transition, 0);
        installGlobeCenterElevation(transform);
      }
      // With a 55 km elevated pivot the visible ground moves farther ahead as pitch increases.
      // Pick an actual, off-centre surface location that remains inside this synthetic viewport.
      const [lngOffset, latOffset] = visibleSurfaceOffsets.get(pitch);
      const loc = new LngLat(127 + lngOffset, 37 + latOffset);
      const point = transform.locationToScreenPoint(loc, terrain);
      assert.ok(
        point.x >= 0 && point.x <= transform.width && point.y >= 0 && point.y <= transform.height,
        `${name} pitch ${pitch} test point must be visible`,
      );
      const probe = transform.clone();
      let centerUpdates = 0;
      const setCenter = probe.setCenter.bind(probe);
      probe.setCenter = (center) => {
        centerUpdates++;
        setCenter(center);
      };
      let currentElevation = transform.elevation;
      const targetZooms = transition === 1 ? [18, 19, 20] : [18, 19, 20, 22];
      for (const targetZoom of targetZooms) {
        const elevation = freeViewElevationForZoom({
          anchorElevation: 55000,
          anchorZoom: 17,
          currentElevation,
          targetZoom,
          maxZoom: 22,
        });
        const groundedElevation = Math.max(elevation, surfaceElevation);
        probe.setZoom(targetZoom);
        probe.setElevation(groundedElevation);
        const updatesBefore = centerUpdates;
        assert.equal(pinGroundLocationAtPoint(probe, { loc, point, surfaceElevation }), true);
        assert.ok(
          centerUpdates - updatesBefore <= 30,
          `${name} pitch ${pitch} zoom ${targetZoom} used too many centre solves`,
        );
        assert.ok(groundedElevation < currentElevation, `${name} pitch ${pitch} zoom ${targetZoom} must descend`);
        const projected = probe.locationToScreenPoint(loc, terrain);
        assert.ok(
          Math.hypot(projected.x - point.x, projected.y - point.y) <= 0.1,
          `${name} pitch ${pitch} zoom ${targetZoom} cursor drifted`,
        );
        currentElevation = groundedElevation;
      }
      if (transition !== 1) {
        assert.equal(currentElevation, surfaceElevation, `${name} pitch ${pitch} must reach terrain`);
      }
    }
  }

  // Exact reported sequence: the aircraft is released while MapLibre is already at maxZoom.
  // Another zoom-in cannot raise transform.zoom, so the continued visual zoom must come from a
  // gradual elevated-pivot descent while the terrain point under the cursor remains fixed.
  const maxZoomOffsets = new Map([
    [45, [0.4, 0.35]],
    [70, [0.95, 0.9]],
    [80, [1.7, 1.65]],
  ]);
  for (const pitch of [45, 70, 80]) {
    const transform = new MercatorTransform({
      minZoom: 0,
      maxZoom: 22,
      minPitch: 0,
      maxPitch: 180,
      renderWorldCopies: true,
    });
    transform.resize(1000, 700);
    transform.setZoom(22);
    transform.setCenter(new LngLat(127, 37));
    transform.setPitch(pitch);
    transform.setBearing(31);
    transform.setElevation(55000);
    const [lngOffset, latOffset] = maxZoomOffsets.get(pitch);
    const loc = new LngLat(127 + lngOffset, 37 + latOffset);
    const nearby = new LngLat(loc.lng + 0.01, loc.lat);
    const point = transform.locationToScreenPoint(loc, terrain);
    const nearbyBefore = transform.locationToScreenPoint(nearby, terrain);
    const scaleBefore = Math.hypot(nearbyBefore.x - point.x, nearbyBefore.y - point.y);
    const nextElevation = Math.max(surfaceElevation, freeViewElevationForZoom({
      anchorElevation: 55000,
      anchorZoom: 22,
      currentElevation: 55000,
      targetZoom: 22.18,
      maxZoom: 27,
    }));
    const probe = transform.clone();
    probe.setElevation(nextElevation);
    assert.equal(probe.zoom, 22);
    assert.ok(nextElevation < transform.elevation);
    assert.equal(pinGroundLocationAtPoint(probe, { loc, point, surfaceElevation }), true);
    const pinned = probe.locationToScreenPoint(loc, terrain);
    assert.ok(Math.hypot(pinned.x - point.x, pinned.y - point.y) <= 0.1);
    const nearbyAfter = probe.locationToScreenPoint(nearby, terrain);
    const scaleAfter = Math.hypot(nearbyAfter.x - point.x, nearbyAfter.y - point.y);
    assert.ok(scaleAfter > scaleBefore * 1.1, `pitch ${pitch} must visibly zoom at maxZoom`);
  }
});
