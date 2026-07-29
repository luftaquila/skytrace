// Narrow runtime adapters for MapLibre internals that are hot in Skytrace's terrain camera.
// Keep every patch instance-scoped and reversible: an upstream internal rename must degrade to the
// stock renderer, never prevent the map from starting.

const VIEWPORT_SYMBOL_SHADER_MARKERS = [
  "u_pitch_with_map",
  "u_camera_to_center_distance",
  "perspective_ratio",
];
const PERSPECTIVE_SIZE_ASSIGNMENT = /\bsize\s*\*=\s*perspective_ratio\s*;/g;

/**
 * MapLibre's symbol shaders multiply even viewport-aligned text/icons by a distance-based
 * perspective ratio. That makes ground labels shrink (and eventually become unreadable) while the
 * camera is pitched or orbiting an elevated aircraft. Preserve the correction for map-aligned
 * symbols, but keep viewport-aligned symbols at their authored CSS-pixel size.
 */
export function keepViewportSymbolSize(shaderSource) {
  if (typeof shaderSource !== "string"
    || !VIEWPORT_SYMBOL_SHADER_MARKERS.every((marker) => shaderSource.includes(marker))) {
    return shaderSource;
  }
  return shaderSource.replace(
    PERSPECTIVE_SIZE_ASSIGNMENT,
    "size *= (u_pitch_with_map ? perspective_ratio : 1.0);",
  );
}

const patchedCollisionPrototypes = new WeakMap();

function installViewportCollisionSize(collisionIndex) {
  const prototype = collisionIndex && Object.getPrototypeOf(collisionIndex);
  const originalPlaceCollisionBox = prototype?.placeCollisionBox;
  if (!prototype || typeof originalPlaceCollisionBox !== "function") return false;
  if (patchedCollisionPrototypes.has(prototype)) return true;

  const fixedViewportCollisionBox = function (...args) {
    // CollisionIndex.placeCollisionBox(..., pitchWithMap, ...): only viewport-aligned point
    // symbols need the fixed screen size. Map-aligned text keeps MapLibre's perspective geometry.
    const pitchWithMap = args[5];
    if (pitchWithMap || typeof this.projectAndGetPerspectiveRatio !== "function") {
      return originalPlaceCollisionBox.apply(this, args);
    }
    const hadOwnProjection = Object.hasOwn(this, "projectAndGetPerspectiveRatio");
    const ownProjection = this.projectAndGetPerspectiveRatio;
    this.projectAndGetPerspectiveRatio = function (...projectionArgs) {
      const projected = ownProjection.apply(this, projectionArgs);
      return projected ? { ...projected, perspectiveRatio: 1 } : projected;
    };
    try {
      return originalPlaceCollisionBox.apply(this, args);
    } finally {
      if (hadOwnProjection) this.projectAndGetPerspectiveRatio = ownProjection;
      else delete this.projectAndGetPerspectiveRatio;
    }
  };
  prototype.placeCollisionBox = fixedViewportCollisionBox;
  patchedCollisionPrototypes.set(prototype, {
    originalPlaceCollisionBox,
    fixedViewportCollisionBox,
  });
  return true;
}

function restoreViewportCollisionSize(collisionIndex) {
  const prototype = collisionIndex && Object.getPrototypeOf(collisionIndex);
  const patch = prototype && patchedCollisionPrototypes.get(prototype);
  if (!prototype || !patch) return;
  if (prototype.placeCollisionBox === patch.fixedViewportCollisionBox) {
    prototype.placeCollisionBox = patch.originalPlaceCollisionBox;
  }
  patchedCollisionPrototypes.delete(prototype);
}

/**
 * Keep MapLibre viewport-aligned symbol rendering and collision placement in the same, fixed
 * screen-pixel coordinate system. The shader hook is scoped to this WebGL context. CollisionIndex
 * is discovered on the first placement; that first provisional placement is discarded so no frame
 * can commit boxes calculated with the old perspective size.
 */
export function installViewportSymbolSize(map) {
  const gl = map?.painter?.context?.gl;
  const style = map?.style;
  const originalShaderSource = gl?.shaderSource;
  const originalUpdatePlacement = style?._updatePlacement;
  if (typeof originalShaderSource !== "function" || typeof originalUpdatePlacement !== "function") {
    return () => {};
  }

  const fixedShaderSource = function (shader, source) {
    return originalShaderSource.call(this, shader, keepViewportSymbolSize(source));
  };
  try {
    gl.shaderSource = fixedShaderSource;
  } catch {
    return () => {};
  }
  if (gl.shaderSource !== fixedShaderSource) return () => {};

  let collisionIndex = null;
  let collisionPrototypeReady = false;
  const patchCurrentCollisionIndex = () => {
    const next = style.pauseablePlacement?.placement?.collisionIndex
      || style.placement?.collisionIndex;
    if (!next) return collisionPrototypeReady;
    collisionIndex = next;
    collisionPrototypeReady = installViewportCollisionSize(next);
    return collisionPrototypeReady;
  };

  const fixedUpdatePlacement = function (...args) {
    const collisionReadyBefore = patchCurrentCollisionIndex();
    const result = originalUpdatePlacement.apply(this, args);
    const collisionReadyAfter = patchCurrentCollisionIndex();
    if (!collisionReadyBefore && collisionReadyAfter) {
      // The first call had already started placing with MapLibre's perspective-sized boxes.
      // Throw that provisional pass away; the next render starts clean with the patched prototype.
      this.pauseablePlacement = undefined;
      this.placement?.setStale?.();
      return true;
    }
    return result;
  };
  style._updatePlacement = fixedUpdatePlacement;

  return () => {
    if (style._updatePlacement === fixedUpdatePlacement) {
      style._updatePlacement = originalUpdatePlacement;
    }
    restoreViewportCollisionSize(collisionIndex);
    if (gl.shaderSource === fixedShaderSource) gl.shaderSource = originalShaderSource;
  };
}

