// MapLibre custom WebGL layer for aircraft, trails, sticks, dots, and the coverage dome.
//
// Stable geographic data is converted to MapLibre's public projection frame only when its source
// changes. Camera projection, aircraft pixel-size clamping, mesh transforms, and screen-space
// line/dot expansion all run on the GPU. This keeps every recorded trail point while removing the
// previous per-frame CPU quad build and one-draw-call-per-aircraft path.
import { AIRCRAFT_GEOMETRY } from "./aircraft-geometry.js";
import { aircraftPixelSize } from "./aircraft-size.js";
import { modelFrameForProjection } from "./maplibre-model-frame.js";

const DEG = Math.PI / 180;
const AIRCRAFT_INSTANCE_FLOATS = 30;
const AIRCRAFT_INSTANCE_BYTES = AIRCRAFT_INSTANCE_FLOATS * Float32Array.BYTES_PER_ELEMENT;
const LINE_INSTANCE_FLOATS = 18;
const LINE_INSTANCE_BYTES = LINE_INSTANCE_FLOATS * Float32Array.BYTES_PER_ELEMENT;
const EMPTY_SOURCE = Object.freeze([]);

function mulInto(out, a, b) {
  for (let c = 0; c < 4; c += 1) {
    for (let r = 0; r < 4; r += 1) {
      out[c * 4 + r] = (
        a[r] * b[c * 4]
        + a[4 + r] * b[c * 4 + 1]
        + a[8 + r] * b[c * 4 + 2]
        + a[12 + r] * b[c * 4 + 3]
      );
    }
  }
  return out;
}

// Rc = Rz(yaw)·Ry(pitch)·Rx(roll): model +X nose, +Y left wing, +Z up → local ENU.
// The public helper remains useful to attitude tests; the renderer writes the same matrix directly
// into retained instance storage and does not allocate these temporary matrices per frame.
export function aircraftAttitudeMatrix(yawDeg, pitchDeg, rollDeg) {
  const yaw = yawDeg * DEG;
  const pitch = pitchDeg * DEG;
  const roll = rollDeg * DEG;
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const cr = Math.cos(roll), sr = Math.sin(roll);
  return new Float64Array([
    cy * cp, sy * cp, -sp, 0,
    cy * sp * sr - sy * cr, sy * sp * sr + cy * cr, cp * sr, 0,
    cy * sp * cr + sy * sr, sy * sp * cr - cy * sr, cp * cr, 0,
    0, 0, 0, 1,
  ]);
}

function writeFrameAttitude(out, offset, yawDeg, pitchDeg, rollDeg) {
  const yaw = yawDeg * DEG;
  const pitch = pitchDeg * DEG;
  const roll = rollDeg * DEG;
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const cr = Math.cos(roll), sr = Math.sin(roll);

  // ENU_TO_FRAME * attitude. ENU east→frame X, north→-frame Z, up→frame Y.
  const c0x = cy * cp, c0y = sy * cp, c0z = -sp;
  const c1x = cy * sp * sr - sy * cr;
  const c1y = sy * sp * sr + cy * cr;
  const c1z = cp * sr;
  const c2x = cy * sp * cr + sy * sr;
  const c2y = sy * sp * cr - cy * sr;
  const c2z = cp * cr;
  out[offset] = c0x; out[offset + 1] = c0z; out[offset + 2] = -c0y;
  out[offset + 3] = c1x; out[offset + 4] = c1z; out[offset + 5] = -c1y;
  out[offset + 6] = c2x; out[offset + 7] = c2z; out[offset + 8] = -c2y;
}

function writeSplitVec3(out, highOffset, lowOffset, x, y, z) {
  const hx = Math.fround(x), hy = Math.fround(y), hz = Math.fround(z);
  out[highOffset] = hx; out[highOffset + 1] = hy; out[highOffset + 2] = hz;
  out[lowOffset] = x - hx; out[lowOffset + 1] = y - hy; out[lowOffset + 2] = z - hz;
}

function projectPxInto(out, matrix, x, y, z, width, height) {
  const cx = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
  const cy = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
  const cw = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
  out[0] = ((cx / cw) * 0.5 + 0.5) * width;
  out[1] = (1 - ((cy / cw) * 0.5 + 0.5)) * height;
  out[2] = cw;
  return out;
}

const AIRCRAFT_VERT = `#version 300 es
precision highp float;
uniform mat4 u_main;
uniform vec2 u_viewport;
uniform float u_icon_floor;
uniform float u_mesh_bottom;
uniform vec3 u_reference_high;
uniform vec3 u_reference_low;
uniform vec4 u_reference_clip;
in vec3 a_pos;
in vec3 a_normal;
in vec3 a_frame0;
in vec3 a_frame1;
in vec3 a_frame2;
in vec3 a_origin_high;
in vec3 a_origin_low;
in vec3 a_rot0;
in vec3 a_rot1;
in vec3 a_rot2;
in vec4 a_color;
in vec2 a_params;
out vec3 v_normal;
out vec4 v_color;

void main() {
  mat3 frame = mat3(a_frame0, a_frame1, a_frame2);
  mat3 attitude = mat3(a_rot0, a_rot1, a_rot2);
  vec3 relativeOrigin = (a_origin_high - u_reference_high)
                      + (a_origin_low - u_reference_low);
  vec4 origin = u_reference_clip + u_main * vec4(relativeOrigin, 0.0);
  if (!(origin.w > 0.0)) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    v_normal = vec3(0.0, 0.0, 1.0);
    v_color = a_color;
    return;
  }

  vec2 originNdc = origin.xy / origin.w;
  vec4 east = origin + u_main * vec4(a_frame0, 0.0);
  vec4 up = origin + u_main * vec4(a_frame1, 0.0);
  vec4 south = origin + u_main * vec4(a_frame2, 0.0);
  float ppm = max(max(
    length((east.xy / east.w - originNdc) * u_viewport * 0.5),
    length((up.xy / up.w - originNdc) * u_viewport * 0.5)
  ), length((south.xy / south.w - originNdc) * u_viewport * 0.5));
  ppm = max(ppm, 0.000001);

  float span = a_params.x;
  bool grounded = a_params.y < 0.0;
  float classMultiplier = abs(a_params.y);
  float worldPixels = span * 130.0 * ppm;
  float pixels = clamp(
    worldPixels,
    34.0 * classMultiplier * u_icon_floor,
    120.0 * classMultiplier
  );
  float modelScale = pixels / max(span * ppm, 0.000001);
  vec3 modelPosition = a_pos;
  if (grounded) modelPosition.z -= u_mesh_bottom;
  vec3 localDelta = attitude * modelPosition * modelScale;
  // One screen pixel of lift keeps the level model wholly above its DEM contact regardless of the
  // icon's zoom-dependent world scale. A tiny clip-depth bias prevents residual coplanar flicker
  // without defeating terrain/globe occlusion for geometry genuinely behind the surface.
  if (grounded) localDelta.y += 1.0 / ppm;
  vec3 delta = frame * localDelta;
  gl_Position = origin + u_main * vec4(delta, 0.0);
  if (grounded) gl_Position.z -= 0.00001 * gl_Position.w;
  v_normal = normalize(attitude * a_normal);
  v_color = a_color;
}`;

