// MapLibre custom WebGL layer that draws the aircraft models directly with the map's own camera
// matrix (`args.defaultProjectionData.mainMatrix` + `map.transform.getMatrixForModel`). Because it
// uses MapLibre's real projection matrix, it rotates AND tilts with the map in BOTH mercator and
// globe — including pitch > 90° (a bottom / look-up view) — which deck.gl's GlobeView cannot do
// (its docs: "No support for rotation (pitch or bearing)"). No three.js / no deck.
//
// It reproduces the old deck look on purpose: per-class baked geometry, TRUE altitude colour,
// the whole-volume self-glow formula, near-constant on-screen size, and IDENT-gold / conflict-pink.
import { AIRCRAFT_GEOMETRY } from "./aircraft-geometry.js";

const DEG = Math.PI / 180;

// --- column-major 4x4 helpers (same convention as gl-matrix / MapLibre matrices) ---------------
function mul(a, b) {
  const o = new Float64Array(16);
  for (let c = 0; c < 4; c += 1) {
    for (let r = 0; r < 4; r += 1) {
      o[c * 4 + r] = a[0 * 4 + r] * b[c * 4 + 0] + a[1 * 4 + r] * b[c * 4 + 1] + a[2 * 4 + r] * b[c * 4 + 2] + a[3 * 4 + r] * b[c * 4 + 3];
    }
  }
  return o;
}
function rotX(rad) {
  const c = Math.cos(rad), s = Math.sin(rad);
  return new Float64Array([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]);
}
function rotY(rad) {
  const c = Math.cos(rad), s = Math.sin(rad);
  return new Float64Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]);
}
function rotZ(rad) {
  const c = Math.cos(rad), s = Math.sin(rad);
  return new Float64Array([c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}
function scale(s) {
  return new Float64Array([s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, 0, 0, 0, 1]);
}
// Rc = Rz(yaw)·Ry(pitch)·Rx(roll): model frame +X nose, +Y right wing, +Z up → local ENU
// (X east, Y north, Z up). yaw=90-track aims the nose along the compass track; pitch=-phi is
// nose-up on climb; roll=-bank is right-wing-down on a right bank (see aircraftList sign notes).
function attitude(yawDeg, pitchDeg, rollDeg) {
  return mul(mul(rotZ(yawDeg * DEG), rotY(pitchDeg * DEG)), rotX(rollDeg * DEG));
}
// project a local-meter point [x,y,z] through M (=mainMatrix·frame) to CSS pixels
function projectPx(M, x, y, z, w, h) {
  const cx = M[0] * x + M[4] * y + M[8] * z + M[12];
  const cy = M[1] * x + M[5] * y + M[9] * z + M[13];
  const cw = M[3] * x + M[7] * y + M[11] * z + M[15];
  return [((cx / cw) * 0.5 + 0.5) * w, (1 - ((cy / cw) * 0.5 + 0.5)) * h, cw];
}

const VERT = `#version 300 es
precision highp float;
uniform mat4 u_mvp;
uniform mat3 u_normal;
in vec3 a_pos;
in vec3 a_normal;
out vec3 v_normal;
void main() {
  v_normal = normalize(u_normal * a_normal);
  gl_Position = u_mvp * vec4(a_pos, 1.0);
}`;

// Fragment: soft two-sided diffuse + ambient (approximating the old PBR look), then the EXACT
// whole-volume self-glow formula the deck version used (lifts the dark colours more).
const FRAG = `#version 300 es
precision highp float;
uniform vec4 u_color;      // rgb 0..1, a 0..1
uniform vec3 u_lightDir;   // in local ENU
in vec3 v_normal;
out vec4 fragColor;
void main() {
  vec3 n = normalize(v_normal);
  float diff = abs(dot(n, normalize(u_lightDir)));   // two-sided so back faces aren't black
  float shade = 0.55 + 0.45 * diff;                  // ambient 0.55 + diffuse
  vec3 c = u_color.rgb * shade;
  float glowLum = dot(c, vec3(0.299, 0.587, 0.114));
  c += c * (0.5 + (1.0 - glowLum) * 0.7);            // whole-volume glow (matches old shader)
  fragColor = vec4(c, u_color.a);
}`;

// Lines (sticks / trails / conflict links) and ground dots are built as screen-space quads in NDC
// on the CPU each frame — this gives exact pixel widths and works in globe (endpoints are projected
// with the SAME map matrix as the aircraft, so they follow the camera).
const LINE_VERT = `#version 300 es
precision highp float;
in vec3 a_ndc;
in vec4 a_color;
out vec4 v_color;
void main() { v_color = a_color; gl_Position = vec4(a_ndc, 1.0); }`;
const LINE_FRAG = `#version 300 es
precision highp float;
in vec4 v_color;
out vec4 fragColor;
void main() { fragColor = v_color; }`;

// Coverage dome: a translucent triangle skin coloured per-fragment by altitude in perceptually
// uniform OKLCH (same shader as the old deck CoverageMeshLayer). Altitude ft = mesh z / 0.3048
// (the vertical exaggeration is in the MVP, not here).
const COV_VERT = `#version 300 es
precision highp float;
uniform mat4 u_mvp;
in vec3 a_pos;
out float v_altFt;
void main() { v_altFt = max(a_pos.z / 0.3048, 0.0); gl_Position = u_mvp * vec4(a_pos, 1.0); }`;
const COV_FRAG = `#version 300 es
precision highp float;
uniform float u_alpha;
in float v_altFt;
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
void main() { fragColor = vec4(covColor(v_altFt), u_alpha); }`;

function scale3(x, y, z) {
  return new Float64Array([x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1]);
}

function compile(gl, src, type) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error("aircraft shader: " + gl.getShaderInfoLog(sh));
  return sh;
}

// getData() → array of { lon, lat, z (exaggerated metres), r, g, b, a (0..255), yaw, pitch, roll, cls }
// getData()     → aircraft (see below)
// getSegments() → [{ a:[lon,lat,alt], b:[lon,lat,alt], color:[r,g,b,a 0..255], widthPx }] (sticks/trails/conflicts)
// getDots()     → [{ p:[lon,lat,alt], color:[r,g,b,a 0..255], sizePx }] (ground feet)
// getCoverage() → { positions: Float32Array (metre offsets, size 3), anchor:[lon,lat], altExagg } | null
export function createAircraftLayer({ id = "aircraft3d", getData, getSegments, getDots, getCoverage }) {
  let gl = null, map = null, program = null, lineProgram = null, lineBuf = null;
  let covProgram = null, covBuf = null, covRef = null, covCount = 0;
  let lastMain = null; // last frame's mainMatrix, for the debug projection hook
  const loc = {};
  const lineLoc = {};
  const covLoc = {};
  const meshes = {}; // per class: { posBuf, normBuf, idxBuf, count, span }

  function buildClass(cls) {
    const g = AIRCRAFT_GEOMETRY[cls];
    const posBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(g.positions), gl.STATIC_DRAW);
    const normBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, normBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(g.normals), gl.STATIC_DRAW);
    const idxBuf = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(g.indices), gl.STATIC_DRAW);
    let mx = 0;
    for (let i = 0; i < g.positions.length; i += 1) mx = Math.max(mx, Math.abs(g.positions[i]));
    meshes[cls] = { posBuf, normBuf, idxBuf, count: g.indices.length, span: mx * 2 };
  }

  return {
    id,
    type: "custom",
    renderingMode: "3d",
    onAdd(m, glCtx) {
      map = m;
      gl = glCtx;
      program = gl.createProgram();
      gl.attachShader(program, compile(gl, VERT, gl.VERTEX_SHADER));
      gl.attachShader(program, compile(gl, FRAG, gl.FRAGMENT_SHADER));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error("aircraft link: " + gl.getProgramInfoLog(program));
      loc.pos = gl.getAttribLocation(program, "a_pos");
      loc.normal = gl.getAttribLocation(program, "a_normal");
      loc.mvp = gl.getUniformLocation(program, "u_mvp");
      loc.normalMat = gl.getUniformLocation(program, "u_normal");
      loc.color = gl.getUniformLocation(program, "u_color");
      loc.lightDir = gl.getUniformLocation(program, "u_lightDir");
      for (const cls of ["small", "medium", "large"]) buildClass(cls);

      lineProgram = gl.createProgram();
      gl.attachShader(lineProgram, compile(gl, LINE_VERT, gl.VERTEX_SHADER));
      gl.attachShader(lineProgram, compile(gl, LINE_FRAG, gl.FRAGMENT_SHADER));
      gl.linkProgram(lineProgram);
      if (!gl.getProgramParameter(lineProgram, gl.LINK_STATUS)) throw new Error("aircraft line link: " + gl.getProgramInfoLog(lineProgram));
      lineLoc.ndc = gl.getAttribLocation(lineProgram, "a_ndc");
      lineLoc.color = gl.getAttribLocation(lineProgram, "a_color");
      lineBuf = gl.createBuffer();

      covProgram = gl.createProgram();
      gl.attachShader(covProgram, compile(gl, COV_VERT, gl.VERTEX_SHADER));
      gl.attachShader(covProgram, compile(gl, COV_FRAG, gl.FRAGMENT_SHADER));
      gl.linkProgram(covProgram);
      if (!gl.getProgramParameter(covProgram, gl.LINK_STATUS)) throw new Error("coverage link: " + gl.getProgramInfoLog(covProgram));
      covLoc.pos = gl.getAttribLocation(covProgram, "a_pos");
      covLoc.mvp = gl.getUniformLocation(covProgram, "u_mvp");
      covLoc.alpha = gl.getUniformLocation(covProgram, "u_alpha");
      covBuf = gl.createBuffer();
    },
    // Debug-only: project a lon/lat/alt to CSS pixels using the EXACT matrix the layer last drew
    // with — lets a test confirm the aircraft follows the map camera (rotate/tilt) in globe.
    project(lon, lat, z) {
      if (!lastMain || !map) return null;
      const M = mul(lastMain, map.transform.getMatrixForModel([lon, lat], z));
      return projectPx(M, 0, 0, 0, map.getCanvas().clientWidth, map.getCanvas().clientHeight);
    },
    onRemove() {
      if (!gl) return;
      for (const cls of Object.keys(meshes)) {
        const mesh = meshes[cls];
        gl.deleteBuffer(mesh.posBuf); gl.deleteBuffer(mesh.normBuf); gl.deleteBuffer(mesh.idxBuf);
      }
      if (program) gl.deleteProgram(program);
      if (lineProgram) gl.deleteProgram(lineProgram);
      if (lineBuf) gl.deleteBuffer(lineBuf);
      if (covProgram) gl.deleteProgram(covProgram);
      if (covBuf) gl.deleteBuffer(covBuf);
    },
    render(glCtx, args) {
      const main = args.defaultProjectionData.mainMatrix;
      lastMain = main;
      const w = map.getCanvas().clientWidth;
      const h = map.getCanvas().clientHeight;
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

      // --- coverage dome FIRST (respects terrain depth; occluded by terrain). Two passes so the
      // translucency is drawn exactly once per pixel (no overlapping-triangle brightening): pass 1
      // writes only the nearest depth, pass 2 colours only fragments at that depth. -----------------
      const cov = getCoverage ? getCoverage() : null;
      if (cov && cov.positions && cov.positions.length) {
        if (cov.positions !== covRef) {
          gl.bindBuffer(gl.ARRAY_BUFFER, covBuf);
          gl.bufferData(gl.ARRAY_BUFFER, cov.positions, gl.STATIC_DRAW);
          covCount = cov.positions.length / 3;
          covRef = cov.positions;
        }
        const covMvp = mul(mul(main, map.transform.getMatrixForModel(cov.anchor, 0)), scale3(1, 1, cov.altExagg));
        gl.useProgram(covProgram);
        gl.uniformMatrix4fv(covLoc.mvp, false, new Float32Array(covMvp));
        gl.bindBuffer(gl.ARRAY_BUFFER, covBuf);
        gl.enableVertexAttribArray(covLoc.pos);
        gl.vertexAttribPointer(covLoc.pos, 3, gl.FLOAT, false, 0, 0);
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LEQUAL);
        gl.depthMask(true);
        gl.colorMask(false, false, false, false);
        gl.uniform1f(covLoc.alpha, 0.0);
        gl.drawArrays(gl.TRIANGLES, 0, covCount);   // pass 1: depth only
        gl.colorMask(true, true, true, true);
        gl.depthMask(false);
        gl.uniform1f(covLoc.alpha, 58 / 255);
        gl.drawArrays(gl.TRIANGLES, 0, covCount);   // pass 2: colour once
      }

      gl.disable(gl.DEPTH_TEST);           // sticks/trails/aircraft over terrain/dome (deck used depthCompare 'always')
      gl.depthMask(true);

      // --- sticks / trails / conflict links + ground dots: screen-space quads (exact px width) ----
      const projClip = (lon, lat, alt) => { const M = mul(main, map.transform.getMatrixForModel([lon, lat], alt)); return [M[12], M[13], M[14], M[15]]; };
      const cornerNdc = (sx, sy, ndcz, col) => [2 * (sx / w) - 1, 1 - 2 * (sy / h), ndcz, col[0] / 255, col[1] / 255, col[2] / 255, (col[3] ?? 255) / 255];
      const verts = [];
      const seg2 = (sx, sy, sz, tx, ty, tz, hw, col) => {
        let dx = tx - sx, dy = ty - sy; const len = Math.hypot(dx, dy) || 1e-6; dx /= len; dy /= len;
        const px = -dy * hw, py = dx * hw;
        const A1 = cornerNdc(sx + px, sy + py, sz, col), A2 = cornerNdc(sx - px, sy - py, sz, col);
        const B1 = cornerNdc(tx + px, ty + py, tz, col), B2 = cornerNdc(tx - px, ty - py, tz, col);
        verts.push(...A1, ...A2, ...B1, ...A2, ...B2, ...B1);
      };
      const segs = getSegments ? getSegments() : null;
      if (segs) for (const s of segs) {
        const ca = projClip(s.a[0], s.a[1], s.a[2]); const cb = projClip(s.b[0], s.b[1], s.b[2]);
        if (!(ca[3] > 0) || !(cb[3] > 0)) continue;
        seg2((ca[0] / ca[3] * 0.5 + 0.5) * w, (1 - (ca[1] / ca[3] * 0.5 + 0.5)) * h, ca[2] / ca[3],
             (cb[0] / cb[3] * 0.5 + 0.5) * w, (1 - (cb[1] / cb[3] * 0.5 + 0.5)) * h, cb[2] / cb[3], (s.widthPx || 1.5) / 2, s.color);
      }
      const dots = getDots ? getDots() : null;
      if (dots) for (const dot of dots) {
        const c = projClip(dot.p[0], dot.p[1], dot.p[2]);
        if (!(c[3] > 0)) continue;
        const sx = (c[0] / c[3] * 0.5 + 0.5) * w, sy = (1 - (c[1] / c[3] * 0.5 + 0.5)) * h, sz = c[2] / c[3], r = (dot.sizePx || 3) / 2;
        const P = (ox, oy) => cornerNdc(sx + ox, sy + oy, sz, dot.color);
        verts.push(...P(-r, -r), ...P(r, -r), ...P(r, r), ...P(-r, -r), ...P(r, r), ...P(-r, r));
      }
      if (verts.length) {
        gl.useProgram(lineProgram);
        gl.bindBuffer(gl.ARRAY_BUFFER, lineBuf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(lineLoc.ndc); gl.vertexAttribPointer(lineLoc.ndc, 3, gl.FLOAT, false, 28, 0);
        gl.enableVertexAttribArray(lineLoc.color); gl.vertexAttribPointer(lineLoc.color, 4, gl.FLOAT, false, 28, 12);
        gl.drawArrays(gl.TRIANGLES, 0, verts.length / 7);
      }

      // --- aircraft models (drawn last, over the sticks/trails) ------------------------------------
      const data = getData();
      if (data && data.length) {
      gl.useProgram(program);
      gl.uniform3f(loc.lightDir, 0.35, 0.25, 0.9);  // light mostly from above, in local ENU
      for (const d of data) {
        const mesh = meshes[d.cls === "small" || d.cls === "medium" || d.cls === "large" ? d.cls : "medium"];
        // frame at the aircraft's lon/lat/exaggerated-altitude
        const frame = map.transform.getMatrixForModel([d.lon, d.lat], d.z);
        const M0 = mul(main, frame);
        // pixels-per-metre here, from a 1 m east step, to hold a near-constant on-screen size
        const o = projectPx(M0, 0, 0, 0, w, h);
        if (!(o[2] > 0)) continue;         // behind the camera
        // pixels-per-metre from the LEAST-foreshortened of the 3 local axes — a single axis (e.g.
        // east) collapses to ~0 px when it points along the view ray, which blew the scale up at
        // certain bearings/pitches. Taking the max gives the true on-screen scale at any angle.
        const ex = projectPx(M0, 1, 0, 0, w, h), ny = projectPx(M0, 0, 1, 0, w, h), uz = projectPx(M0, 0, 0, 1, w, h);
        const ppm = Math.max(
          Math.hypot(ex[0] - o[0], ex[1] - o[1]),
          Math.hypot(ny[0] - o[0], ny[1] - o[1]),
          Math.hypot(uz[0] - o[0], uz[1] - o[1]),
        ) || 1e-6;
        const worldPx = mesh.span * 185 * ppm;                 // sizeScale 185 m, like deck
        const clsMul = d.clsMul || 1;
        const px = Math.min(Math.max(worldPx, 48 * clsMul), 68 * clsMul);
        const s = px / (mesh.span * ppm);
        const R = attitude(d.yaw, d.pitch, d.roll);
        const mvp = mul(mul(M0, R), scale(s));
        if (typeof window !== "undefined" && window.__T3D_DEBUG && !window.__t3dLastSize) {
          window.__t3dLastSize = { px: +px.toFixed(1), s: +s.toFixed(1), ppm: +ppm.toFixed(5), span: +mesh.span.toFixed(3), worldPx: +worldPx.toFixed(1), clsMul, cls: d.cls };
        }

        gl.uniformMatrix4fv(loc.mvp, false, new Float32Array(mvp));
        gl.uniformMatrix3fv(loc.normalMat, false, new Float32Array([R[0], R[1], R[2], R[4], R[5], R[6], R[8], R[9], R[10]]));
        gl.uniform4f(loc.color, d.r / 255, d.g / 255, d.b / 255, (d.a ?? 255) / 255);

        gl.bindBuffer(gl.ARRAY_BUFFER, mesh.posBuf);
        gl.enableVertexAttribArray(loc.pos);
        gl.vertexAttribPointer(loc.pos, 3, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, mesh.normBuf);
        gl.enableVertexAttribArray(loc.normal);
        gl.vertexAttribPointer(loc.normal, 3, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.idxBuf);
        gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_SHORT, 0);
      }
      }
      // Restore the GL state MapLibre expects for the rest of its frame.
      gl.colorMask(true, true, true, true);
      gl.depthMask(true);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.disable(gl.BLEND);
    },
  };
}
