import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createAircraftLayer } from "../web/src/aircraft-layer.js";

const layer = await readFile(
  new URL("../web/src/aircraft-layer.js", import.meta.url),
  "utf8",
);
const tactical = await readFile(
  new URL("../web/src/tactical3d.js", import.meta.url),
  "utf8",
);
const renderSource = layer.slice(layer.indexOf("render(_glContext, args)"));

test("aircraft projection, pixel clamping, and mesh rendering are GPU-instanced", () => {
  assert.match(layer, /const AIRCRAFT_VERT = `#version 300 es/);
  assert.match(layer, /float pixels = clamp\(/);
  assert.match(layer, /vec3 delta = frame \* \(attitude \* a_pos \* modelScale\)/);
  assert.match(layer, /gl\.drawElementsInstanced\(/);
  assert.match(layer, /mesh\.staticBatch/);
  assert.match(layer, /mesh\.dynamicBatch/);
  assert.match(layer, /writeSplitVec3\(/);
  assert.match(layer, /u_reference_clip \+ u_main \* vec4\(relativeOrigin, 0\.0\)/);
  assert.doesNotMatch(renderSource, /\.clientWidth|\.clientHeight|updateViewport\(\)/);
  assert.doesNotMatch(layer, /item\.screenPx\s*=|d\.screenPx\s*=/);
  assert.match(tactical, /aircraftLayer\.screenSize\(/);
});

test("camera-relative projection preserves the Float64 custom-layer anchor", () => {
  const scale = 100_000_000.25;
  const referenceX = 0.5;
  const originX = referenceX + 1e-8;
  const translation = -(scale * referenceX) + 0.25;
  const exactReferenceClip = scale * referenceX + translation;
  const exactOriginClip = scale * originX + translation;

  // This models the regression: MapLibre's full-precision matrix was truncated before its large
  // world translation cancelled, so the small clip-space anchor term disappeared.
  const naiveReferenceClip = Math.fround(
    Math.fround(Math.fround(scale) * Math.fround(referenceX))
      + Math.fround(translation),
  );
  const relativeOrigin = Math.fround(originX - referenceX);
  const relativeClip = Math.fround(
    Math.fround(exactReferenceClip)
      + Math.fround(Math.fround(scale) * relativeOrigin),
  );

  assert.ok(Math.abs(naiveReferenceClip - exactReferenceClip) >= 0.1);
  assert.ok(Math.abs(relativeClip - exactOriginClip) < 1e-5);
});

test("trails and dots retain compact instances and expand their quads in the shader", () => {
  assert.match(layer, /int vertex = gl_VertexID % 6/);
  assert.match(layer, /gl\.drawArraysInstanced\(gl\.TRIANGLES, 0, 6, resource\.count\)/);
  assert.match(layer, /LINE_INSTANCE_FLOATS = 18/);
  assert.match(layer, /lineResources = new Map\(\)/);
  assert.match(layer, /resource\.count !== source\.length \|\| resource\.key !== key/);
  assert.doesNotMatch(layer, /\blineUpload\b|\bseg2\(|requiredLineFloats/);
});

test("GPU resources and vertex-array state have explicit lifecycle handling", () => {
  assert.match(layer, /gl\.deleteVertexArray\(resource\.vao\)/);
  assert.match(layer, /gl\.deleteVertexArray\(mesh\.staticBatch\.vao\)/);
  assert.match(layer, /gl\.deleteVertexArray\(coverageVao\)/);
  assert.match(layer, /gl\.bindVertexArray\(null\)/);
  assert.match(layer, /gl\.disable\(gl\.BLEND\)/);
});

test("the coverage shell preserves aircraft glow with premultiplied screen blending", () => {
  assert.match(layer, /fragColor = vec4\(color \* u_alpha, u_alpha\)/);
  assert.match(
    renderSource,
    /gl\.blendFuncSeparate\(\s*gl\.ONE,\s*gl\.ONE_MINUS_SRC_COLOR,\s*gl\.ONE,\s*gl\.ONE_MINUS_SRC_ALPHA,\s*\)/,
  );

  const aircraft = [0.92, 0.58, 0.21];
  const coverage = [0.18, 0.72, 0.84];
  const alpha = 0.3;
  const composited = aircraft.map((destination, index) => {
    const source = coverage[index] * alpha;
    return source + destination * (1 - source);
  });
  assert.ok(composited.every((channel, index) => channel >= aircraft[index]));
});

function fakeWebGl2() {
  let objectId = 0;
  let depthTest = false;
  let depthWrite = true;
  let colorWrite = true;
  const attributeLocations = new WeakMap();
  const drawEvents = [];
  const blendEvents = [];
  const recordDraw = (kind) => {
    drawEvents.push({
      kind,
      depthTest,
      depthWrite,
      colorWrite,
    });
  };
  const gl = {
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    COMPILE_STATUS: 3,
    LINK_STATUS: 4,
    MAX_VERTEX_ATTRIBS: 5,
    ARRAY_BUFFER: 6,
    ELEMENT_ARRAY_BUFFER: 7,
    STATIC_DRAW: 8,
    DYNAMIC_DRAW: 9,
    FLOAT: 10,
    TRIANGLES: 11,
    UNSIGNED_SHORT: 12,
    UNSIGNED_INT: 13,
    BLEND: 14,
    SRC_ALPHA: 15,
    ONE_MINUS_SRC_ALPHA: 16,
    DEPTH_TEST: 17,
    LEQUAL: 18,
    ONE: 19,
    ONE_MINUS_SRC_COLOR: 20,
    createShader: () => ({ id: ++objectId }),
    shaderSource() {},
    compileShader() {},
    getShaderParameter: () => true,
    getShaderInfoLog: () => "",
    deleteShader() {},
    createProgram: () => ({ id: ++objectId }),
    attachShader() {},
    linkProgram() {},
    getProgramParameter: () => true,
    getProgramInfoLog: () => "",
    deleteProgram() {},
    getAttribLocation(program, name) {
      let locations = attributeLocations.get(program);
      if (!locations) {
        locations = new Map();
        attributeLocations.set(program, locations);
      }
      if (!locations.has(name)) locations.set(name, locations.size);
      return locations.get(name);
    },
    getUniformLocation: (_program, name) => ({ name }),
    getParameter(name) { return name === this.MAX_VERTEX_ATTRIBS ? 16 : 0; },
    createBuffer: () => ({ id: ++objectId }),
    bindBuffer() {},
    bufferData() {},
    bufferSubData() {},
    deleteBuffer() {},
    createVertexArray: () => ({ id: ++objectId }),
    bindVertexArray() {},
    deleteVertexArray() {},
    enableVertexAttribArray() {},
    vertexAttribPointer() {},
    vertexAttribDivisor() {},
    useProgram() {},
    uniformMatrix4fv() {},
    uniform2f() {},
    uniform1f() {},
    uniform3f() {},
    uniform3fv() {},
    uniform4fv() {},
    drawEvents,
    blendEvents,
    drawElements() { recordDraw("coverage-elements"); },
    drawArrays() { recordDraw("coverage-arrays"); },
    drawElementsInstanced() { recordDraw("aircraft"); },
    drawArraysInstanced() { recordDraw("line"); },
    enable(capability) {
      if (capability === this.DEPTH_TEST) depthTest = true;
    },
    disable(capability) {
      if (capability === this.DEPTH_TEST) depthTest = false;
    },
    blendFunc(...args) { blendEvents.push(args); },
    blendFuncSeparate(...args) { blendEvents.push(args); },
    depthFunc() {},
    depthMask(value) { depthWrite = value; },
    colorMask(red, green, blue, alpha) {
      colorWrite = red || green || blue || alpha;
    },
  };
  return gl;
}

test("terrain depth occludes aircraft and sticks before the translucent coverage pass", () => {
  const map = {
    getCanvas: () => ({ width: 600, height: 400, clientWidth: 600, clientHeight: 400 }),
    getContainer: () => ({ clientWidth: 600, clientHeight: 400 }),
    getCenter: () => ({ lng: 127, lat: 36 }),
    getZoom: () => 8,
  };
  const gl = fakeWebGl2();
  const aircraftLayer = createAircraftLayer({
    getData: () => [{
      lon: 127,
      lat: 36,
      z: 1000,
      r: 255,
      g: 255,
      b: 255,
      a: 255,
      yaw: 0,
      pitch: 0,
      roll: 0,
      cls: "medium",
      clsMul: 1,
    }],
    getSegments: () => [[{
      a: [127, 36, 1000],
      b: [127, 36, 0],
      color: [255, 255, 255, 255],
      widthPx: 2,
    }]],
    getDots: () => [],
    getCoverage: () => ({
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      anchor: [127, 36],
      altExagg: 1,
      alpha: 0.25,
    }),
  });
  const projection = {
    defaultProjectionData: {
      mainMatrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
      projectionTransition: 0,
    },
  };

  aircraftLayer.onAdd(map, gl);
  aircraftLayer.render(gl, projection);

  assert.deepEqual(gl.drawEvents.map(({ kind }) => kind), [
    "line",
    "aircraft",
    "coverage-arrays",
    "coverage-arrays",
  ]);
  assert.deepEqual(gl.drawEvents.slice(0, 2), [
    { kind: "line", depthTest: true, depthWrite: false, colorWrite: true },
    { kind: "aircraft", depthTest: true, depthWrite: false, colorWrite: true },
  ]);
  assert.deepEqual(gl.drawEvents.slice(2), [
    { kind: "coverage-arrays", depthTest: true, depthWrite: true, colorWrite: false },
    { kind: "coverage-arrays", depthTest: true, depthWrite: false, colorWrite: true },
  ]);
  assert.deepEqual(gl.blendEvents, [
    [gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA],
    [gl.ONE, gl.ONE_MINUS_SRC_COLOR, gl.ONE, gl.ONE_MINUS_SRC_ALPHA],
    [gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA],
  ]);
  aircraftLayer.onRemove();
});

test("a retained 15k trail uploads once while only the moving aircraft updates next frame", () => {
  const points = Array.from(
    { length: 15_001 },
    (_, index) => [127 + index * 0.000001, 36, 1000],
  );
  const segments = points.slice(1).map((point, index) => ({
    a: points[index],
    b: point,
    color: [80, 180, 255, 255],
    widthPx: 2,
  }));
  const aircraft = [
    {
      lon: 127,
      lat: 36,
      z: 1000,
      r: 255,
      g: 255,
      b: 255,
      a: 255,
      yaw: 0,
      pitch: 0,
      roll: 0,
      cls: "medium",
      clsMul: 1,
    },
    {
      lon: 127.1,
      lat: 36.1,
      z: 1200,
      r: 255,
      g: 200,
      b: 80,
      a: 255,
      yaw: 20,
      pitch: 2,
      roll: 4,
      cls: "medium",
      clsMul: 1,
      dynamic: true,
    },
  ];
  const canvas = {
    width: 1200,
    height: 800,
    get clientWidth() { throw new Error("render must not force layout"); },
    get clientHeight() { throw new Error("render must not force layout"); },
  };
  const map = {
    getCanvas: () => canvas,
    getContainer: () => ({ clientWidth: 600, clientHeight: 400 }),
    getPixelRatio: () => 2,
    getCenter: () => ({ lng: 127, lat: 36 }),
    getZoom: () => 8,
  };
  const gl = fakeWebGl2();
  const aircraftLayer = createAircraftLayer({
    getData: () => aircraft,
    getSegments: () => [segments],
    getDots: () => [],
    getCoverage: () => null,
  });
  const projection = {
    defaultProjectionData: {
      mainMatrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
      projectionTransition: 0,
    },
  };

  aircraftLayer.onAdd(map, gl);
  aircraftLayer.render(gl, projection);
  assert.deepEqual(aircraftLayer.stats(), {
    aircraftInstances: 2,
    aircraftDrawCalls: 2,
    aircraftUploadBytes: 240,
    lineInstances: 15_000,
    lineDrawCalls: 1,
    lineUploadBytes: 1_080_000,
  });

  aircraftLayer.render(gl, projection);
  assert.deepEqual(aircraftLayer.stats(), {
    aircraftInstances: 2,
    aircraftDrawCalls: 2,
    aircraftUploadBytes: 120,
    lineInstances: 15_000,
    lineDrawCalls: 1,
    lineUploadBytes: 0,
  });
  aircraftLayer.onRemove();
  aircraftLayer.onAdd(map, gl);
  aircraftLayer.render(gl, projection);
  assert.equal(aircraftLayer.stats().aircraftInstances, 2);
  assert.equal(aircraftLayer.stats().lineInstances, 15_000);
  aircraftLayer.onRemove();
});