const AIRCRAFT_FRAG = `#version 300 es
precision highp float;
uniform vec3 u_lightDir;
in vec3 v_normal;
in vec4 v_color;
out vec4 fragColor;
void main() {
  vec3 n = normalize(v_normal);
  float diff = abs(dot(n, normalize(u_lightDir)));
  float shade = 0.55 + 0.45 * diff;
  vec3 c = v_color.rgb * shade;
  float glowLum = dot(c, vec3(0.299, 0.587, 0.114));
  c += c * (0.5 + (1.0 - glowLum) * 0.7);
  fragColor = vec4(c, v_color.a);
}`;

// Six implicit vertices form either a line quad or a dot square. Only the geographic endpoints and
// style live in the instance buffer, so camera motion changes a uniform instead of rebuilding and
// uploading 42 floats for every trail segment.
const LINE_VERT = `#version 300 es
precision highp float;
uniform mat4 u_main;
uniform vec2 u_viewport;
uniform vec3 u_reference_high;
uniform vec3 u_reference_low;
uniform vec4 u_reference_clip;
in vec3 a_start_high;
in vec3 a_start_low;
in vec3 a_end_high;
in vec3 a_end_low;
in vec4 a_color;
in vec2 a_params;
out vec4 v_color;

vec4 projectOrigin(vec3 highPart, vec3 lowPart) {
  vec3 relativeOrigin = (highPart - u_reference_high)
                      + (lowPart - u_reference_low);
  return u_reference_clip + u_main * vec4(relativeOrigin, 0.0);
}

void main() {
  vec4 startClip = projectOrigin(a_start_high, a_start_low);
  vec4 endClip = projectOrigin(a_end_high, a_end_low);
  v_color = a_color;
  if (!(startClip.w > 0.0) || !(endClip.w > 0.0)) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  int vertex = gl_VertexID % 6;
  float size = a_params.x;
  bool dot = mod(a_params.y, 2.0) > 0.5;
  bool groundContact = a_params.y > 1.5;
  if (dot) {
    vec2 corner;
    if (vertex == 0 || vertex == 3) corner = vec2(-1.0, -1.0);
    else if (vertex == 1) corner = vec2(1.0, -1.0);
    else if (vertex == 2 || vertex == 4) corner = vec2(1.0, 1.0);
    else corner = vec2(-1.0, 1.0);
    vec2 offsetNdc = vec2(corner.x, -corner.y) * size / u_viewport;
    gl_Position = startClip + vec4(offsetNdc * startClip.w, 0.0, 0.0);
    if (groundContact) gl_Position.z -= 0.00001 * gl_Position.w;
    return;
  }

  vec2 startNdc = startClip.xy / startClip.w;
  vec2 endNdc = endClip.xy / endClip.w;
  vec2 deltaScreen = vec2(
    (endNdc.x - startNdc.x) * u_viewport.x * 0.5,
    -(endNdc.y - startNdc.y) * u_viewport.y * 0.5
  );
  float lineLength = max(length(deltaScreen), 0.000001);
  vec2 normalScreen = vec2(-deltaScreen.y, deltaScreen.x) / lineLength * size * 0.5;
  vec2 normalNdc = vec2(
    normalScreen.x * 2.0 / u_viewport.x,
    -normalScreen.y * 2.0 / u_viewport.y
  );
  bool atEnd = vertex == 2 || vertex == 4 || vertex == 5;
  float side = vertex == 0 || vertex == 2 || vertex == 5 ? 1.0 : -1.0;
  vec4 base = atEnd ? endClip : startClip;
  gl_Position = base + vec4(normalNdc * side * base.w, 0.0, 0.0);
  if (groundContact && atEnd) gl_Position.z -= 0.00001 * gl_Position.w;
}`;

const LINE_FRAG = `#version 300 es
precision highp float;
in vec4 v_color;
out vec4 fragColor;
void main() { fragColor = v_color; }`;

const COVERAGE_VERT = `#version 300 es
precision highp float;
uniform mat4 u_mvp;
in vec3 a_pos;
in vec3 a_normal;
out float v_altFt;
out vec3 v_normal;
void main() {
  v_altFt = max(a_pos.z / 0.3048, 0.0);
  v_normal = a_normal;
  gl_Position = u_mvp * vec4(a_pos, 1.0);
}`;

