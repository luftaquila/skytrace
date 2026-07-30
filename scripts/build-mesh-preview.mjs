#!/usr/bin/env node
// Reads .cache/meshes/type-meshes.json and writes .cache/meshes/mesh-preview.html — an Artifact-ready
// (no <html>/<head>/<body> wrapper) self-contained WebGL2 turntable viewer for confirming each
// per-type mesh in a real browser. Shading mirrors web/src/aircraft-layer.js (two-sided diffuse +
// whole-volume glow) so the preview reads like the live 3D view. Model frame: +X nose, +Y right
// wing, +Z up.
//
//   node scripts/build-type-meshes.mjs && node scripts/build-mesh-preview.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IN = path.join(HERE, "../.cache/meshes/type-meshes.json");
const OUT = path.join(HERE, "../.cache/meshes/mesh-preview.html");

const LABELS = {
  small: "JET · SMALL (P-51)",
  medium: "JET · MEDIUM",
  large: "JET · LARGE",
  helicopter: "HELICOPTER · A7",
  glider: "GLIDER · B1",
  airship: "AIRSHIP · B2",
  fighter: "FIGHTER · A6 (F-22)",
  drone: "UAV · B6 (QUADCOPTER)",
  spacecraft: "SPACECRAFT · B7 (STARSHIP)",
  parachute: "PARACHUTIST · B3",
  ground: "SURFACE VEHICLE · C1/C2",
};

const meshes = JSON.parse(fs.readFileSync(IN, "utf8"));
const order = Object.keys(meshes);
const data = {};
for (const k of order) {
  data[k] = { label: LABELS[k] || k.toUpperCase(), tris: meshes[k].triCount, stock: !!meshes[k].stock, watertight: meshes[k].watertight !== false, positions: meshes[k].positions, normals: meshes[k].normals };
}

