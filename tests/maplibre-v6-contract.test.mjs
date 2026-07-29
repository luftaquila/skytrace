import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const webPackage = JSON.parse(
  await readFile(new URL("../web/package.json", import.meta.url), "utf8"),
);
const webLock = JSON.parse(
  await readFile(new URL("../web/package-lock.json", import.meta.url), "utf8"),
);
const runtime = await readFile(
  new URL("../web/src/maplibre-runtime.js", import.meta.url),
  "utf8",
);
const tactical = await readFile(
  new URL("../web/src/tactical3d.js", import.meta.url),
  "utf8",
);
const internals = await readFile(
  new URL("../web/src/maplibre-internals.js", import.meta.url),
  "utf8",
);
const performanceAdapters = await readFile(
  new URL("../web/src/maplibre-performance.js", import.meta.url),
  "utf8",
);
const aircraft = await readFile(
  new URL("../web/src/aircraft-layer.js", import.meta.url),
  "utf8",
);
const mapSource = await readFile(
  new URL("../web/node_modules/maplibre-gl/src/ui/map.ts", import.meta.url),
  "utf8",
);
const cameraSource = await readFile(
  new URL("../web/node_modules/maplibre-gl/src/ui/camera.ts", import.meta.url),
  "utf8",
);
const vectorTileSource = await readFile(
  new URL("../web/node_modules/maplibre-gl/src/source/vector_tile_source.ts", import.meta.url),
  "utf8",
);
const globeSource = await readFile(
  new URL(
    "../web/node_modules/maplibre-gl/src/geo/projection/globe_transform.ts",
    import.meta.url,
  ),
  "utf8",
);
const verticalSource = await readFile(
  new URL(
    "../web/node_modules/maplibre-gl/src/geo/projection/vertical_perspective_transform.ts",
    import.meta.url,
  ),
  "utf8",
);

test("MapLibre v6 is exact-pinned in the manifest and lockfile", () => {
  assert.equal(webPackage.dependencies["maplibre-gl"], "6.0.0");
  assert.equal(webLock.packages[""].dependencies["maplibre-gl"], "6.0.0");
  assert.equal(webLock.packages["node_modules/maplibre-gl"].version, "6.0.0");
});

test("Vite receives a self-contained MapLibre module worker URL", () => {
  assert.match(runtime, /import \* as maplibregl from "maplibre-gl"/);
  assert.match(runtime, /maplibre-gl-worker\.mjs\?worker&url/);
  assert.match(runtime, /maplibregl\.setWorkerUrl\(workerUrl\)/);
  assert.doesNotMatch(runtime, /maplibre-gl-worker\.mjs\?url["']/);
});

test("the migration preserves v5 label overscaling and replaces the removed model helper", () => {
  assert.match(tactical, /zoomLevelsToOverscale:\s*undefined/);
  assert.match(tactical, /map\.setMissingStyleImageResolver\(/);
  assert.doesNotMatch(tactical, /map\.on\("styleimagemissing"/);
  assert.doesNotMatch(aircraft, /getMatrixForModel|map\.transform/);
  assert.match(aircraft, /modelFrameForProjection/);
  assert.match(aircraft, /defaultProjectionData\.projectionTransition/);
});

test("the exact v6 camera compatibility boundary still matches the installed engine", () => {
  assert.match(mapSource, /this\._camera = new Camera\(/);
  assert.match(mapSource, /this\._handlers = new HandlerManager\(/);
  assert.match(cameraSource, /transform: ITransform/);
  assert.match(cameraSource, /cameraHelper: ICameraHelper/);
  assert.match(cameraSource, /_requestedCameraState\?: ITransform/);
  assert.match(globeSource, /_verticalPerspectiveTransform: VerticalPerspectiveTransform/);
  assert.match(verticalSource, /_globeViewProjMatrix32f/);
  assert.match(verticalSource, /_globeViewProjMatrixNoCorrectionInverted/);
  assert.match(verticalSource, /_cachedClippingPlane/);
  assert.match(verticalSource, /_cachedFrustum/);
});

test("the exact-v6 adapter contains no v5 object-graph fallbacks", () => {
  assert.match(internals, /map\?\._camera\?\.transform/);
  assert.match(internals, /map\?\._camera\?\._requestedCameraState/);
  assert.match(internals, /map\?\._camera\?\.cameraHelper/);
  assert.match(internals, /map\?\._handlers\?\._handlersById/);
  assert.doesNotMatch(
    internals,
    /map\?\.(?:transform|_requestedCameraState|cameraHelper|handlers)\b/,
  );
});

test("reference-source retry uses the installed v6 public VectorTileSource API", () => {
  assert.match(vectorTileSource, /setUrl\(url: string\): this/);
  assert.match(tactical, /source\.setUrl\(MAP_REFERENCE_SOURCE_URL\)/);
  assert.doesNotMatch(tactical, /style\?\._reloadSource|reloadSource\.call/);
});

test("the v5 shader prewarm experiment is absent from the v6 runtime", () => {
  assert.doesNotMatch(performanceAdapters, /prewarmMapLibreShaders|MAPLIBRE_PREWARM_PROGRAMS|painter\.useProgram/);
  assert.doesNotMatch(tactical, /prewarmMapLibreShaders|MAPLIBRE_PREWARM_PROGRAMS/);
});