const COVERAGE_FRAG = `#version 300 es
precision highp float;
uniform float u_alpha;
in float v_altFt;
in vec3 v_normal;
out vec4 fragColor;
float covLinToSrgb(float v) { v = max(v, 0.0); return v <= 0.0031308 ? v * 12.92 : 1.055 * pow(v, 1.0 / 2.4) - 0.055; }
vec3 covOklch(float L, float C, float hDeg) {
  float h = radians(hDeg); float a = C * cos(h); float b = C * sin(h);
  float lr = L + 0.3963377774 * a + 0.2158037573 * b;
  float mr = L - 0.1055613458 * a - 0.0638541728 * b;
  float sr = L - 0.0894841775 * a - 1.2914855480 * b;
  float l = lr * lr * lr, m = mr * mr * mr, s = sr * sr * sr;
  vec3 lin = vec3(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
                  -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
                  -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s);
  return clamp(vec3(covLinToSrgb(lin.r), covLinToSrgb(lin.g), covLinToSrgb(lin.b)), 0.0, 1.0);
}
vec3 covColor(float ft) { float t = clamp(ft / 40000.0, 0.0, 1.0); return covOklch(0.72, 0.18, mix(50.0, 300.0, t)); }
void main() {
  float light = abs(dot(normalize(v_normal), normalize(vec3(-0.35, 0.45, 0.82))));
  vec3 color = covColor(v_altFt) * (0.76 + 0.24 * light);
  // Premultiply for the screen blend used by the coverage colour pass. Screen compositing keeps
  // every destination channel at least as bright as it was, so the shell cannot wash out aircraft.
  fragColor = vec4(color * u_alpha, u_alpha);
}`;

// MapLibre model frames are Y-up (X east, Y up, Z south). Coverage vertices are ENU Z-up.
const ENU_TO_FRAME = new Float64Array([
  1, 0, 0, 0,
  0, 0, -1, 0,
  0, 1, 0, 0,
  0, 0, 0, 1,
]);

function compile(gl, source, type) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`aircraft shader: ${message}`);
  }
  return shader;
}

function createProgram(gl, vertexSource, fragmentSource, label) {
  const vertex = compile(gl, vertexSource, gl.VERTEX_SHADER);
  const fragment = compile(gl, fragmentSource, gl.FRAGMENT_SHADER);
  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`${label} link: ${message}`);
  }
  return program;
}

function attribute(gl, program, name) {
  const location = gl.getAttribLocation(program, name);
  if (location < 0) throw new Error(`aircraft shader attribute missing: ${name}`);
  return location;
}

function uniform(gl, program, name) {
  const location = gl.getUniformLocation(program, name);
  if (location == null) throw new Error(`aircraft shader uniform missing: ${name}`);
  return location;
}

function configureInstanceAttribute(gl, location, size, stride, offset) {
  gl.enableVertexAttribArray(location);
  gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset);
  gl.vertexAttribDivisor(location, 1);
}

