import assert from "node:assert/strict";
import test from "node:test";

import {
  createRetainedSymbolPlacement,
  installSingleTerrainSourceUpdate,
  installViewportSymbolSize,
  keepViewportSymbolSize,
} from "../web/src/maplibre-performance.js";

function terrainManager(counter) {
  const base = {
    update() {
      counter.count++;
    },
  };
  return {
    tileManager: base,
    update() {
      base.update();
    },
  };
}

test("a source-dirty terrain render updates the base DEM manager only once", () => {
  const dem = { count: 0 };
  const other = { count: 0 };
  const map = {
    sourcesDirty: true,
    terrain: { tileManager: terrainManager(dem) },
    _render() {
      if (this.sourcesDirty) {
        this.terrain.tileManager.tileManager.update();
        other.count++;
      }
      this.terrain.tileManager.update();
    },
  };

  const restore = installSingleTerrainSourceUpdate(map);
  map._render();
  assert.equal(dem.count, 1);
  assert.equal(other.count, 1, "unrelated source managers must still update");

  map.sourcesDirty = false;
  map._render();
  assert.equal(dem.count, 2, "the first DEM update of the next render must still run");

  map.terrain.tileManager.tileManager.update();
  map.terrain.tileManager.tileManager.update();
  assert.equal(dem.count, 4, "updates outside Map._render must never be deduplicated");

  restore();
  map.sourcesDirty = true;
  map._render();
  assert.equal(dem.count, 6, "restoring returns MapLibre's original two-call path");
});

test("a terrain manager replaced by setTerrain is patched on the next render", () => {
  const first = { count: 0 };
  const second = { count: 0 };
  const map = {
    terrain: { tileManager: terrainManager(first) },
    _render() {
      this.terrain.tileManager.tileManager.update();
      this.terrain.tileManager.update();
    },
  };

  const restore = installSingleTerrainSourceUpdate(map);
  map._render();
  assert.equal(first.count, 1);

  map.terrain.tileManager = terrainManager(second);
  map._render();
  assert.equal(second.count, 1);

  restore();
  map._render();
  assert.equal(second.count, 3);
});

test("viewport symbol shaders retain authored screen size while map-aligned symbols keep perspective", () => {
  const shader = `
    uniform bool u_pitch_with_map;
    uniform highp float u_camera_to_center_distance;
    void main() {
      highp float perspective_ratio = 0.5;
      size *= perspective_ratio;
    }
  `;
  const fixed = keepViewportSymbolSize(shader);
  assert.match(fixed, /size \*= \(u_pitch_with_map \? perspective_ratio : 1\.0\);/);
  assert.equal(keepViewportSymbolSize("size *= perspective_ratio;"), "size *= perspective_ratio;");
});

test("viewport symbol collision boxes use the same fixed screen size as the shader", () => {
  const shaderSources = [];
  const gl = {
    shaderSource(shader, source) {
      shaderSources.push([shader, source]);
    },
  };
  class CollisionIndex {
    projectAndGetPerspectiveRatio() {
      return { x: 1, y: 2, perspectiveRatio: 0.42 };
    }

    placeCollisionBox(...args) {
      return this.projectAndGetPerspectiveRatio(args[0], args[1]);
    }
  }
  const style = {
    pauseablePlacement: undefined,
    placement: undefined,
    _updatePlacement() {
      this.pauseablePlacement = {
        placement: {
          collisionIndex: new CollisionIndex(),
        },
      };
      return false;
    },
  };
  const map = { painter: { context: { gl } }, style };
  const restore = installViewportSymbolSize(map);

  gl.shaderSource("vertex", `
    uniform bool u_pitch_with_map;
    uniform float u_camera_to_center_distance;
    void main() { float perspective_ratio = 0.5; size *= perspective_ratio; }
  `);
  assert.match(shaderSources[0][1], /u_pitch_with_map \? perspective_ratio : 1\.0/);

  // The discovery pass is discarded so the first committed placement uses the fixed collision
  // prototype rather than a mixture of old and new box sizes.
  assert.equal(style._updatePlacement(), true);
  assert.equal(style.pauseablePlacement, undefined);
  style._updatePlacement();
  const collision = style.pauseablePlacement.placement.collisionIndex;
  assert.equal(collision.placeCollisionBox({}, null, null, null, null, false).perspectiveRatio, 1);
  assert.equal(collision.placeCollisionBox({}, null, null, null, null, true).perspectiveRatio, 0.42);

  restore();
  assert.equal(collision.placeCollisionBox({}, null, null, null, null, false).perspectiveRatio, 0.42);
});

test("a queued source render can never be relabelled as a tactical-only placement skip", () => {
  let placementCalls = 0;
  let updateCalls = 0;
  const style = {
    _updatePlacement() {
      placementCalls++;
      return "placed";
    },
  };
  const map = {
    style,
    _frameRequest: null,
    _sourcesDirty: false,
    _styleDirty: false,
    _placementDirty: false,
    isMoving: () => false,
    _update(updateStyle = false) {
      updateCalls++;
      this._sourcesDirty = true;
      this._styleDirty ||= updateStyle;
      this.triggerRepaint();
      return this;
    },
    triggerRepaint() {
      this._frameRequest ||= { pending: true };
    },
  };
  const stockMapUpdate = map._update;
  const retained = createRetainedSymbolPlacement(map);
  assert.notEqual(map._update, stockMapUpdate);
  assert.equal(retained.installStyle(), true);

  // A clean frame requested solely for the custom tactical layer may reuse the settled placement.
  retained.triggerTacticalRepaint();
  assert.ok(map._frameRequest);
  map._frameRequest = null; // MapLibre clears this immediately before entering Map._render().
  assert.equal(style._updatePlacement(), false);
  assert.equal(placementCalls, 0);

  // Reproduce the regression: source data arrives after the tactical request but before render.
  retained.triggerTacticalRepaint();
  map._update(false);
  assert.equal(updateCalls, 1);
  map._frameRequest = null;
  map._sourcesDirty = false; // Map._render clears this before Style._updatePlacement().
  assert.equal(style._updatePlacement(), "placed");
  assert.equal(placementCalls, 1, "the newly arrived symbol bucket must be placed");

  // A frame MapLibre had already scheduled is never owned by the tactical repaint either.
  map._frameRequest = { external: true };
  retained.triggerTacticalRepaint();
  map._frameRequest = null;
  assert.equal(style._updatePlacement(), "placed");
  assert.equal(placementCalls, 2);

  retained.destroy();
  assert.equal(map._update, stockMapUpdate);
  assert.equal(style._updatePlacement(), "placed");
  assert.equal(placementCalls, 3);
});
