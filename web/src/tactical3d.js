// Top Gun style 3D tactical view: a self-contained three.js scene with Korean terrain
// built from free AWS Terrarium DEM tiles, a glowing grid/contour shader, and true 3D
// aircraft — lit meshes oriented by heading + climb angle so direction and attitude read
// from any camera angle — with WebGL altitude sticks / trails / conflict links / coverage
// volume, and DOM data-block labels billboarded beside each target.
//
// This module is only ever loaded via dynamic import from App.vue, so three.js stays out
// of the initial bundle. All app state and formatting comes in through the `deps` object;
// nothing here touches Vue reactivity directly.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { AIRFIELDS, isMinorAirfield } from "./airfields.js";

// Fixed scene region: South Korea + surrounding seas, comfortably covering the
// receiver's ADS-B horizon. DEM z8 keeps the initial download to ~60 tiles.
const REGION = { lonMin: 123.5, lonMax: 132.5, latMin: 32.5, latMax: 40.0 };
// Scene origin (= range-ring center, local coordinate origin): Yuseong IC, Daejeon —
// effectively the receiver's location without publishing its exact coordinates.
const SCENE_CENTER = { lon: 127.33113, lat: 36.36599 };
const DEM_ZOOM = 8;
const DEM_URL = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
// Downsample factor applied to the stitched DEM pixels when building the mesh grid.
// Stride 2 => ~1.2 km cells; checked against surveyed peaks (Hallasan/Jirisan/Seoraksan),
// stride 4 shaved 15-20% off summits while stride 2 stays close to the source pixels.
const DEM_STRIDE = 2;

const FT_TO_M = 0.3048;
const EARTH_R = 6378137;
const MAX_TARGETS = 600; // preallocated stick/dot buffer capacity (2D MARKER_LIMIT is 1000, real traffic ~100)
const TRAIL_MAX_POINTS = 2000;
const TRACK_GAP_MS = 10 * 60 * 1000; // mirror the 2D drawTrack gap splitting
const RING_RADII_KM = [100, 200, 300];

// --- Web mercator <-> local scene coordinates -------------------------------------------
// Scene space is meters on a plane: X = east, Y = up (altitude), Z = south, origin at
// SCENE_CENTER. Mercator XY is scaled by cos(center lat) so distances are true meters at
// the center; the residual scale drift across the region (<10%) is fine for a display.
const K_SCALE = Math.cos((SCENE_CENTER.lat * Math.PI) / 180);
function lonToMx(lon) { return EARTH_R * ((lon * Math.PI) / 180); }
function latToMy(lat) { return EARTH_R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)); }
const MX0 = lonToMx(SCENE_CENTER.lon);
const MY0 = latToMy(SCENE_CENTER.lat);
function toLocalX(lon) { return (lonToMx(lon) - MX0) * K_SCALE; }
function toLocalZ(lat) { return -(latToMy(lat) - MY0) * K_SCALE; }
function localToLon(x) { return ((MX0 + x / K_SCALE) / EARTH_R) * (180 / Math.PI); }
function localToLat(z) {
  const my = MY0 - z / K_SCALE;
  return ((2 * Math.atan(Math.exp(my / EARTH_R)) - Math.PI / 2) * 180) / Math.PI;
}

// altitudeColor()/trackSegmentColor() emit `hsl(H S% L%)` (or hex for ground/unknown);
// THREE.Color only parses the comma form, so convert explicitly.
function parseCssColor(str) {
  const m = /hsl\(\s*([\d.]+)[ ,]+([\d.]+)%[ ,]+([\d.]+)%\s*\)/.exec(str);
  if (m) return new THREE.Color().setHSL(Number(m[1]) / 360, Number(m[2]) / 100, Number(m[3]) / 100);
  return new THREE.Color(str);
}

// --- Terrain shader: dark fill, altitude tint, glowing world-space grid + contours ------
const TERRAIN_VERT = /* glsl */ `
  uniform float uExagg;
  varying vec3 vWorld;
  varying float vFog;
  void main() {
    vec3 p = position;      // p.y carries RAW elevation meters; exaggeration applied here
    vWorld = p;
    p.y *= uExagg;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vFog = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;
const TERRAIN_FRAG = /* glsl */ `
  precision highp float;
  uniform vec3 uSea;
  uniform vec3 uLandLow;
  uniform vec3 uLandHigh;
  uniform vec3 uGrid;
  uniform vec3 uContour;
  uniform vec3 uFogColor;
  uniform float uFogNear;
  uniform float uFogFar;
  varying vec3 vWorld;
  varying float vFog;

  float gridLine(vec2 coord) {
    vec2 g = abs(fract(coord - 0.5) - 0.5) / fwidth(coord);
    return 1.0 - min(min(g.x, g.y), 1.0);
  }

  void main() {
    float elev = vWorld.y;
    bool sea = elev < 0.5;
    float t = pow(clamp(elev / 1900.0, 0.0, 1.0), 0.55);
    vec3 col = sea ? uSea : mix(uLandLow, uLandHigh, t);
    float g10 = gridLine(vWorld.xz / 10000.0);
    float g50 = gridLine(vWorld.xz / 50000.0);
    col += uGrid * max(g10 * (sea ? 0.10 : 0.22), g50 * (sea ? 0.20 : 0.34));
    if (!sea) {
      float c = 1.0 - min(abs(fract(elev / 200.0 - 0.5) - 0.5) / fwidth(elev / 200.0), 1.0);
      col += uContour * c * 0.30;
      // Shoreline emphasis so flat coastal land reads against the sea at long range.
      col += uGrid * (1.0 - smoothstep(1.0, 90.0, elev)) * 0.16;
    }
    gl_FragColor = vec4(mix(col, uFogColor, smoothstep(uFogNear, uFogFar, vFog)), 1.0);
  }