// getData() → [{lon,lat,z,r,g,b,a,yaw,pitch,roll,cls,clsMul,grounded?,dynamic}]
// getSegments() → ordered arrays of
//   [{a:[lon,lat,alt],b:[lon,lat,alt],color:[r,g,b,a],widthPx,groundContact?,dynamic?,mutable?}]
// getDots() → [{p:[lon,lat,alt],color:[r,g,b,a],sizePx,groundContact?,dynamic?,mutable?}]
// getCoverage() → {positions,normals,indices?,anchor,altExagg,alpha} | null
export function createAircraftLayer({
  id = "aircraft3d",
  getData,
  getSegments,
  getDots,
  getCoverage,
}) {
  let gl = null;
  let map = null;
  let aircraftProgram = null;
  let lineProgram = null;
  let coverageProgram = null;
  let coverageVao = null;
  let coveragePositionBuffer = null;
  let coverageNormalBuffer = null;
  let coverageIndexBuffer = null;
  let coveragePositionRef = null;
  let coverageNormalRef = null;
  let coverageIndexRef = null;
  let coverageCount = 0;
  let coverageIndexType = null;
  let coverageFrameProjection = null;
  let coverageFrameLon = NaN;
  let coverageFrameLat = NaN;
  let coverageFrame = null;
  let lastProjectionTransition = 0;
  let hasLastMain = false;
  let viewportWidth = 1;
  let viewportHeight = 1;
  let viewportResizeHandler = null;
  let frameSerial = 0;
  let lastAircraftSource = null;
  let lastAircraftProjection = null;

  const lastMain = new Float64Array(16);
  const main32 = new Float32Array(16);
  const referenceHigh32 = new Float32Array(3);
  const referenceLow32 = new Float32Array(3);
  const referenceClip32 = new Float32Array(4);
  const projectMatrix = new Float64Array(16);
  const projectResult = new Float64Array(3);
  const metricOrigin = new Float64Array(3);
  const metricAxis = new Float64Array(3);
  const coverageTmpA = new Float64Array(16);
  const coverageTmpB = new Float64Array(16);
  const coverageMvp32 = new Float32Array(16);
  const aircraftLoc = {};
  const lineLoc = {};
  const coverageLoc = {};
  const meshes = {};
  const meshList = [];
  const aircraftStateCache = new WeakMap();
  const pointFrameCache = new WeakMap();
  const lineResources = new Map();
  const gpuStats = {
    aircraftInstances: 0,
    aircraftDrawCalls: 0,
    aircraftUploadBytes: 0,
    lineInstances: 0,
    lineDrawCalls: 0,
    lineUploadBytes: 0,
  };

  function projectionKey(transition) {
    return transition > 0 ? "globe" : "mercator";
  }

  function updateViewport() {
    const container = map.getContainer?.();
    const canvas = map.getCanvas();
    viewportWidth = Math.max(1, container?.clientWidth || canvas.clientWidth || 1);
    viewportHeight = Math.max(1, container?.clientHeight || canvas.clientHeight || 1);
  }

  function updateProjectionReference(main, transition) {
    const center = map.getCenter();
    const frame = modelFrameForProjection([center.lng, center.lat], 0, transition);
    const x = frame[12], y = frame[13], z = frame[14];
    const hx = Math.fround(x), hy = Math.fround(y), hz = Math.fround(z);
    referenceHigh32[0] = hx;
    referenceHigh32[1] = hy;
    referenceHigh32[2] = hz;
    referenceLow32[0] = x - hx;
    referenceLow32[1] = y - hy;
    referenceLow32[2] = z - hz;
    for (let row = 0; row < 4; row += 1) {
      referenceClip32[row] = (
        main[row] * x
        + main[4 + row] * y
        + main[8 + row] * z
        + main[12 + row]
      );
    }
  }

  function aircraftState(item, key, transition) {
    let state = aircraftStateCache.get(item);
    if (!state) {
      state = {
        projection: null,
        lon: NaN,
        lat: NaN,
        z: NaN,
        yaw: NaN,
        pitch: NaN,
        roll: NaN,
        frame: null,
        attitude: new Float32Array(9),
      };
      aircraftStateCache.set(item, state);
    }
    if (state.projection !== key
      || state.lon !== item.lon
      || state.lat !== item.lat
      || state.z !== item.z) {
      state.frame = modelFrameForProjection([item.lon, item.lat], item.z, transition);
      state.projection = key;
      state.lon = item.lon;
      state.lat = item.lat;
      state.z = item.z;
    }
    const yaw = item.yaw || 0;
    const pitch = item.pitch || 0;
    const roll = item.roll || 0;
    if (state.yaw !== yaw || state.pitch !== pitch || state.roll !== roll) {
      writeFrameAttitude(state.attitude, 0, yaw, pitch, roll);
      state.yaw = yaw;
      state.pitch = pitch;
      state.roll = roll;
    }
    return state;
  }

  function packAircraftInstance(target, offset, item, mesh, key, transition) {
    const state = aircraftState(item, key, transition);
    const frame = state.frame;
    target[offset] = frame[0]; target[offset + 1] = frame[1]; target[offset + 2] = frame[2];
    target[offset + 3] = frame[4]; target[offset + 4] = frame[5]; target[offset + 5] = frame[6];
    target[offset + 6] = frame[8]; target[offset + 7] = frame[9]; target[offset + 8] = frame[10];
    writeSplitVec3(target, offset + 9, offset + 12, frame[12], frame[13], frame[14]);
    target.set(state.attitude, offset + 15);
    target[offset + 24] = item.r / 255;
    target[offset + 25] = item.g / 255;
    target[offset + 26] = item.b / 255;
    target[offset + 27] = (item.a ?? 255) / 255;
    target[offset + 28] = mesh.span;
    const classMultiplier = Number.isFinite(item.clsMul) && item.clsMul > 0 ? item.clsMul : 1;
    target[offset + 29] = item.grounded ? -classMultiplier : classMultiplier;
  }

  function createAircraftBatch(mesh, usage) {
    const buffer = gl.createBuffer();
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.positionBuffer);
    gl.enableVertexAttribArray(aircraftLoc.pos);
    gl.vertexAttribPointer(aircraftLoc.pos, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.normalBuffer);
    gl.enableVertexAttribArray(aircraftLoc.normal);
    gl.vertexAttribPointer(aircraftLoc.normal, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.indexBuffer);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    configureInstanceAttribute(gl, aircraftLoc.frame0, 3, AIRCRAFT_INSTANCE_BYTES, 0);
    configureInstanceAttribute(gl, aircraftLoc.frame1, 3, AIRCRAFT_INSTANCE_BYTES, 12);
    configureInstanceAttribute(gl, aircraftLoc.frame2, 3, AIRCRAFT_INSTANCE_BYTES, 24);
    configureInstanceAttribute(gl, aircraftLoc.originHigh, 3, AIRCRAFT_INSTANCE_BYTES, 36);
    configureInstanceAttribute(gl, aircraftLoc.originLow, 3, AIRCRAFT_INSTANCE_BYTES, 48);
    configureInstanceAttribute(gl, aircraftLoc.rot0, 3, AIRCRAFT_INSTANCE_BYTES, 60);
    configureInstanceAttribute(gl, aircraftLoc.rot1, 3, AIRCRAFT_INSTANCE_BYTES, 72);
    configureInstanceAttribute(gl, aircraftLoc.rot2, 3, AIRCRAFT_INSTANCE_BYTES, 84);
    configureInstanceAttribute(gl, aircraftLoc.color, 4, AIRCRAFT_INSTANCE_BYTES, 96);
    configureInstanceAttribute(gl, aircraftLoc.params, 2, AIRCRAFT_INSTANCE_BYTES, 112);
    gl.bindVertexArray(null);
    return { buffer, vao, usage, items: [], data: new Float32Array(0), count: 0 };
  }

  function buildMesh(cls) {
    const geometry = AIRCRAFT_GEOMETRY[cls];
    const positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(geometry.positions), gl.STATIC_DRAW);
    const normalBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, normalBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(geometry.normals), gl.STATIC_DRAW);
    const indexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(geometry.indices), gl.STATIC_DRAW);
    let maxExtent = 0;
    let bottom = Infinity;
    for (let i = 0; i < geometry.positions.length; i += 1) {
      maxExtent = Math.max(maxExtent, Math.abs(geometry.positions[i]));
      if (i % 3 === 2) bottom = Math.min(bottom, geometry.positions[i]);
    }
    const mesh = {
      positionBuffer,
      normalBuffer,
      indexBuffer,
      count: geometry.indices.length,
      span: maxExtent * 2,
      bottom,
    };
    mesh.staticBatch = createAircraftBatch(mesh, gl.STATIC_DRAW);
    mesh.dynamicBatch = createAircraftBatch(mesh, gl.DYNAMIC_DRAW);
    meshes[cls] = mesh;
    meshList.push(mesh);
  }

  function uploadAircraftBatch(batch, mesh, items, key, transition) {
    batch.items = items;
    batch.count = items.length;
    batch.data = new Float32Array(items.length * AIRCRAFT_INSTANCE_FLOATS);
    for (let i = 0; i < items.length; i += 1) {
      packAircraftInstance(batch.data, i * AIRCRAFT_INSTANCE_FLOATS, items[i], mesh, key, transition);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, batch.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, batch.data, batch.usage);
    gpuStats.aircraftUploadBytes += batch.data.byteLength;
  }

  function rebuildAircraftBatches(data, key, transition) {
    const grouped = new Map();
    for (const cls of Object.keys(meshes)) grouped.set(cls, { staticItems: [], dynamicItems: [] });
    for (const item of data || []) {
      const cls = meshes[item.cls] ? item.cls : "medium";
      const bucket = grouped.get(cls);
      (item.dynamic ? bucket.dynamicItems : bucket.staticItems).push(item);
    }
    for (const [cls, mesh] of Object.entries(meshes)) {
      const bucket = grouped.get(cls);
      uploadAircraftBatch(mesh.staticBatch, mesh, bucket.staticItems, key, transition);
      uploadAircraftBatch(mesh.dynamicBatch, mesh, bucket.dynamicItems, key, transition);
    }
  }

  function refreshDynamicAircraft(key, transition) {
    for (const mesh of meshList) {
      const batch = mesh.dynamicBatch;
      if (!batch.count) continue;
      for (let i = 0; i < batch.count; i += 1) {
        packAircraftInstance(batch.data, i * AIRCRAFT_INSTANCE_FLOATS, batch.items[i], mesh, key, transition);
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, batch.buffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, batch.data);
      gpuStats.aircraftUploadBytes += batch.data.byteLength;
    }
  }

  function drawAircraftBatch(mesh, batch) {
    if (!batch.count) return;
    gl.uniform1f(aircraftLoc.meshBottom, mesh.bottom);
    gl.bindVertexArray(batch.vao);
    gl.drawElementsInstanced(
      gl.TRIANGLES,
      mesh.count,
      gl.UNSIGNED_SHORT,
      0,
      batch.count,
    );
    gpuStats.aircraftInstances += batch.count;
    gpuStats.aircraftDrawCalls += 1;
  }

  function drawCoverageMesh() {
    if (coverageIndexType) {
      gl.drawElements(gl.TRIANGLES, coverageCount, coverageIndexType, 0);
    } else {
      gl.drawArrays(gl.TRIANGLES, 0, coverageCount);
    }
  }

  function cachedPointFrame(point, key, transition, allowCache) {
    if (!allowCache || !point || typeof point !== "object") {
      return modelFrameForProjection([point[0], point[1]], point[2], transition);
    }
    let variants = pointFrameCache.get(point);
    let frame = variants?.get(key);
    if (!frame) {
      frame = modelFrameForProjection([point[0], point[1]], point[2], transition);
      variants ||= new Map();
      variants.set(key, frame);
      pointFrameCache.set(point, variants);
    }
    return frame;
  }

  function packLineItem(target, offset, item, dot, key, transition) {
    const startPoint = dot ? item.p : item.a;
    const endPoint = dot ? item.p : item.b;
    const allowPointCache = !item.dynamic;
    const start = cachedPointFrame(startPoint, key, transition, allowPointCache);
    const end = dot ? start : cachedPointFrame(endPoint, key, transition, allowPointCache);
    writeSplitVec3(target, offset, offset + 3, start[12], start[13], start[14]);
    writeSplitVec3(target, offset + 6, offset + 9, end[12], end[13], end[14]);
    const color = item.color || [255, 255, 255, 255];
    target[offset + 12] = color[0] / 255;
    target[offset + 13] = color[1] / 255;
    target[offset + 14] = color[2] / 255;
    target[offset + 15] = (color[3] ?? 255) / 255;
    target[offset + 16] = dot ? (item.sizePx || 3) : (item.widthPx || 1.5);
    target[offset + 17] = (dot ? 1 : 0) + (item.groundContact ? 2 : 0);
  }

  function createLineResource(source, dot) {
    const buffer = gl.createBuffer();
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    configureInstanceAttribute(gl, lineLoc.startHigh, 3, LINE_INSTANCE_BYTES, 0);
    configureInstanceAttribute(gl, lineLoc.startLow, 3, LINE_INSTANCE_BYTES, 12);
    configureInstanceAttribute(gl, lineLoc.endHigh, 3, LINE_INSTANCE_BYTES, 24);
    configureInstanceAttribute(gl, lineLoc.endLow, 3, LINE_INSTANCE_BYTES, 36);
    configureInstanceAttribute(gl, lineLoc.color, 4, LINE_INSTANCE_BYTES, 48);
    configureInstanceAttribute(gl, lineLoc.params, 2, LINE_INSTANCE_BYTES, 64);
    gl.bindVertexArray(null);
    const resource = {
      source,
      dot,
      buffer,
      vao,
      data: new Float32Array(0),
      count: 0,
      key: null,
      updateIndices: [],
      seen: 0,
    };
    lineResources.set(source, resource);
    return resource;
  }

  function deleteLineResource(resource) {
    gl.deleteVertexArray(resource.vao);
    gl.deleteBuffer(resource.buffer);
    lineResources.delete(resource.source);
  }

  function updateLineResource(source, dot, key, transition) {
    let resource = lineResources.get(source);
    if (resource && resource.dot !== dot) {
      deleteLineResource(resource);
      resource = null;
    }
    resource ||= createLineResource(source, dot);
    resource.seen = frameSerial;
    const rebuild = resource.count !== source.length || resource.key !== key;
    if (rebuild) {
      resource.count = source.length;
      resource.key = key;
      resource.data = new Float32Array(source.length * LINE_INSTANCE_FLOATS);
      resource.updateIndices = [];
      for (let i = 0; i < source.length; i += 1) {
        packLineItem(resource.data, i * LINE_INSTANCE_FLOATS, source[i], dot, key, transition);
        if (source[i].dynamic || source[i].mutable) resource.updateIndices.push(i);
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, resource.buffer);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        resource.data,
        resource.updateIndices.length ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW,
      );
      gpuStats.lineUploadBytes += resource.data.byteLength;
    } else if (resource.updateIndices.length) {
      for (const index of resource.updateIndices) {
        packLineItem(
          resource.data,
          index * LINE_INSTANCE_FLOATS,
          source[index],
          dot,
          key,
          transition,
        );
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, resource.buffer);
      if (resource.updateIndices.length > 16) {
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, resource.data);
        gpuStats.lineUploadBytes += resource.data.byteLength;
      } else {
        for (const index of resource.updateIndices) {
          const start = index * LINE_INSTANCE_FLOATS;
          const item = resource.data.subarray(start, start + LINE_INSTANCE_FLOATS);
          gl.bufferSubData(gl.ARRAY_BUFFER, start * Float32Array.BYTES_PER_ELEMENT, item);
          gpuStats.lineUploadBytes += item.byteLength;
        }
      }
    }
    return resource;
  }

  function screenMetrics(item) {
    if (!hasLastMain || !item) return null;
    const mesh = meshes[item.cls] || meshes.medium;
    if (!mesh) return null;
    const key = projectionKey(lastProjectionTransition);
    const state = aircraftState(item, key, lastProjectionTransition);
    mulInto(projectMatrix, lastMain, state.frame);
    projectPxInto(metricOrigin, projectMatrix, 0, 0, 0, viewportWidth, viewportHeight);
    if (!(metricOrigin[2] > 0)) return null;
    let pixelsPerMetre = 0;
    for (let axis = 0; axis < 3; axis += 1) {
      projectPxInto(
        metricAxis,
        projectMatrix,
        axis === 0 ? 1 : 0,
        axis === 1 ? 1 : 0,
        axis === 2 ? 1 : 0,
        viewportWidth,
        viewportHeight,
      );
      pixelsPerMetre = Math.max(
        pixelsPerMetre,
        Math.hypot(metricAxis[0] - metricOrigin[0], metricAxis[1] - metricOrigin[1]),
      );
    }
    pixelsPerMetre ||= 1e-6;
    const classMultiplier = Number.isFinite(item.clsMul) && item.clsMul > 0 ? item.clsMul : 1;
    const iconFloor = Math.max(0.3, Math.min(1, (map.getZoom() - 3.8) / 2.7));
    const worldPixels = mesh.span * 130 * pixelsPerMetre;
    const pixels = aircraftPixelSize({
      worldPixels,
      classMultiplier,
      minScale: iconFloor,
    });
    return { pixels, pixelsPerMetre, worldPixels, span: mesh.span, classMultiplier };
  }

  return {
    id,
    type: "custom",
    renderingMode: "3d",

    onAdd(mapInstance, glContext) {
      map = mapInstance;
      gl = glContext;
      lastAircraftSource = null;
      lastAircraftProjection = null;
      coveragePositionRef = null;
      coverageNormalRef = null;
      coverageIndexRef = null;
      coverageFrameProjection = null;
      coverageFrame = null;
      hasLastMain = false;
      if (gl.getParameter(gl.MAX_VERTEX_ATTRIBS) < 12) {
        throw new Error("aircraft instancing requires at least 12 vertex attributes");
      }

      aircraftProgram = createProgram(gl, AIRCRAFT_VERT, AIRCRAFT_FRAG, "aircraft");
      aircraftLoc.pos = attribute(gl, aircraftProgram, "a_pos");
      aircraftLoc.normal = attribute(gl, aircraftProgram, "a_normal");
      aircraftLoc.frame0 = attribute(gl, aircraftProgram, "a_frame0");
      aircraftLoc.frame1 = attribute(gl, aircraftProgram, "a_frame1");
      aircraftLoc.frame2 = attribute(gl, aircraftProgram, "a_frame2");
      aircraftLoc.originHigh = attribute(gl, aircraftProgram, "a_origin_high");
      aircraftLoc.originLow = attribute(gl, aircraftProgram, "a_origin_low");
      aircraftLoc.rot0 = attribute(gl, aircraftProgram, "a_rot0");
      aircraftLoc.rot1 = attribute(gl, aircraftProgram, "a_rot1");
      aircraftLoc.rot2 = attribute(gl, aircraftProgram, "a_rot2");
      aircraftLoc.color = attribute(gl, aircraftProgram, "a_color");
      aircraftLoc.params = attribute(gl, aircraftProgram, "a_params");
      aircraftLoc.main = uniform(gl, aircraftProgram, "u_main");
      aircraftLoc.viewport = uniform(gl, aircraftProgram, "u_viewport");
      aircraftLoc.iconFloor = uniform(gl, aircraftProgram, "u_icon_floor");
      aircraftLoc.meshBottom = uniform(gl, aircraftProgram, "u_mesh_bottom");
      aircraftLoc.referenceHigh = uniform(gl, aircraftProgram, "u_reference_high");
      aircraftLoc.referenceLow = uniform(gl, aircraftProgram, "u_reference_low");
      aircraftLoc.referenceClip = uniform(gl, aircraftProgram, "u_reference_clip");
      aircraftLoc.lightDir = uniform(gl, aircraftProgram, "u_lightDir");
      for (const cls of Object.keys(AIRCRAFT_GEOMETRY)) buildMesh(cls);

      lineProgram = createProgram(gl, LINE_VERT, LINE_FRAG, "aircraft line");
      lineLoc.startHigh = attribute(gl, lineProgram, "a_start_high");
      lineLoc.startLow = attribute(gl, lineProgram, "a_start_low");
      lineLoc.endHigh = attribute(gl, lineProgram, "a_end_high");
      lineLoc.endLow = attribute(gl, lineProgram, "a_end_low");
      lineLoc.color = attribute(gl, lineProgram, "a_color");
      lineLoc.params = attribute(gl, lineProgram, "a_params");
      lineLoc.main = uniform(gl, lineProgram, "u_main");
      lineLoc.viewport = uniform(gl, lineProgram, "u_viewport");
      lineLoc.referenceHigh = uniform(gl, lineProgram, "u_reference_high");
      lineLoc.referenceLow = uniform(gl, lineProgram, "u_reference_low");
      lineLoc.referenceClip = uniform(gl, lineProgram, "u_reference_clip");

      coverageProgram = createProgram(gl, COVERAGE_VERT, COVERAGE_FRAG, "coverage");
      coverageLoc.pos = attribute(gl, coverageProgram, "a_pos");
      coverageLoc.normal = attribute(gl, coverageProgram, "a_normal");
      coverageLoc.mvp = uniform(gl, coverageProgram, "u_mvp");
      coverageLoc.alpha = uniform(gl, coverageProgram, "u_alpha");
      coveragePositionBuffer = gl.createBuffer();
      coverageNormalBuffer = gl.createBuffer();
      coverageIndexBuffer = gl.createBuffer();
      coverageVao = gl.createVertexArray();
      gl.bindVertexArray(coverageVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, coveragePositionBuffer);
      gl.enableVertexAttribArray(coverageLoc.pos);
      gl.vertexAttribPointer(coverageLoc.pos, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, coverageNormalBuffer);
      gl.enableVertexAttribArray(coverageLoc.normal);
      gl.vertexAttribPointer(coverageLoc.normal, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, coverageIndexBuffer);
      gl.bindVertexArray(null);
      updateViewport();
      viewportResizeHandler = () => updateViewport();
      map.on?.("resize", viewportResizeHandler);
    },

    // Debug/interaction projection using the exact public projection frame and last drawn matrix.
    project(lon, lat, z) {
      if (!hasLastMain) return null;
      const frame = modelFrameForProjection([lon, lat], z, lastProjectionTransition);
      mulInto(projectMatrix, lastMain, frame);
      projectPxInto(projectResult, projectMatrix, 0, 0, 0, viewportWidth, viewportHeight);
      return projectResult[2] > 0 ? Array.from(projectResult) : null;
    },

    // Only selected/pinned/hovered UI asks for this. All rendered aircraft sizes are calculated in
    // the vertex shader, so the normal frame never walks the full aircraft list on the CPU.
    screenSize(item) {
      return screenMetrics(item)?.pixels || 0;
    },

    stats() {
      return { ...gpuStats };
    },

    onRemove() {
      if (!gl) return;
      if (viewportResizeHandler) map?.off?.("resize", viewportResizeHandler);
      viewportResizeHandler = null;
      for (const resource of lineResources.values()) deleteLineResource(resource);
      for (const mesh of meshList) {
        gl.deleteVertexArray(mesh.staticBatch.vao);
        gl.deleteBuffer(mesh.staticBatch.buffer);
        gl.deleteVertexArray(mesh.dynamicBatch.vao);
        gl.deleteBuffer(mesh.dynamicBatch.buffer);
        gl.deleteBuffer(mesh.positionBuffer);
        gl.deleteBuffer(mesh.normalBuffer);
        gl.deleteBuffer(mesh.indexBuffer);
      }
      meshList.length = 0;
      for (const cls of Object.keys(meshes)) delete meshes[cls];
      if (coverageVao) gl.deleteVertexArray(coverageVao);
      if (coveragePositionBuffer) gl.deleteBuffer(coveragePositionBuffer);
      if (coverageNormalBuffer) gl.deleteBuffer(coverageNormalBuffer);
      if (coverageIndexBuffer) gl.deleteBuffer(coverageIndexBuffer);
      if (aircraftProgram) gl.deleteProgram(aircraftProgram);
      if (lineProgram) gl.deleteProgram(lineProgram);
      if (coverageProgram) gl.deleteProgram(coverageProgram);
      gl = null;
      map = null;
    },

    render(_glContext, args) {
      const main = args.defaultProjectionData.mainMatrix;
      const transition = Number(args.defaultProjectionData.projectionTransition) || 0;
      const key = projectionKey(transition);
      for (let i = 0; i < 16; i += 1) {
        lastMain[i] = main[i];
        main32[i] = main[i];
      }
      hasLastMain = true;
      lastProjectionTransition = transition;
      updateProjectionReference(main, transition);
      frameSerial += 1;
      gpuStats.aircraftInstances = 0;
      gpuStats.aircraftDrawCalls = 0;
      gpuStats.aircraftUploadBytes = 0;
      gpuStats.lineInstances = 0;
      gpuStats.lineDrawCalls = 0;
      gpuStats.lineUploadBytes = 0;

      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

      // Keep MapLibre's terrain/globe depth buffer active for all tactical geometry. Do not write
      // symbology depth: the coverage shell remains a translucent overlay rather than an occluder,
      // while aircraft/trails retain their previous overlay ordering among themselves.
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.depthMask(false);

      // Trails/sticks/conflict links and dots retain one compact instance per source item. The
      // shader projects endpoints and expands the six screen-space vertices for the current camera.
      gl.useProgram(lineProgram);
      gl.uniformMatrix4fv(lineLoc.main, false, main32);
      gl.uniform2f(lineLoc.viewport, viewportWidth, viewportHeight);
      gl.uniform3fv(lineLoc.referenceHigh, referenceHigh32);
      gl.uniform3fv(lineLoc.referenceLow, referenceLow32);
      gl.uniform4fv(lineLoc.referenceClip, referenceClip32);
      const rawSegments = getSegments?.();
      const segmentGroups = rawSegments?.length
        ? (Array.isArray(rawSegments[0]) ? rawSegments : [rawSegments])
        : [];
      for (const group of segmentGroups) {
        if (!group.length) continue;
        const resource = updateLineResource(group, false, key, transition);
        gl.bindVertexArray(resource.vao);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, resource.count);
        gpuStats.lineInstances += resource.count;
        gpuStats.lineDrawCalls += 1;
      }
      const dots = getDots?.();
      if (dots?.length) {
        const resource = updateLineResource(dots, true, key, transition);
        gl.bindVertexArray(resource.vao);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, resource.count);
        gpuStats.lineInstances += resource.count;
        gpuStats.lineDrawCalls += 1;
      }
      gl.bindVertexArray(null);
      for (const resource of lineResources.values()) {
        if (resource.seen !== frameSerial) deleteLineResource(resource);
      }

      // Aircraft are grouped by mesh and volatility. Static instances upload only when the render
      // list/projection changes; selected, pinned, coasting, and playback instances update in their
      // small dynamic batches.
      const data = getData?.() || EMPTY_SOURCE;
      const rebuildAircraft = data !== lastAircraftSource || key !== lastAircraftProjection;
      if (rebuildAircraft) {
        rebuildAircraftBatches(data, key, transition);
        lastAircraftSource = data;
        lastAircraftProjection = key;
      } else {
        refreshDynamicAircraft(key, transition);
      }
      if (data.length) {
        gl.useProgram(aircraftProgram);
        gl.uniformMatrix4fv(aircraftLoc.main, false, main32);
        gl.uniform2f(aircraftLoc.viewport, viewportWidth, viewportHeight);
        gl.uniform3fv(aircraftLoc.referenceHigh, referenceHigh32);
        gl.uniform3fv(aircraftLoc.referenceLow, referenceLow32);
        gl.uniform4fv(aircraftLoc.referenceClip, referenceClip32);
        gl.uniform1f(
          aircraftLoc.iconFloor,
          Math.max(0.3, Math.min(1, (map.getZoom() - 3.8) / 2.7)),
        );
        gl.uniform3f(aircraftLoc.lightDir, 0.35, 0.25, 0.9);
        // Opaque/static silhouettes first, then moving/coasting/playback batches. This preserves
        // the old "translucent target over solid target" behavior even though meshes are grouped.
        for (const mesh of meshList) drawAircraftBatch(mesh, mesh.staticBatch);
        for (const mesh of meshList) drawAircraftBatch(mesh, mesh.dynamicBatch);
        gl.bindVertexArray(null);
        if (typeof window !== "undefined" && window.__T3D_DEBUG && !window.__t3dLastSize) {
          const metrics = screenMetrics(data[0]);
          if (metrics) {
            window.__t3dLastSize = {
              px: +metrics.pixels.toFixed(1),
              ppm: +metrics.pixelsPerMetre.toFixed(5),
              span: +metrics.span.toFixed(3),
              worldPx: +metrics.worldPixels.toFixed(1),
              clsMul: metrics.classMultiplier,
              cls: data[0].cls,
            };
          }
        }
      }

      // Draw the coverage shell after depth-tested tactical geometry. Its private depth pre-pass
      // still prevents translucent front/back faces from stacking, while doing it last prevents
      // the shell depth from hiding aircraft and sticks that are inside the observed volume.
      // Premultiplied screen blending lets the shell tint/light the scene without reducing any
      // existing aircraft colour channel, preserving the whole-volume aircraft glow.
      const coverage = getCoverage?.();
      if (coverage?.positions?.length) {
        if (coverage.positions !== coveragePositionRef) {
          gl.bindBuffer(gl.ARRAY_BUFFER, coveragePositionBuffer);
          gl.bufferData(gl.ARRAY_BUFFER, coverage.positions, gl.STATIC_DRAW);
          coveragePositionRef = coverage.positions;
        }
        if (coverage.normals !== coverageNormalRef) {
          gl.bindBuffer(gl.ARRAY_BUFFER, coverageNormalBuffer);
          gl.bufferData(gl.ARRAY_BUFFER, coverage.normals, gl.STATIC_DRAW);
          coverageNormalRef = coverage.normals;
        }
        if (coverage.indices) {
          if (coverage.indices !== coverageIndexRef) {
            gl.bindVertexArray(coverageVao);
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, coverageIndexBuffer);
            gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, coverage.indices, gl.STATIC_DRAW);
            gl.bindVertexArray(null);
            coverageIndexRef = coverage.indices;
          }
          coverageCount = coverage.indices.length;
          coverageIndexType = coverage.indices instanceof Uint32Array
            ? gl.UNSIGNED_INT
            : gl.UNSIGNED_SHORT;
        } else {
          coverageIndexRef = null;
          coverageCount = coverage.positions.length / 3;
          coverageIndexType = null;
        }
        if (coverageFrameProjection !== key
          || coverageFrameLon !== coverage.anchor[0]
          || coverageFrameLat !== coverage.anchor[1]) {
          coverageFrame = modelFrameForProjection(coverage.anchor, 0, transition);
          coverageFrameProjection = key;
          coverageFrameLon = coverage.anchor[0];
          coverageFrameLat = coverage.anchor[1];
        }
        mulInto(coverageTmpA, main, coverageFrame);
        mulInto(coverageTmpB, coverageTmpA, ENU_TO_FRAME);
        for (let i = 0; i < 16; i += 1) coverageMvp32[i] = coverageTmpB[i];
        for (let i = 8; i < 12; i += 1) coverageMvp32[i] *= coverage.altExagg;

        gl.useProgram(coverageProgram);
        gl.uniformMatrix4fv(coverageLoc.mvp, false, coverageMvp32);
        gl.bindVertexArray(coverageVao);
        gl.depthMask(true);
        gl.colorMask(false, false, false, false);
        gl.uniform1f(coverageLoc.alpha, 0);
        drawCoverageMesh();
        gl.colorMask(true, true, true, true);
        gl.depthMask(false);
        gl.uniform1f(coverageLoc.alpha, coverage.alpha ?? 58 / 255);
        gl.blendFuncSeparate(
          gl.ONE,
          gl.ONE_MINUS_SRC_COLOR,
          gl.ONE,
          gl.ONE_MINUS_SRC_ALPHA,
        );
        drawCoverageMesh();
        gl.bindVertexArray(null);
      }

      if (typeof window !== "undefined" && window.__T3D_DEBUG) {
        window.__t3dGpuStats = { ...gpuStats };
      }

      // Restore the high-level state MapLibre expects for the remainder of the frame.
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      gl.colorMask(true, true, true, true);
      gl.depthMask(true);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.disable(gl.BLEND);
    },
  };
}