/**
 * Retain an already-settled symbol placement only when Skytrace is creating a genuinely
 * custom-layer-only frame.
 *
 * MapLibre clears `_styleDirty` and `_sourcesDirty` before it calls Style._updatePlacement().
 * Inspecting those flags from an _updatePlacement wrapper is therefore too late: a vector tile or
 * GeoJSON update that shares a browser frame with a tactical repaint can look clean and have its
 * only placement pass skipped. Patch Map._update as an invalidation signal and refuse to claim a
 * frame that MapLibre had already scheduled for itself.
 */
export function createRetainedSymbolPlacement(map) {
  let tacticalOnlyPending = false;
  let restoreStylePlacement = null;
  const originalMapUpdate = map?._update;

  const invalidate = () => {
    tacticalOnlyPending = false;
  };
  const invalidatingMapUpdate = function (...args) {
    invalidate();
    return originalMapUpdate.apply(this, args);
  };

  if (typeof originalMapUpdate === "function") {
    try {
      map._update = invalidatingMapUpdate;
    } catch {
      // An upstream private API change must fall back to stock placement, never suppress it.
    }
  }

  function canRetainForTacticalFrame() {
    return map?._update === invalidatingMapUpdate
      && "_frameRequest" in map
      && map._frameRequest == null
      && map._sourcesDirty === false
      && map._styleDirty === false
      && map._placementDirty === false
      && map.isMoving?.() === false;
  }

  function triggerTacticalRepaint() {
    // A non-null frame request belongs to MapLibre (source/style/camera work) or to an earlier
    // repaint. Never relabel that shared frame as tactical-only.
    tacticalOnlyPending = canRetainForTacticalFrame();
    map?.triggerRepaint?.();
  }

  function installStyle() {
    restoreStylePlacement?.();
    restoreStylePlacement = null;
    const style = map?.style;
    const originalUpdatePlacement = style?._updatePlacement;
    if (typeof originalUpdatePlacement !== "function") return false;

    const retainedUpdatePlacement = function (...args) {
      const tacticalOnly = tacticalOnlyPending;
      tacticalOnlyPending = false;
      // The pre-render snapshot above owns the main decision. Keep these late checks as a final
      // guard for synchronous mutations made from inside MapLibre's own render work.
      if (tacticalOnly
        && map._sourcesDirty === false
        && map._styleDirty === false
        && map._placementDirty === false
        && map.isMoving?.() === false) return false;
      return originalUpdatePlacement.apply(this, args);
    };
    style._updatePlacement = retainedUpdatePlacement;
    restoreStylePlacement = () => {
      if (style._updatePlacement === retainedUpdatePlacement) {
        style._updatePlacement = originalUpdatePlacement;
      }
    };
    return true;
  }

  function destroy() {
    invalidate();
    restoreStylePlacement?.();
    restoreStylePlacement = null;
    if (map?._update === invalidatingMapUpdate) map._update = originalMapUpdate;
  }

  return {
    destroy,
    installStyle,
    invalidate,
    triggerTacticalRepaint,
  };
}

/**
 * MapLibre 6.0 still reaches the raster-dem TileManager twice in a source-dirty terrain render:
 *
 *   Style._updateSources() -> dem TileManager.update()
 *   TerrainTileManager.update() -> dem TileManager.update() again
 *
 * The second call receives the same transform and terrain in the same synchronous Map._render().
 * Make only that duplicate idempotent. Updates outside Map._render() (source data events, reloads)
 * and the first DEM update of every later render continue to run normally.
 */
export function installSingleTerrainSourceUpdate(map) {
  const originalRender = map?._render;
  if (typeof originalRender !== "function") return () => {};

  let renderDepth = 0;
  let updatedInRender = new Set();
  const patchedManagers = new Map();

  function patchCurrentTerrainManager() {
    const manager = map.terrain?.tileManager?.tileManager;
    if (!manager || patchedManagers.has(manager) || typeof manager.update !== "function") return;
    const originalUpdate = manager.update;
    const singleTerrainSourceUpdate = function (...args) {
      if (renderDepth > 0) {
        if (updatedInRender.has(manager)) return;
        updatedInRender.add(manager);
      }
      return originalUpdate.apply(this, args);
    };
    manager.update = singleTerrainSourceUpdate;
    patchedManagers.set(manager, { originalUpdate, singleTerrainSourceUpdate });
  }

  const deduplicatedRender = function (...args) {
    patchCurrentTerrainManager();
    const outermost = renderDepth === 0;
    if (outermost) updatedInRender = new Set();
    renderDepth++;
    try {
      return originalRender.apply(this, args);
    } finally {
      renderDepth--;
      if (outermost) updatedInRender.clear();
    }
  };
  map._render = deduplicatedRender;
  patchCurrentTerrainManager();

  return () => {
    if (map._render === deduplicatedRender) map._render = originalRender;
    for (const [manager, { originalUpdate, singleTerrainSourceUpdate }] of patchedManagers) {
      if (manager.update === singleTerrainSourceUpdate) manager.update = originalUpdate;
    }
    patchedManagers.clear();
    updatedInRender.clear();
  };
}