`;

export function createTactical3d({ container, deps }) {
  // --- DOM scaffolding -------------------------------------------------------------------
  const overlayEl = document.createElement("div");
  overlayEl.className = "t3d-overlay";
  // Single hover popover, used for airfields only — aircraft carry their data blocks.
  const afTooltipEl = document.createElement("div");
  afTooltipEl.className = "t3d-tt airfield-tt";
  afTooltipEl.style.display = "none";
  const loadingEl = document.createElement("div");
  loadingEl.className = "t3d-loading";
  loadingEl.textContent = "ACQUIRING TERRAIN DATA…";
  const hintEl = document.createElement("div");
  hintEl.className = "t3d-hint";
  hintEl.textContent = "Drag rotate · Right-drag pan · Scroll zoom";

  // --- three.js core ---------------------------------------------------------------------
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x050a0c, 1);
  renderer.domElement.className = "t3d-canvas";
  container.appendChild(renderer.domElement);
  container.appendChild(overlayEl);
  container.appendChild(afTooltipEl);
  container.appendChild(loadingEl);
  container.appendChild(hintEl);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, 1, 50, 4_000_000);
  camera.position.set(0, 300_000, 420_000);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.zoomToCursor = true;
  controls.minDistance = 4_000;
  controls.maxDistance = 1_500_000;
  controls.maxPolarAngle = Math.PI * 0.49; // stay above the horizon
  controls.target.set(0, 0, 0);

  const uniforms = {
    uExagg: { value: 2 },
    uSea: { value: new THREE.Color(0x04131b) },
    uLandLow: { value: new THREE.Color(0x0b2a25) },
    uLandHigh: { value: new THREE.Color(0x1d6f66) },
    uGrid: { value: new THREE.Color(0x48e0d1) },
    uContour: { value: new THREE.Color(0x48e0d1) },
    uFogColor: { value: new THREE.Color(0x050a0c) },
    uFogNear: { value: 250_000 },
    uFogFar: { value: 2_200_000 },
  };
  const terrainMaterial = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: TERRAIN_VERT,
    fragmentShader: TERRAIN_FRAG,
  });

  // --- Lights (aircraft meshes are lit so their 3D form conveys attitude; the terrain
  // shader is unlit and ignores these) ---------------------------------------------------
  scene.add(new THREE.HemisphereLight(0x9fd8ff, 0x0a1512, 1.0));
  const keyLight = new THREE.DirectionalLight(0xffffff, 1.25);
  keyLight.position.set(-0.45, 1, 0.3);
  scene.add(keyLight);

  // --- Aircraft geometries (built once; nose points -Z = north at identity) --------------
  const WHITE = new THREE.Color(0xffffff);
  const AMBER = new THREE.Color(0xf59e0b);
  const RED = new THREE.Color(0xfb7185);
  const BASE_NOSE = new THREE.Vector3(0, 0, -1);
  const _fwd = new THREE.Vector3();

  function buildPlaneGeo() {
    const fus = new THREE.CylinderGeometry(0.05, 0.07, 0.82, 12); fus.rotateX(Math.PI / 2);
    const nose = new THREE.ConeGeometry(0.07, 0.3, 12); nose.rotateX(-Math.PI / 2); nose.translate(0, 0, -0.56);
    const wing = new THREE.BoxGeometry(1.05, 0.02, 0.26); wing.translate(0, -0.01, 0.05);
    const tailplane = new THREE.BoxGeometry(0.44, 0.02, 0.13); tailplane.translate(0, 0, 0.4);
    const fin = new THREE.BoxGeometry(0.02, 0.2, 0.17); fin.translate(0, 0.1, 0.4);
    return mergeGeometries([fus, nose, wing, tailplane, fin]);
  }
  function buildHeliGeo() {
    const body = new THREE.SphereGeometry(0.2, 14, 12); body.scale(1, 0.92, 1.55);
    const boom = new THREE.BoxGeometry(0.05, 0.05, 0.62); boom.translate(0, 0.03, 0.52);
    const fin = new THREE.BoxGeometry(0.02, 0.17, 0.09); fin.translate(0, 0.09, 0.78);
    const rotor = new THREE.CylinderGeometry(0.64, 0.64, 0.012, 24); rotor.translate(0, 0.2, 0);
    return mergeGeometries([body, boom, fin, rotor]);
  }
  function buildGroundGeo() {
    const hull = new THREE.BoxGeometry(0.34, 0.16, 0.6);
    const top = new THREE.BoxGeometry(0.26, 0.14, 0.3); top.translate(0, 0.14, 0.03);
    return mergeGeometries([hull, top]);
  }
  const GEO = { plane: buildPlaneGeo(), helicopter: buildHeliGeo(), ground: buildGroundGeo() };
  const GEO_LEN = { plane: 1.12, helicopter: 1.1, ground: 0.6 }; // nose-to-tail units, for screen-size scaling
  const aircraftMatBase = new THREE.MeshStandardMaterial({ roughness: 0.42, metalness: 0.14 });
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const TARGET_PX = 34; // apparent aircraft length in screen px, held constant across zoom

  // --- Terrain / elevation state ---------------------------------------------------------
  let terrainMesh = null;
  // Elevation grid for stick-foot / airfield sampling (built alongside the mesh).
  let elevGrid = null; // Float32Array gridW*gridH, raw meters, clamped >= 0
  let grid = { w: 0, h: 0, x0: 0, z0: 0, dx: 1, dz: 1 }; // local-space origin + cell size
  let disposed = false;

  function sampleElevation(lon, lat) {
    if (!elevGrid) return 0;
    const gx = (toLocalX(lon) - grid.x0) / grid.dx;
    const gz = (toLocalZ(lat) - grid.z0) / grid.dz;
    if (gx < 0 || gz < 0 || gx > grid.w - 1 || gz > grid.h - 1) return 0;
    const x0 = Math.floor(gx);
    const z0 = Math.floor(gz);
    const x1 = Math.min(grid.w - 1, x0 + 1);
    const z1 = Math.min(grid.h - 1, z0 + 1);
    const fx = gx - x0;
    const fz = gz - z0;
    const a = elevGrid[z0 * grid.w + x0] * (1 - fx) + elevGrid[z0 * grid.w + x1] * fx;
    const b = elevGrid[z1 * grid.w + x0] * (1 - fx) + elevGrid[z1 * grid.w + x1] * fx;
    return a * (1 - fz) + b * fz;
  }

  async function fetchDemTile(z, x, y) {
    try {
      const res = await fetch(DEM_URL(z, x, y), { mode: "cors" });
      if (!res.ok) throw new Error(`DEM tile ${z}/${x}/${y}: ${res.status}`);
      return await createImageBitmap(await res.blob());
    } catch (err) {
      console.warn(err);
      return null; // missing tile renders as sea level
    }
  }

  async function buildTerrain() {
    const n = 2 ** DEM_ZOOM;
    const lonToTx = (lon) => ((lon + 180) / 360) * n;
    const latToTy = (lat) => {
      const rad = (lat * Math.PI) / 180;
      return ((1 - Math.asinh(Math.tan(rad)) / Math.PI) / 2) * n;
    };
    const tx0 = Math.floor(lonToTx(REGION.lonMin));
    const tx1 = Math.floor(lonToTx(REGION.lonMax));
    const ty0 = Math.floor(latToTy(REGION.latMax)); // tile y grows southward
    const ty1 = Math.floor(latToTy(REGION.latMin));
    const cols = tx1 - tx0 + 1;
    const rows = ty1 - ty0 + 1;

    const canvas = document.createElement("canvas");
    canvas.width = cols * 256;
    canvas.height = rows * 256;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const tiles = [];
    for (let ty = ty0; ty <= ty1; ty += 1) {
      for (let tx = tx0; tx <= tx1; tx += 1) tiles.push({ tx, ty });
    }
    const bitmaps = await Promise.all(tiles.map(({ tx, ty }) => fetchDemTile(DEM_ZOOM, tx, ty)));
    if (disposed) return;
    bitmaps.forEach((bmp, i) => {
      if (bmp) ctx.drawImage(bmp, (tiles[i].tx - tx0) * 256, (tiles[i].ty - ty0) * 256);
    });
    const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

    // Local-space extent of the stitched tile rect (tile edges, not the REGION bbox).
    const worldSize = 2 * Math.PI * EARTH_R;
    const tileM = worldSize / n;
    const mxMin = -worldSize / 2 + tx0 * tileM;
    const myMax = worldSize / 2 - ty0 * tileM;
    const x0 = (mxMin - MX0) * K_SCALE;
    const z0 = -(myMax - MY0) * K_SCALE; // top edge (north) => smallest z
    const w = Math.floor(canvas.width / DEM_STRIDE);
    const h = Math.floor(canvas.height / DEM_STRIDE);
    const cell = (tileM / 256) * DEM_STRIDE * K_SCALE;
    grid = { w, h, x0, z0, dx: cell, dz: cell };

    elevGrid = new Float32Array(w * h);
    const positions = new Float32Array(w * h * 3);
    for (let j = 0; j < h; j += 1) {
      for (let i = 0; i < w; i += 1) {
        const p = (j * DEM_STRIDE * canvas.width + i * DEM_STRIDE) * 4;
        // Terrarium encoding; clamp bathymetry to sea level so oceans stay flat and the
        // land/sea threshold in the shader draws the coastline.
        const elev = Math.max(0, px[p] * 256 + px[p + 1] + px[p + 2] / 256 - 32768);
        const idx = j * w + i;
        elevGrid[idx] = elev;
        positions[idx * 3] = x0 + i * cell;
        positions[idx * 3 + 1] = elev; // raw meters — the shader applies exaggeration
        positions[idx * 3 + 2] = z0 + j * cell;
      }
    }
    const indices = new Uint32Array((w - 1) * (h - 1) * 6);
    let o = 0;
    for (let j = 0; j < h - 1; j += 1) {
      for (let i = 0; i < w - 1; i += 1) {
        const a = j * w + i;
        indices[o++] = a; indices[o++] = a + w; indices[o++] = a + 1;
        indices[o++] = a + 1; indices[o++] = a + w; indices[o++] = a + w + 1;
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    terrainMesh = new THREE.Mesh(geometry, terrainMaterial);
    terrainMesh.frustumCulled = false;
    scene.add(terrainMesh);

    // Flat sea frame around the terrain rect out to the fog limit, same material
    // (y=0 => sea color + grid), no overlap with the terrain so nothing z-fights.
    const xMax = x0 + (w - 1) * cell;
    const zMax = z0 + (h - 1) * cell;
    const EXT = 3_000_000;
    const framePieces = [
      [-EXT, x0, -EXT, EXT],   // west strip, full height
      [xMax, EXT, -EXT, EXT],  // east strip, full height
      [x0, xMax, -EXT, z0],    // north strip between them
      [x0, xMax, zMax, EXT],   // south strip
    ];
    const frameGeo = new THREE.BufferGeometry();
    const fp = [];
    const fi = [];
    framePieces.forEach(([xa, xb, za, zb], k) => {
      const b = k * 4;
      fp.push(xa, 0, za, xb, 0, za, xa, 0, zb, xb, 0, zb);
      fi.push(b, b + 2, b + 1, b + 1, b + 2, b + 3);
    });
    frameGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(fp), 3));
    frameGeo.setIndex(fi);
    const frame = new THREE.Mesh(frameGeo, terrainMaterial);
    frame.frustumCulled = false;
    scene.add(frame);

    loadingEl.style.display = "none";
    rebuildAirfields();
    dataPass();
  }

  // --- Range rings (sea-level tactical reference) -----------------------------------------
  const staticLabels = []; // {x, y, z, el} projected each frame alongside markers
  function addStaticLabel(x, y, z, className, text) {
    const el = document.createElement("div");
    el.className = className;
    el.textContent = text;
    overlayEl.appendChild(el);
    staticLabels.push({ x, y, z, el });
  }
  {
    const ringMat = new THREE.LineBasicMaterial({ color: 0x48e0d1, transparent: true, opacity: 0.28 });
    for (const km of RING_RADII_KM) {
      const r = km * 1000;
      const pts = [];
      for (let i = 0; i <= 128; i += 1) {
        const a = (i / 128) * Math.PI * 2;
        pts.push(new THREE.Vector3(Math.cos(a) * r, 60, Math.sin(a) * r));
      }
      scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), ringMat));
      const diag = Math.SQRT1_2 * r;
      addStaticLabel(diag, 60, -diag, "t3d-ringlabel", `${km} km`);
    }
    const compassR = 340_000;
    addStaticLabel(0, 60, -compassR, "t3d-compass", "N");
    addStaticLabel(compassR, 60, 0, "t3d-compass", "E");
    addStaticLabel(0, 60, compassR, "t3d-compass", "S");
    addStaticLabel(-compassR, 60, 0, "t3d-compass", "W");
  }

  // --- Altitude sticks + ground dots (preallocated dynamic buffers) -----------------------
  function makeDynamicBuffer(verticesPer, object3dFactory) {
    const positions = new THREE.BufferAttribute(new Float32Array(MAX_TARGETS * verticesPer * 3), 3);
    const colors = new THREE.BufferAttribute(new Float32Array(MAX_TARGETS * verticesPer * 3), 3);
    positions.setUsage(THREE.DynamicDrawUsage);
    colors.setUsage(THREE.DynamicDrawUsage);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", positions);
    geometry.setAttribute("color", colors);
    geometry.setDrawRange(0, 0);
    const object = object3dFactory(geometry);
    object.frustumCulled = false;
    scene.add(object);
    return { geometry, positions, colors };
  }
  const sticks = makeDynamicBuffer(2, (g) => new THREE.LineSegments(
    g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9 }),
  ));
  const dots = makeDynamicBuffer(1, (g) => new THREE.Points(
    g, new THREE.PointsMaterial({ vertexColors: true, size: 3, sizeAttenuation: false, transparent: true, opacity: 0.9 }),
  ));

  // Trail + conflict lines are rebuilt per dataPass (small geometries).
  let trailLine = null;
  let conflictLine = null;
  const conflictLabels = []; // {x, y, z, el}

  // --- Aircraft targets: a lit 3D mesh (direction + attitude) plus a billboarded DOM
  // data block. hex -> {hex, interactive, el, blockEl, mesh, mat, geoKind, sigBlock,
  // x, y, z, groundY, stick, baseColor, flags…, scaleMul, blink, visible} ------------------
  const targets = new Map();
  let raycastMeshes = []; // meshes tested on hover/click; rebuilt each dataPass
  let ghostTarget = null; // playback marker, non-interactive
  let hoverHex = null; // aircraft under the pointer / hovered in the list
  let hoverAf = null; // airfield entry under the pointer (drives the single popover)
  let exagg = 2;
  let needsRender = true;
  let running = false;
  let rafId = 0;

  function makeTarget(hex, interactive) {
    const el = document.createElement("div");
    el.className = "t3d-marker";
    const blockEl = document.createElement("span");
    blockEl.className = "t3d-block";
    el.appendChild(blockEl);
    if (!interactive) el.classList.add("t3d-ghost");
    overlayEl.appendChild(el);
    return { hex, interactive, el, blockEl, mesh: null, mat: null, geoKind: null, sigBlock: "", visible: true };
  }

  function setTargetMesh(target, kind) {
    if (target.geoKind === kind && target.mesh) return;
    if (target.mesh) { scene.remove(target.mesh); target.mat.dispose(); }
    const mat = aircraftMatBase.clone();
    const mesh = new THREE.Mesh(GEO[kind] || GEO.plane, mat);
    mesh.frustumCulled = false;
    mesh.userData.hex = target.hex;
    scene.add(mesh);
    target.mesh = mesh;
    target.mat = mat;
    target.geoKind = kind;
  }

  function removeTarget(target) {
    if (target.mesh) { scene.remove(target.mesh); target.mat.dispose(); }
    target.el.remove();
  }

  function updateTarget(target, item, selected, conflictSet) {
    const kind = deps.aircraftKind(item);
    setTargetMesh(target, kind);

    const groundY = sampleElevation(item.lon, item.lat);
    const altFt = item.altBaro ?? item.altGeom;
    const airborne = !item.onGround && altFt != null;
    const altM = airborne ? Math.max(groundY, altFt * FT_TO_M) : groundY;
    target.x = toLocalX(item.lon);
    target.z = toLocalZ(item.lat);
    target.y = altM * exagg;
    target.groundY = groundY * exagg;
    target.stick = airborne;
    target.mesh.position.set(target.x, target.y, target.z);

    // Orient by heading (yaw) and climb angle (pitch). setFromUnitVectors gives the
    // minimal rotation from the base nose (-Z) to the flight vector, so wings stay level
    // (no fake bank) while nose points exactly where the aircraft is going and climbing.
    const th = (Number.isFinite(item.track) ? item.track : 0) * (Math.PI / 180);
    let phi = 0;
    if (airborne) {
      const vs = item.baroRate ?? item.geomRate; // ft/min
      const gsMps = (item.gs ?? 0) * 0.514444;
      if (vs != null && gsMps > 5) phi = Math.atan2(vs * 0.00508, gsMps);
      phi = Math.max(-0.5, Math.min(0.5, phi)); // clamp to ±~29° so steep VS stays readable
    }
    const cf = Math.cos(phi);
    _fwd.set(Math.sin(th) * cf, Math.sin(phi), -Math.cos(th) * cf);
    target.mesh.quaternion.setFromUnitVectors(BASE_NOSE, _fwd);

    const sigBlock = deps.datablockHtml(item);
    if (target.sigBlock !== sigBlock) { target.blockEl.innerHTML = sigBlock; target.sigBlock = sigBlock; }

    target.baseColor = parseCssColor(deps.altitudeColor(item));
    target.ground = item.onGround;
    target.emergency = !!(item.emergency && item.emergency !== "none");
    target.ident = !!item.spi;
    target.conflict = conflictSet.has(item.hex);
    target.coasting = deps.isCoasting(item);
    target.selected = selected;
    target.hovered = target.interactive && item.hex === hoverHex;
    target.ghost = !target.interactive;
    applyTargetStyle(target);
  }

  // Steady-state material + scale for a target's flags. Blink (ident/conflict) is layered
  // on top per-frame; baseRender* hold the values to restore between blink flashes.
  function applyTargetStyle(t) {
    const mat = t.mat;
    let color = t.baseColor.clone();
    let emis = t.baseColor.clone().multiplyScalar(0.55);
    let scaleMul = t.ground ? 0.75 : 1;
    if (t.ghost) { emis = t.baseColor.clone().multiplyScalar(0.3); scaleMul *= 0.9; }
    if (t.emergency) emis = RED.clone().multiplyScalar(0.7);
    if (t.selected) { color = t.baseColor.clone().lerp(WHITE, 0.12); emis = t.baseColor.clone().lerp(WHITE, 0.25).multiplyScalar(0.95); scaleMul *= 1.6; }
    if (t.hovered) { color = t.baseColor.clone().lerp(WHITE, 0.45); emis = emis.clone().lerp(WHITE, 0.4); scaleMul = Math.max(scaleMul, t.ground ? 1 : 1.28); }
    mat.color.copy(color);
    mat.emissive.copy(emis);
    mat.opacity = t.coasting ? 0.5 : (t.ghost ? 0.65 : 1);
    mat.transparent = t.coasting || t.ghost;
    t.scaleMul = scaleMul;
    t.baseRenderColor = color;
    t.baseRenderEmissive = emis;
    t.blink = t.conflict ? "conflict" : t.ident ? "ident" : null;
    t.blockEl.classList.toggle("selected", !!t.selected);
    t.blockEl.classList.toggle("hovered", !!t.hovered);
  }

  // --- Airfields (terrain-pinned DOM reference points, graded + hover info) ----------------
  const airfieldEls = []; // {x, y(raw m), z, el, field}
  function rebuildAirfields() {
    for (const f of airfieldEls) f.el.remove();
    airfieldEls.length = 0;
    if (hoverAf) { hoverAf = null; afTooltipEl.style.display = "none"; }
    const settings = deps.getSettings();
    if (!settings.airfields) return;
    for (const field of AIRFIELDS) {
      const minor = isMinorAirfield(field);
      if (minor && !settings.airfieldsMinor) continue;
      const el = document.createElement("div");
      el.className = `t3d-airfield kind-${field.kind}${minor ? " minor" : ""}`;
      el.innerHTML = `<span class="t3d-af-dot"></span>${minor ? "" : `<span class="t3d-af-code">${field.code}</span>`}`;
      overlayEl.appendChild(el);
      const entry = { x: toLocalX(field.lon), y: sampleElevation(field.lon, field.lat) * exagg, z: toLocalZ(field.lat), el, field };
      const dot = el.querySelector(".t3d-af-dot");
      dot.addEventListener("mouseenter", () => {
        hoverAf = entry;
        afTooltipEl.innerHTML = deps.airfieldTooltip(field);
        afTooltipEl.style.display = "";
        needsRender = true;
      });
      dot.addEventListener("mouseleave", () => {
        if (hoverAf === entry) { hoverAf = null; afTooltipEl.style.display = "none"; }
      });
      airfieldEls.push(entry);
    }
  }

  // --- dataPass: rebuild everything that depends on app data (not the camera) --------------
  function dataPass() {
    if (disposed) return;
    exagg = Math.max(1, Math.min(4, Number(deps.getSettings().terrainExaggeration) || 2));
    uniforms.uExagg.value = exagg;

    const selectedHex = deps.getSelectedHex();
    const conflictSet = new Set();
    for (const pair of deps.getConflicts()) { conflictSet.add(pair.a.hex); conflictSet.add(pair.b.hex); }

    const seen = new Set();
    let stickCount = 0;
    let dotCount = 0;
    for (const item of deps.getAircraft()) {
      if (item.lat == null || item.lon == null) continue;
      if (!deps.passesFilters(item)) continue;
      if (deps.isDropped(item)) continue;
      if (targets.size >= MAX_TARGETS && !targets.has(item.hex)) continue;
      seen.add(item.hex);
      let target = targets.get(item.hex);
      if (!target) {
        target = makeTarget(item.hex, true);
        targets.set(item.hex, target);
      }
      updateTarget(target, item, selectedHex === item.hex, conflictSet);

      const c = target.baseColor;
      if (target.stick) {
        const p = stickCount * 6;
        sticks.positions.array.set([target.x, target.y, target.z, target.x, target.groundY, target.z], p);
        sticks.colors.array.set([c.r, c.g, c.b, c.r * 0.15, c.g * 0.15, c.b * 0.15], p);
        stickCount += 1;
      }
      const d = dotCount * 3;
      dots.positions.array.set([target.x, target.groundY + 20, target.z], d);
      dots.colors.array.set([c.r * 0.6, c.g * 0.6, c.b * 0.6], d);
      dotCount += 1;
    }
    for (const [hex, target] of targets) {
      if (!seen.has(hex)) {
        removeTarget(target);
        targets.delete(hex);
        if (hoverHex === hex) hoverHex = null;
      }
    }
    raycastMeshes = [];
    for (const t of targets.values()) if (t.mesh) raycastMeshes.push(t.mesh);
    sticks.geometry.setDrawRange(0, stickCount * 2);
    sticks.positions.needsUpdate = true;
    sticks.colors.needsUpdate = true;
    dots.geometry.setDrawRange(0, dotCount);
    dots.positions.needsUpdate = true;
    dots.colors.needsUpdate = true;

    // Playback ghost marker along the selected track.
    const ghostItem = deps.getPlaybackGhost();
    if (ghostItem) {
      if (!ghostTarget) ghostTarget = makeTarget("__ghost__", false);
      updateTarget(ghostTarget, ghostItem, false, conflictSet);
    } else if (ghostTarget) {
      removeTarget(ghostTarget);
      ghostTarget = null;
    }

    rebuildTrail();
    rebuildConflicts();
    needsRender = true;
  }

  function rebuildTrail() {
    if (trailLine) {
      trailLine.geometry.dispose();
      scene.remove(trailLine);
      trailLine = null;
    }
    let pts = deps.getSelectedTrack().filter((p) => p.lat != null && p.lon != null);
    if (pts.length < 2) return;
    if (pts.length > TRAIL_MAX_POINTS) {
      const step = Math.ceil(pts.length / TRAIL_MAX_POINTS);
      pts = pts.filter((_, i) => i % step === 0 || i === pts.length - 1);
    }
    const positions = [];
    const colors = [];
    let prev = null;
    let prevTime = null;
    let lastAltM = 0;
    for (const point of pts) {
      const time = Date.parse(point.positionAt);
      const altFt = point.altBaro ?? point.altGeom;
      const altM = altFt != null ? altFt * FT_TO_M : lastAltM;
      lastAltM = altM;
      const v = [toLocalX(point.lon), Math.max(sampleElevation(point.lon, point.lat), altM) * exagg, toLocalZ(point.lat)];
      const gap = prev && Number.isFinite(time) && Number.isFinite(prevTime) && time - prevTime > TRACK_GAP_MS;
      if (prev && !gap) {
        const c = parseCssColor(deps.trackSegmentColor(point));
        positions.push(...prev, ...v);
        colors.push(c.r, c.g, c.b, c.r, c.g, c.b);
      }
      prev = v;
      prevTime = time;
    }
    if (!positions.length) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(colors), 3));
    trailLine = new THREE.LineSegments(
      geometry, new THREE.LineBasicMaterial({
        vertexColors: true, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false,
      }),
    );
    trailLine.frustumCulled = false;
    scene.add(trailLine);
  }

  function rebuildConflicts() {
    if (conflictLine) {
      conflictLine.geometry.dispose();
      scene.remove(conflictLine);
      conflictLine = null;
    }
    for (const label of conflictLabels) label.el.remove();
    conflictLabels.length = 0;
    const pairs = deps.getConflicts();
    if (!pairs.length) return;
    const positions = [];
    for (const pair of pairs) {
      const pa = [toLocalX(pair.a.lon), ((pair.a.altBaro ?? pair.a.altGeom) || 0) * FT_TO_M * exagg, toLocalZ(pair.a.lat)];
      const pb = [toLocalX(pair.b.lon), ((pair.b.altBaro ?? pair.b.altGeom) || 0) * FT_TO_M * exagg, toLocalZ(pair.b.lat)];
      positions.push(...pa, ...pb);
      const el = document.createElement("div");
      el.className = "conflict-label t3d-pin";
      el.textContent = `${pair.distNm.toFixed(1)} NM · ${Math.round(pair.vertFt)} ft`;
      overlayEl.appendChild(el);
      conflictLabels.push({
        x: (pa[0] + pb[0]) / 2, y: (pa[1] + pb[1]) / 2, z: (pa[2] + pb[2]) / 2, el,
      });
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
    conflictLine = new THREE.LineSegments(
      geometry, new THREE.LineDashedMaterial({ color: 0xfb7185, dashSize: 2500, gapSize: 1800, transparent: true, opacity: 0.9 }),
    );
    conflictLine.computeLineDistances();
    conflictLine.frustumCulled = false;
    scene.add(conflictLine);
  }

  // --- Coverage volume: the receiver's reception envelope as stacked altitude-band shells,
  // so the reachable airspace reads as a 3D dome. Rebuilt only when coverage/exaggeration
  // changes (not per-second), via the exported drawCoverage(). --------------------------
  let coverageGroup = null;
  function bandMidFeet(band) {
    const max = band.maxAltitude ?? band.minAltitude + 10000;
    return (band.minAltitude + max) / 2;
  }
  function addCoverageShell(group, ring, y, color) {
    const pts = ring.map(([lon, lat]) => [toLocalX(lon), toLocalZ(lat)]);
    const n = pts.length;
    if (n < 3) return;
    // Fan-triangulate from the centroid — reception envelopes are star-shaped about the
    // receiver, so a centroid fan fills them without a general triangulator.
    let cx = 0;
    let cz = 0;
    for (const [x, z] of pts) { cx += x; cz += z; }
    cx /= n; cz /= n;
    const fill = [cx, y, cz];
    for (const [x, z] of pts) fill.push(x, y, z);
    const idx = [];
    for (let i = 1; i <= n; i += 1) idx.push(0, i, i === n ? 1 : i + 1);
    const fillGeo = new THREE.BufferGeometry();
    fillGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(fill), 3));
    fillGeo.setIndex(idx);
    const fillMesh = new THREE.Mesh(fillGeo, new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.06, side: THREE.DoubleSide, depthWrite: false,
    }));
    fillMesh.frustumCulled = false;
    group.add(fillMesh);
    const loop = [];
    for (const [x, z] of pts) loop.push(x, y, z);
    loop.push(pts[0][0], y, pts[0][1]);
    const loopGeo = new THREE.BufferGeometry();
    loopGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(loop), 3));
    const line = new THREE.Line(loopGeo, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.55 }));
    line.frustumCulled = false;
    group.add(line);
  }
  function drawCoverage() {
    if (coverageGroup) {
      coverageGroup.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
      scene.remove(coverageGroup);
      coverageGroup = null;
    }
    if (!deps.getSettings().coverage) return;
    const areas = deps.getCoverage()?.areas || [];
    if (!areas.length) return;
    const group = new THREE.Group();
    for (const area of areas) {
      const bands = (area.bands || []).filter((b) => b.polygon?.coordinates?.[0]?.length >= 3);
      if (bands.length) {
        for (const band of bands) {
          const mid = bandMidFeet(band);
          addCoverageShell(group, band.polygon.coordinates[0], mid * FT_TO_M * exagg, parseCssColor(deps.altitudeColorFeet(mid)));
        }
      } else if (area.polygon?.coordinates?.[0]?.length >= 3) {
        addCoverageShell(group, area.polygon.coordinates[0], 60, new THREE.Color(0x2dd4bf));
      }
    }
    coverageGroup = group;
    scene.add(group);
    needsRender = true;
  }

  // --- Per-frame DOM overlay sync ----------------------------------------------------------
  const _v = new THREE.Vector3();
  let viewW = 1;
  let viewH = 1;
  function projectToScreen(x, y, z, out) {
    _v.set(x, y, z).applyMatrix4(camera.matrixWorldInverse);
    if (_v.z > -camera.near) return false; // behind the camera plane
    out.depth = -_v.z;
    _v.applyMatrix4(camera.projectionMatrix); // divides by w
    out.x = (_v.x * 0.5 + 0.5) * viewW;
    out.y = (0.5 - _v.y * 0.5) * viewH;
    return true;
  }

  const _p = { x: 0, y: 0, depth: 0 };
  function placeEl(entry, offsetY = 0) {
    const ok = projectToScreen(entry.x, entry.y, entry.z, _p)
      && _p.x > -160 && _p.x < viewW + 160 && _p.y > -160 && _p.y < viewH + 160;
    if (!ok) {
      if (entry.visible !== false) { entry.el.style.display = "none"; entry.visible = false; }
      return false;
    }
    if (entry.visible === false) { entry.el.style.display = ""; entry.visible = true; }
    entry.el.style.transform = `translate3d(${_p.x.toFixed(1)}px, ${(_p.y + offsetY).toFixed(1)}px, 0)`;
    return true;
  }

  function syncOverlay() {
    camera.updateMatrixWorld();
    for (const target of targets.values()) {
      if (placeEl(target)) {
        target.el.style.zIndex = String(Math.max(1, 4_000_000 - Math.round(_p.depth)));
      }
    }
    if (ghostTarget) placeEl(ghostTarget);
    for (const entry of airfieldEls) placeEl(entry);
    for (const entry of staticLabels) placeEl(entry);
    for (const entry of conflictLabels) placeEl(entry);
    if (hoverAf) {
      if (projectToScreen(hoverAf.x, hoverAf.y, hoverAf.z, _p)) {
        afTooltipEl.style.display = "";
        afTooltipEl.style.transform = `translate3d(${_p.x.toFixed(1)}px, ${(_p.y - 12).toFixed(1)}px, 0) translate(-50%, -100%)`;
      } else {
        afTooltipEl.style.display = "none";
      }
    }
  }

  // --- Camera helpers -----------------------------------------------------------------------
  let panAnim = null; // {t0, dur, fromT, toT}
  function panTo(lon, lat) {
    panAnim = {
      t0: performance.now(),
      dur: 550,
      fromT: controls.target.clone(),
      toT: new THREE.Vector3(toLocalX(lon), 0, toLocalZ(lat)),
    };
    needsRender = true;
  }

  const BASE_MPP = 156543.03392; // web mercator meters/px at zoom 0 (equator)
  function setCameraFromMap(center, zoom) {
    const lat = center.lat;
    const mpp = (BASE_MPP * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
    const groundH = mpp * Math.max(200, viewH);
    const fovRad = (camera.fov * Math.PI) / 180;
    const dist = Math.min(1_400_000, Math.max(8_000, groundH / 2 / Math.tan(fovRad / 2)));
    const target = new THREE.Vector3(toLocalX(center.lng ?? center.lon), 0, toLocalZ(lat));
    controls.target.copy(target);
    // Approach from the south, ~42 deg above the horizon — the classic tactical vantage.
    const elev = (42 * Math.PI) / 180;
    camera.position.set(target.x, target.y + Math.sin(elev) * dist, target.z + Math.cos(elev) * dist);
    controls.update();
    needsRender = true;
  }

  function getCameraForMap() {
    const lon = localToLon(controls.target.x);
    const lat = localToLat(controls.target.z);
    const dist = camera.position.distanceTo(controls.target);
    const fovRad = (camera.fov * Math.PI) / 180;
    const mpp = (2 * dist * Math.tan(fovRad / 2)) / Math.max(200, viewH);
    const zoom = Math.log2((BASE_MPP * Math.cos((lat * Math.PI) / 180)) / mpp);
    return { center: [lat, lon], zoom: Math.min(18, Math.max(3, Math.round(zoom))) };
  }

  function fitAircraft(points) {
    // points: [{lat, lon}] — frame them all from the current viewing direction.
    if (!points.length) return;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of points) {
      const x = toLocalX(p.lon);
      const z = toLocalZ(p.lat);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    const target = new THREE.Vector3((minX + maxX) / 2, 0, (minZ + maxZ) / 2);
    const fovRad = (camera.fov * Math.PI) / 180;
    const hFov = 2 * Math.atan(Math.tan(fovRad / 2) * camera.aspect);
    const need = Math.max(
      (maxZ - minZ) / 2 / Math.tan(fovRad / 2),
      (maxX - minX) / 2 / Math.tan(hFov / 2),
      30_000,
    ) * 1.35;
    const dir = camera.position.clone().sub(controls.target).normalize();
    controls.target.copy(target);
    camera.position.copy(target).addScaledVector(dir, Math.min(1_400_000, need));
    controls.update();
    needsRender = true;
  }

  // --- Input: raycast aircraft meshes for hover + click; empty space deselects (with a
  // drag guard so orbiting never selects/deselects) ------------------------------------
  let downX = 0;
  let downY = 0;
  function pickHex(event) {
    const rect = renderer.domElement.getBoundingClientRect();
    ndc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    return raycaster.intersectObjects(raycastMeshes, false)[0]?.object.userData.hex || null;
  }
  renderer.domElement.addEventListener("pointerdown", (event) => {
    downX = event.clientX;
    downY = event.clientY;
  });
  renderer.domElement.addEventListener("pointermove", (event) => {
    if (!running || event.buttons) return; // ignore while dragging the camera
    const hex = pickHex(event);
    if (hex !== hoverHex) {
      hoverHex = hex;
      deps.onHover(hex);
      renderer.domElement.style.cursor = hex ? "pointer" : "";
    }
  });
  renderer.domElement.addEventListener("click", (event) => {
    if (Math.hypot(event.clientX - downX, event.clientY - downY) > 5) return;
    const hex = pickHex(event);
    if (hex) deps.onSelect(hex);
    else deps.onMapClick();
  });

  // --- Resize / render loop ------------------------------------------------------------------
  function resize() {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (!w || !h) return;
    viewW = w;
    viewH = h;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    needsRender = true;
  }
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(container);

  controls.addEventListener("change", () => { needsRender = true; });

  // Scale each aircraft to a constant apparent size (so distant traffic stays visible) and
  // flash IDENT/conflict targets. Runs just before render so it uses the final camera.
  function updateTargetVisuals() {
    const now = performance.now();
    const identOn = Math.floor(now / 500) % 2 === 0;
    const conflictOn = Math.floor(now / 300) % 2 === 0;
    const pxFactor = (2 * Math.tan(((camera.fov * Math.PI) / 180) / 2)) / Math.max(200, viewH);
    let blinkers = false;
    const visit = (t) => {
      if (!t.mesh) return;
      // Meshes are added straight to the scene, so mesh.position is already world space.
      const dist = camera.position.distanceTo(t.mesh.position) || 1;
      t.mesh.scale.setScalar((TARGET_PX * pxFactor * dist * t.scaleMul) / GEO_LEN[t.geoKind]);
      if (t.blink) {
        blinkers = true;
        const on = t.blink === "conflict" ? conflictOn : identOn;
        if (on) {
          const col = t.blink === "conflict" ? RED : AMBER;
          t.mat.color.copy(col);
          t.mat.emissive.copy(col).multiplyScalar(0.85);
        } else {
          t.mat.color.copy(t.baseRenderColor);
          t.mat.emissive.copy(t.baseRenderEmissive);
        }
      }
    };
    for (const t of targets.values()) visit(t);
    if (ghostTarget) visit(ghostTarget);
    if (blinkers) needsRender = true; // keep animating while any target is flashing
  }

  function frame() {
    if (!running) return;
    rafId = requestAnimationFrame(frame);
    if (panAnim) {
      const t = Math.min(1, (performance.now() - panAnim.t0) / panAnim.dur);
      const ease = 1 - (1 - t) ** 3;
      const next = panAnim.fromT.clone().lerp(panAnim.toT, ease);
      camera.position.add(next.clone().sub(controls.target));
      controls.target.copy(next);
      if (t >= 1) panAnim = null;
      needsRender = true;
    }
    const moved = controls.update();
    if (moved || needsRender) {
      needsRender = false;
      camera.updateMatrixWorld();
      updateTargetVisuals();
      renderer.render(scene, camera);
      syncOverlay();
    }
  }

  function setActive(active) {
    if (active === running) return;
    running = active;
    if (active) {
      resize();
      hintEl.style.display = "";
      setTimeout(() => { hintEl.style.display = "none"; }, 8000);
      rafId = requestAnimationFrame(frame);
    } else {
      cancelAnimationFrame(rafId);
      hoverHex = null;
      hoverAf = null;
      afTooltipEl.style.display = "none";
      renderer.domElement.style.cursor = "";
    }
  }

  // Hover driven from the sidebar list: highlight the matching aircraft mesh. (Pointer
  // hover on the canvas is handled directly by the raycaster above.)
  function setHoverClass(prevHex, nextHex) {
    hoverHex = nextHex;
    for (const hex of [prevHex, nextHex]) {
      const t = hex && targets.get(hex);
      if (t) { t.hovered = hex === nextHex; applyTargetStyle(t); }
    }
    needsRender = true;
  }

  function applySettings() {
    exagg = Math.max(1, Math.min(4, Number(deps.getSettings().terrainExaggeration) || 2));
    uniforms.uExagg.value = exagg;
    rebuildAirfields();
    drawCoverage();
    dataPass();
  }

  function destroy() {
    disposed = true;
    setActive(false);
    resizeObserver.disconnect();
    controls.dispose();
    for (const t of targets.values()) removeTarget(t);
    targets.clear();
    if (ghostTarget) removeTarget(ghostTarget);
    scene.traverse((obj) => {
      obj.geometry?.dispose?.();
      if (obj.material && obj.material !== terrainMaterial) obj.material.dispose?.();
    });
    for (const geo of Object.values(GEO)) geo.dispose();
    aircraftMatBase.dispose();
    terrainMaterial.dispose();
    renderer.dispose();
    for (const el of [renderer.domElement, overlayEl, afTooltipEl, loadingEl, hintEl]) el.remove();
  }

  buildTerrain();

  return {
    setActive,
    resize,
    dataPass,
    drawCoverage,
    applySettings,
    setHoverClass,
    panTo,
    fitAircraft,
    setCameraFromMap,
    getCameraForMap,
    destroy,
  };
}