const html = `<title>Skytrace · Aircraft-Type Mesh Preview</title>
<style>
  :root {
    --bg: #070d10; --bg2: #0b151a; --panel: rgba(9,20,25,0.82); --line: rgba(120,190,200,0.16);
    --ink: #cfe6ea; --dim: #6f8b91; --accent: #f5b942; --accent-dim: #8a6a1f; --good: #57d38c;
    --mono: ui-monospace, "SF Mono", "JetBrains Mono", "Menlo", monospace;
  }
  #app { position: fixed; inset: 0; background: radial-gradient(120% 120% at 50% 0%, var(--bg2), var(--bg)); color: var(--ink); font-family: var(--mono); overflow: hidden; }
  #gl { position: absolute; inset: 0; width: 100%; height: 100%; display: block; touch-action: none; cursor: grab; }
  #gl:active { cursor: grabbing; }
  .hud { position: absolute; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); padding: 12px 14px; }
  .hud-tl { top: 16px; left: 16px; min-width: 210px; }
  .eyebrow { font-size: 10px; letter-spacing: 0.22em; color: var(--dim); text-transform: uppercase; margin-bottom: 8px; }
  .title { font-size: 15px; letter-spacing: 0.08em; color: var(--accent); font-weight: 600; }
  .stat { display: flex; justify-content: space-between; gap: 18px; font-size: 12px; margin-top: 6px; color: var(--ink); }
  .stat b { color: var(--dim); font-weight: 400; letter-spacing: 0.04em; }
  .stat .ok { color: var(--good); } .stat .warn { color: #e8705b; }
  .tabs { position: absolute; top: 16px; right: 16px; display: flex; flex-direction: column; gap: 6px; max-width: 210px; }
  .tab { text-align: left; font-family: var(--mono); font-size: 11px; letter-spacing: 0.05em; color: var(--dim);
         background: var(--panel); border: 1px solid var(--line); border-radius: 7px; padding: 8px 11px; cursor: pointer; transition: color .12s, border-color .12s; }
  .tab:hover { color: var(--ink); }
  .tab.on { color: var(--accent); border-color: var(--accent-dim); }
  .tab:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .dock { bottom: 16px; left: 16px; display: flex; gap: 8px; align-items: center; }
  .dock button { font-family: var(--mono); font-size: 11px; letter-spacing: 0.06em; color: var(--dim); background: transparent; border: 1px solid var(--line); border-radius: 6px; padding: 7px 12px; cursor: pointer; }
  .dock button.on { color: var(--accent); border-color: var(--accent-dim); }
  .dock button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .legend { bottom: 16px; right: 16px; font-size: 11px; letter-spacing: 0.04em; line-height: 1.9; }
  .legend .ax { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 7px; vertical-align: middle; }
  .legend .x { background: #e8705b; } .legend .y { background: #57d38c; } .legend .z { background: #5aa9e6; }
  .legend b { color: var(--dim); font-weight: 400; }
  .hint { position: absolute; bottom: 16px; left: 50%; transform: translateX(-50%); font-size: 10.5px; letter-spacing: 0.12em; color: var(--dim); text-transform: uppercase; pointer-events: none; }
  @media (max-width: 640px) { .hint { display: none; } .hud-tl { min-width: 0; } .tabs, .tab { max-width: 150px; } }
</style>
<div id="app">
  <canvas id="gl"></canvas>
  <div class="hud hud-tl">
    <div class="eyebrow" id="eyebrow">Skytrace · type mesh</div>
    <div class="title" id="title">—</div>
    <div class="stat"><b>triangles</b><span id="tris">—</span></div>
    <div class="stat"><b>kind</b><span id="kind">—</span></div>
    <div class="stat"><b>watertight</b><span id="wt">—</span></div>
  </div>
  <div class="tabs" id="tabs"></div>
  <div class="hud dock">
    <button id="mode" type="button">SOLID</button>
    <button id="spin" class="on" type="button">◱ AUTO-SPIN</button>
  </div>
  <div class="hud legend">
    <div><span class="ax x"></span><b>+X</b> &nbsp;nose (forward)</div>
    <div><span class="ax y"></span><b>+Y</b> &nbsp;right wing</div>
    <div><span class="ax z"></span><b>+Z</b> &nbsp;up</div>
  </div>
  <div class="hint">drag&nbsp;·&nbsp;rotate &nbsp;&nbsp; scroll&nbsp;·&nbsp;zoom</div>
</div>
<script>
const MESH = ${JSON.stringify(data)};
const ORDER = ${JSON.stringify(order)};
(function () {
  const canvas = document.getElementById("gl");
  const gl = canvas.getContext("webgl2", { antialias: true, alpha: false });
  if (!gl) { document.getElementById("title").textContent = "WebGL2 unavailable"; return; }

  // ---- mat4 helpers (column-major) ----
  const sub = (a, b) => [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
  const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
  const dot = (a, b) => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
  const nrm = (a) => { const l = Math.hypot(a[0],a[1],a[2])||1; return [a[0]/l,a[1]/l,a[2]/l]; };
  function mul(a, b) { const o = new Float32Array(16);
    for (let c=0;c<4;c++) for (let r=0;r<4;r++) o[c*4+r]=a[r]*b[c*4]+a[4+r]*b[c*4+1]+a[8+r]*b[c*4+2]+a[12+r]*b[c*4+3];
    return o; }
  function perspective(fovy, aspect, near, far) { const f=1/Math.tan(fovy/2), nf=1/(near-far);
    return new Float32Array([f/aspect,0,0,0, 0,f,0,0, 0,0,(far+near)*nf,-1, 0,0,2*far*near*nf,0]); }
  function lookAt(eye, ctr, up) { const z=nrm(sub(eye,ctr)), x=nrm(cross(up,z)), y=cross(z,x);
    return new Float32Array([x[0],y[0],z[0],0, x[1],y[1],z[1],0, x[2],y[2],z[2],0, -dot(x,eye),-dot(y,eye),-dot(z,eye),1]); }

  function compile(src, type) { const s=gl.createShader(type); gl.shaderSource(s,src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; }
  function link(vs, fs) { const p=gl.createProgram(); gl.attachShader(p,compile(vs,gl.VERTEX_SHADER)); gl.attachShader(p,compile(fs,gl.FRAGMENT_SHADER));
    gl.linkProgram(p); if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p)); return p; }

  // model program — mirrors aircraft-layer.js shading (two-sided diffuse + whole-volume glow)
  const prog = link(
    \`#version 300 es
     uniform mat4 u_mvp; in vec3 a_pos; in vec3 a_normal; out vec3 v_n;
     void main(){ v_n = a_normal; gl_Position = u_mvp * vec4(a_pos,1.0); }\`,
    \`#version 300 es
     precision highp float; uniform vec4 u_color; uniform vec3 u_light; in vec3 v_n; out vec4 o;
     void main(){ vec3 n=normalize(v_n); float d=abs(dot(n,normalize(u_light)));
       float shade=0.55+0.45*d; vec3 c=u_color.rgb*shade;
       float lum=dot(c,vec3(0.299,0.587,0.114)); c+=c*(0.5+(1.0-lum)*0.7);
       o=vec4(c,u_color.a); }\`);
  const uMvp = gl.getUniformLocation(prog, "u_mvp");
  const uColor = gl.getUniformLocation(prog, "u_color");
  const uLight = gl.getUniformLocation(prog, "u_light");
  const aPos = gl.getAttribLocation(prog, "a_pos"), aNrm = gl.getAttribLocation(prog, "a_normal");

  // flat-colour line program (grid + axes + wireframe)
  const lprog = link(
    \`#version 300 es
     uniform mat4 u_mvp; in vec3 a_pos; void main(){ gl_Position = u_mvp * vec4(a_pos,1.0); }\`,
    \`#version 300 es
     precision highp float; uniform vec4 u_color; out vec4 o; void main(){ o = u_color; }\`);
  const luMvp = gl.getUniformLocation(lprog, "u_mvp"), luColor = gl.getUniformLocation(lprog, "u_color");
  const laPos = gl.getAttribLocation(lprog, "a_pos");

  // ---- static geometry: floor grid + axis gnomon ----
  const gridV = []; const G = 0.6, N = 12, step = (2*G)/N;
  for (let i=0;i<=N;i++){ const t=-G+i*step; gridV.push(-G,t,0, G,t,0, t,-G,0, t,G,0); }
  const gridBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, gridBuf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(gridV), gl.STATIC_DRAW);
  const axV = [0,0,0, 0.5,0,0,  0,0,0, 0,0.5,0,  0,0,0, 0,0,0.4];
  const axBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, axBuf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(axV), gl.STATIC_DRAW);

  // ---- per-mesh GL buffers ----
  const built = {};
  function build(key) {
    if (built[key]) return built[key];
    const m = MESH[key];
    const pos = new Float32Array(m.positions), nor = new Float32Array(m.normals);
    const pb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, pb); gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);
    const nb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, nb); gl.bufferData(gl.ARRAY_BUFFER, nor, gl.STATIC_DRAW);
    // wireframe edges (3 per triangle)
    const we = [];
    for (let i=0;i<pos.length;i+=9){ const P=(o)=>[pos[i+o],pos[i+o+1],pos[i+o+2]];
      const a=P(0),b=P(3),c=P(6); we.push(...a,...b, ...b,...c, ...c,...a); }
    const wb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, wb); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(we), gl.STATIC_DRAW);
    // center + radius for framing
    let mn=[1e9,1e9,1e9], mx=[-1e9,-1e9,-1e9];
    for (let i=0;i<pos.length;i+=3) for(let k=0;k<3;k++){ mn[k]=Math.min(mn[k],pos[i+k]); mx[k]=Math.max(mx[k],pos[i+k]); }
    const ctr=[(mn[0]+mx[0])/2,(mn[1]+mx[1])/2,(mn[2]+mx[2])/2];
    const rad=Math.max(mx[0]-mn[0],mx[1]-mn[1],mx[2]-mn[2]);
    built[key]={ pb, nb, wb, count: pos.length/3, wcount: we.length/3, ctr, rad };
    return built[key];
  }

  // ---- camera / interaction ----
  let cur = ORDER[ORDER.length - 1]; // default to the newest mesh (the one under review)
  let yaw = -0.9, pitch = 0.5, radius = 1.9, spin = true;
  const MODE = ["SOLID", "SOLID + WIRE", "WIRE"]; let modeIdx = 0;
  let dragging = false, lx = 0, ly = 0;
  canvas.addEventListener("pointerdown", (e)=>{ dragging=true; lx=e.clientX; ly=e.clientY; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener("pointerup", (e)=>{ dragging=false; });
  canvas.addEventListener("pointermove", (e)=>{ if(!dragging) return; yaw-=(e.clientX-lx)*0.008; pitch+=(e.clientY-ly)*0.008;
    pitch=Math.max(-1.45,Math.min(1.45,pitch)); lx=e.clientX; ly=e.clientY; });
  canvas.addEventListener("wheel", (e)=>{ e.preventDefault(); radius*=Math.exp(e.deltaY*0.0011); radius=Math.max(0.9,Math.min(4.5,radius)); }, { passive:false });

  function selectTab(key){ cur=key; const m=MESH[key]; build(key);
    document.getElementById("title").textContent=m.label;
    document.getElementById("eyebrow").textContent = m.stock ? "Skytrace · baseline jet" : "Skytrace · type mesh";
    const t=document.getElementById("tris"); t.textContent=m.tris; t.className = m.tris<=200?"ok":"warn";
    const kind=document.getElementById("kind"); kind.textContent = m.stock ? "baseline (existing)" : "new type mesh";
    const wt=document.getElementById("wt");
    if (m.watertight) { wt.textContent="✓ closed solid"; wt.className="ok"; }
    else { wt.textContent="✕ open edges"; wt.className="warn"; }
    radius = 1.9;
    for (const el of document.querySelectorAll(".tab")) el.classList.toggle("on", el.dataset.k===key); }

  const tabs = document.getElementById("tabs");
  for (const key of ORDER) { const btn=document.createElement("button"); btn.className="tab"; btn.dataset.k=key; btn.type="button";
    btn.textContent=MESH[key].label; btn.addEventListener("click",()=>selectTab(key)); tabs.appendChild(btn); }
  document.getElementById("mode").addEventListener("click",(e)=>{ modeIdx=(modeIdx+1)%3; e.target.textContent=MODE[modeIdx]; e.target.classList.toggle("on", modeIdx!==0); });
  document.getElementById("spin").addEventListener("click",(e)=>{ spin=!spin; e.target.classList.toggle("on", spin); });

  function resize(){ const dpr=Math.min(window.devicePixelRatio||1,2);
    const w=canvas.clientWidth*dpr|0, h=canvas.clientHeight*dpr|0;
    if (canvas.width!==w||canvas.height!==h){ canvas.width=w; canvas.height=h; } }

  function draw(){
    resize();
    const b = build(cur);
    if (spin && !dragging) yaw += 0.006;
    const aspect = canvas.width/canvas.height || 1;
    const ctr = b.ctr;
    const r = b.rad * radius;
    const eye = [ctr[0]+r*Math.cos(pitch)*Math.cos(yaw), ctr[1]+r*Math.cos(pitch)*Math.sin(yaw), ctr[2]+r*Math.sin(pitch)];
    const view = lookAt(eye, ctr, [0,0,1]);
    const proj = perspective(0.72, aspect, 0.02, 20);
    const mvp = mul(proj, view);

    gl.viewport(0,0,canvas.width,canvas.height);
    gl.clearColor(0.027,0.051,0.063,1); gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    // grid + axes
    gl.useProgram(lprog); gl.uniformMatrix4fv(luMvp,false,mvp);
    gl.bindBuffer(gl.ARRAY_BUFFER, gridBuf); gl.enableVertexAttribArray(laPos); gl.vertexAttribPointer(laPos,3,gl.FLOAT,false,0,0);
    gl.uniform4f(luColor, 0.36,0.56,0.60,0.16); gl.drawArrays(gl.LINES,0,gridV.length/3);
    gl.bindBuffer(gl.ARRAY_BUFFER, axBuf); gl.vertexAttribPointer(laPos,3,gl.FLOAT,false,0,0);
    gl.uniform4f(luColor, 0.91,0.44,0.36,0.95); gl.drawArrays(gl.LINES,0,2);   // +X nose
    gl.uniform4f(luColor, 0.34,0.83,0.55,0.95); gl.drawArrays(gl.LINES,2,2);   // +Y right
    gl.uniform4f(luColor, 0.35,0.66,0.90,0.95); gl.drawArrays(gl.LINES,4,2);   // +Z up

    // model
    if (modeIdx !== 2) {
      gl.useProgram(prog); gl.uniformMatrix4fv(uMvp,false,mvp);
      gl.uniform3f(uLight, 0.35,0.25,0.9); gl.uniform4f(uColor, 0.62,0.80,0.90,1.0);
      gl.bindBuffer(gl.ARRAY_BUFFER, b.pb); gl.enableVertexAttribArray(aPos); gl.vertexAttribPointer(aPos,3,gl.FLOAT,false,0,0);
      gl.bindBuffer(gl.ARRAY_BUFFER, b.nb); gl.enableVertexAttribArray(aNrm); gl.vertexAttribPointer(aNrm,3,gl.FLOAT,false,0,0);
      gl.drawArrays(gl.TRIANGLES,0,b.count);
    }
    if (modeIdx !== 0) {
      gl.useProgram(lprog); gl.uniformMatrix4fv(luMvp,false,mvp);
      gl.bindBuffer(gl.ARRAY_BUFFER, b.wb); gl.enableVertexAttribArray(laPos); gl.vertexAttribPointer(laPos,3,gl.FLOAT,false,0,0);
      gl.uniform4f(luColor, 0.96,0.73,0.26, modeIdx===2?0.95:0.5); gl.drawArrays(gl.LINES,0,b.wcount);
    }
    requestAnimationFrame(draw);
  }

  selectTab(cur);
  requestAnimationFrame(draw);
})();
</script>`;

fs.writeFileSync(OUT, html);
console.log(`wrote ${path.relative(process.cwd(), OUT)} (${(html.length / 1024).toFixed(1)} KB, ${order.length} mesh${order.length > 1 ? "es" : ""})`);
