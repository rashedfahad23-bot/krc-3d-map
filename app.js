import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const $ = id => document.getElementById(id);
const stage = $('stage'), canvas = $('gl');

function fallback() {
  canvas.hidden = true; $('ui').hidden = true; $('labels').hidden = true;
  const d = document.createElement('div'); d.className = 'fallback';
  d.innerHTML = '<img src="img/aerial.jpg" alt="صورة جوية للمركز"><p class="hud">هذا الجهاز لا يعرض المجسم ثلاثي الأبعاد، فهذه الصورة الجوية بدلاً منه.</p>';
  stage.appendChild(d);
}
let renderer;
try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' }); }
catch (e) { fallback(); throw e; }

const COARSE = matchMedia('(pointer:coarse)').matches || Math.min(screen.width, screen.height) < 600;
const PHONE = matchMedia('(max-width: 859px)'); /* the panel is a bottom sheet below this width */
/* language: Arabic by default, or English. ?lang=en in the URL wins, then the visitor's last choice */
let LANG = (function () {
  const q = new URLSearchParams(location.search).get('lang'); if (q === 'en' || q === 'ar') return q;
  try { return localStorage.getItem('krc-lang') === 'en' ? 'en' : 'ar'; } catch (_) { return 'ar'; }
})();
const L = (ar, en) => LANG === 'en' ? en : ar;
/* a place's name in the current language, its name in the other one, and its note */
const nm = p => LANG === 'en' ? p.en : p.n, alt = p => LANG === 'en' ? p.n : p.en, nt = p => (LANG === 'en' ? p.ne : p.note) || '';
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.95;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = false;

/* ---------- units: aerial pixels -> metres ---------- */
const W = 2796, H = 979, S = 0.1626, GW = W * S, GH = H * S; /* scale from Arena 1 and 2 = 40 m long */
const X = px => (px - W / 2) * S;
const Z = py => (py - H / 2) * S;
let seed = 7;
function rnd() { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }
const C = h => [(h >> 16 & 255) / 255, (h >> 8 & 255) / 255, (h & 255) / 255];
const mulc = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
const ONE = [1, 1, 1], WHITE = C(0xEFEDE6), POLE = C(0xB4B8BB), LAMP = C(0x2A2D30), DARK = [0.10, 0.10, 0.11],
  PAVE = [0.95, 0.95, 0.95], FLAT = [0.74, 0.72, 0.68], BEIGE = [0.80, 0.74, 0.64];

/* ---------- batches: geometry is baked into a few static buffers, one per material ---------- */
const B = {}, ORDER = [];
function mk(n, o = {}) { B[n] = { name: n, base: o.base || n, a: [], wm: o.wm || null, tex: o.tex === undefined ? n : o.tex, alpha: !!o.alpha, file: o.file || null, rs: !!o.rs, rt: !!o.rt, opt: o.opt || null }; ORDER.push(n); }
mk('col', { tex: null });
mk('stone', { wm: [2.0, 0.8], file: 'stone', rs: 1, rt: 1 });
mk('roof', { wm: [4, 3.2] }); mk('metal', { wm: [3, 3] }); mk('bark', { wm: [1.1, 2.2] });
['gateC', 'gateS', 'towerL', 'towerR', 'doorA', 'doorB', 'doorC', 'doorCC', 'round', 'wc', 'storeE', 'storeW', 'admin', 'recback', 'gateL', 'pav', 'dlabel', 'cafe']
  .forEach(n => mk(n, { file: n }));
mk('bay', { file: 'bay', rs: 1 }); mk('dbox', { file: 'dbox' });
mk('droof', { wm: [3, 3], tex: 'metal' });
mk('leaf', { alpha: 1 }); mk('frond', { alpha: 1 });
/* swappable sets: hidden when a Meshy model of the same thing is loaded */
mk('pbark', { wm: [1.1, 2.2], tex: 'bark', opt: 'palm' }); mk('pfrond', { alpha: 1, tex: 'frond', opt: 'palm' });
mk('jcol', { tex: null, opt: 'jump' });
mk('bcol', { tex: null, opt: 'booth' });
mk('apron', { tex: 'pave' });
mk('glass', { tex: null }); mk('lamp', { tex: null }); mk('amb', { tex: null }); mk('blabel', { tex: null }); mk('ceil', { tex: null });
mk('tbark', { wm: [1.1, 2.2], tex: 'bark', opt: 'tree' }); mk('tleaf', { alpha: 1, tex: 'leaf', opt: 'tree' });

function norm3(v) { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function XF(x, y, z, ry, rz) {
  const cy = Math.cos(ry || 0), sy = Math.sin(ry || 0), cz = Math.cos(rz || 0), sz = Math.sin(rz || 0);
  return p => { const x1 = p[0] * cz - p[1] * sz, y1 = p[0] * sz + p[1] * cz, z1 = p[2]; return [x + x1 * cy + z1 * sy, y + y1, z - x1 * sy + z1 * cy]; };
}
/* while REDIR is set, geometry goes into a copy of each batch tagged with that option, so it can be hidden as a set */
let REDIR = null;
function optB(b) { const k = b.name + '__' + REDIR; if (!B[k]) { mk(k, { base: b.base, wm: b.wm, tex: b.tex, alpha: b.alpha, file: b.file, rs: b.rs, rt: b.rt, opt: REDIR }); B[k].wm = b.wm; } return B[k]; }
function vtx(b, p, n, c, u, v) { if (REDIR && b.opt !== REDIR) b = optB(b); b.a.push(p[0], p[1], p[2], n[0], n[1], n[2], c[0], c[1], c[2], u, v); }
function tri(b, p, q, r, col, up, uq, ur, ctr) {
  const ux = q[0] - p[0], uy = q[1] - p[1], uz = q[2] - p[2], vx = r[0] - p[0], vy = r[1] - p[1], vz = r[2] - p[2];
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, l = Math.sqrt(nx * nx + ny * ny + nz * nz); if (l < 1e-9) return; nx /= l; ny /= l; nz /= l;
  /* face away from ctr, and wind the triangle to match: on DoubleSide materials three.js flips the normal of a face
     seen from its back, so a triangle wound against its normal would be lit inside-out */
  if (ctr) { const mx = (p[0] + q[0] + r[0]) / 3 - ctr[0], my = (p[1] + q[1] + r[1]) / 3 - ctr[1], mz = (p[2] + q[2] + r[2]) / 3 - ctr[2]; if (nx * mx + ny * my + nz * mz < 0) { nx = -nx; ny = -ny; nz = -nz; [q, r] = [r, q]; [uq, ur] = [ur, uq]; } }
  if (!up) {
    if (b.wm) {
      const su = b.wm[0], sv = b.wm[1];
      if (Math.abs(ny) > 0.995) { up = [p[0] / su, p[2] / sv]; uq = [q[0] / su, q[2] / sv]; ur = [r[0] / su, r[2] / sv]; }
      else {
        l = Math.sqrt(nx * nx + nz * nz); const tx = nz / l, tz = -nx / l, bx = -ny * tz, by = nz * tx - nx * tz, bz = ny * tx;
        up = [(p[0] * tx + p[2] * tz) / su, (p[0] * bx + p[1] * by + p[2] * bz) / sv]; uq = [(q[0] * tx + q[2] * tz) / su, (q[0] * bx + q[1] * by + q[2] * bz) / sv]; ur = [(r[0] * tx + r[2] * tz) / su, (r[0] * bx + r[1] * by + r[2] * bz) / sv];
      }
    } else { up = uq = ur = [0, 0]; }
  }
  const n = [nx, ny, nz]; vtx(b, p, n, col, up[0], up[1]); vtx(b, q, n, col, uq[0], uq[1]); vtx(b, r, n, col, ur[0], ur[1]);
}
function quadUV(b, p, q, r, s, col, ctr, u0, v0, u1, v1) { tri(b, p, q, r, col, [u0, v0], [u1, v0], [u1, v1], ctr); tri(b, p, r, s, col, [u0, v0], [u1, v1], [u0, v1], ctr); }
function quad(b, p, q, r, s, col, ctr, rep) {
  if (rep) quadUV(b, p, q, r, s, col, ctr, 0, 0, rep, 1);
  else { tri(b, p, q, r, col, null, null, null, ctr); tri(b, p, r, s, col, null, null, null, ctr); }
}
function box(f, w, h, d, col, o = {}) {
  const hw = w / 2, hd = d / 2, of = o.off || [0, 0, 0], sd = o.side, bb = o.b || B.col;
  const P = (x, y, z) => f([x + of[0], y + of[1], z + of[2]]);
  const ctr = P(0, h / 2, 0);
  function face(name, a, b2, c, e, rep) { const t = sd && (!sd.only || sd.only.indexOf(name) > -1); if (t) quad(sd.b, a, b2, c, e, ONE, ctr, rep || 1); else quad(bb, a, b2, c, e, col, ctr); }
  face('+x', P(hw, 0, hd), P(hw, 0, -hd), P(hw, h, -hd), P(hw, h, hd), sd && sd.rx);
  face('-x', P(-hw, 0, -hd), P(-hw, 0, hd), P(-hw, h, hd), P(-hw, h, -hd), sd && sd.rx);
  face('+z', P(-hw, 0, hd), P(hw, 0, hd), P(hw, h, hd), P(-hw, h, hd), sd && sd.rz);
  face('-z', P(hw, 0, -hd), P(-hw, 0, -hd), P(-hw, h, -hd), P(hw, h, -hd), sd && sd.rz);
  if (!o.noTop) quad(o.topB || (o.b && o.b !== B.stone ? o.b : B.col), P(-hw, h, hd), P(hw, h, hd), P(hw, h, -hd), P(-hw, h, -hd), o.top || (o.b ? FLAT : col), ctr);
}
function hip(f, w, d, h, col, b, ring) {
  b = b || B.roof; const hw = w / 2, hd = d / 2, A = f([-hw, 0, -hd]), Bq = f([hw, 0, -hd]), Cq = f([hw, 0, hd]), D = f([-hw, 0, hd]), ctr = f([0, -1, 0]); let R1, R2;
  const t = (p, q, r) => tri(b, p, q, r, col, null, null, null, ctr);
  if (w >= d) { R1 = f([-hw + hd, h, 0]); R2 = f([hw - hd, h, 0]); t(A, Bq, R2); t(A, R2, R1); t(Cq, D, R1); t(Cq, R1, R2); t(Bq, Cq, R2); t(D, A, R1); }
  else { R1 = f([0, h, -hd + hw]); R2 = f([0, h, hd - hw]); t(Bq, Cq, R2); t(Bq, R2, R1); t(D, A, R1); t(D, R1, R2); t(A, Bq, R1); t(Cq, D, R2); }
  const e = 0.22, A2 = f([-hw, -e, -hd]), B2 = f([hw, -e, -hd]), C2 = f([hw, -e, hd]), D2 = f([-hw, -e, hd]), dk = [0.60, 0.25, 0.17], c2 = f([0, 0, 0]); /* red-painted fascia, as on the barns */
  quad(B.col, A2, B2, Bq, A, dk, c2); quad(B.col, B2, C2, Cq, Bq, dk, c2); quad(B.col, C2, D2, D, Cq, dk, c2); quad(B.col, D2, A2, A, D, dk, c2);
  /* wooden soffit under the eave, like the barns in the photos; a hollow building only gets the ring under the overhang */
  const SOF = [0.40, 0.24, 0.14];
  if (!ring) quad(B.col, D2, C2, B2, A2, SOF, f([0, 5, 0]));
  else { const ix = hw - ring, iz = hd - ring, a = f([-ix, -e, -iz]), bq = f([ix, -e, -iz]), c = f([ix, -e, iz]), dq2 = f([-ix, -e, iz]), up = f([0, 5, 0]);
    quad(B.col, A2, B2, bq, a, SOF, up); quad(B.col, B2, C2, c, bq, SOF, up); quad(B.col, C2, D2, dq2, c, SOF, up); quad(B.col, D2, A2, a, dq2, SOF, up); }
}
function cyl(f, rt, rb, h, n, col, cap, b) {
  b = b || B.col; const ctr = f([0, h / 2, 0]), top = f([0, h, 0]);
  for (let i = 0; i < n; i++) {
    const a0 = i / n * 6.2832, a1 = (i + 1) / n * 6.2832;
    const p0 = f([Math.cos(a0) * rb, 0, Math.sin(a0) * rb]), p1 = f([Math.cos(a1) * rb, 0, Math.sin(a1) * rb]);
    const q0 = f([Math.cos(a0) * rt, h, Math.sin(a0) * rt]), q1 = f([Math.cos(a1) * rt, h, Math.sin(a1) * rt]);
    tri(b, p0, p1, q1, col, null, null, null, ctr); if (rt > 0) { tri(b, p0, q1, q0, col, null, null, null, ctr); if (cap) tri(b === B.bark || b === B.pbark || b === B.tbark ? B.col : b, q0, q1, top, col, null, null, null, ctr); }
  }
}
/* foliage: many small textured cards, normals bent outward as if they lay on a sphere */
function card(b, c, t, bt, sz, ctr, col) {
  const s = [[-1, -1], [1, -1], [1, 1], [-1, 1]], P = [], N = [];
  for (let i = 0; i < 4; i++) {
    P.push([c[0] + (t[0] * s[i][0] + bt[0] * s[i][1]) * sz, c[1] + (t[1] * s[i][0] + bt[1] * s[i][1]) * sz, c[2] + (t[2] * s[i][0] + bt[2] * s[i][1]) * sz]);
    N.push(norm3([P[i][0] - ctr[0], P[i][1] - ctr[1] + 0.5 * sz, P[i][2] - ctr[2]]));
  }
  for (const i of [0, 1, 2, 0, 2, 3]) vtx(b, P[i], N[i], col, s[i][0] * 0.5 + 0.5, s[i][1] * 0.5 + 0.5);
}
function crown(x, y, z, rx, ry, n, tint, bt0) {
  const ctr = [x, y, z];
  for (let i = 0; i < n; i++) {
    const u = rnd() * 2 - 1, a = rnd() * 6.2832, s = Math.sqrt(1 - u * u), rr = 0.45 + 0.55 * Math.sqrt(rnd()), d = [Math.cos(a) * s, u, Math.sin(a) * s];
    const c = [x + d[0] * rx * rr, y + d[1] * ry * rr, z + d[2] * rx * rr];
    const nn = norm3([d[0] + (rnd() - .5) * 1.7, d[1] + (rnd() - .5) * 1.7, d[2] + (rnd() - .5) * 1.7]);
    const t = norm3(cross(nn, Math.abs(nn[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0])), bt = cross(nn, t);
    const k = (0.58 + 0.42 * (d[1] * 0.5 + 0.5)) * (0.86 + 0.28 * rnd());
    card(bt0 || B.leaf, c, t, bt, (0.40 + rnd() * 0.22) * Math.min(rx, ry), ctr, mulc(tint, k));
  }
}
const TREES = []; /* every tree position, so a Meshy tree can take over */
function tree(x, z, list = TREES) {
  if (z < Z(60) && GATEX.some(g => Math.abs(x - g) < 9)) return;
  const h = 5.5 + rnd() * 3.5, r = 2.5 + rnd() * 1.5, g = 0.82 + rnd() * 0.22, lean = (rnd() - .5) * 0.06;
  list.push([x, z, h + r * 0.9]);
  cyl(XF(x, 0, z, rnd() * 6, lean), 0.14, 0.26, h * 0.72, 6, mulc(ONE, 0.9 + rnd() * 0.2), false, B.tbark);
  for (let i = 0; i < 3; i++) { const a = rnd() * 6.2832; cyl(XF(x, h * 0.5, z, a, 0.55 + rnd() * 0.3), 0.05, 0.1, h * 0.42, 4, ONE, false, B.tbark); }
  crown(x, h, z, r, r * 0.92, 30, [g, g * (0.95 + rnd() * 0.1), g * 0.9], B.tleaf);
  crown(x + (rnd() - .5) * r, h - r * 0.35, z + (rnd() - .5) * r, r * 0.7, r * 0.6, 10, [g * 0.9, g * 0.9, g * 0.82], B.tleaf);
}
function shrub(x, z, r) { crown(x, r * 0.85, z, r, r * 0.9, 16, [1.02, 1.05, 0.95]); }
function pot(x, z) { cyl(XF(x, 0, z), 0.3, 0.2, 0.42, 8, [0.62, 0.36, 0.27], true); crown(x, 0.85, z, 0.5, 0.5, 7, [1.05, 1.1, 0.95]); }
function frond(x, y, z, az, el, len, tint) {
  const n = 6, seg = len / n, side = [-Math.sin(az), 0, Math.cos(az)], w = 0.62; let p = [x, y, z], dir = [Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el)], L0, R0, v0 = 0;
  for (let i = 0; i <= n; i++) {
    const t = i / n, L = [p[0] - side[0] * w, p[1], p[2] - side[2] * w], R = [p[0] + side[0] * w, p[1], p[2] + side[2] * w];
    if (i > 0) {
      let nn = norm3(cross(side, dir)); if (nn[1] < 0) nn = [-nn[0], -nn[1], -nn[2]]; nn = norm3([nn[0], nn[1] + 0.6, nn[2]]);
      vtx(B.pfrond, L0, nn, tint, 0, v0); vtx(B.pfrond, R0, nn, tint, 1, v0); vtx(B.pfrond, R, nn, tint, 1, t); vtx(B.pfrond, L0, nn, tint, 0, v0); vtx(B.pfrond, R, nn, tint, 1, t); vtx(B.pfrond, L, nn, tint, 0, t);
    }
    L0 = L; R0 = R; v0 = t; p = [p[0] + dir[0] * seg, p[1] + dir[1] * seg, p[2] + dir[2] * seg]; dir = norm3([dir[0], dir[1] - 0.2 - 0.1 * t, dir[2]]);
  }
}
const PALMS = [];
function palm(x, z) {
  const h = 6.5 + rnd() * 3.5, n = 26, pc = [0.86, 0.8, 0.72];
  PALMS.push([x, z, h + 2.5]);
  cyl(XF(x, 0, z, rnd() * 6, (rnd() - .5) * 0.05), 0.24, 0.34, h, 8, pc, false, B.pbark);
  cyl(XF(x, h - 0.9, z), 0.42, 0.26, 1.0, 8, mulc(pc, 0.8), false, B.pbark);
  for (let j = 0; j < n; j++) {
    const el = 1.3 - 1.75 * (j / (n - 1)) + (rnd() - .5) * 0.2; let k = 0.8 + rnd() * 0.35; if (el < -0.2) k *= 0.8;
    frond(x, h, z, j * 2.4 + rnd() * 0.5, el, 3.4 + rnd() * 1.2, [k, k, k * 0.95]);
  }
}

const boxes = [], circles = [];
/* paving laid over the roof prints in the aerial photo, so the ground reads correctly under the eaves */
function apron(x0, z0, x1, z1, col, y) { y = y || 0.03; quad(B.apron, [X(x0), y, Z(z1)], [X(x1), y, Z(z1)], [X(x1), y, Z(z0)], [X(x0), y, Z(z0)], col || PAVE, [0, -9, 0]); }
function bld(x0, z0, x1, z1, o = {}) {
  const w = (x1 - x0) * S, d = (z1 - z0) * S, cx = X((x0 + x1) / 2), cz = Z((z0 + z1) / 2), wall = o.wall || 4, rh = o.roof == null ? 2.6 : o.roof, ov = o.over == null ? 0.7 : o.over;
  box(XF(cx, 0, cz), w, wall, d, o.wc || ONE, { b: o.wb || B.stone });
  if (rh > 0) hip(XF(cx, wall, cz), w + ov * 2, d + ov * 2, rh, o.rc || ONE, o.rb);
  boxes.push([cx - w / 2, cz - d / 2, cx + w / 2, cz + d / 2]);
}
function shed(x0, z0, x1, z1, h) { bld(x0, z0, x1, z1, { wall: h || 4.5, roof: 1.4, wb: B.metal, rb: B.metal, rc: mulc(ONE, 0.92), over: 0.2 }); }
/* a stable barn: the aerial outline is the roof edge, so the walls sit in from it under a wide eave */
function barn(x0, z0, x1, z1, tag) {
  const OV = 2.4, wt = (x1 - x0) * S, dt = (z1 - z0) * S, w = wt - 2 * OV, d = dt - 2 * OV, cx = X((x0 + x1) / 2), cz = Z((z0 + z1) / 2), wall = 4.2, rh = 2.6, base = wall - OV * rh / (dt / 2);
  apron(x0 - 10, z0 - 10, x1 + 10, z1 + 10);
  const nb = Math.max(1, Math.round(w / 4)), bw = w / nb;
  /* walls and the inside come later (buildInterior); the roof goes in its own set so it can be lifted off */
  REDIR = 'roof' + tag;
  hip(XF(cx, base, cz), wt, dt, rh, ONE, null, OV);
  const cd = dt * 0.40, cw = wt - dt * 0.78, by = base + rh * (1 - cd / dt);
  box(XF(cx, by - 0.3, cz), cw, 1.4, cd, [0.40, 0.35, 0.30]);
  hip(XF(cx, by + 1.1, cz), cw + 1.8, cd + 1.8, 1.4, mulc(ONE, 0.95));
  REDIR = null;
  /* the eave is cantilevered: no posts along the long sides (Rashed: the real barns have none) */
  return { cx, cz, w, d, bw, nb, wall };
}
function bayX(info, pxAerial) { const lx = X(pxAerial) - info.cx, k = Math.min(info.nb - 1, Math.max(0, Math.round((lx + info.w / 2) / info.bw - 0.5))); return info.cx - info.w / 2 + (k + 0.5) * info.bw; }
function bayPanel(info, side, x, batch) {
  const zf = info.cz + side * (info.d / 2 + 0.04), h = info.wall, hw = info.bw / 2, L = [x - hw, 0, zf], R = [x + hw, 0, zf], ctr = [x, 2, info.cz];
  if (side > 0) quad(batch, L, R, [R[0], h, zf], [L[0], h, zf], ONE, ctr, 1); else quad(batch, R, L, [L[0], h, zf], [R[0], h, zf], ONE, ctr, 1);
  return zf;
}
function porch(info, side, pxAerial, batch) {
  const x = bayX(info, pxAerial), zf = bayPanel(info, side, x, batch), wall = info.wall, ye = wall + 0.25, yr = wall + 2.1, zin = zf - side * 4.5, zout = zf + side * 3.4, ctr = [x, 0, zf];
  tri(B.stone, [x - 3.4, wall, zf], [x + 3.4, wall, zf], [x, wall + 1.85, zf], ONE, null, null, null, [x, 2, info.cz]);
  const zr = zf + side * 0.05, a = [x - 0.55, wall + 0.2, zr], b = [x + 0.55, wall + 0.2, zr];
  if (side > 0) quad(B.round, a, b, [b[0], wall + 1.3, zr], [a[0], wall + 1.3, zr], ONE, [x, 2, info.cz], 1); else quad(B.round, b, a, [a[0], wall + 1.3, zr], [b[0], wall + 1.3, zr], ONE, [x, 2, info.cz], 1);
  quad(B.roof, [x - 3.9, ye, zin], [x - 3.9, ye, zout], [x, yr, zout], [x, yr, zin], ONE, ctr);
  quad(B.roof, [x + 3.9, ye, zout], [x + 3.9, ye, zin], [x, yr, zin], [x, yr, zout], ONE, ctr);
  return x;
}
function pots(info, side, skipX) {
  for (let i = 0; i <= info.nb; i++) { const x = info.cx - info.w / 2 + i * info.bw; if (skipX != null && Math.abs(x - skipX) < 3) continue; pot(x, info.cz + side * (info.d / 2 + 0.75)); }
}
function endDoor(info, end, zw, batch) {
  const x = info.cx + end * (info.w / 2 + 0.04), a = [x, 0, zw - 0.8], b = [x, 0, zw + 0.8], ctr = [info.cx, 1, zw];
  if (end < 0) quad(batch, a, b, [x, 2.6, zw + 0.8], [x, 2.6, zw - 0.8], ONE, ctr, 1); else quad(batch, b, a, [x, 2.6, zw - 0.8], [x, 2.6, zw + 0.8], ONE, ctr, 1);
}

/* ---------- barns A, B and C ---------- */
const barnA = barn(329, 89, 793, 225, 'A'), barnB = barn(324, 777, 771, 921, 'B'), barnC = barn(1453, 690, 2013, 900, 'C');
const doorAx = porch(barnA, 1, 597, B.doorA), doorBx = porch(barnB, -1, 596, B.doorB);
pots(barnA, 1, doorAx); pots(barnB, -1, doorBx);
const doorCx = porch(barnC, -1, 1745, B.doorCC); pots(barnC, -1, doorCx);
const wcWz = Z(225) - 2.4 - 1.5, wcMz = Z(777) + 2.4 + 1.5;
endDoor(barnA, -1, wcWz, B.wc); endDoor(barnB, -1, wcMz, B.wc);
const cafeX = barnB.cx - barnB.w / 2 + 1.5 * barnB.bw; bayPanel(barnB, -1, cafeX, B.cafe);
(function () { /* chairs and a table at the cafeteria window */
  const z = barnB.cz - barnB.d / 2 - 1.0; box(XF(cafeX - 2.2, 0, z), 1.2, 0.75, 0.6, [0.2, 0.19, 0.18]);
  for (let i = 0; i < 3; i++) { const x = cafeX + 0.6 + i * 0.75; box(XF(x, 0, z), 0.5, 0.42, 0.5, WHITE); box(XF(x, 0.42, z + 0.22), 0.5, 0.42, 0.06, WHITE); }
})();

/* ---------- horse walkers ---------- */
function walkerAt(px, pz, pr) {
  const x = X(px), z = Z(pz), R = pr * S, ri = R * 0.52, n = 6, GREY = [0.62, 0.64, 0.66];
  apron(px - pr - 8, pz - pr - 8, px + pr + 8, pz + pr + 8, [0.86, 0.80, 0.66]);
  cyl(XF(x, 0, z), 0.09, 0.12, 3.5, 8, GREY, true);
  for (let i = 0; i < n; i++) {
    const a = i / n * 6.2832 + 0.3, ca = Math.cos(a), sa = Math.sin(a);
    box(XF(x, 2.55, z, -a), R * 0.93, 0.07, 0.07, GREY, { off: [R * 0.93 / 2, 0, 0] });
    box(XF(x, 2.55, z, -a, 0.33), R * 0.5, 0.05, 0.05, GREY, { off: [R * 0.25, 0, 0] });
    box(XF(x + ca * R * 0.93, 0, z + sa * R * 0.93), 0.08, 2.6, 0.08, GREY);
    if (i % 2 === 0) {
      const pl = R * 0.93 - ri, pm = ri + pl / 2; [0.45, 1.25, 2.0].forEach(y => box(XF(x, y, z, -a), pl, 0.05, 0.05, GREY, { off: [pm, 0, 0] }));
      [ri, ri + pl / 2].forEach(r => box(XF(x + ca * r, 0.45, z + sa * r), 0.05, 1.6, 0.05, GREY));
    }
  }
  for (let i = 0; i < 16; i++) {
    const a0 = i / 16 * 6.2832, a1 = (i + 1) / 16 * 6.2832, mx = x + (Math.cos(a0) + Math.cos(a1)) * ri / 2, mz = z + (Math.sin(a0) + Math.sin(a1)) * ri / 2, ang = Math.atan2(Math.sin(a1) - Math.sin(a0), Math.cos(a1) - Math.cos(a0));
    [0.5, 1.0, 1.5].forEach(y => box(XF(mx, y, mz, -ang), ri * 0.4, 0.05, 0.05, GREY)); box(XF(x + Math.cos(a0) * ri, 0, z + Math.sin(a0) * ri), 0.06, 1.55, 0.06, GREY);
  }
  circles.push([x, z, R + 0.2]);
}
walkerAt(265, 849, 43); walkerAt(2257, 652, 60);

/* ---------- Barn B east end: doors, wash bay, tack room and the outdoor boxes ---------- */
function endQuad(info, end, zpx, wd, y0, y1, b, col, rep, off) {
  const x = info.cx + end * (info.w / 2 + (off || 0.04)), zc = Z(zpx), a = [x, y0, zc - wd / 2], c = [x, y0, zc + wd / 2], ctr = [info.cx, 1, zc];
  if (end < 0) quad(b, a, c, [x, y1, zc + wd / 2], [x, y1, zc - wd / 2], col, ctr, rep); else quad(b, c, a, [x, y1, zc - wd / 2], [x, y1, zc + wd / 2], col, ctr, rep);
}
(function () {
  const I = barnB, BRN = [0.36, 0.22, 0.20];
  apron(770, 884, 932, 928);
  endQuad(I, 1, 799, 2.2, 1.15, 2.45, B.col, [0.93, 0.90, 0.80], 0, 0.05); endQuad(I, 1, 799, 2.0, 1.25, 2.35, B.col, [0.33, 0.47, 0.60], 0, 0.07);
  endQuad(I, 1, 816, 4.0, 0, I.wall, B.doorC, ONE, 1);
  endQuad(I, 1, 832, 1.5, 0, 3.0, B.col, [0.90, 0.90, 0.88], 0, 0.06);
  endQuad(I, 1, 851, 3.4, 0, 3.3, B.col, [0.06, 0.06, 0.07], 0, 0.05); endQuad(I, 1, 851, 3.4, 3.3, 3.9, B.col, [0.55, 0.58, 0.60], 0, 0.05);
  endQuad(I, 1, 877, 3.6, 0, 2.9, B.col, [1.0, 0.86, 0.56], 0, 0.05); endQuad(I, 1, 877, 3.6, 0, 1.0, B.col, [0.10, 0.10, 0.11], 0, 0.07);
  const tx0 = 768, tx1 = 800, tz0 = 891, tz1 = 925, th = 6.2, tcx = X((tx0 + tx1) / 2), tcz = Z((tz0 + tz1) / 2), zn = Z(tz0) - 0.04, dx = X(786), ctr = [tcx, 2, tcz];
  box(XF(tcx, 0, tcz), (tx1 - tx0) * S, th, (tz1 - tz0) * S, ONE, { b: B.stone });
  quad(B.recback, [dx + 1.5, 0, zn], [dx - 1.5, 0, zn], [dx - 1.5, 3, zn], [dx + 1.5, 3, zn], ONE, ctr, 1);
  quad(B.col, [dx + 1.9, 4.1, zn], [dx - 1.9, 4.1, zn], [dx - 1.9, 5.2, zn], [dx + 1.9, 5.2, zn], [0.40, 0.48, 0.55], ctr);
  const xe = X(tx1) + 0.04; quad(B.col, [xe, 4.1, tcz - 1.6], [xe, 4.1, tcz + 1.6], [xe, 5.2, tcz + 1.6], [xe, 5.2, tcz - 1.6], [0.40, 0.48, 0.55], ctr);
  boxes.push([X(tx0), Z(tz0), X(tx1), Z(tz1)]);
  const ox0 = 800, ox1 = 915, len = (ox1 - ox0) * S, ocx = X((ox0 + ox1) / 2), zf = Z(906), zb = Z(925), zr = Z(895), n = Math.max(1, Math.round(len / 3.6)), bl = len / n;
  box(XF(ocx, 0, (Z(919) + zb) / 2), len, 3.4, zb - Z(919), ONE, { b: B.stone });
  box(XF(X(ox1) - 0.15, 0, (zf + zb) / 2), 0.3, 3.4, zb - zf, ONE, { b: B.stone });
  box(XF(ocx, 3.4, (zr + zb) / 2), len + 0.4, 0.45, zb - zr + 0.3, [0.80, 0.76, 0.66], { top: FLAT });
  for (let i = 0; i <= n; i++) {
    const bx = X(ox0) + i * bl; if (i > 0) box(XF(Math.min(bx, X(ox1) - 0.2), 0, zr + 0.2), 0.38, 3.4, 0.38, WHITE); if (i < n) {
      box(XF(bx + bl / 2, 0, zf), bl - 0.1, 1.45, 0.07, BRN); box(XF(bx + bl / 2, 1.45, zf), bl - 0.1, 0.55, 0.04, mulc(BRN, 0.55));
      box(XF(bx + bl, 0, (zf + Z(919)) / 2), 0.07, 1.9, Z(919) - zf, BRN);
    }
  }
  boxes.push([X(ox0), zf - 0.1, X(ox1), zb]);
})();

const R = (a, b) => { const o = []; for (let i = a; a <= b ? i <= b : i >= b; i += a <= b ? 1 : -1) o.push(i); return o; };
const INB = {
  A: { info: barnA, total: 15.5, depth: 6.8, aisles: [{ z: 0 }],
    rows: [{ z: -5.2, aisles: [0], ids: [13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1] }, { z: 5.2, aisles: [0], ids: [14, 15, 16, 17, 18, 19, 0, 20, 21, 22, 23, 24, 25] }] },
  B: { info: barnB, total: 17.5, depth: 3.7, aisles: [{ z: -3.7 }, { z: 3.7 }],
    rows: [{ z: -7.4, aisles: [0], ids: [12, 11, 10, 9, 8, 7, 0, 6, 5, 4, 3, 2, 1] }, { z: 0, aisles: [0, 1], ids: R(13, 25) }, { z: 7.4, aisles: [1], ids: R(42, 26) }] },
  C: { info: barnC, total: 24.5, depth: 4.6, aisles: [{ z: -7.3 }, { z: 7.3 }],
    rows: [{ z: -12.15, aisles: [0], ids: [...R(20, 11), 0, 0, 0, 0, ...R(10, 1)] },
      { z: -2.5, aisles: [0], ids: [...R(21, 28), 0, 0, 0, 0, 84, 0, 0, 0, ...R(29, 36)] },
      { z: 0, aisles: [0, 1], ids: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 83], draw: false },
      { z: 2.5, aisles: [1], ids: [...R(52, 45), 0, 0, 0, 0, 82, 0, 0, 0, ...R(44, 37)] },
      { z: 12.15, aisles: [1], ids: [...R(53, 62), 0, 0, 0, 0, ...R(63, 72)] }] }
};

/* ---------- inside Barns A, B and C, from the barn map and the photo of Barn C's aisle ----------
   Hollow stone walls with openings at the aisle ends and the side door, interlock pavers in the aisles,
   box fronts of galvanised bars between rounded sandstone pillars, and a number plate on each box.
   The maroon ceiling, beams and duct belong to the roof set, so the inside shows from above when it is lifted. */
const PLATES = [];
function plate(key, x, z, s) {
  let i = PLATES.indexOf(key); if (i < 0) { i = PLATES.length; PLATES.push(key); }
  const c = i % 16, r = Math.floor(i / 16), u0 = c / 16, u1 = (c + 1) / 16, v1 = 1 - r / 12, v0 = 1 - (r + 1) / 12, hw = 0.19, y0 = 1.5, y1 = 1.69, ctr = [x, y0, z - s];
  if (s > 0) quadUV(B.blabel, [x - hw, y0, z], [x + hw, y0, z], [x + hw, y1, z], [x - hw, y1, z], ONE, ctr, u0, v0, u1, v1);
  else quadUV(B.blabel, [x + hw, y0, z], [x - hw, y0, z], [x - hw, y1, z], [x + hw, y1, z], ONE, ctr, u0, v0, u1, v1);
}
function buildInterior(b, sideDoors) {
  const I = INB[b], info = I.info, cx = info.cx, cz = info.cz, w = info.w, d = info.d, wall = info.wall, t = 0.3, xW = cx - w / 2, xE = cx + w / 2, zN = cz - d / 2, zS = cz + d / 2, L = w / I.total;
  const GALV = [0.64, 0.66, 0.67], SHAV = [0.78, 0.67, 0.48], AISLES = I.aisles.map(a => cz + a.z);
  /* facade: the photo texture of the bays, on the outside face only */
  quad(B.bay, [xW, 0, zS + 0.012], [xE, 0, zS + 0.012], [xE, wall, zS + 0.012], [xW, wall, zS + 0.012], ONE, [cx, 2, cz], info.nb);
  quad(B.bay, [xE, 0, zN - 0.012], [xW, 0, zN - 0.012], [xW, wall, zN - 0.012], [xE, wall, zN - 0.012], ONE, [cx, 2, cz], info.nb);
  const slabX = (xa, xb, z) => { if (xb - xa < 0.2) return; box(XF((xa + xb) / 2, 0, z), xb - xa, wall, t, ONE, { b: B.stone }); boxes.push([xa, z - t / 2, xb, z + t / 2]); };
  const slabZ = (za, zb, x) => { if (zb - za < 0.2) return; box(XF(x, 0, (za + zb) / 2), t, wall, zb - za, ONE, { b: B.stone }); boxes.push([x - t / 2, za, x + t / 2, zb]); };
  [[zN + t / 2, -1], [zS - t / 2, 1]].forEach(([z, side]) => { let xa = xW; sideDoors.filter(q => q.side === side).map(q => q.x).sort((p, q) => p - q).forEach(g => { slabX(xa, g - 1.3, z); xa = g + 1.3; }); slabX(xa, xE, z); });
  [xW + t / 2, xE - t / 2].forEach(x => { let za = zN; AISLES.forEach(az => { slabZ(za, az - 1.6, x); za = az + 1.6; }); slabZ(za, zS, x); });
  /* ceiling, beams and the AC duct over each aisle: lifted off with the roof */
  REDIR = 'roof' + b;
  quad(B.ceil, [xW, wall - 0.1, zN], [xE, wall - 0.1, zN], [xE, wall - 0.1, zS], [xW, wall - 0.1, zS], [0.66, 0.34, 0.36], [cx, wall + 9, cz]);
  for (let x = xW + 3; x < xE - 1; x += 6) box(XF(x, wall - 0.65, cz), 0.25, 0.5, d - 0.4, [0.72, 0.3, 0.32], { b: B.ceil });
  AISLES.forEach(az => box(XF(cx, wall - 0.75, az), w - 2, 0.45, 0.7, [0.86, 0.86, 0.84]));
  REDIR = null;
  AISLES.forEach(az => quad(B.apron, [xW, 0.05, az + 1.7], [xE, 0.05, az + 1.7], [xE, 0.05, az - 1.7], [xW, 0.05, az - 1.7], PAVE, [0, -9, 0]));
  I.rows.forEach(row => {
    if (row.draw === false) return;
    const z0 = cz + row.z - I.depth / 2, z1 = cz + row.z + I.depth / 2, n = row.ids.length, xr0 = xE - 0.25 * L, xl0 = xr0 - n * L;
    const fronts = row.aisles.map(ai => cz + I.aisles[ai].z > cz + row.z ? { z: z1, s: 1 } : { z: z0, s: -1 });
    boxes.push([xl0, z0, xr0, z1]);
    /* a row with one open side and the other not against the barn wall gets a back wall (Barn C's middle block) */
    [[z0, -1], [z1, 1]].forEach(([z, s]) => { if (!fronts.some(f => f.s === s) && Math.abs(z - zN) > 0.6 && Math.abs(z - zS) > 0.6) box(XF((xl0 + xr0) / 2, 0, z), xr0 - xl0, 2.8, 0.18, ONE, { b: B.stone }); });
    row.ids.forEach((num, i) => {
      const xr = xr0 - i * L, xl = xr - L, xm = (xl + xr) / 2;
      box(XF(xr, 0, (z0 + z1) / 2), 0.16, 2.7, z1 - z0, ONE, { b: B.stone }); if (i === n - 1) box(XF(xl, 0, (z0 + z1) / 2), 0.16, 2.7, z1 - z0, ONE, { b: B.stone });
      if (num) quad(B.col, [xl, 0.045, z1], [xr, 0.045, z1], [xr, 0.045, z0], [xl, 0.045, z0], SHAV, [xm, -5, (z0 + z1) / 2]);
      fronts.forEach(f => {
        if (!num) { box(XF(xm, 0, f.z), L, 2.8, 0.2, ONE, { b: B.stone }); return; }
        const nb = Math.max(6, Math.round((L - 0.5) / 0.16));
        for (let k = 0; k <= nb; k++) box(XF(xl + 0.25 + k * (L - 0.5) / nb, 0.1, f.z), 0.035, 2.45, 0.035, GALV);
        [0.12, 1.24, 1.36, 2.55].forEach(y => box(XF(xm, y, f.z), L - 0.4, 0.05, 0.06, GALV));
        [xl, xr].forEach(x => box(XF(x, 0, f.z), 0.42, 2.8, 0.42, ONE, { b: B.stone }));
        plate(b + '-' + num, xr - 0.48, f.z + f.s * 0.05, f.s);
      });
    });
  });
}
buildInterior('A', [{ side: 1, x: doorAx }]); buildInterior('B', [{ side: -1, x: doorBx }]); buildInterior('C', [{ side: -1, x: doorCx }]);

/* ---------- main entrance: Reception in the middle, a vehicle gate and a tower each side ---------- */
(function () {
  const zc = Z(495), xF = X(189), xB = X(236), cw = 11.58, hC = 4.28, dep = xB - xF, cxm = (xF + xB) / 2, ctr = [cxm, 2, zc];
  apron(186, 398, 304, 592);
  box(XF(cxm, 0, zc), dep, hC, cw, ONE, { b: B.stone, side: { b: B.gateC, only: '-x', rx: 1 } });
  quad(B.roof, [xF - 0.3, hC - 0.08, zc + cw / 2], [xF - 0.3, hC - 0.08, zc - cw / 2], [xF + 1.1, hC + 0.68, zc - cw / 2], [xF + 1.1, hC + 0.68, zc + cw / 2], ONE, [xF, 0, zc]);
  quad(B.stone, [xF + 1.1, hC, zc - cw / 2], [xF + 1.1, hC, zc + cw / 2], [xF + 1.1, hC + 0.68, zc + cw / 2], [xF + 1.1, hC + 0.68, zc - cw / 2], ONE, [xF, hC, zc]);
  quad(B.recback, [xB + 0.04, 0, zc + 1.5], [xB + 0.04, 0, zc - 1.5], [xB + 0.04, 3, zc - 1.5], [xB + 0.04, 3, zc + 1.5], ONE, ctr, 1);
  const ix0 = xF + 0.25, ix1 = xB - 0.25;
  box(XF((ix0 + ix1) / 2, 0.02, zc), ix1 - ix0, 3.1, cw - 0.5, [0.95, 0.92, 0.85], { top: [1, 1, 0.98] });
  apron(189.5, 460, 235.5, 530, [0.9, 0.85, 0.76], 0.04);
  box(XF(X(213), 0.04, zc + 2.6), 3.6, 1.1, 0.5, [0.9, 0.84, 0.70]);
  [[ix0 + 0.02, 1], [ix1 - 0.02, -1]].forEach(d => quad(B.col, [d[0], 0.04, zc - 0.75], [d[0], 0.04, zc + 0.75], [d[0], 2.35, zc + 0.75], [d[0], 2.35, zc - 0.75], [0.45, 0.24, 0.14], [d[0] - d[1], 1, zc]));
  boxes.push([xF, zc - cw / 2, xB, zc - 1.4], [xF, zc + 1.4, xB, zc + cw / 2]);
  [-1, 1].forEach(sg => {
    const z0 = zc + sg * cw / 2, z1 = zc + sg * (Z(574.5) - zc - 2.45), zm = (z0 + z1) / 2, x = xF - 0.25;
    box(XF(xF + 0.3, 0, zm), 1.0, 5.87, Z(574.5) - zc - 2.45 - cw / 2, ONE, { b: B.stone });
    quad(B.gateS, [x, 0, z1], [x, 0, z0], [x, 5.87, z0], [x, 5.87, z1], ONE, [xF + 2, 2, zm], 1);
    boxes.push([xF - 0.2, Math.min(z0, z1), xF + 0.8, Math.max(z0, z1)]);
  });
  [[415.5, B.towerL], [574.5, B.towerR]].forEach(t => {
    const tx = X(207), tz = Z(t[0]), s = 4.9, h = 8.2;
    box(XF(tx, 0, tz), s, h, s, ONE, { b: B.stone, side: { b: t[1], only: '-x', rx: 1 } }); hip(XF(tx, h, tz), s + 2.2, s + 2.2, 2.5, ONE); boxes.push([tx - s / 2, tz - s / 2, tx + s / 2, tz + s / 2]);
  });
  function wall(x0, z0, x1, z1) { box(XF(X((x0 + x1) / 2), 0, Z((z0 + z1) / 2)), Math.max(0.5, Math.abs(x1 - x0) * S), 2.4, Math.max(0.5, Math.abs(z1 - z0) * S), ONE, { b: B.stone }); }
  wall(183, 203, 183, 400); wall(183, 590, 183, 979); wall(254, 4, 814, 4); wall(848, 4, 1582, 4); wall(1618, 4, 2387, 4); wall(2423, 4, 2792, 4); /* gaps: the two back gates */ wall(183, 975, 2792, 975); wall(2792, 4, 2792, 975);
  [[Z(400), -1], [Z(590), 1]].forEach(e => {
    const z0 = e[0], z1 = e[0] + e[1] * 7, xa = X(183) - 0.25, xb = X(183) + 0.25, zm = (z0 + z1) / 2;
    tri(B.stone, [xa, 2.4, z0], [xa, 2.4, z1], [xa, 4.6, z0], ONE, null, null, null, [xb + 5, 3, zm]); tri(B.stone, [xb, 2.4, z0], [xb, 2.4, z1], [xb, 4.6, z0], ONE, null, null, null, [xa - 5, 3, zm]);
    quad(B.col, [xa, 4.6, z0], [xb, 4.6, z0], [xb, 2.4, z1], [xa, 2.4, z1], FLAT, [X(183), 0, zm]);
  });
  [[172, 388, 1.3], [168, 372, 1.0], [172, 602, 1.3], [168, 618, 1.0]].forEach(s => shrub(X(s[0]), Z(s[1]), s[2]));
})();

/* ---------- Tack shop and Administration ---------- */
(function () {
  const x0 = 186, x1 = 252, z0 = 0, z1 = 164, h = 5.6, cx = X((x0 + x1) / 2), cz = Z((z0 + z1) / 2), w = (x1 - x0) * S, d = (z1 - z0) * S, ctr = [cx, 2, cz];
  box(XF(cx, 0, cz), w, h, d, ONE, { b: B.stone });
  const xe = X(x1) + 0.04, xw = X(x0) - 0.04;
  quad(B.storeE, [xe, 0, Z(164)], [xe, 0, Z(64)], [xe, h, Z(64)], [xe, h, Z(164)], ONE, ctr, 1);
  quad(B.storeW, [xw, 0, Z(114)], [xw, 0, Z(164)], [xw, h, Z(164)], [xw, h, Z(114)], ONE, ctr, 1);
  boxes.push([X(x0), Z(z0), X(x1), Z(z1)]);
  const ah = 3.8, acx = X(277), acz = Z(32), zs = Z(64) + 0.04;
  box(XF(acx, 0, acz), 50 * S, ah, 64 * S, ONE, { b: B.stone });
  quad(B.admin, [X(252), 0, zs], [X(302), 0, zs], [X(302), ah, zs], [X(252), ah, zs], ONE, [acx, 2, acz], 1);
  boxes.push([X(252), Z(0), X(302), Z(64)]);
  (function () {
    const gx = X(186), za = Z(172), zb = Z(198), n = 10, hC = (zb - za) * 0.8, hE = hC * 0.87, ctr = [gx + 5, 1, (za + zb) / 2];
    const hh = t => hE + (hC - hE) * (1 - (2 * t - 1) * (2 * t - 1));
    for (let i = 0; i < n; i++) {
      const t0 = i / n, t1 = (i + 1) / n, z0 = za + (zb - za) * t0, z1 = za + (zb - za) * t1, h0 = hh(t0), h1 = hh(t1);
      tri(B.gateL, [gx, 0, z0], [gx, 0, z1], [gx, h1, z1], ONE, [t0, 0], [t1, 0], [t1, h1 / hC], ctr); tri(B.gateL, [gx, 0, z0], [gx, h1, z1], [gx, h0, z0], ONE, [t0, 0], [t1, h1 / hC], [t0, h0 / hC], ctr);
    }
    box(XF(X(186), 0, (Z(164) + za) / 2), 1.0, hE + 0.5, za - Z(164), ONE, { b: B.stone });
    box(XF(X(186), 0, (zb + Z(203)) / 2), 1.0, hE + 0.5, Z(203) - zb, ONE, { b: B.stone });
    boxes.push([X(183), Z(164), X(189), Z(203)]);
  })();
  pot(X(256), Z(150)); pot(X(256), Z(100)); pot(X(262), Z(70));
})();

/* ---------- garden pavilion: enclosed octagon on a round platform ---------- */
let PAV = {};
(function () {
  const x = X(455), z = Z(500), R = 5.0, ph = 0.6, wh = 3.3, ro = 7.6, rr = R / Math.cos(Math.PI / 8), ry = ro / Math.cos(Math.PI / 8), ye = ph + wh - 0.1, apex = [x, ph + wh + 2.3, z];
  cyl(XF(x, 0, z), 7.0, 7.2, ph, 28, BEIGE, true);
  box(XF(x - 7.7, 0, z), 1.0, 0.4, 4.4, BEIGE); box(XF(x - 8.6, 0, z), 1.0, 0.2, 4.8, BEIGE);
  for (let i = 0; i < 8; i++) {
    const a0 = (i - 0.5) / 8 * 6.2832, a1 = (i + 0.5) / 8 * 6.2832;
    const p = [x + Math.cos(a0) * rr, ph, z + Math.sin(a0) * rr], q = [x + Math.cos(a1) * rr, ph, z + Math.sin(a1) * rr];
    quad(B.pav, p, q, [q[0], ph + wh, q[2]], [p[0], ph + wh, p[2]], ONE, [x, ph + 1, z], 1);
    const e0 = [x + Math.cos(a0) * ry, ye, z + Math.sin(a0) * ry], e1 = [x + Math.cos(a1) * ry, ye, z + Math.sin(a1) * ry];
    tri(B.roof, e0, e1, apex, ONE, null, null, null, [x, 0, z]);
    tri(B.col, e0, e1, [x, ye - 0.02, z], [0.33, 0.20, 0.12], null, null, null, [x, 20, z]);
  }
  circles.push([x, z, R + 0.5]); PAV = { x, z, r: 7.0, h: ph };
  [[345, 488], [345, 512], [375, 488], [375, 512]].forEach(p => cyl(XF(X(p[0]), 0, Z(p[1])), 0.11, 0.11, 0.75, 8, WHITE, true));
})();

/* ---------- Barn D: arched canopy over two rows of eight boxes ---------- */
const DBOX = {};
(function () {
  const x0 = 221, x1 = 289, z0 = 600, z1 = 757, cx = X(255), w = (x1 - x0) * S, len = (z1 - z0) * S, zs = Z(z0), eave = 3.2, rise = 1.5, n = 12, bl = len / 8, depth = 3.5, hx = w / 2;
  apron(x0 - 8, z0 - 45, x1 + 8, z1 + 12, [0.80, 0.66, 0.60]);
  apron(x0 + 21, z0, x1 - 21, z1, [0.88, 0.87, 0.84], 0.036); /* grey concrete aisle between the two rows of boxes */
  for (let i = 0; i < n; i++) {
    const a0 = i / n * Math.PI, a1 = (i + 1) / n * Math.PI, xa = cx - Math.cos(a0) * hx * 1.05, ya = eave + Math.sin(a0) * rise, xb = cx - Math.cos(a1) * hx * 1.05, yb = eave + Math.sin(a1) * rise;
    quad(B.droof, [xa, ya, zs + len + 0.6], [xb, yb, zs + len + 0.6], [xb, yb, zs - 0.6], [xa, ya, zs - 0.6], [0.92, 0.86, 0.72], [cx, 0, zs + len / 2]);
  }
  for (let k = 0; k <= 8; k++) [-1, 1].forEach(sx => box(XF(cx + sx * hx, 0, zs + k * bl), 0.1, eave, 0.1, POLE));
  for (let k = 0; k < 8; k++) [-1, 1].forEach(sx => {
    const num = sx > 0 ? 8 - k : 9 + k, zc = zs + (k + 0.5) * bl, xf = cx + sx * (hx - depth), xbk = cx + sx * hx, za = zc - bl / 2, zb = zc + bl / 2, ctr = [xbk, 1, zc];
    if (sx < 0) quad(B.dbox, [xf, 0, zb], [xf, 0, za], [xf, 2.3, za], [xf, 2.3, zb], ONE, ctr, 1); else quad(B.dbox, [xf, 0, za], [xf, 0, zb], [xf, 2.3, zb], [xf, 2.3, za], ONE, ctr, 1);
    box(XF(cx + sx * (hx - depth / 2), 0, za), depth, 1.6, 0.06, DARK); if (k === 7) box(XF(cx + sx * (hx - depth / 2), 0, zb), depth, 1.6, 0.06, DARK);
    box(XF(xbk, 0, zc), 0.06, 2.0, bl, DARK);
    const c = (num - 1) % 4, r = Math.floor((num - 1) / 4), u0 = c / 4, u1 = (c + 1) / 4, v1 = 1 - r / 4, v0 = 1 - (r + 1) / 4, xl = xf - sx * 0.03, zl = sx < 0 ? zb - 0.42 * bl : za + 0.42 * bl, hw = 0.24;
    if (sx < 0) quadUV(B.dlabel, [xl, 1.0, zl + hw], [xl, 1.0, zl - hw], [xl, 1.24, zl - hw], [xl, 1.24, zl + hw], ONE, ctr, u0, v0, u1, v1);
    else quadUV(B.dlabel, [xl, 1.0, zl - hw], [xl, 1.0, zl + hw], [xl, 1.24, zl + hw], [xl, 1.24, zl - hw], ONE, ctr, u0, v0, u1, v1);
    DBOX[num] = { k, sx, x: (xf + xbk) / 2, z: zc, rect: [Math.min(xf, xbk), za, Math.max(xf, xbk), zb] };
  });
  boxes.push([cx - hx, zs, cx - hx + depth, zs + len], [cx + hx - depth, zs, cx + hx, zs + len]);
})();

/* ---------- Glass room and stands, judges' tower, main arena gate ---------- */
const edgeA = Math.atan2(Z(47) - Z(385), X(1200) - X(840)), ROT = -edgeA;
let CLUBP = {};
(function () {
  const ax = X(885), az = Z(343), bx = X(1150), bz = Z(94), mx = (ax + bx) / 2, mz = (az + bz) / 2, len = Math.hypot(bx - ax, bz - az), PH = 2.4, BRW = [0.36, 0.24, 0.20], f = XF(mx, 0, mz, ROT);
  for (let i = 0; i < 6; i++) box(f, len * 0.86, 0.4 * (i + 1), 0.75, ONE, { b: B.stone, top: BEIGE, off: [0, 0, -(2.2 + i * 0.75 + 0.375)] });
  box(f, len * 0.86, PH, 8.7, ONE, { b: B.stone, top: BEIGE, off: [0, 0, -11.05] });
  const gw = 64 * S, pc = f([0, 0, -10]);
  box(f, gw, 3.6, gw, [0.16, 0.32, 0.28], { off: [0, PH, -10], b: B.glass }); box(f, gw + 0.16, 0.5, gw + 0.16, BRW, { off: [0, PH, -10] }); box(f, gw + 0.16, 0.3, gw + 0.16, BRW, { off: [0, PH + 3.3, -10] });
  hip(XF(pc[0], PH + 3.6, pc[2], ROT), gw + 2.8, gw + 2.8, 2.6, ONE);
  [-1, 1].forEach(sg => {
    const ww = 80 * S, wd = 50 * S, wc = f([sg * (gw / 2 + 1.5 + ww / 2), 0, -10.9]), fw = XF(wc[0], PH, wc[2], ROT);
    for (let k = 0; k < 4; k++) box(fw, 0.9, 2.6, 0.5, ONE, { b: B.stone, off: [-ww / 2 + 0.45 + k * (ww - 0.9) / 3, 0, -wd / 2 + 0.4] });
    box(fw, ww, 0.7, 0.5, ONE, { b: B.stone, off: [0, 2.6, -wd / 2 + 0.4] });
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(c => box(fw, 0.4, 4.3, 0.4, BRW, { off: [c[0] * ww / 2, 0, c[1] * wd / 2] }));
    box(fw, ww + 1.2, 0.35, wd + 1.2, BRW, { off: [0, 3.3, 0] }); circles.push([wc[0], wc[2], 6.5]);
  });
  circles.push([pc[0], pc[2], 6]);
  const zb = -15.44, ctr = f([0, 1, -10]);
  quad(B.wc, f([0.8, 0, zb]), f([-0.8, 0, zb]), f([-0.8, 2.3, zb]), f([0.8, 2.3, zb]), ONE, ctr, 1);
  const px = 13, pz = -21, pw = 9.5, pd = 4.5, zf = pz - pd / 2 - 0.04, pctr = f([px, 1, pz]);
  box(f, pw, 3.2, pd, ONE, { b: B.stone, off: [px, 0, pz] });
  [3.9, 0.9].forEach(dx => quad(B.recback, f([px + dx + 0.6, 0, zf]), f([px + dx - 0.6, 0, zf]), f([px + dx - 0.6, 2.4, zf]), f([px + dx + 0.6, 2.4, zf]), ONE, pctr, 1));
  quad(B.glass, f([px - 0.6, 1.7, zf]), f([px - 4.0, 1.7, zf]), f([px - 4.0, 2.25, zf]), f([px - 0.6, 2.25, zf]), [0.5, 0.6, 0.65], pctr);
  const pp = f([px, 0, pz]); circles.push([pp[0], pp[2], 4.2]);
  const toPx = v => [v[0] / S + W / 2, v[2] / S + H / 2];
  CLUBP = { wc: toPx(f([0, 0, -17.2])), wcFace: toPx(f([0, 0, -15.4])), pry: toPx(f([px + 2.4, 0, pz - 4])), pryFace: toPx(pp), pav: toPx(pc) };
})();
const JT = { x: X(1268), z: Z(590) };
REDIR = 'judges';
(function () { /* judges' tower: two storeys, green glass upstairs */
  const x0 = 1238, z0 = 560, x1 = 1298, z1 = 620, cx = X((x0 + x1) / 2), cz = Z((z0 + z1) / 2), w = (x1 - x0) * S, d = (z1 - z0) * S;
  box(XF(cx, 0, cz), w, 6.4, d, ONE, { b: B.stone }); box(XF(cx, 3.5, cz), w + 0.12, 1.9, d + 0.12, [0.16, 0.40, 0.27], { b: B.glass }); box(XF(cx, 0.5, cz), w * 0.6, 2.0, d + 0.1, [0.12, 0.14, 0.15]);
  hip(XF(cx, 6.4, cz), w + 3, d + 3, 2.0, ONE); boxes.push([cx - w / 2, cz - d / 2, cx + w / 2, cz + d / 2]);
})();
REDIR = null;
(function () { /* Main arena gate tower, big screen and flagpoles */
  const cx = X(1470.5), cz = Z(293.5), w = 31 * S + 1, d = 57 * S, pw = (d - 4.2) / 2, h = 6.2;
  [-1, 1].forEach(sg => { const z = cz + sg * (2.1 + pw / 2); box(XF(cx, 0, z), w, h, pw, ONE, { b: B.stone }); boxes.push([cx - w / 2, z - pw / 2, cx + w / 2, z + pw / 2]); });
  box(XF(cx, 3.9, cz), w, h - 3.9, 4.2, ONE, { b: B.stone }); hip(XF(cx, h, cz), w + 2.2, d + 2.2, 2.2, ONE);
  const a = [X(1405), Z(110)], b = [X(1443), Z(236)], dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz), ang = Math.atan2(dz, dx); let ox = -dz / l, oz = dx / l;
  if (ox * (X(1150) - a[0]) + oz * (Z(330) - a[1]) > 0) { ox = -ox; oz = -oz; }
  const sx = a[0] + dx * 0.3 + ox * 3, sz = a[1] + dz * 0.3 + oz * 3;
  box(XF(sx, 0, sz, -ang), 9, 7.5, 0.7, [0.70, 0.72, 0.74]); box(XF(sx - ox * 0.37, 2.2, sz - oz * 0.37, -ang), 8.4, 4.8, 0.05, [0.08, 0.10, 0.12], { b: B.glass });
  for (let i = 0; i < 6; i++) { const t = 0.62 + i * 0.07; cyl(XF(a[0] + dx * t + ox * 2, 0, a[1] + dz * t + oz * 2), 0.05, 0.07, 7, 6, POLE); }
  const c = [X(1355), Z(72)]; for (let i = 0; i < 6; i++) { const t2 = 0.1 + i * 0.15; cyl(XF(c[0] + (a[0] - c[0]) * t2 + ox * 2, 0, c[1] + (a[1] - c[1]) * t2 + oz * 2), 0.05, 0.07, 7, 6, POLE); }
})();
bld(1953, 500, 1985, 545, { wall: 3.2, roof: 1.8 });
shed(229, 250, 271, 395, 3.4); shed(363, 0, 539, 49, 3.4);
(function () { /* open hay shed behind Barn A */
  const x0 = 554, x1 = 739, z0 = 20, z1 = 68, cx = X((x0 + x1) / 2), cz = Z((z0 + z1) / 2), w = (x1 - x0) * S, d = (z1 - z0) * S, RED = [0.50, 0.22, 0.20], HAY = [0.80, 0.69, 0.42];
  for (let i = 0; i <= 6; i++) [-1, 1].forEach(sg => box(XF(cx - w / 2 + i * w / 6, 0, cz + sg * (d / 2 - 0.2)), 0.22, 4.2, 0.22, RED));
  box(XF(cx, 4.2, cz), w + 0.6, 0.7, d + 0.6, RED); hip(XF(cx, 4.9, cz), w + 0.6, d + 0.6, 1.3, mulc(ONE, 0.9));
  box(XF(cx, 0, cz - d / 2 + 0.1), w, 4.2, 0.12, RED);
  for (let i = 0; i < 5; i++) box(XF(cx - w / 2 + 3 + i * 4.4, 0, cz - 0.6), 4.2, 2.2 + 0.5 * ((i * 7) % 3), d - 2.6, mulc(HAY, 0.92 + 0.05 * (i % 3)));
  boxes.push([cx - w / 2, cz - d / 2, cx + w / 2, cz + d / 2]);
})();
/* a vehicle gate in the north wall: stone posts with lamps, two iron leaves standing open */
function ironGate(pxa, pxb) {
  const zg = Z(4), xa = X(pxa), xb = X(pxb), IRON = [0.13, 0.13, 0.14], lw = (xb - xa) / 2 - 0.3, n = Math.round(lw / 0.25);
  [xa, xb].forEach(x => { box(XF(x, 0, zg), 0.6, 3.0, 0.6, ONE, { b: B.stone }); cyl(XF(x, 3.0, zg), 0.22, 0.16, 0.34, 8, [1.0, 0.95, 0.8], true, B.lamp); boxes.push([x - 0.4, zg - 0.4, x + 0.4, zg + 0.4]); });
  [[xa + 0.3, 1], [xb - 0.3, -1]].forEach(g => {
    const ry = g[1] > 0 ? -1.2 : 1.2 + Math.PI, f = XF(g[0], 0, zg + 0.2, ry);
    for (let k = 0; k <= n; k++) box(f, 0.04, 2.4, 0.04, IRON, { off: [k * lw / n, 0.1, 0] });
    [0.1, 1.3, 2.45].forEach(y => box(f, lw, 0.06, 0.05, IRON, { off: [lw / 2, y, 0] }));
  });
}
ironGate(1582, 1618); ironGate(2387, 2423);
const GATEX = [X(1600), X(2405)]; /* keep trees out of the way of these gates */
const BOOTH = { x: X(792), z: Z(24) };
(function () { /* side gate at Barn A: iron gate between two lamp posts, with the white guard booth */
  const zg = Z(4), xa = X(815), xb = X(847), IRON = [0.13, 0.13, 0.14];
  [xa, xb].forEach(x => { box(XF(x, 0, zg), 0.6, 3.0, 0.6, ONE, { b: B.stone }); cyl(XF(x, 3.0, zg), 0.22, 0.16, 0.34, 8, [1.0, 0.95, 0.8], true, B.lamp); boxes.push([x - 0.4, zg - 0.4, x + 0.4, zg + 0.4]); });
  [[xa + 0.3, 1], [xb - 0.3, -1]].forEach(g => {
    const ry = g[1] > 0 ? -1.2 : 1.2 + Math.PI, f = XF(g[0], 0, zg + 0.2, ry);
    for (let k = 0; k <= 10; k++) box(f, 0.04, 2.4, 0.04, IRON, { off: [k * 0.25, 0.1, 0] });
    [0.1, 1.3, 2.45].forEach(y => box(f, 2.5, 0.06, 0.05, IRON, { off: [1.25, y, 0] }));
  });
  const bxp = BOOTH.x, bzp = BOOTH.z; box(XF(bxp, 0, bzp), 2.5, 2.5, 1.7, WHITE, { b: B.bcol, top: WHITE }); hip(XF(bxp, 2.5, bzp), 2.7, 1.9, 0.35, [0.9, 0.9, 0.88], B.bcol);
  quad(B.bcol, [bxp - 0.8, 1.2, bzp + 0.87], [bxp + 0.8, 1.2, bzp + 0.87], [bxp + 0.8, 2.1, bzp + 0.87], [bxp - 0.8, 2.1, bzp + 0.87], [0.16, 0.2, 0.22], [bxp, 1, bzp]);
  boxes.push([bxp - 1.3, bzp - 0.9, bxp + 1.3, bzp + 0.9]);
})();

shed(2185, 58, 2255, 246, 5); shed(2256, 60, 2325, 248, 5); shed(2326, 62, 2368, 248, 5);
shed(2366, 250, 2402, 566, 3.6); shed(2378, 570, 2458, 860, 5);
shed(2580, 373, 2770, 455, 5.5); shed(2603, 460, 2770, 545, 5.5); shed(2470, 663, 2607, 725, 5); shed(2635, 663, 2760, 725, 5); shed(2465, 727, 2762, 865, 6.5);
bld(2600, 255, 2740, 345, { wall: 4.2, roof: 2.6 }); bld(2615, 100, 2712, 140, { wall: 3.4, roof: 1.2 });

/* ---------- arenas: white rail fences; the same shapes drive the ground materials ---------- */
const ARENAS = [[338, 243, 584, 361], [614, 246, 738, 489], [611, 525, 738, 754], [336, 643, 575, 750], [775, 670, 900, 754], [799, 788, 907, 886], [956, 661, 1104, 886], [1107, 661, 1246, 889], [1250, 661, 1389, 889],
  [1655, 48, 2175, 245], [1553, 290, 1950, 648], [1990, 300, 2177, 652]];
const MAINP = [[839, 389], [1200, 46], [1355, 72], [1405, 110], [1443, 236], [1450, 329], [1436, 400], [1400, 464], [1314, 543], [1193, 604], [911, 589]];
const LAWNS = [[[336, 400], [450, 400], [450, 493], [336, 493]], [[464, 400], [579, 400], [579, 493], [464, 493]], [[336, 514], [450, 514], [450, 611], [336, 611]], [[464, 514], [579, 514], [579, 611], [464, 611]],
  [[775, 400], [800, 357], [845, 390], [893, 600], [880, 643], [790, 640], [775, 560]]];
const segs = [];
function poly(p) { for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; segs.push([X(a[0]), Z(a[1]), X(b[0]), Z(b[1])]); } }
ARENAS.forEach(r => poly([[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]]));
poly(MAINP);
const WALKS = [{ x: 265, z: 849, r: 43 }, { x: 2257, z: 652, r: 60 }];
WALKS.forEach(WK => { const c = [], n = WK.r > 50 ? 28 : 20; for (let i = 0; i < n; i++) { const a = i / n * 6.2832; c.push([WK.x + Math.cos(a) * WK.r, WK.z + Math.sin(a) * WK.r]); } poly(c); });
const RING = []; for (let i = 0; i < 24; i++) { const a = i / 24 * 6.2832; RING.push([2267 + Math.cos(a) * 52, 317 + Math.sin(a) * 52]); } poly(RING);
segs.forEach(s => {
  const dx = s[2] - s[0], dz = s[3] - s[1], len = Math.hypot(dx, dz), ang = Math.atan2(dz, dx), n = Math.max(1, Math.round(len / 2.4));
  [0.45, 0.85, 1.25].forEach(y => box(XF((s[0] + s[2]) / 2, y, (s[1] + s[3]) / 2, -ang), len, 0.13, 0.05, WHITE));
  for (let i = 0; i < n; i++) box(XF(s[0] + dx * i / n, 0, s[1] + dz * i / n, -ang), 0.14, 1.46, 0.14, WHITE);
  /* rough grey stone kerb at the foot of every rail, as in the photos */
  box(XF((s[0] + s[2]) / 2, 0, (s[1] + s[3]) / 2, -ang), len + 0.3, 0.24, 0.55, mulc(ONE, 0.78), { b: B.stone });
});
/* white bollards edging the four garden lawns beside the paths */
[0, 1, 2, 3].forEach(li => {
  const p = LAWNS[li];
  for (let i = 0; i < 4; i++) {
    const a = p[i], b = p[(i + 1) % 4], len = Math.hypot(b[0] - a[0], b[1] - a[1]) * S, n = Math.max(1, Math.round(len / 9));
    for (let k = 0; k < n; k++) { const t = (k + 0.5) / n; cyl(XF(X(a[0] + (b[0] - a[0]) * t), 0, Z(a[1] + (b[1] - a[1]) * t)), 0.11, 0.12, 0.78, 8, WHITE, true); }
  }
});

/* ---------- floodlight masts ---------- */
const MASTS = [[960, 598], [1090, 602], [1185, 600], [1285, 548], [1365, 492], [1425, 410], [1437, 280], [1960, 370], [1950, 567], [1553, 560], [2184, 382], [2180, 575], [1900, 246], [2120, 246], [560, 396], [345, 396], [588, 642], [742, 640], [1010, 892], [1300, 892]];
MASTS.forEach(p => {
  const x = X(p[0]), z = Z(p[1]), ry = rnd() * 3; cyl(XF(x, 0, z), 0.14, 0.28, 18, 8, POLE); box(XF(x, 17.8, z, ry), 3.2, 0.12, 0.12, POLE);
  for (let i = -1; i <= 1; i++) box(XF(x + Math.cos(ry) * i * 1.1, 17.9, z - Math.sin(ry) * i * 1.1, ry), 0.8, 0.5, 0.45, LAMP, { top: LAMP });
  circles.push([x, z, 0.4]);
});

/* ---------- trees and palms ---------- */
(function () {
  function band(x0, z0, x1, z1, step) { const n = Math.round(((x1 - x0) * (z1 - z0) * S * S) / (step * step)); for (let i = 0; i < n; i++) tree(X(x0 + rnd() * (x1 - x0)), Z(z0 + rnd() * (z1 - z0))); }
  band(760, 8, 800, 44, 7); band(1015, 8, 2780, 44, 7); band(190, 930, 1400, 972, 7); band(2765, 10, 2788, 970, 7); band(150, 215, 180, 395, 6); band(150, 600, 180, 900, 6);
  for (let z = 612; z < 752; z += 11) { shrub(X(213 + rnd() * 3), Z(z), 1.5); shrub(X(296 + rnd() * 3), Z(z), 1.5); }
  band(2210, 400, 2340, 570, 6.5); band(2490, 130, 2590, 350, 7.5); band(1400, 925, 2760, 970, 9.5);
  [[1415, 515], [1432, 545], [1445, 585], [1410, 600], [1340, 612], [1215, 575], [296, 540], [262, 222], [742, 275], [782, 415], [1248, 62], [1503, 62], [1500, 215], [1118, 632], [752, 636], [870, 632], [1000, 632], [2475, 180], [2455, 330], [330, 30], [560, 35], [525, 470], [400, 565], [246, 580], [306, 258], [840, 470], [835, 560]]
    .forEach(p => { const x = X(p[0]), z = Z(p[1]); palm(x, z); circles.push([x, z, 0.45]); });
  [[1235, 640, 1.0], [1310, 640, 1.0], [1520, 270, 0.9], [1520, 330, 0.9], [231, 592, 1.1]].forEach(s => shrub(X(s[0]), Z(s[1]), s[2]));
})();

/* ---------- show jumps in the main arena ---------- */
const JUMPS = [[1000, 300], [1085, 205], [1185, 150], [1285, 235], [1150, 335], [1050, 435], [1250, 405], [1335, 330], [1120, 505]].map((p, i) => {
  const cols = [C(0xC8362B), C(0x2A5CAD), C(0xE0AC1E), C(0x2B8A4E)], x = X(p[0]), z = Z(p[1]), ry = rnd() * 3.1416, cy = Math.cos(ry), sy = Math.sin(ry);
  [-1.85, 1.85].forEach(o => { box(XF(x + o * cy, 0, z - o * sy, ry), 0.12, 1.7, 0.5, WHITE, { b: B.jcol, top: WHITE }); box(XF(x + o * cy, 0, z - o * sy, ry), 0.5, 0.08, 0.9, WHITE, { b: B.jcol, top: WHITE }); });
  [0.4, 0.75, 1.1].forEach((y, j) => cyl(XF(x - 1.8 * cy, y, z + 1.8 * sy, ry, -1.5708), 0.05, 0.05, 3.6, 6, j % 2 ? WHITE : cols[i % 4], false, B.jcol));
  return [x, z, ry];
});

/* ---------- Equine Home: the brown building against the east end of Barn C ---------- */
bld(2014, 727, 2050, 879, { wall: 4.2, roof: 1.6 });

/* ---------- cars in the car park, where they stand in the aerial photo, and the ambulance by the entrance ---------- */
const AMB_RED = C(0xC8102E), TYRE = [0.05, 0.05, 0.055], CARGLASS = [0.05, 0.07, 0.09];
function wheels(f, fx, fz, ry, L, Wd, r) {
  [-1, 1].forEach(sx => [-1, 1].forEach(sz => {
    const c = f([sx * (L / 2 - 0.85), r, sz * (Wd / 2 - 0.12)]), a = ry + (sz > 0 ? Math.PI / 2 : -Math.PI / 2), ax = [Math.sin(ry) * sz, Math.cos(ry) * sz];
    /* a cylinder grows along +y; turned on its side its axis points out of the car, so the cap is the outer face */
    cyl(XF(c[0] - ax[0] * 0.12, c[1], c[2] - ax[1] * 0.12, a, Math.PI / 2), r, r, 0.24, 12, TYRE, true);
  }));
}
function cabin(f, x0, x1, t0, t1, y0, y1, w0, w1, roof) {
  const ctr = f([(x0 + x1) / 2, (y0 + y1) / 2, 0]), A = [x0, y0, -w0], Bp = [x1, y0, -w0], Cp = [x1, y0, w0], D = [x0, y0, w0], E = [t0, y1, -w1], F = [t1, y1, -w1], G = [t1, y1, w1], Hh = [t0, y1, w1];
  [[A, Bp, F, E], [Bp, Cp, G, F], [Cp, D, Hh, G], [D, A, E, Hh]].forEach(q => quad(B.glass, f(q[0]), f(q[1]), f(q[2]), f(q[3]), CARGLASS, ctr));
  quad(B.col, f(E), f(F), f(G), f(Hh), roof, ctr);
}
function car(px, pz, ry, col, suv) {
  const x = X(px), z = Z(pz), f = XF(x, 0, z, ry), L = suv ? 4.8 : 4.5, Wd = suv ? 1.92 : 1.8, h0 = 0.3, hb = suv ? 0.92 : 0.66, ch = suv ? 0.72 : 0.6;
  box(f, L, hb, Wd, col, { off: [0, h0, 0] });
  if (suv) cabin(f, -2.2, 1.0, -2.15, 0.45, h0 + hb, h0 + hb + ch, Wd / 2 - 0.04, Wd / 2 - 0.16, col);
  else cabin(f, -1.45, 1.1, -1.05, 0.35, h0 + hb, h0 + hb + ch, Wd / 2 - 0.06, Wd / 2 - 0.22, col);
  [-1, 1].forEach(sz => {
    box(f, 0.06, 0.16, 0.38, [1, 0.97, 0.88], { off: [L / 2, h0 + hb - 0.28, sz * (Wd / 2 - 0.3)] });
    box(f, 0.06, 0.14, 0.34, [0.55, 0.05, 0.04], { off: [-L / 2, h0 + hb - 0.24, sz * (Wd / 2 - 0.28)] });
  });
  wheels(f, x, z, ry, L, Wd, 0.34);
  const ex = Math.abs(Math.cos(ry)) * L / 2 + Math.abs(Math.sin(ry)) * Wd / 2, ez = Math.abs(Math.sin(ry)) * L / 2 + Math.abs(Math.cos(ry)) * Wd / 2;
  boxes.push([x - ex, z - ez, x + ex, z + ez]);
}
function ambulance(px, pz, ry) {
  const x = X(px), z = Z(pz), f = XF(x, 0, z, ry), L = 6.2, Wd = 2.2, h0 = 0.38, bx = -0.75, bl = 4.3, bh = 2.35, AW = [0.95, 0.95, 0.93];
  box(f, bl, bh, Wd, AW, { off: [bx, h0, 0] });
  box(f, bl + 0.02, 0.3, Wd + 0.02, AMB_RED, { off: [bx, h0 + 0.62, 0] });
  box(f, 1.9, 0.95, Wd - 0.06, AW, { off: [bx + bl / 2 + 0.95, h0, 0] });
  cabin(f, bx + bl / 2, bx + bl / 2 + 1.5, bx + bl / 2, bx + bl / 2 + 0.75, h0 + 0.95, h0 + 1.75, Wd / 2 - 0.05, Wd / 2 - 0.12, AW);
  box(f, 0.5, 0.16, 1.5, [0.85, 0.08, 0.08], { off: [bx + bl / 2 - 0.4, h0 + bh, -0.38] });
  box(f, 0.5, 0.16, 0.7, [0.12, 0.3, 0.85], { off: [bx + bl / 2 - 0.4, h0 + bh, 0.4] });
  /* the side panels read the same way round from either side */
  const zs = Wd / 2 + 0.012, x0 = bx - bl / 2 + 0.25, x1 = bx + bl / 2 - 0.25, y0 = h0 + 0.95, y1 = h0 + 2.0, ctr = f([bx, 1.5, 0]);
  quadUV(B.amb, f([x0, y0, zs]), f([x1, y0, zs]), f([x1, y1, zs]), f([x0, y1, zs]), ONE, ctr, 0, 0, 1, 1);
  quadUV(B.amb, f([x1, y0, -zs]), f([x0, y0, -zs]), f([x0, y1, -zs]), f([x1, y1, -zs]), ONE, ctr, 0, 0, 1, 1);
  wheels(f, x, z, ry, L - 0.6, Wd, 0.38);
  const ex = Math.abs(Math.cos(ry)) * L / 2 + Math.abs(Math.sin(ry)) * Wd / 2, ez = Math.abs(Math.sin(ry)) * L / 2 + Math.abs(Math.cos(ry)) * Wd / 2;
  boxes.push([x - ex, z - ez, x + ex, z + ez]);
}
[[15, 92, 0, C(0xE9E9E6)], [15, 112, 0, C(0x1B2433)], [12, 145, Math.PI, C(0x2E3033)], [152, 141, Math.PI, C(0xF1F1EF), 1], [145, 157, Math.PI, C(0x24477A)], [152, 238, Math.PI, C(0xE6E6E3)], [140, 520, Math.PI, C(0xDADAD6), 1]]
  .forEach(c => car(c[0], c[1], c[2], c[3], c[4]));
ambulance(152, 352, Math.PI / 2);

/* ---------- planting around the club: green land, a row of trees just outside the wall, groves further out ---------- */
const OUTTREES = [];
(function () {
  REDIR = 'otree';
  const ox = GW / 2 + 9, oz = GH / 2 + 9;
  for (let x = -ox; x <= ox; x += 11) { tree(x + (rnd() - .5) * 3, -oz + (rnd() - .5) * 3, OUTTREES); tree(x + (rnd() - .5) * 3, oz + (rnd() - .5) * 3, OUTTREES); }
  for (let z = -oz + 11; z < oz; z += 11) { tree(-ox + (rnd() - .5) * 3, z, OUTTREES); tree(ox + (rnd() - .5) * 3, z, OUTTREES); }
  REDIR = null;
  /* groves of lighter trees further out: never swapped for the Meshy model, so they stay cheap */
  const grove = vnoise(16);
  for (let i = 0; i < 2600; i++) {
    const x = (rnd() - .5) * (GW + 520), z = (rnd() - .5) * (GH + 520), dx = Math.max(0, Math.abs(x) - GW / 2), dz = Math.max(0, Math.abs(z) - GH / 2), d = Math.hypot(dx, dz);
    if (d < 24 || d > 250 || grove(x / 45 + 50, z / 45 + 50) < 0.52) continue;
    const h = 4.5 + rnd() * 3, r = 2.3 + rnd() * 1.6, g = 0.78 + rnd() * 0.25;
    cyl(XF(x, 0, z, rnd() * 6), 0.15, 0.25, h * 0.72, 5, ONE, false, B.bark);
    crown(x, h, z, r, r * 0.9, 20, [g * 0.95, g, g * 0.85]);
  }
})();

/* =====================================================================
   Three.js scene
   ===================================================================== */
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 1, 0.3, 4000);
const texLoader = new THREE.TextureLoader();
const maxAniso = renderer.capabilities.getMaxAnisotropy();
let pending = 0, total = 0;
function loaderDone() { const l = $('loader'); if (l.classList.contains('done')) return; l.classList.add('done'); setTimeout(() => { l.hidden = true; }, 600); if (!route) toast(HINT.orbit); }
function loadedOne() {
  pending--; $('loaderBar').style.width = Math.round(100 * (total - pending) / total) + '%';
  if (pending <= 0) setTimeout(loaderDone, 250);
  renderer.shadowMap.needsUpdate = true;
}
function tex(name, rs, rt, cs = true) {
  pending++; total++;
  const t = texLoader.load('img/' + name + '.jpg', loadedOne, undefined, loadedOne);
  t.wrapS = rs ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping; t.wrapT = rt ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.anisotropy = Math.min(8, maxAniso); if (cs) t.colorSpace = THREE.SRGBColorSpace; return t;
}
function canvasTex(c, rep, cs = true) { const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = rep ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping; t.anisotropy = Math.min(8, maxAniso); if (cs) t.colorSpace = THREE.SRGBColorSpace; return t; }
function cv(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function speckle(g, w, h, n, a) { for (let i = 0; i < n; i++) { g.fillStyle = rnd() < 0.5 ? 'rgba(0,0,0,' + a + ')' : 'rgba(255,255,255,' + a + ')'; g.fillRect(rnd() * w, rnd() * h, 1 + rnd() * 2, 1 + rnd() * 2); } }
/* a normal map from any canvas, treating brightness as height */
function normalFrom(src, strength) {
  const w = src.width, h = src.height, d = src.getContext('2d').getImageData(0, 0, w, h).data, o = cv(w, h), og = o.getContext('2d'), im = og.createImageData(w, h);
  const L = (x, y) => { x = (x + w) % w; y = (y + h) % h; const i = (y * w + x) * 4; return (d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11) / 255; };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = (L(x + 1, y) - L(x - 1, y)) * strength, dy = (L(x, y + 1) - L(x, y - 1)) * strength, l = Math.hypot(dx, dy, 1), i = (y * w + x) * 4;
    im.data[i] = (-dx / l * 0.5 + 0.5) * 255; im.data[i + 1] = (dy / l * 0.5 + 0.5) * 255; im.data[i + 2] = (1 / l * 0.5 + 0.5) * 255; im.data[i + 3] = 255;
  }
  og.putImageData(im, 0, 0); return o;
}
function imgCanvas(src, cb) { const im = new Image(); im.onload = () => { const c = cv(im.naturalWidth, im.naturalHeight); c.getContext('2d').drawImage(im, 0, 0); cb(c); }; im.src = src; }

/* roof tiles: terracotta barrel tiles, row by row */
const roofCanvas = (function () {
  const c = cv(256, 256), g = c.getContext('2d');
  for (let r = 0; r < 8; r++) for (let k = 0; k < 16; k++) {
    const j = (rnd() - .5) * 30; g.fillStyle = 'rgb(' + Math.round(196 + j) + ',' + Math.round(92 + j * 0.6) + ',' + Math.round(64 + j * 0.5) + ')'; g.fillRect(k * 16, r * 32, 16, 32);
    const gr = g.createLinearGradient(k * 16, 0, k * 16 + 16, 0); gr.addColorStop(0, 'rgba(0,0,0,.26)'); gr.addColorStop(.5, 'rgba(255,225,190,.22)'); gr.addColorStop(1, 'rgba(0,0,0,.26)'); g.fillStyle = gr; g.fillRect(k * 16, r * 32, 16, 32);
  }
  for (let r = 0; r < 8; r++) { const g2 = g.createLinearGradient(0, r * 32 + 24, 0, r * 32 + 32); g2.addColorStop(0, 'rgba(0,0,0,0)'); g2.addColorStop(1, 'rgba(0,0,0,.32)'); g.fillStyle = g2; g.fillRect(0, r * 32 + 24, 256, 8); }
  speckle(g, 256, 256, 4000, 0.05); return c;
})();
const roofHeight = (function () {
  const c = cv(256, 256), g = c.getContext('2d');
  for (let r = 0; r < 8; r++) for (let k = 0; k < 16; k++) {
    const gr = g.createLinearGradient(k * 16, 0, k * 16 + 16, 0); gr.addColorStop(0, '#000'); gr.addColorStop(.5, '#fff'); gr.addColorStop(1, '#000'); g.fillStyle = gr; g.fillRect(k * 16, r * 32, 16, 32);
    const g2 = g.createLinearGradient(0, r * 32, 0, r * 32 + 32); g2.addColorStop(0, 'rgba(0,0,0,.6)'); g2.addColorStop(.85, 'rgba(0,0,0,0)'); g.fillStyle = g2; g.fillRect(k * 16, r * 32, 16, 32);
  }
  return c;
})();
const metalCanvas = (function () {
  const c = cv(128, 128), g = c.getContext('2d');
  g.fillStyle = '#dcdbd4'; g.fillRect(0, 0, 128, 128);
  for (let k = 0; k < 16; k++) { const gr = g.createLinearGradient(k * 8, 0, k * 8 + 8, 0); gr.addColorStop(0, 'rgba(0,0,0,.16)'); gr.addColorStop(.5, 'rgba(255,255,255,.22)'); gr.addColorStop(1, 'rgba(0,0,0,.16)'); g.fillStyle = gr; g.fillRect(k * 8, 0, 8, 128); }
  for (let k = 0; k < 26; k++) { g.fillStyle = 'rgba(110,95,70,' + (0.03 + rnd() * 0.05) + ')'; g.fillRect(rnd() * 128, rnd() * 128, 2 + rnd() * 5, 20 + rnd() * 70); }
  speckle(g, 128, 128, 900, 0.04); return c;
})();
const barkCanvas = (function () {
  const c = cv(64, 64), g = c.getContext('2d');
  g.fillStyle = '#7b6753'; g.fillRect(0, 0, 64, 64);
  for (let k = 0; k < 70; k++) { g.fillStyle = 'rgba(' + (rnd() < 0.5 ? '40,28,18' : '170,150,125') + ',' + (0.10 + rnd() * 0.18) + ')'; g.fillRect(rnd() * 64, rnd() * 64, 1 + rnd() * 2, 6 + rnd() * 22); }
  for (let k = 0; k < 8; k++) { g.fillStyle = 'rgba(35,25,15,.22)'; g.fillRect(0, k * 8 + rnd() * 3, 64, 1.5); } return c;
})();
/* interlocking pavers like the courtyards in the photos */
const paveCanvas = (function () {
  const c = cv(256, 256), g = c.getContext('2d');
  g.fillStyle = '#8f8676'; g.fillRect(0, 0, 256, 256);
  for (let r = 0; r < 8; r++) for (let k = 0; k < 4; k++) {
    const off = (r % 2) * 32, j = (rnd() - .5) * 26, x = k * 64 + off, y = r * 32;
    g.fillStyle = 'rgb(' + Math.round(206 + j) + ',' + Math.round(196 + j) + ',' + Math.round(176 + j * 0.8) + ')';
    for (const xx of [x, x - 256]) { g.beginPath(); g.roundRect ? g.roundRect(xx + 2, y + 2, 60, 28, 4) : g.rect(xx + 2, y + 2, 60, 28); g.fill(); }
  }
  speckle(g, 256, 256, 6000, 0.06); return c;
})();
function rgbaTex(col, mask) {
  const w = col.width, h = col.height, a = col.getContext('2d').getImageData(0, 0, w, h), m = mask.getContext('2d').getImageData(0, 0, w, h).data;
  for (let i = 0; i < w * h; i++) a.data[i * 4 + 3] = m[i * 4]; col.getContext('2d').putImageData(a, 0, 0); return col;
}
const leafCanvas = (function () {
  const c = cv(256, 256), m = cv(256, 256), g = c.getContext('2d'), k = m.getContext('2d');
  g.fillStyle = '#17260f'; g.fillRect(0, 0, 256, 256); k.fillStyle = '#000'; k.fillRect(0, 0, 256, 256); k.fillStyle = '#fff';
  for (let i = 0; i < 14; i++) { k.beginPath(); k.arc(128 + (rnd() - .5) * 110, 128 + (rnd() - .5) * 110, 26 + rnd() * 30, 0, 6.2832); k.fill(); }
  for (let i = 0; i < 950; i++) {
    const r = 120 * Math.sqrt(rnd()), a = rnd() * 6.2832, x = 128 + Math.cos(a) * r, y = 128 + Math.sin(a) * r, t = i / 950, L = 9 + t * 17 + (1 - y / 256) * 8 + rnd() * 6, hh = 80 + rnd() * 26, ss = 28 + rnd() * 18, rot = rnd() * 6.2832, rw = 3 + rnd() * 3.5, rl = 7 + rnd() * 8;
    g.fillStyle = 'hsl(' + hh.toFixed(0) + ',' + ss.toFixed(0) + '%,' + L.toFixed(0) + '%)'; g.beginPath(); g.ellipse(x, y, rw, rl, rot, 0, 6.2832); g.fill();
    k.beginPath(); k.ellipse(x, y, rw, rl, rot, 0, 6.2832); k.fill();
  }
  return rgbaTex(c, m);
})();
const frondCanvas = (function () {
  const w = 64, h = 256, c = cv(w, h), m = cv(w, h), g = c.getContext('2d'), k = m.getContext('2d');
  g.fillStyle = '#3f5029'; g.fillRect(0, 0, w, h); k.fillStyle = '#000'; k.fillRect(0, 0, w, h);
  const ln = (ctx, x0, y0, x1, y1, lw) => { ctx.lineWidth = lw; ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke(); };
  k.strokeStyle = '#fff'; g.lineCap = k.lineCap = 'round';
  for (let y = h - 6; y > 4; y -= 4.2) {
    const t = 1 - y / h, len = 30 * Math.min(1, 0.25 + t * 3.2) * Math.min(1, (1 - t) * 2.6 + 0.12), up = 10 + 16 * t;
    for (let s = -1; s <= 1; s += 2) { const L = 17 + rnd() * 15; g.strokeStyle = 'hsl(' + (82 + rnd() * 18).toFixed(0) + ',' + (22 + rnd() * 14).toFixed(0) + '%,' + L.toFixed(0) + '%)'; ln(g, 32, y, 32 + s * len, y - up, 2.3); ln(k, 32, y, 32 + s * len, y - up, 2.5); }
  }
  g.strokeStyle = '#8f9460'; ln(g, 32, h, 32, 6, 2.6); ln(k, 32, h, 32, 6, 3.2); return rgbaTex(c, m);
})();
/* number plates for the boxes in Barns A, B and C, one cell each in a 16 x 12 atlas */
const plateCanvas = (function () {
  const c = cv(1024, 384), g = c.getContext('2d'); g.fillStyle = '#F4F2EC'; g.fillRect(0, 0, 1024, 384);
  g.fillStyle = '#1E1A16'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = 'bold 22px "Helvetica Neue",Arial,sans-serif';
  PLATES.forEach((k, i) => { const x = (i % 16) * 64, y = Math.floor(i / 16) * 32; g.strokeStyle = '#9A8C76'; g.lineWidth = 2; g.strokeRect(x + 2, y + 2, 60, 28); g.fillText(k, x + 32, y + 17); });
  return c;
})();
/* ambulance side panel: red band, star of life, the word in Arabic and English */
const ambCanvas = (function () {
  const c = cv(512, 128), g = c.getContext('2d');
  g.fillStyle = '#F2F2EF'; g.fillRect(0, 0, 512, 128);
  g.fillStyle = '#C8102E'; g.fillRect(0, 100, 512, 16);
  g.save(); g.translate(256, 52); g.fillStyle = '#1F4FB4';
  for (let i = 0; i < 3; i++) { g.rotate(Math.PI / 3); g.fillRect(-9, -34, 18, 68); }
  g.fillStyle = '#F2F2EF'; g.fillRect(-2, -24, 4, 48); g.restore();
  g.fillStyle = '#C8102E'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = 'bold 46px "IBM Plex Sans Arabic","Geeza Pro",sans-serif'; g.fillText('إسعاف', 395, 54);
  g.font = 'bold 34px "Helvetica Neue",Arial,sans-serif'; g.fillText('AMBULANCE', 118, 56);
  return c;
})();
function vnoise(period) {
  const n = period, t = new Float32Array(n * n); for (let i = 0; i < n * n; i++) t[i] = rnd();
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y); let fx = x - xi, fy = y - yi; const x0 = ((xi % n) + n) % n, y0 = ((yi % n) + n) % n, x1 = (x0 + 1) % n, y1 = (y0 + 1) % n; fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
    return (t[y0 * n + x0] * (1 - fx) + t[y0 * n + x1] * fx) * (1 - fy) + (t[y1 * n + x0] * (1 - fx) + t[y1 * n + x1] * fx) * fy;
  };
}
const detailCanvas = (function () {
  const s = 256, c = cv(s, s), g = c.getContext('2d'), im = g.createImageData(s, s), n1 = vnoise(8), n2 = vnoise(32), n3 = vnoise(128); let i = 0;
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) { const v = n1(x / 32, y / 32) * 0.34 + n2(x / 8, y / 8) * 0.33 + n3(x / 2, y / 2) * 0.33, b = Math.round(v * 255); im.data[i++] = b; im.data[i++] = b; im.data[i++] = b; im.data[i++] = 255; }
  g.putImageData(im, 0, 0); return c;
})();
/* ground materials: red = arena sand, green = lawn, blue = road outside the wall */
const maskCanvas = (function () {
  const w = 1024, h = 512, c = cv(w, h), g = c.getContext('2d'), sx = w / W, sy = h / H;
  g.fillStyle = '#000'; g.fillRect(0, 0, w, h); g.fillStyle = '#00f'; g.fillRect(0, 0, 183 * sx, h);
  const fp = (p, col) => { g.fillStyle = col; g.beginPath(); p.forEach((q, i) => { if (i) g.lineTo(q[0] * sx, q[1] * sy); else g.moveTo(q[0] * sx, q[1] * sy); }); g.closePath(); g.fill(); };
  ARENAS.forEach(r => fp([[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]], '#f00')); fp(MAINP, '#f00'); fp(RING, '#f00');
  LAWNS.forEach(p => fp(p, '#0f0'));
  WALKS.forEach(WK => { g.fillStyle = '#f00'; g.beginPath(); g.ellipse(WK.x * sx, WK.z * sy, WK.r * sx, WK.r * sy, 0, 0, 6.2832); g.fill(); g.fillStyle = '#0f0'; g.beginPath(); g.ellipse(WK.x * sx, WK.z * sy, WK.r * 0.5 * sx, WK.r * 0.5 * sy, 0, 0, 6.2832); g.fill(); });
  return c;
})();

/* ---------- materials ---------- */
const T = {
  roof: canvasTex(roofCanvas, true), roofN: canvasTex(normalFrom(roofHeight, 3), true, false),
  metal: canvasTex(metalCanvas, true), bark: canvasTex(barkCanvas, true), pave: canvasTex(paveCanvas, true), paveN: canvasTex(normalFrom(paveCanvas, 4), true, false),
  leaf: canvasTex(leafCanvas, false), frond: canvasTex(frondCanvas, false), detail: canvasTex(detailCanvas, true, false), mask: canvasTex(maskCanvas, false, false)
};
const stoneT = tex('stone', true, true);
const stoneN = new THREE.CanvasTexture(cv(2, 2)); stoneN.wrapS = stoneN.wrapT = THREE.RepeatWrapping;
imgCanvas('img/stone.jpg', c => { stoneN.image = normalFrom(c, 5); stoneN.needsUpdate = true; });
T.stone = stoneT;

const MAT = {};
/* the sky environment is kept faint: it tints every shade blue. Shade in the desert is warm, lit by the sand (the hemisphere light below) */
const std = o => new THREE.MeshStandardMaterial(Object.assign({ vertexColors: true, roughness: 0.88, metalness: 0, side: THREE.DoubleSide, envMapIntensity: 0.12 }, o));
MAT.col = std({}); MAT.jcol = std({ roughness: 0.6 }); MAT.bcol = std({ roughness: 0.5 });
MAT.stone = std({ map: T.stone, normalMap: stoneN, normalScale: new THREE.Vector2(0.9, 0.9), roughness: 0.92 });
MAT.roof = std({ map: T.roof, normalMap: T.roofN, normalScale: new THREE.Vector2(0.8, 0.8), roughness: 0.62 });
MAT.metal = std({ map: T.metal, roughness: 0.42, metalness: 0.45 }); MAT.droof = MAT.metal;
MAT.bark = std({ map: T.bark, roughness: 0.95 }); MAT.pbark = MAT.bark; MAT.tbark = MAT.bark;
MAT.leaf = std({ map: T.leaf, alphaTest: 0.4, roughness: 0.8 }); MAT.tleaf = MAT.leaf;
MAT.frond = std({ map: T.frond, alphaTest: 0.4, roughness: 0.75 }); MAT.pfrond = MAT.frond;
MAT.apron = std({ map: T.pave, normalMap: T.paveN, normalScale: new THREE.Vector2(0.6, 0.6), roughness: 0.9 });
MAT.lamp = std({ emissive: new THREE.Color(0xfff2d6), emissiveIntensity: 0.0, roughness: 0.3 });
MAT.glass = std({ roughness: 0.06, metalness: 0.65, envMapIntensity: 1.4 });
MAT.amb = std({ map: canvasTex(ambCanvas, false), roughness: 0.4 });
/* the barn ceilings face down and get only the sand-coloured bounce, so they glow a little, like daylight from the high windows */
MAT.ceil = std({ emissive: new THREE.Color(0x3a1a1c), roughness: 0.8 });
MAT.blabel = std({ map: canvasTex(plateCanvas, false), roughness: 0.5 });
ORDER.forEach(n => { const b = B[n]; if (!MAT[n] && b.file && b.base === n) MAT[n] = std({ map: tex(b.file, b.rs, b.rt), roughness: n === 'dbox' || n === 'bay' ? 0.6 : 0.82 }); });

ORDER.forEach(n => { const b = B[n]; if (!MAT[n] && b.base !== n && MAT[b.base]) MAT[n] = MAT[b.base]; });
const MESH = {}; const ROOFSET = { A: [], B: [], C: [] }; let roofOpen = null;
const linear = c => c <= 0 ? 0 : (c <= 1 ? Math.pow(c, 2.2) : c);
ORDER.forEach(n => {
  const b = B[n]; if (!b.a.length || !MAT[n]) return;
  const a = new Float32Array(b.a); b.a = null;
  for (let i = 0; i < a.length; i += 11) {
    a[i + 6] = linear(a[i + 6]); a[i + 7] = linear(a[i + 7]); a[i + 8] = linear(a[i + 8]);
    if (n === 'apron') { a[i + 9] = a[i] / 2.2; a[i + 10] = a[i + 2] / 2.2; }
  }
  const ib = new THREE.InterleavedBuffer(a, 11), g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.InterleavedBufferAttribute(ib, 3, 0));
  g.setAttribute('normal', new THREE.InterleavedBufferAttribute(ib, 3, 3));
  g.setAttribute('color', new THREE.InterleavedBufferAttribute(ib, 3, 6));
  g.setAttribute('uv', new THREE.InterleavedBufferAttribute(ib, 2, 9));
  g.computeBoundingSphere();
  const m = new THREE.Mesh(g, MAT[n]); m.castShadow = n !== 'apron'; m.receiveShadow = true; m.matrixAutoUpdate = false; m.renderOrder = 2;
  if (MAT[n].alphaTest) m.customDepthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: MAT[n].map, alphaTest: 0.4 });
  if (n === 'apron') m.renderOrder = 0;
  scene.add(m); MESH[n] = m; { const o = b.opt; if (o && /^roof[ABC]$/.test(o)) ROOFSET[o[4]].push(m); }
});

/* ---------- ground: the aerial photo, with real materials blended in near the camera ---------- */
const groundTex = tex('aerial', false, false);
const groundMat = new THREE.MeshStandardMaterial({ map: groundTex, roughness: 0.95, metalness: 0, envMapIntensity: 0.12 });
groundMat.onBeforeCompile = sh => {
  sh.uniforms.uDetail = { value: T.detail }; sh.uniforms.uMask = { value: T.mask }; sh.uniforms.uG = { value: new THREE.Vector4(GW / 2, GH / 2, 1 / GW, 1 / GH) };
  sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWP;').replace('#include <project_vertex>', '#include <project_vertex>\nvWP=(modelMatrix*vec4(transformed,1.0)).xyz;');
  sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vWP;uniform sampler2D uDetail;uniform sampler2D uMask;uniform vec4 uG;\nfloat hsh(vec2 p){return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453);}')
    .replace('#include <map_fragment>', `
      vec4 aer=texture2D(map,vMapUv);
      aer.rgb=max(mix(vec3(dot(aer.rgb,vec3(0.2126,0.7152,0.0722))),aer.rgb,1.15),0.0);
      float dd=length(vViewPosition);
      vec2 mu=vec2((vWP.x+uG.x)*uG.z,1.0-(vWP.z+uG.y)*uG.w);
      vec3 mk=(mu.x<0.0||mu.x>1.0||mu.y<0.0||mu.y>1.0)?vec3(0.0,0.0,1.0):texture2D(uMask,mu).rgb;
      float near=1.0-smoothstep(10.0,90.0,dd);float nb=1.0-smoothstep(3.0,30.0,dd);
      float n1=texture2D(uDetail,vWP.xz*0.9).r;float n2=texture2D(uDetail,vWP.xz*0.17).r;float n3=texture2D(uDetail,vWP.xz*3.1).r;float nn=n1*0.6+n2*0.4;
      vec2 p=vWP.xz*vec2(4.0,8.0);p.x+=0.5*floor(p.y);vec2 f=fract(p);
      float jt=smoothstep(0.0,0.07,f.x)*smoothstep(0.0,0.14,f.y)*(1.0-smoothstep(0.93,1.0,f.x))*(1.0-smoothstep(0.86,1.0,f.y));
      vec3 pave=vec3(0.66,0.62,0.56)*mix(0.95,(0.84+0.22*hsh(floor(p)))*(0.6+0.4*jt),nb)*(0.9+0.2*n2);
      vec3 sand=vec3(0.56,0.45,0.31)*(0.82+0.36*nn)*(0.92+0.16*n3);
      vec3 grs=vec3(0.10,0.17,0.05)*(0.6+0.8*n1)*(0.85+0.3*n3);
      vec3 asp=vec3(0.16,0.155,0.15)*(0.8+0.4*n1);
      vec3 mat=mix(mix(mix(pave,sand,step(0.5,mk.r)),grs,step(0.5,mk.g)),asp,step(0.5,mk.b));
      vec3 base=aer.rgb*mix(1.0,0.78+0.44*nn,near*0.8);
      diffuseColor.rgb*=mix(base,mat,0.78*near);
      float edm=min(min(mu.x,1.0-mu.x)/uG.z,min(mu.y,1.0-mu.y)/uG.w);
      diffuseColor.rgb=mix(vec3(0.075,0.14,0.032)*(0.8+0.4*n2),diffuseColor.rgb,smoothstep(0.0,8.0,edm));
    `);
};
const ground = new THREE.Mesh(new THREE.PlaneGeometry(GW, GH), groundMat);
ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; ground.renderOrder = 0; scene.add(ground);

/* ---------- roofs take their colour from the aerial photo ----------
   Seen from above, the photo already shows the real roofs: their true terracotta, the AC units, the weathering.
   Upward-facing faces sample it by world XZ; the material's own texture (tiles, corrugation) is kept as
   fine detail by modulating the photo with its brightness. minY keeps low things (rails, benches) out. */
function avgLum(c) {
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data, lin = v => Math.pow(v / 255, 2.2); let t = 0, n = 0;
  for (let i = 0; i < d.length; i += 16) { t += 0.2126 * lin(d[i]) + 0.7152 * lin(d[i + 1]) + 0.0722 * lin(d[i + 2]); n++; } return t / n;
}
function drape(mat, o) {
  mat.onBeforeCompile = sh => {
    sh.uniforms.uAer = { value: groundTex }; sh.uniforms.uAG = { value: new THREE.Vector4(GW / 2, GH / 2, 1 / GW, 1 / GH) };
    sh.uniforms.uAD = { value: new THREE.Vector3(o.lum || 1, o.detail || 0, o.minY || -1) };
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vAW;varying vec3 vAN;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvAW=(modelMatrix*vec4(transformed,1.0)).xyz;vAN=normalize(mat3(modelMatrix)*objectNormal);');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vAW;varying vec3 vAN;uniform sampler2D uAer;uniform vec4 uAG;uniform vec3 uAD;')
      .replace('#include <color_fragment>', `#include <color_fragment>
      {
        float up=vAN.y*(gl_FrontFacing?1.0:-1.0); /* only the side seen from above */
        float aw=smoothstep(0.3,0.62,up)*step(uAD.z,vAW.y);
        vec2 auv=vec2((vAW.x+uAG.x)*uAG.z,1.0-(vAW.z+uAG.y)*uAG.w);
        if(aw>0.0&&auv.x>0.0&&auv.x<1.0&&auv.y>0.0&&auv.y<1.0){
          vec3 a=texture2D(uAer,auv).rgb; a=max(mix(vec3(dot(a,vec3(0.2126,0.7152,0.0722))),a,1.15),0.0);
          float dl=dot(diffuseColor.rgb,vec3(0.2126,0.7152,0.0722))/uAD.x;
          diffuseColor.rgb=mix(diffuseColor.rgb,a*mix(1.0,clamp(dl,0.35,1.8),uAD.y),aw);
        }
      }`);
  };
  mat.needsUpdate = true;
}
drape(MAT.roof, { lum: avgLum(roofCanvas), detail: 0.6 });
drape(MAT.metal, { lum: avgLum(metalCanvas), detail: 0.35 });
drape(MAT.col, { minY: 3.0 });
/* green land around the site: grass sampled in world space, with large-scale variation so the tiling does not show */
const grassC = cv(512, 512); {
  const g = grassC.getContext('2d'), n1 = vnoise(8), n2 = vnoise(32), n3 = vnoise(128), im = g.createImageData(512, 512); let i = 0;
  for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) {
    const v = n1(x / 64, y / 64) * 0.45 + n2(x / 16, y / 16) * 0.35 + n3(x / 4, y / 4) * 0.2, b = rnd() < 0.18 ? 1.18 : rnd() < 0.18 ? 0.8 : 1;
    im.data[i++] = (52 + 62 * v) * b; im.data[i++] = (84 + 64 * v) * b; im.data[i++] = (30 + 30 * v) * b; im.data[i++] = 255;
  }
  g.putImageData(im, 0, 0);
}
const grassMat = new THREE.MeshStandardMaterial({ map: canvasTex(grassC, true), roughness: 0.96, envMapIntensity: 0.12 });
grassMat.onBeforeCompile = sh => {
  sh.uniforms.uDetail = { value: T.detail };
  sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vGW;').replace('#include <project_vertex>', '#include <project_vertex>\nvGW=(modelMatrix*vec4(transformed,1.0)).xyz;');
  sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vGW;uniform sampler2D uDetail;')
    .replace('#include <map_fragment>', `
      vec4 gs=texture2D(map,vGW.xz/14.0);
      float gv=texture2D(uDetail,vGW.xz*0.0035).r*0.6+texture2D(uDetail,vGW.xz*0.017).r*0.4;
      diffuseColor*=gs; diffuseColor.rgb*=0.72+0.56*gv;`);
};
const grassland = new THREE.Mesh(new THREE.CircleGeometry(3000, 64), grassMat);
grassland.rotation.x = -Math.PI / 2; grassland.position.y = -0.06; grassland.receiveShadow = true; scene.add(grassland);

/* ---------- sky, sun and image-based light ---------- */
const sky = new Sky(); sky.scale.setScalar(3500); scene.add(sky);
const su = sky.material.uniforms; su.turbidity.value = 7; su.rayleigh.value = 1.4; su.mieCoefficient.value = 0.006; su.mieDirectionalG.value = 0.82;
const sun = new THREE.DirectionalLight(0xfff1dc, 3.0); scene.add(sun); scene.add(sun.target);
sun.castShadow = true; const SM = COARSE ? 2048 : 4096; sun.shadow.mapSize.set(SM, SM);
const sc = sun.shadow.camera; sc.left = -250; sc.right = 250; sc.top = 250; sc.bottom = -250; sc.near = 10; sc.far = 1400;
sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.06;
const hemi = new THREE.HemisphereLight(0xece8e0, 0xc9ad84, 1.0); scene.add(hemi);
scene.fog = new THREE.FogExp2(0xd8d4c8, 0.0011);
const pmrem = new THREE.PMREMGenerator(renderer);
let envRT = null;
const TIMES = {
  morning: { dir: [0.26, 0.62, 0.74], sun: 0xfff0d8, si: 3.1, hi: 1.0, fog: 0xd9d5ca, exp: 0.95, turb: 7, lamps: 0 },
  noon: { dir: [0.18, 0.93, 0.32], sun: 0xffffff, si: 3.4, hi: 1.05, fog: 0xdfe2e2, exp: 0.85, turb: 6, lamps: 0 },
  sunset: { dir: [-0.82, 0.12, 0.55], sun: 0xffb27a, si: 2.6, hi: 0.7, fog: 0xc9a98c, exp: 1.15, turb: 9, lamps: 2.5 }
};
function setTime(k) {
  const t = TIMES[k], d = new THREE.Vector3(...t.dir).normalize();
  su.sunPosition.value.copy(d); su.turbidity.value = t.turb;
  sun.color.setHex(t.sun); sun.intensity = t.si; sun.position.copy(d).multiplyScalar(600); sun.target.position.set(0, 0, 0);
  hemi.intensity = t.hi; scene.fog.color.setHex(t.fog); renderer.toneMappingExposure = t.exp;
  MAT.lamp.emissiveIntensity = t.lamps;
  /* image-based light from the sky, so glass and metal reflect it */
  sky.visible = true; const tmp = new THREE.Scene(); tmp.add(sky);
  if (envRT) envRT.dispose(); envRT = pmrem.fromScene(tmp, 0, 0.1, 5000); scene.environment = envRT.texture; scene.add(sky);
  renderer.shadowMap.needsUpdate = true;
  ['tMorning', 'tNoon', 'tSunset'].forEach((id, i) => $(id).setAttribute('aria-pressed', ['morning', 'noon', 'sunset'][i] === k));
}
$('tMorning').onclick = () => setTime('morning'); $('tNoon').onclick = () => setTime('noon'); $('tSunset').onclick = () => setTime('sunset');
setTime('morning');

/* ---------- post-processing on desktop: 4x MSAA, ground-truth ambient occlusion, then tone mapping ---------- */
let composer = null, gtao = null;
if (!COARSE && renderer.capabilities.isWebGL2) {
  composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 }));
  composer.addPass(new RenderPass(scene, camera));
  gtao = new GTAOPass(scene, camera, 1, 1, undefined,
    { radius: 2.6, distanceExponent: 1.4, thickness: 1.5, scale: 1.15, samples: 16, distanceFallOff: 1, screenSpaceRadius: false },
    { lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 16 });
  gtao.blendIntensity = 0.9; gtao.normalMaterial.side = THREE.DoubleSide; /* canopies and eaves are seen from below too */
  /* the sky dome and the route ribbon must not occlude anything */
  const ov = gtao.overrideVisibility.bind(gtao);
  gtao.overrideVisibility = () => { ov(); sky.visible = false; routeMesh.visible = false; for (const n in MESH) if (MESH[n].material.alphaTest) MESH[n].visible = false; };
  composer.addPass(gtao);
  composer.addPass(new OutputPass());
}

/* ---------- Meshy models: drop a GLB into models/ and it takes over from the drawn version ---------- */
const MODELS = {
  horse: { name: 'خيل', en: 'Horses', h: 1.68, at: [[1100, 268, 0.6], [1236, 430, 2.4], [462, 312, 1.2], [676, 610, 3.0], [1176, 760, 0.2], [1030, 790, 4.1], [500, 700, 5.0], [853, 830, 1.7]] },
  palm: { name: 'نخيل', en: 'Palms', hide: 'palm', list: () => PALMS, skip: COARSE },
  tree: { name: 'أشجار', en: 'Trees', h: null, list: () => TREES, hide: 'tree' },
  otree: { name: 'أشجار حول المركز', en: 'Trees around the centre', file: 'tree', h: null, list: () => OUTTREES, hide: 'otree' },
  jump: { name: 'حواجز', en: 'Show jumps', h: 1.6, hide: 'jump', list: () => JUMPS.map(j => [j[0], j[1], 1.6, j[2]]) },
  judges: { name: 'برج الحكام', en: 'Judges’ tower', h: 8.6, hide: 'judges', at: [[1268, 590, 0]] },
  booth: { name: 'كشك الحارس', en: 'Guard booth', h: 2.9, hide: 'booth', list: () => [[BOOTH.x, BOOTH.z, 2.9, 0]] }
};
const gltf = new GLTFLoader();
const modelChips = $('models');
Object.keys(MODELS).forEach(k => { const c = document.createElement('span'); c.className = 'chip'; c.id = 'mc_' + k; c.textContent = chipText(k); modelChips.appendChild(c); });
function chipText(k) { const c = MODELS[k]; return (c.on ? '✓ ' : '') + L(c.name, c.en); }
function hideOpt(opt) {
    ORDER.forEach(n => { if (B[n] && B[n].opt === opt && MESH[n]) MESH[n].visible = false; });
}
function placeModel(k, root) {
  const cfg = MODELS[k];
  root.updateMatrixWorld(true);
  const bb = new THREE.Box3().setFromObject(root), size = bb.getSize(new THREE.Vector3()), base = bb.min.y;
  const ctr = bb.getCenter(new THREE.Vector3());
  /* gather meshes once and instance them, so dozens of trees cost one draw each */
  const parts = [];
  root.traverse(o => { if (o.isMesh) { o.material.side = THREE.FrontSide; o.material.envMapIntensity = 0.2; if (o.material.map) o.material.map.anisotropy = Math.min(8, maxAniso); parts.push(o); } });
  let spots = cfg.list ? cfg.list() : cfg.at.map(a => [X(a[0]), Z(a[1]), cfg.h, a[2]]);
  if (cfg.cap && spots.length > cfg.cap) { const step = spots.length / cfg.cap; spots = spots.filter((_, i) => Math.floor(i % step) === 0).slice(0, cfg.cap); }
  parts.forEach(p => {
    const im = new THREE.InstancedMesh(p.geometry, p.material, spots.length); im.castShadow = true; im.receiveShadow = true; im.renderOrder = 2;
    const local = p.matrixWorld.clone(), mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), off = new THREE.Matrix4().makeTranslation(-ctr.x, -base, -ctr.z);
    spots.forEach((sp, i) => {
      const hgt = sp[2] || cfg.h || 6, sc = hgt / size.y * (cfg.list && !cfg.h ? 0.9 + ((i * 37) % 10) / 40 : 1);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), sp[3] != null ? sp[3] : (i * 2.39996));
      s.set(sc, sc, sc);
      mtx.compose(new THREE.Vector3(sp[0], 0, sp[1]), q, s).multiply(off).multiply(local);
      im.setMatrixAt(i, mtx);
    });
    im.computeBoundingSphere(); scene.add(im);
  });
  if (cfg.hide) hideOpt(cfg.hide);
  { cfg.on = true; const c = $('mc_' + k); c.classList.add('on'); c.textContent = chipText(k); } renderer.shadowMap.needsUpdate = true;
}
Object.keys(MODELS).forEach(k => {
  if (MODELS[k].skip) return;
  gltf.load('m/' + (MODELS[k].file || k) + '.json', g => { try { placeModel(k, g.scene); } catch (e) { console.warn(k, e); } }, undefined, () => { });
});

/* =====================================================================
   Wayfinding: path network, places, routes
   ===================================================================== */
const N = {}, ADJ = {};
function node(id, x, z, at) { N[id] = { x, z, at: at || '' }; ADJ[id] = []; }
function edge(a, b) { const d = Math.hypot(N[a].x - N[b].x, N[a].z - N[b].z); ADJ[a].push([b, d]); ADJ[b].push([a, d]); }
function chain(...ids) { for (let i = 1; i < ids.length; i++) edge(ids[i - 1], ids[i]); }
const dCx = doorCx / S + W / 2, wcWpx = (wcWz / S) + H / 2, wcMpx = (wcMz / S) + H / 2, cafePx = cafeX / S + W / 2, dAx = doorAx / S + W / 2, dBx = doorBx / S + W / 2;
node('park', 140, 495); node('gw', 186, 495); node('rec', 212, 495, 'داخل الاستقبال'); node('recwc', 226, 516); node('ge', 240, 495);
node('pl', 270, 495, 'في الساحة خلف الاستقبال'); node('s5', 312, 495, 'عند الممر الرئيسي');
node('d0', 264, 548); node('dn', 256, 594);
node('sN1', 312, 375, 'عند ميدان 1'); node('sN2', 312, 234, 'عند زاوية إسطبل A'); node('swc', 312, wcWpx, 'عند طرف إسطبل A'); node('wcw', 333, wcWpx);
node('sst', 312, 125, 'مقابل محل المستلزمات'); node('st1', 276, 125, 'عند محل المستلزمات'); node('store', 260, 125); node('st2', 276, 78); node('adm', 262, 71);
node('sS1', 312, 628, 'عند ميدان 4'); node('sS2', 312, 766, 'عند زاوية إسطبل B'); node('sS3', 312, wcMpx, 'عند طرف إسطبل B'); node('wcm', 329, wcMpx);
node('pvW', 392, 500, 'عند جلسة الحديقة'); node('pvN', 455, 438, 'عند جلسة الحديقة'); node('pvE', 518, 500, 'عند جلسة الحديقة'); node('pvS', 455, 562, 'عند جلسة الحديقة'); node('pav', 410, 500);
node('rN', 455, 375, 'عند ميدان 1'); node('rS', 455, 628, 'عند ميدان 4');
node('cN2', dAx, 234, 'أمام إسطبل A'); node('cN1', 598, 375, 'بين ميدان 1 وميدان 2'); node('cM', 598, 504, 'بعد الحديقة'); node('cS1', 598, 628, 'بين ميدان 4 وميدان 3'); node('cS2', dBx, 766, 'أمام إسطبل B');
node('barnA', dAx, 216); node('barnB', dBx, 787); node('cafeN', cafePx, 766); node('cafe', cafePx, 782);
node('e1', 765, 234, 'عند نهاية إسطبل A'); node('e2', 765, 392, 'عند الميدان الرئيسي'); node('e3', 765, 505, 'بجانب ميدان 2 وميدان 3'); node('e4', 765, 650, 'عند طريق الميدان الرئيسي'); node('e5', 765, 768, 'عند نهاية إسطبل B');
node('mainA', 802, 392); node('n1', 830, 234, 'بعد إسطبل A'); node('n2', 830, 62, 'في آخر الطريق'); node('clubwc', CLUBP.wc[0], CLUBP.wc[1]); node('pry', CLUBP.pry[0], CLUBP.pry[1]); node('sgate', 831, 16);
node('r1', 838, 656, 'عند ميدان KRC Stars B'); node('starsB', 838, 665); node('r2', 928, 650, 'عند ميدان KRC Stars B'); node('a6A', 1030, 654); node('a6B', 1176, 654); node('a6C', 1320, 654); node('jt', 1268, 640); node('r3', 1420, 652); node('barnC', dCx, 676); node('c1', 2186, 672, 'بعد إسطبل C'); node('c2', 2186, 735); node('zb', 2365, 735); node('cE2', 2186, 258, 'عند الحلقة الدائرية'); node('club', 800, 345);
node('l1', 853, 771, 'عند ميدان KRC Stars A'); node('starsA', 853, 783); node('l2', 928, 771, 'بعد ميدان KRC Stars A'); node('l3', 928, 897, 'عند السور البعيد'); node('barnE', 2240, 258);
node('arena1', 455, 366); node('arena2', 608, 375); node('arena3', 608, 640); node('arena4', 455, 638);
node('out0', 140, 150, 'عند باب محل المستلزمات'); node('shopW', 180, 150);
chain('park', 'gw', 'rec', 'ge', 'pl', 's5'); edge('rec', 'recwc'); chain('pl', 'd0', 'dn');
chain('s5', 'sN1', 'sN2', 'swc', 'sst', 'st1', 'store'); edge('swc', 'wcw'); chain('sst', 'st2', 'adm');
chain('s5', 'sS1', 'sS2', 'sS3', 'wcm');
chain('s5', 'pvW', 'pvN', 'pvE', 'pvS', 'pvW'); edge('pvW', 'pav');
chain('pvN', 'rN', 'sN1'); edge('rN', 'cN1'); edge('rN', 'arena1'); chain('pvS', 'rS', 'sS1'); edge('rS', 'cS1'); edge('rS', 'arena4');
chain('sN2', 'cN2', 'barnA'); chain('cN2', 'cN1', 'cM', 'cS1', 'cS2', 'barnB'); edge('cN1', 'arena2'); edge('cM', 'pvE'); edge('cS1', 'arena3');
chain('sS2', 'cafeN', 'cS2'); edge('cafeN', 'cafe');
chain('cN2', 'e1', 'e2', 'e3', 'e4', 'e5', 'cS2'); edge('e2', 'mainA'); edge('e3', 'cM');
chain('e1', 'n1', 'n2', 'sgate'); edge('n1', 'clubwc'); edge('n2', 'pry'); edge('clubwc', 'pry');
node('eqp', 2032, 674, 'عند الطرف الشرقي لإسطبل C'); node('eqh', 2032, 716); chain('barnC', 'eqp', 'c1'); edge('eqp', 'eqh');
node('m1', 1505, 640); node('m2', 1505, 268, 'عند بوابة الميدان الرئيسي'); node('g1a', 1600, 268); node('gate1', 1600, 12);
node('g2b', 2380, 249); node('g2a', 2405, 249); node('gate2', 2405, 12);
node('lngN', 2186, 317); chain('e4', 'r1', 'r2', 'a6A', 'a6B', 'a6C', 'r3', 'barnC', 'c1', 'lngN', 'cE2', 'barnE'); chain('c1', 'c2', 'zb'); edge('a6B', 'jt'); chain('r3', 'm1', 'm2', 'g1a', 'gate1'); chain('cE2', 'g1a'); chain('barnE', 'g2b', 'g2a', 'gate2'); edge('e2', 'club'); edge('r1', 'starsB');
chain('e5', 'l1', 'l2', 'l3'); edge('l1', 'starsA'); edge('l2', 'r2');
chain('park', 'out0', 'shopW');
node('wkr', 304, 812); edge('sS3', 'wkr');
node('bE', 785, 848, 'عند الطرف الشرقي لإسطبل B'); node('washB', 775, 877); node('tackB', 786, 884); node('outB', 850, 891); chain('e5', 'bE', 'washB'); chain('bE', 'tackB', 'outB');
(function () { let prev = 'dn'; for (let k = 0; k < 8; k++) { const id = 'da' + k; node(id, 255, 600 + (k + 0.5) * 19.625); edge(prev, id); prev = id; } })();

const P = n => 'img/p_' + n + '.jpg';
const PLACES = [
  { id: 'entrance', n: 'المدخل الرئيسي', en: 'Main entrance', g: 'other', nodes: ['park'], face: [189, 495], ph: [P('entrance')], note: 'جهة المواقف من البوابة الرئيسية. الاستقبال هو الباب الأوسط.', lbl: [150, 495, 3] },
  { id: 'reception', n: 'الاستقبال', en: 'Reception', g: 'svc', nodes: ['rec'], ph: [P('reception1'), P('reception2')], note: 'داخل مبنى المدخل الرئيسي. الباب الخلفي يفتح على الحديقة.', lbl: [212, 495, 7] },
  { id: 'wc_rec', n: 'دورة مياه الاستقبال', en: 'Restroom, Reception', g: 'svc', nodes: ['recwc'], face: [232, 522], ph: [P('wc_rec')], note: 'داخل الاستقبال، في الممر الجانبي بجانب الباب الخلفي.' },
  { id: 'wc_w', n: 'دورة مياه النساء · إسطبل A', en: 'Women’s restroom, Barn A', g: 'svc', nodes: ['wcw'], face: [345, wcWpx], ph: [P('wc_w')], note: 'باب الزاوية في طرف إسطبل A، مقابل محل المستلزمات.', lbl: [336, wcWpx, 3.4] },
  { id: 'wc_m', n: 'دورة مياه الرجال · إسطبل B', en: 'Men’s restroom, Barn B', g: 'svc', nodes: ['wcm'], face: [340, wcMpx], ph: [P('wc_m')], note: 'باب الزاوية في طرف إسطبل B، بجانب الكافتيريا.', lbl: [332, wcMpx, 3.4] },
  { id: 'wc_cw', n: 'دورة مياه النساء · إسطبل C', en: 'Women’s restroom, Barn C', g: 'svc', nodes: ['barnC'], face: [dCx, 700], ph: [P('barnC')], note: 'داخل إسطبل C. المسار يوصلك إلى الباب الرئيسي للإسطبل، ومكانها الدقيق في الداخل لم يُحدَّد بعد.' },
  { id: 'wc_cm', n: 'دورة مياه الرجال · إسطبل C', en: 'Men’s restroom, Barn C', g: 'svc', nodes: ['barnC'], face: [dCx, 700], ph: [P('barnC')], note: 'داخل إسطبل C. المسار يوصلك إلى الباب الرئيسي للإسطبل، ومكانها الدقيق في الداخل لم يُحدَّد بعد.' },
  { id: 'wc_club', n: 'دورات مياه القاعة الزجاجية', en: 'Restrooms, Glass room', g: 'svc', nodes: ['clubwc'], face: CLUBP.wcFace, ph: [P('wc_club')], note: 'تحت القاعة الزجاجية. الباب في مستوى الأرض بجانب الدرج.', lbl: [CLUBP.wcFace[0] - 6, CLUBP.wcFace[1] - 6, 3.2] },
  { id: 'shop', n: 'محل مستلزمات الفروسية', en: 'Tack shop', g: 'svc', nodes: ['store', 'shopW'], faces: { store: [252, 125], shopW: [186, 148] }, ph: [P('shop1'), P('shop2'), P('shop3')], note: 'له بابان: واحد من جهة المواقف، وواحد داخل المركز مقابل إسطبل A.', lbl: [222, 120, 7.5] },
  { id: 'admin', n: 'الإدارة', en: 'Administration', g: 'svc', nodes: ['adm'], face: [262, 64], ph: [P('admin')], note: 'بجانب محل المستلزمات، داخل المركز.', lbl: [278, 36, 5.5] },
  { id: 'cafe', n: 'الكافتيريا', en: 'Cafeteria', g: 'svc', nodes: ['cafe'], face: [cafePx, 793], ph: [P('cafe')], note: 'شبّاك الطلبات على جدار إسطبل B، بجانب دورة مياه الرجال.', lbl: [cafePx, 786, 5.6] },
  { id: 'tackB', n: 'غرفة السروج · إسطبل B', en: 'Tack room, Barn B', g: 'svc', nodes: ['tackB'], face: [786, 892], ph: [P('tackB1'), P('tackB2')], note: 'المبنى ذو الطابقين في الطرف الشرقي لإسطبل B، مقابل باب الإسطبل الطرفي.', lbl: [786, 908, 7.2] },
  { id: 'washB', n: 'مغسلة الخيل · إسطبل B', en: 'Horse wash bay, Barn B', g: 'svc', nodes: ['washB'], face: [757, 877], ph: [P('washB')], note: 'بين غرفة السروج وممر إسطبل B، في الطرف الشرقي.', lbl: [763, 872, 3.6] },
  { id: 'prayer', n: 'المصلى', en: 'Prayer room', g: 'svc', nodes: ['pry'], face: CLUBP.pryFace, ph: [P('prayer')], note: 'خلف القاعة الزجاجية. مبنى حجري منخفض له بابان.', lbl: [CLUBP.pryFace[0], CLUBP.pryFace[1], 4.4] },
  { id: 'barnA', n: 'إسطبل A', en: 'Barn A', g: 'barn', nodes: ['barnA'], face: [dAx, 210], ph: [P('barnA')], note: 'الباب الرئيسي على الجهة الطويلة المقابلة لميدان 1 وميدان 2. ابحث عن رقم البوكس مثل A-9.', lbl: [561, 157, 10] },
  { id: 'barnB', n: 'إسطبل B', en: 'Barn B', g: 'barn', nodes: ['barnB'], face: [dBx, 793], ph: [P('barnB')], note: 'الباب الرئيسي على الجهة الطويلة المقابلة لميدان 4 وميدان 3، وباب ثانٍ في الطرف الشرقي عند غرفة السروج. ابحث عن رقم البوكس مثل B-17.', lbl: [548, 849, 10] },
  { id: 'barnD', n: 'إسطبل D', en: 'Barn D', g: 'barn', nodes: ['dn'], face: [255, 640], ph: [P('barnD')], note: 'ستة عشر بوكساً تحت المظلة المقوسة، على يمينك بعد الخروج من الباب الخلفي للاستقبال.', lbl: [255, 678, 6.5], boxes: 1 },
  { id: 'barnC', n: 'إسطبل C', en: 'Barn C', g: 'barn', nodes: ['barnC'], face: [dCx, 700], ph: [P('barnC')], note: 'الإسطبل الكبير في الخلف على اليمين. الباب الرئيسي على الجهة المقابلة للميادين، ودورات المياه بالداخل.', lbl: [1733, 795, 10] },
  { id: 'barnE', n: 'إسطبل E', en: 'Barn E', g: 'barn', nodes: ['barnE'], face: [2270, 246], ph: [], note: 'الخيام البيضاء الثلاث المتجاورة في الخلف على اليسار. أرقام البوكسات لم تُضَف بعد.', lbl: [2276, 150, 6.5] },
  { id: 'barnZ', n: 'حظيرة الخيمة', en: 'Tent Barn', g: 'barn', nodes: ['zb'], face: [2380, 735], ph: [], note: 'الخيمة البيضاء المنفردة في الخلف على اليمين.', lbl: [2418, 715, 6.5] },
  { id: 'outB', n: 'البوكسات الخارجية', en: 'Outdoor boxes', g: 'barn', nodes: ['outB'], face: [850, 906], ph: [P('outB')], note: 'صف البوكسات تحت السقف المسطح بجانب غرفة سروج إسطبل B.', lbl: [857, 912, 4.4] },
  { id: 'main', n: 'الميدان الرئيسي', en: 'Main arena', g: 'arena', nodes: ['mainA'], ph: [P('main')], lbl: [1150, 330, 5] },
  { id: 'a1', n: 'ميدان 1', en: 'Arena 1', g: 'arena', nodes: ['arena1'], ph: [], lbl: [461, 302, 4] },
  { id: 'a2', n: 'ميدان 2', en: 'Arena 2', g: 'arena', nodes: ['arena2'], ph: [], lbl: [676, 367, 4] },
  { id: 'a3', n: 'ميدان 3', en: 'Arena 3', g: 'arena', nodes: ['arena3'], ph: [], lbl: [675, 640, 4] },
  { id: 'a4', n: 'ميدان 4', en: 'Arena 4', g: 'arena', nodes: ['arena4'], ph: [], lbl: [455, 697, 4] },
  { id: 'lunge', n: 'الميدان الدائري (لونج)', en: 'Lunging arena', g: 'arena', nodes: ['lngN'], face: [2267, 317], ph: [], note: 'الميدان الدائري مقابل إسطبل E. لم يُصوَّر بعد.', lbl: [2267, 317, 4] },
  { id: 'a6a', n: 'ميدان 6A', en: 'Arena 6A', g: 'arena', nodes: ['a6A'], ph: [P('a6')], lbl: [1030, 773, 4] },
  { id: 'a6b', n: 'ميدان 6B', en: 'Arena 6B', g: 'arena', nodes: ['a6B'], ph: [P('a6')], lbl: [1176, 775, 4] },
  { id: 'a6c', n: 'ميدان 6C', en: 'Arena 6C', g: 'arena', nodes: ['a6C'], ph: [P('a6')], lbl: [1320, 775, 4] },
  { id: 'sa', n: 'ميدان KRC Stars A', en: 'KRC Stars A', g: 'arena', nodes: ['starsA'], ph: [], lbl: [853, 837, 4] },
  { id: 'sb', n: 'ميدان KRC Stars B', en: 'KRC Stars B', g: 'arena', nodes: ['starsB'], ph: [], lbl: [838, 712, 4] },
  { id: 'pavilion', n: 'جلسة الحديقة', en: 'Garden pavilion', g: 'other', nodes: ['pav'], face: [455, 500], ph: [P('pavilion')], note: 'في وسط الحديقة، أمامك مباشرة عند الخروج من الباب الخلفي للاستقبال.', lbl: [455, 500, 7.5] },
  { id: 'club', n: 'القاعة الزجاجية والمدرجات', en: 'Glass room and stands', g: 'other', nodes: ['club'], face: CLUBP.pav, ph: [P('club')], note: 'القاعة الزجاجية والمدرجات على الضلع المائل للميدان الرئيسي. دورات المياه تحتها والمصلى خلفها.', lbl: [CLUBP.pav[0], CLUBP.pav[1], 10.5] },
  { id: 'gate1', n: 'البوابة الخلفية 1 · الميدان الرئيسي', en: 'Back gate 1, main arena', g: 'other', nodes: ['gate1'], face: [1600, 4], ph: [], note: 'بوابة في السور الخلفي، بين الميدان الرئيسي والميدان الكبير.', lbl: [1600, 8, 4.2] },
  { id: 'gate2', n: 'البوابة الخلفية 2 · إسطبل E', en: 'Back gate 2, Barn E', g: 'other', nodes: ['gate2'], face: [2405, 4], ph: [], note: 'بوابة في السور الخلفي، على الطريق بجانب خيام إسطبل E.', lbl: [2405, 8, 4.2] },
  { id: 'gateA', n: 'البوابة الجانبية · إسطبل A', en: 'Side gate, Barn A', g: 'other', nodes: ['sgate'], face: [831, 4], ph: [P('gateA1'), P('gateA2')], note: 'البوابة الحديدية مع كشك الحارس الأبيض، في آخر الطريق بعد إسطبل A.', lbl: [831, 8, 4.2] },
  { id: 'judges', n: 'برج الحكام', en: 'Judges’ tower', g: 'other', nodes: ['jt'], face: [1268, 620], ph: [P('judges')], note: 'البرج ذو الطابقين بين الميدان الرئيسي وميدان 6.', lbl: [1268, 590, 9.5] },
  { id: 'walker', n: 'جهاز مشي الخيل · إسطبل B', en: 'Horse walker, Barn B', g: 'other', nodes: ['wkr'], face: [265, 849], ph: [P('walker')], note: 'خلف إسطبل B، مقابل دورة مياه الرجال.', lbl: [265, 849, 4.2] },
  { id: 'equine', n: 'اكوين هوم', en: 'Equine Home', g: 'barn', nodes: ['eqh'], face: [2032, 760], ph: [], note: 'المبنى البني الملاصق للطرف الشرقي لإسطبل C.', lbl: [2032, 800, 6] },
  { id: 'walker2', n: 'جهاز مشي الخيل · إسطبل C', en: 'Horse walker, Barn C', g: 'other', nodes: ['c1'], face: [2257, 652], ph: [], note: 'قرب إسطبل C. بنفس تصميم جهاز المشي خلف إسطبل B.', lbl: [2257, 652, 4.2] }
];
/* English for the place notes and for the spot phrases on the path nodes */
const NOTE_EN = {
  entrance: 'The car park side of the main gate. Reception is the middle door.',
  reception: 'Inside the main entrance building. The back door opens onto the garden.',
  wc_rec: 'Inside Reception, in the side corridor next to the back door.',
  wc_w: 'The corner door at the end of Barn A, opposite the tack shop.',
  wc_m: 'The corner door at the end of Barn B, next to the cafeteria.',
  wc_cw: 'Inside Barn C. The route takes you to the barn’s main door; the exact spot inside is not mapped yet.',
  wc_cm: 'Inside Barn C. The route takes you to the barn’s main door; the exact spot inside is not mapped yet.',
  wc_club: 'Under the glass room. The door is at ground level next to the stairs.',
  shop: 'Two doors: one from the car park, and one inside the centre opposite Barn A.',
  admin: 'Next to the tack shop, inside the centre.',
  cafe: 'The order window is on the wall of Barn B, next to the men’s restroom.',
  tackB: 'The two-storey building at the east end of Barn B, opposite the barn’s end door.',
  washB: 'Between the tack room and the Barn B aisle, at the east end.',
  prayer: 'Behind the glass room. A low stone building with two doors.',
  barnA: 'The main door is on the long side facing Arena 1 and Arena 2. Search for a box number like A-9.',
  barnB: 'The main door is on the long side facing Arena 4 and Arena 3, with a second door at the east end by the tack room. Search for a box number like B-17.',
  barnD: 'Sixteen boxes under the arched canopy, on your right as you leave Reception by the back door.',
  barnC: 'The large barn at the back on the right. The main door faces the arenas, and the restrooms are inside.',
  barnE: 'The three white tents side by side at the back on the left. Box numbers are not added yet.',
  barnZ: 'The single white tent at the back on the right.',
  equine: 'The brown building against the east end of Barn C.',
  outB: 'The row of boxes under the flat roof next to the Barn B tack room.',
  lunge: 'The round arena opposite Barn E. Not photographed yet.',
  pavilion: 'In the middle of the garden, straight ahead as you leave Reception by the back door.',
  club: 'The glass room and stands on the angled side of the main arena. The restrooms are underneath and the prayer room is behind.',
  gate1: 'A gate in the back wall, between the main arena and the large arena.',
  gate2: 'A gate in the back wall, on the road beside the Barn E tents.',
  gateA: 'The iron gate with the white guard booth, at the end of the road past Barn A.',
  judges: 'The two-storey tower between the main arena and Arena 6.',
  walker: 'Behind Barn B, opposite the men’s restroom.',
  walker2: 'Near Barn C. The same design as the walker behind Barn B.'
};
const AT_EN = {
  'داخل الاستقبال': 'inside Reception', 'في الساحة خلف الاستقبال': 'in the yard behind Reception', 'عند الممر الرئيسي': 'at the main walkway',
  'عند ميدان 1': 'at Arena 1', 'عند زاوية إسطبل A': 'at the corner of Barn A', 'عند طرف إسطبل A': 'at the end of Barn A',
  'مقابل محل المستلزمات': 'opposite the tack shop', 'عند محل المستلزمات': 'at the tack shop', 'عند ميدان 4': 'at Arena 4',
  'عند زاوية إسطبل B': 'at the corner of Barn B', 'عند طرف إسطبل B': 'at the end of Barn B', 'عند جلسة الحديقة': 'at the garden pavilion',
  'أمام إسطبل A': 'in front of Barn A', 'بين ميدان 1 وميدان 2': 'between Arena 1 and Arena 2', 'بعد الحديقة': 'after the garden',
  'بين ميدان 4 وميدان 3': 'between Arena 4 and Arena 3', 'أمام إسطبل B': 'in front of Barn B', 'عند نهاية إسطبل A': 'at the far end of Barn A',
  'عند الميدان الرئيسي': 'at the main arena', 'بجانب ميدان 2 وميدان 3': 'beside Arena 2 and Arena 3', 'عند طريق الميدان الرئيسي': 'at the main arena road',
  'عند نهاية إسطبل B': 'at the far end of Barn B', 'بعد إسطبل A': 'past Barn A', 'في آخر الطريق': 'at the end of the road',
  'عند ميدان KRC Stars B': 'at KRC Stars B', 'بعد إسطبل C': 'past Barn C', 'عند الحلقة الدائرية': 'at the round pen',
  'عند ميدان KRC Stars A': 'at KRC Stars A', 'بعد ميدان KRC Stars A': 'past KRC Stars A', 'عند السور البعيد': 'at the far wall',
  'عند باب محل المستلزمات': 'at the tack shop door', 'عند الطرف الشرقي لإسطبل B': 'at the east end of Barn B', 'عند الطرف الشرقي لإسطبل C': 'at the east end of Barn C', 'عند بوابة الميدان الرئيسي': 'at the main arena gate'
};
PLACES.forEach(p => { p.ne = NOTE_EN[p.id]; });
const PBY = {}; PLACES.forEach(p => { PBY[p.id] = p; });
function boxPlace(num) {
  const b = DBOX[num]; if (!b) return null;
  return { id: 'D-' + num, n: 'بوكس D-' + num, en: 'Box D-' + num, g: 'Barn D', nodes: ['da' + b.k], face: [b.x / S + W / 2, b.z / S + H / 2], ph: num <= 2 ? [P('boxD'), P('barnD')] : [P('barnD')], box: num, note: 'إسطبل D، الصف ' + (b.sx > 0 ? 'الأيسر' : 'الأيمن') + ' وأنت داخل من جهة الاستقبال.', ne: 'Barn D, the ' + (b.sx > 0 ? 'left' : 'right') + ' row as you come in from the Reception end.' };
}


/* ---------- boxes inside Barns A, B and C, from the club's barn map (Sep 2026) ----------
   Each plan is drawn with the east end at the top: in Barn B the walker and the cafeteria are at the bottom,
   and they stand at the west end. Rows are listed top (east) to bottom (west); 0 is a door, wash room or
   tack room. z is metres from the barn's centre line, north negative. Only numbers are used: the map is public. */
const pxOf = (x, z) => [x / S + W / 2, z / S + H / 2];
/* doors: at the ends of the aisles, plus the side doors that are already on the path network */
(function () {
  const endNode = (id, b, ai, end) => { const I = INB[b].info, p = pxOf(I.cx + end * (I.w / 2 + 3.6), I.cz + INB[b].aisles[ai].z); node(id, p[0], p[1]); (INB[b].aisles[ai].doors = INB[b].aisles[ai].doors || []).push({ id, end }); };
  const sideDoor = (id, b, ai, side) => (INB[b].aisles[ai].doors = INB[b].aisles[ai].doors || []).push({ id, side });
  endNode('aE', 'A', 0, 1); endNode('aW', 'A', 0, -1); sideDoor('barnA', 'A', 0, 1); edge('aE', 'n1'); edge('aW', 'sst'); edge('aW', 'swc');
  endNode('bE1', 'B', 0, 1); sideDoor('barnB', 'B', 0, -1); endNode('bE2', 'B', 1, 1); endNode('bW2', 'B', 1, -1); edge('bE1', 'bE'); edge('bE2', 'bE'); edge('bW2', 'sS3'); edge('bW2', 'wkr');
  /* Barn C's east-end doors open on to Equine Home, so routes use the west ends and the north side door */
  endNode('cW1', 'C', 0, -1); sideDoor('barnC', 'C', 0, -1); endNode('cW2', 'C', 1, -1); edge('cW1', 'r3'); edge('cW1', 'cW2');
})();
const BXS = {};
Object.keys(INB).forEach(b => {
  const I = INB[b].info, L = I.w / INB[b].total, xE = I.cx + I.w / 2;
  INB[b].rows.forEach(row => row.ids.forEach((n, i) => {
    if (!n) return; const x = xE - (0.25 + i + 0.5) * L, z = I.cz + row.z;
    BXS[b + '-' + n] = { barn: b, num: n, row, slot: i, x, z, rect: [x - L / 2 + 0.1, z - INB[b].depth / 2, x + L / 2 - 0.1, z + INB[b].depth / 2] };
  }));
});
/* B-43 to B-46 are the outdoor boxes beside Barn B's tack room */
(function () { const x0 = X(800), bl = (X(915) - x0) / 5, z = (Z(906) + Z(919)) / 2; [43, 44, 45, 46].forEach((n, i) => { const x = x0 + (i + 0.5) * bl; BXS['B-' + n] = { barn: 'B', num: n, out: true, x, z, rect: [x - bl / 2 + 0.1, Z(906), x + bl / 2 - 0.1, Z(919)] }; }); })();
function slotX(b, i) { const I = INB[b].info; return I.cx + I.w / 2 - (0.25 + i + 0.5) * I.w / INB[b].total; }
function abcPlace(key) {
  const x = BXS[key]; if (!x) return null; const I = INB[x.barn];
  const nodes = x.out ? ['outB'] : [...new Set(x.row.aisles.flatMap(a => I.aisles[a].doors.map(d => d.id)))];
  return { id: key, n: 'بوكس ' + key, en: 'Box ' + key, g: 'barn', nodes, bx: x, ph: [P('barn' + x.barn)],
    note: x.out ? 'من البوكسات الخارجية بجانب غرفة سروج إسطبل B.' : 'داخل إسطبل ' + x.barn + '. المسار يوصلك لأقرب باب، وآخر خطوة تقول لك وين البوكس.',
    ne: x.out ? 'One of the outdoor boxes beside the Barn B tack room.' : 'Inside Barn ' + x.barn + '. The route takes you to the nearest door, and the last step tells you where the box is.' };
}
const ORD = n => n + (n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th');
/* the last step: which way to go inside the barn, which side the box is on, and how many boxes along */
function insideStep(x, doorId) {
  const key = x.barn + '-' + x.num;
  if (x.out) return L('البوكس ' + key + ' في صف البوكسات الخارجية تحت السقف المسطح.', 'Box ' + key + ' is in the row of outdoor boxes under the flat roof.');
  const I = INB[x.barn]; let door = null, aisle = null;
  I.aisles.forEach(a => (a.doors || []).forEach(d => { if (d.id === doorId) { door = d; aisle = a; } }));
  if (!door) return '';
  const ids = x.row.ids, dX = X(N[doorId].x), hx = door.end ? -door.end : Math.sign(x.x - dX) || 1;
  const right = (x.row.z - aisle.z) * hx > 0, between = i => door.end ? (door.end > 0 ? i <= x.slot : i >= x.slot) : (hx > 0 ? slotX(x.barn, i) <= x.x + 0.1 && slotX(x.barn, i) >= dX : slotX(x.barn, i) >= x.x - 0.1 && slotX(x.barn, i) <= dX);
  const count = ids.filter((n, i) => n && between(i)).length, sideAr = right ? 'على يمينك' : 'على يسارك', sideEn = right ? 'on your right' : 'on your left';
  if (door.end) return L('ادخل من الباب وامشِ في الممر. البوكس ' + key + ' ' + sideAr + '، وهو رقم ' + count + ' في الصف من جهة الباب.',
    'Go in and walk down the aisle. Box ' + key + ' is ' + sideEn + ', the ' + ORD(count) + ' box in the row from the door.');
  const hz = -door.side, turnR = hx * -hz > 0;
  return L('ادخل من الباب الجانبي وانعطف ' + (turnR ? 'يميناً' : 'يساراً') + ' في الممر. البوكس ' + key + ' ' + sideAr + '، وهو رقم ' + count + ' من الباب.',
    'Go in through the side door and turn ' + (turnR ? 'right' : 'left') + ' into the aisle. Box ' + key + ' is ' + sideEn + ', the ' + ORD(count) + ' box from the door.');
}
function stepsFor(path, target) {
  if (!target.bx) return describe(path, target, fromName());
  const x = target.bx, door = { n: x.out ? 'البوكسات الخارجية · إسطبل B' : 'باب إسطبل ' + x.barn, en: x.out ? 'the outdoor boxes, Barn B' : 'the Barn ' + x.barn + ' door' };
  return describe(path, door, fromName()).concat([insideStep(x, path[path.length - 1])]);
}
/* the barn plan in the panel, laid out like the club's sheet: east at the top */
function planABC(b, cur) {
  const I = INB[b], w = el('div', 'plan bplan'), cap = el('div', 'plan-cap', L('مخطط إسطبل ' + b + ' كما في خريطة المركز، والطرف الشرقي فوق. اضغط على أي بوكس.', 'Barn ' + b + ' plan as on the club’s sheet, east end at the top. Tap any box.')); cap.dir = L('rtl', 'ltr'); w.appendChild(cap);
  const g = el('div', 'bgrid'), cols = []; I.rows.forEach((r, i) => { if (r.ids.some(n => n)) cols.push({ r }); const nxt = I.rows[i + 1]; if (nxt && I.aisles.some(a => a.z > r.z && a.z < nxt.z)) cols.push({ aisle: 1 }); });
  g.style.gridTemplateColumns = cols.map(c => c.aisle ? '8px' : '1fr').join(' ');
  cols.forEach((c, ci) => { if (c.aisle) return; c.r.ids.forEach((n, ri) => { if (!n) return; const key = b + '-' + n, bt = el('button', null, String(n)); bt.type = 'button'; bt.setAttribute('data-bx', key); bt.setAttribute('aria-label', L('بوكس ', 'Box ') + key); bt.style.gridColumn = ci + 1; bt.style.gridRow = ri + 1; bt.addEventListener('click', () => goTo(abcPlace(key))); g.appendChild(bt); }); });
  w.appendChild(g);
  if (b === 'B') { const o = el('div', 'plan-row'); [43, 44, 45, 46].forEach(n => { const key = 'B-' + n, bt = el('button', null, String(n)); bt.type = 'button'; bt.setAttribute('data-bx', key); bt.addEventListener('click', () => goTo(abcPlace(key))); o.appendChild(bt); }); const c2 = el('div', 'plan-cap', L('البوكسات الخارجية', 'Outdoor boxes')); c2.dir = cap.dir; w.appendChild(c2); w.appendChild(o); }
  return w;
}

function shortest(src, dsts) {
  const dist = {}, prev = {}, done = {}; for (const k in N) dist[k] = 1e12; dist[src] = 0;
  for (; ;) {
    let best = 1e12, u = null; for (const k in N) if (!done[k] && dist[k] < best) { best = dist[k]; u = k; } if (u === null) break; done[u] = 1;
    for (const e of ADJ[u]) if (dist[u] + e[1] < dist[e[0]]) { dist[e[0]] = dist[u] + e[1]; prev[e[0]] = u; }
  }
  let t = null; dsts.forEach(d => { if (t === null || dist[d] < dist[t]) t = d; }); if (dist[t] >= 1e12) return null;
  const path = [t]; while (path[0] !== src) path.unshift(prev[path[0]]); return path;
}
function nearestNode(x, z) { let best = null, bd = 1e12; for (const k in N) { const d = Math.hypot(X(N[k].x) - x, Z(N[k].z) - z); if (d < bd) { bd = d; best = k; } } return best; }
function turnSide(a, b, c) { const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]), dt = (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]); return Math.atan2(cr, dt); }
function describe(path, target, fromName) {
  const st = [L('ابدأ من ' + fromName + '.', 'Start at ' + fromName + '.')], RINGN = { pvW: 1, pvN: 1, pvE: 1, pvS: 1 }; let last = '';
  const side = a => a > 0 ? L('يميناً', 'right') : L('يساراً', 'left');
  if (path[0] === 'park' && path[1] === 'out0') st.push(L('وأنت مقابل البوابة، امشِ يساراً بمحاذاة السور الخارجي.', 'Facing the gate, walk left along the outer wall.'));
  for (let i = 1; i < path.length - 1; i++) {
    const id = path[i], a = N[path[i - 1]], b = N[id], c = N[path[i + 1]]; let s = '';
    if (id === 'rec' && path[i - 1] === 'gw' && path[i + 1] === 'ge') s = L('ادخل من الباب الأوسط، مروراً بالاستقبال، واخرج من الباب الخلفي.', 'Go in through the middle door, through Reception, and out of the back door.');
    else if (id === 'rec' && path[i - 1] === 'ge' && path[i + 1] === 'gw') s = L('مُرّ عبر الاستقبال واخرج من الباب الأمامي.', 'Go through Reception and out of the front door.');
    else if (id === 'gw' && path[i + 1] === 'rec') s = '';
    else if (id === 'dn' && path[i + 1] === 'da0') s = L('ادخل تحت مظلة إسطبل D.', 'Go in under the Barn D canopy.');
    else if (RINGN[id]) { if (!RINGN[path[i - 1]]) { const ar = turnSide([a.x, a.z], [b.x, b.z], [c.x, c.z]); if (Math.abs(ar) > 0.6 && RINGN[path[i + 1]]) s = L('دُر ' + side(ar) + ' حول جلسة الحديقة.', 'Go ' + side(ar) + ' around the garden pavilion.'); } }
    else {
      const an = turnSide([a.x, a.z], [b.x, b.z], [c.x, c.z]), at = b.at ? L(b.at, AT_EN[b.at] || '') : '';
      if (Math.abs(an) > 0.6) s = L('انعطف ', 'Turn ') + side(an) + (at ? ' ' + at : '') + '.';
    }
    if (s && s !== last) { st.push(s); last = s; }
  }
  const end = path[path.length - 1], f = (target.faces && target.faces[end]) || target.face, tn = nm(target); let arr = L('وصلت: ' + tn + '.', 'You have arrived: ' + tn + '.');
  if (f && path.length > 1) {
    const p = N[path[path.length - 2]], q = N[end], an2 = turnSide([p.x, p.z], [q.x, q.z], f), far = Math.hypot(f[0] - q.x, f[1] - q.z) > 3;
    if (far) arr = Math.abs(an2) < 0.6 ? L(tn + ' أمامك مباشرة.', tn + ' is straight ahead.') : an2 > 0 ? L(tn + ' على يمينك.', tn + ' is on your right.') : L(tn + ' على يسارك.', tn + ' is on your left.');
  }
  st.push(arr); return st;
}

/* ---------- camera and modes ---------- */
let mode = 'orbit', cw = 1, ch = 1, active = false;
const HOME = { x: X(760), z: Z(490), az: Math.PI, pol: 1.0, dist: 230 };
const ob = { x: HOME.x, z: HOME.z, az: HOME.az, pol: HOME.pol, dist: HOME.dist }; let goal = null;
const wk = { x: X(30), z: Z(495), yaw: 0, pitch: 0.08 };
let keys = {}; const jv = { x: 0, y: 0 };
const noMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
let route = null, curTarget = null, fromId = 'entrance'; const guide = { on: false, s: 0, speed: 8 };

function blocked(x, z) {
  const m = 0.45; if (x < X(6) || x > X(W - 6) || z < Z(6) || z > Z(H - 6)) return true;
  for (const b of boxes) if (x > b[0] - m && x < b[2] + m && z > b[1] - m && z < b[3] + m) return true;
  for (const b of circles) if ((x - b[0]) * (x - b[0]) + (z - b[1]) * (z - b[1]) < b[2] * b[2]) return true;
  return false;
}
function toast(t) { const e = $('toast'); e.textContent = t; e.hidden = !t; clearTimeout(toast.t); if (t) toast.t = setTimeout(() => { e.hidden = true; }, 5200); }
function setMode(m) {
  mode = m; $('mWalk').setAttribute('aria-pressed', m === 'walk'); $('mOrbit').setAttribute('aria-pressed', m === 'orbit');
  $('joy').hidden = m !== 'walk'; $('zIn').hidden = $('zOut').hidden = m === 'walk';
  goal = null; if (m !== 'walk') stopGuide();
}
const HINT = {
  get walk() { return L('اسحب لتنظر حولك · استخدم العصا أو الأسهم للمشي', 'Drag to look around · use the joystick or arrow keys to walk'); },
  get orbit() { return COARSE ? L('اسحب للتدوير · قرّب بإصبعين', 'Drag to rotate · pinch to zoom') : L('اسحب للتدوير · قرّب بالعجلة · اضغط على أي مكان', 'Drag to rotate · scroll to zoom · click any place'); }
};
function stopGuide() { guide.on = false; $('stop').hidden = true; }
function pointAt(s) {
  const c = route.cum, p = route.pts; let i = 1; s = Math.max(0, Math.min(route.total, s)); while (i < c.length - 1 && c[i] < s) i++;
  const l = c[i] - c[i - 1], t = l > 0 ? (s - c[i - 1]) / l : 0; return [p[i - 1][0] + (p[i][0] - p[i - 1][0]) * t, p[i - 1][1] + (p[i][1] - p[i - 1][1]) * t];
}
function frameRoute() {
  const p = route.pts; let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9; p.forEach(q => { x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); z0 = Math.min(z0, q[1]); z1 = Math.max(z1, q[1]); });
  if (route.barnD) { x0 = Math.min(x0, X(215)); x1 = Math.max(x1, X(295)); z1 = Math.max(z1, Z(762)); }
  x0 = Math.min(x0, route.pin[0]); x1 = Math.max(x1, route.pin[0]); z0 = Math.min(z0, route.pin[1]); z1 = Math.max(z1, route.pin[1]);
  const pt = padTarget(), fw = Math.max(0.25, (cw - pt[0]) / cw), fh = Math.max(0.25, (PHONE.matches ? ch - Math.min(sheetH, ch * 0.62) - PHONE_TOP : ch - pt[1]) / ch), asp = cw / ch;
  /* look along whichever axis lets the camera come closest: on a tall phone screen a long route turns to run up it */
  const fit = (a, b) => Math.max((a + 60) / (0.82 * asp * fw), (b + 40) / (0.75 * fh)), dN = fit(x1 - x0, z1 - z0), dT = fit(z1 - z0, x1 - x0), turn = dT < dN * 0.9, d = turn ? dT : dN;
  const g = { x: (x0 + x1) / 2, z: (z0 + z1) / 2 + 2, az: turn ? Math.PI : Math.PI / 2, pol: d > 450 ? 0.4 : 0.55, dist: Math.min(1200, Math.max(48, d)) };
  if (noMotion) { Object.assign(ob, g); goal = null; } else goal = g;
}
function startGuide() {
  if (!route) return; setMode('walk'); const a = route.pts[0], b = route.pts[Math.min(1, route.pts.length - 1)]; wk.x = a[0]; wk.z = a[1]; wk.pitch = 0.03;
  if (route.total > 0.5) { wk.yaw = Math.atan2(b[1] - a[1], b[0] - a[0]); guide.on = true; guide.s = 0; guide.speed = Math.min(13, Math.max(5.5, route.total / 20)); $('stop').hidden = false; toast(''); }
}
function clearRoute() { route = null; curTarget = null; stopGuide(); $('pin').hidden = true; routeMesh.visible = false; if (MESH.droof) MESH.droof.visible = true; renderResult(); markList(); if (PHONE.matches) sheetTo('peek'); }
function fromNode() { if (fromId === 'here') return nearestNode(wk.x, wk.z); const p = PBY[fromId]; return p && p.nodes ? p.nodes[0] : 'park'; }
function fromName() { return fromId === 'here' ? L('مكان وقوفك', 'where you are standing') : nm(PBY[fromId]); }
function goTo(target, keepView) {
  if (!target || !target.nodes) return;
  const src = fromNode(), path = shortest(src, target.nodes); if (!path) return;
  const pts = path.map(id => [X(N[id].x), Z(N[id].z)]), cum = [0];
  if (target.bx && !target.bx.out) {
    const x = target.bx, I = INB[x.barn]; let door = null, aisle = null;
    I.aisles.forEach(a => (a.doors || []).forEach(dd => { if (dd.id === path[path.length - 1]) { door = dd; aisle = a; } }));
    if (door) { const az = I.info.cz + aisle.z, lp = pts[pts.length - 1]; pts.push(door.end ? [I.info.cx + door.end * (I.info.w / 2 - 1), az] : [lp[0], az], [x.x, az]); }
  }
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const end = path[path.length - 1], f = (target.faces && target.faces[end]) || target.face; let pin = f ? [X(f[0]), Z(f[1])] : pts[pts.length - 1];
  if (target.box) { const b = DBOX[target.box]; pin = [b.x, b.z]; }
  if (target.bx) pin = [target.bx.x, target.bx.z];
  route = { path, pts, cum, total: cum[cum.length - 1], target, steps: stepsFor(path, target), pin, box: target.box || 0, barnD: target.id === 'barnD' || !!target.box,
    rect: target.bx ? target.bx.rect : null, plan: target.bx ? target.bx.barn : ({ barnA: 'A', barnB: 'B', barnC: 'C' })[target.id] || null };
  curTarget = target; stopGuide(); renderResult(); markList();
  $('pin').textContent = nm(target); $('pin').hidden = false;
  if (PHONE.matches) { qEl.blur(); sheetTo('half'); }
  if (mode === 'walk' && !keepView) startGuide(); else if (!keepView) { setMode('orbit'); frameRoute(); }
}

/* ---------- sheet ---------- */
const listEl = $('list'), qEl = $('q'), fromEl = $('from'), tabsEl = $('tabs');
function el(tag, cls, txt) { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
const ico = n => '<svg class="ic" aria-hidden="true"><use href="#i-' + n + '"/></svg>';
/* the icon shown in a place's bubble: a symbol from index.html, or short text such as WC */
const PICON = { reception: 'bell', entrance: 'door', shop: 'bag', admin: 'building', cafe: 'coffee', tackB: 'bag', washB: 'drop', prayer: 'moon', outB: 'barn', pavilion: 'tree', club: 'building', gateA: 'gate', gate1: 'gate', gate2: 'gate', judges: 'tower', walker: 'rotate', walker2: 'rotate', lunge: 'rotate' };
function placeIcon(p) { if (/^wc/.test(p.id)) return { t: 'WC' }; if (PICON[p.id]) return { i: PICON[p.id] }; return { i: p.g === 'barn' || p.box ? 'barn' : p.g === 'arena' ? 'flag' : 'pin' }; }
function bubble(p) { const b = el('span', 'bub'), ic = placeIcon(p); if (ic.t) b.textContent = ic.t; else b.innerHTML = ico(ic.i); return b; }
const AR_DIG = { '٠': 0, '١': 1, '٢': 2, '٣': 3, '٤': 4, '٥': 5, '٦': 6, '٧': 7, '٨': 8, '٩': 9 };
function parseBox(s) { s = s.replace(/[٠-٩]/g, d => AR_DIG[d]); const m = /^\s*(?:box\s*|بوكس\s*)?([a-e])\s*[- ]?\s*(\d{1,2})\s*$/i.exec(s); return m ? { barn: m[1].toUpperCase(), num: +m[2] } : null; }
function markList() {
  listEl.querySelectorAll('button[data-id]').forEach(b => { if (curTarget && b.getAttribute('data-id') === curTarget.id) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current'); });
  document.querySelectorAll('.plan button').forEach(b => { const on = curTarget && (b.hasAttribute('data-bx') ? curTarget.id === b.getAttribute('data-bx') : curTarget.box === +b.getAttribute('data-box')); if (on) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current'); });
}
const CATS = [['svc', 'الخدمات', 'Services', 'bell'], ['barn', 'الإسطبلات', 'Barns', 'barn'], ['arena', 'الميادين', 'Arenas', 'flag'], ['other', 'أماكن أخرى', 'Other places', 'pin']]; let cat = 'svc';
function itemBtn(p, label, sub) {
  const b = el('button', 'item'), t = el('span', 'txt'), sm = el('small', null, sub || alt(p)); b.type = 'button'; b.appendChild(bubble(p));
  t.appendChild(el('span', null, label || nm(p))); sm.dir = 'auto'; t.appendChild(sm); b.appendChild(t);
  if (p.id) b.setAttribute('data-id', p.id); b.addEventListener('click', () => goTo(p)); return b;
}
CATS.forEach(([g, ar, en, icon]) => {
  const b = el('button'); b.innerHTML = ico(icon); b.appendChild(el('span', null, L(ar, en))); b.type = 'button'; b.setAttribute('aria-pressed', g === cat);
  b.addEventListener('click', () => { cat = g; [...tabsEl.children].forEach(c => c.setAttribute('aria-pressed', c === b)); renderList(); }); tabsEl.appendChild(b);
});
function renderList() {
  const q = qEl.value.trim().toLowerCase(), bx = parseBox(qEl.value); listEl.textContent = '';
  if (bx) {
    const wrap = el('div', 'grp');
    const key = bx.barn + '-' + bx.num;
    if (bx.barn === 'D' && DBOX[bx.num]) wrap.appendChild(itemBtn(boxPlace(bx.num), L('بوكس D-', 'Box D-') + bx.num, L('إسطبل D', 'Barn D')));
    else if (BXS[key]) wrap.appendChild(itemBtn(abcPlace(key), L('بوكس ', 'Box ') + key, L('إسطبل ', 'Barn ') + bx.barn));
    else if (bx.barn === 'D') wrap.appendChild(el('p', 'empty', L('إسطبل D فيه البوكسات من 1 إلى 16.', 'Barn D has boxes 1 to 16.')));
    else {
      const pb = PBY['barn' + bx.barn], MAXB = { A: 25, B: 46, C: 84 };
      if (MAXB[bx.barn]) { wrap.appendChild(el('p', 'empty', L('إسطبل ' + bx.barn + ' فيه البوكسات من 1 إلى ' + MAXB[bx.barn] + '.', 'Barn ' + bx.barn + ' has boxes 1 to ' + MAXB[bx.barn] + '.'))); if (pb) wrap.appendChild(itemBtn(pb)); listEl.appendChild(wrap); tabsEl.hidden = true; return; }
      wrap.appendChild(el('p', 'empty', L('أرقام بوكسات إسطبل ' + bx.barn + ' لم تُضَف بعد.', 'Box numbers for Barn ' + bx.barn + ' are not added yet.') + (pb ? L(' يمكنك الذهاب إلى الإسطبل نفسه.', ' You can go to the barn itself.') : '')));
      if (pb) wrap.appendChild(itemBtn(pb));
    }
    listEl.appendChild(wrap); tabsEl.hidden = true; return;
  }
  let any = false;
  CATS.forEach(([g, ar, en]) => {
    if (!q && g !== cat) return;
    const items = PLACES.filter(p => p.g === g && (!q || p.n.toLowerCase().includes(q) || p.en.toLowerCase().includes(q))); if (!items.length) return; any = true;
    const wrap = el('div', 'grp'); if (q) wrap.appendChild(el('h3', null, L(ar, en)));
    items.forEach(p => wrap.appendChild(itemBtn(p)));
    listEl.appendChild(wrap);
  });
  if (!any) listEl.appendChild(el('p', 'empty', L('لا يوجد مكان بهذا الاسم. جرّب اسماً آخر أو رقم بوكس مثل D-9.', 'No place by that name. Try another name, or a box number like D-9.')));
  tabsEl.hidden = !!q; markList();
}
function planEl() {
  const w = el('div', 'plan'), cap = el('div', 'plan-cap', L('بوكسات إسطبل D · جهة الاستقبال على اليسار. اضغط على أي بوكس.', 'Barn D boxes · the Reception end is on the left. Tap any box.')); cap.dir = L('rtl', 'ltr'); w.appendChild(cap);
  [[8, 7, 6, 5, 4, 3, 2, 1], [9, 10, 11, 12, 13, 14, 15, 16]].forEach((row, ri) => {
    const r = el('div', 'plan-row'); r.setAttribute('aria-label', ri ? L('الصف الأيمن', 'Right row') : L('الصف الأيسر', 'Left row'));
    row.forEach(n => { const b = el('button', null, String(n)); b.type = 'button'; b.setAttribute('data-box', n); b.setAttribute('aria-label', L('بوكس D-', 'Box D-') + n); b.addEventListener('click', () => goTo(boxPlace(n))); r.appendChild(b); });
    w.appendChild(r); if (!ri) { const a = el('div', 'plan-aisle', L('الممر', 'Aisle')); a.dir = L('rtl', 'ltr'); w.appendChild(a); }
  });
  return w;
}
function renderResult() {
  const r = $('res'); if (!route) { r.hidden = true; $('card').hidden = true; return; } r.hidden = false; const t = route.target;
  $('resT').textContent = nm(t); $('resN').textContent = nt(t); $('resN').hidden = !nt(t);
  const m = $('resM'); m.textContent = ''; const metres = Math.round(route.total), mins = Math.max(1, Math.round(route.total / 70));
  const chip = (icon, txt) => { const c = el('span', 'chip'); c.dir = 'auto'; if (icon) c.innerHTML = ico(icon); c.appendChild(document.createTextNode(txt)); m.appendChild(c); };
  chip('route', metres + L(' م', ' m')); chip('clock', L('حوالي ' + mins + ' د', 'about ' + mins + ' min')); chip(null, alt(t));
  const ol = $('resS'); ol.textContent = ''; route.steps.forEach(s => ol.appendChild(el('li', null, s)));
  $('resSum').textContent = L('الاتجاهات · ' + route.steps.length + ' خطوات', 'Directions · ' + route.steps.length + ' steps'); $('body').scrollTop = 0;
  const d = $('resD'); d.textContent = ''; if (route.barnD) d.appendChild(planEl()); else if (route.plan) d.appendChild(planABC(route.plan)); d.hidden = !route.barnD && !route.plan;
  const p = $('resP'); p.textContent = ''; const ph = t.ph || [];
  ph.forEach(src => { const im = document.createElement('img'); im.src = src; im.alt = L('صورة: ', 'Photo: ') + nm(t); im.loading = 'lazy'; p.appendChild(im); });
  p.className = 'res-p' + (ph.length > 1 ? ' multi' : ''); p.hidden = !ph.length;
  $('cardT').textContent = nm(t); $('cardM').textContent = metres + L(' م · حوالي ' + mins + ' د', ' m · about ' + mins + ' min');
  const ci = $('cardImg'); ci.hidden = !ph.length; if (ph.length) ci.src = ph[0]; $('card').hidden = false;
  markList();
}
function buildFrom() {
  fromEl.textContent = '';
  const o = el('option', null, L('المدخل الرئيسي (المواقف)', 'Main entrance (car park)')); o.value = 'entrance'; fromEl.appendChild(o);
  PLACES.forEach(p => { if (p.id === 'entrance') return; const e = el('option', null, nm(p)); e.value = p.id; fromEl.appendChild(e); });
  const h = el('option', null, L('مكان وقوفي (في وضع المشي)', 'Where I am standing (walk mode)')); h.value = 'here'; fromEl.appendChild(h);
  fromEl.value = fromId;
}
(function () {
  buildFrom();
  fromEl.addEventListener('change', () => { fromId = fromEl.value; if (curTarget) goTo(curTarget, mode === 'walk'); });
  qEl.addEventListener('input', renderList);
  qEl.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return; e.preventDefault(); const bx = parseBox(qEl.value);
    if (bx && bx.barn === 'D' && DBOX[bx.num]) { goTo(boxPlace(bx.num)); return; } if (bx && BXS[bx.barn + '-' + bx.num]) { goTo(abcPlace(bx.barn + '-' + bx.num)); return; } const f = listEl.querySelector('button.item'); if (f) f.click();
  });
  $('resX').addEventListener('click', clearRoute);
  $('goWalk').addEventListener('click', startGuide);
  $('goTop').addEventListener('click', () => { if (!route) return; setMode('orbit'); frameRoute(); });
  $('stop').addEventListener('click', () => { stopGuide(); toast(L('توقّف المشي الموجّه. استخدم العصا لتكمل.', 'Guided walk stopped. Use the joystick to carry on.')); });
  renderList(); renderResult();
})();

/* ---------- bottom sheet on phones: peek, half or full, dragged by its handle ---------- */
const sheetEl = $('sheet'), appEl = $('app'); let sheetState = 'peek', sheetH = 0;
function sheetHeights() { const h = innerHeight; return { peek: Math.ceil($('grab').offsetHeight + sheetEl.querySelector('.head').offsetHeight + 4), half: Math.round(h * 0.5), full: h - 70 }; }
function setSheetH(px) { sheetH = px; appEl.style.setProperty('--sh', px + 'px'); }
function sheetTo(s) { if (!PHONE.matches) return; sheetState = s; setSheetH(sheetHeights()[s]); }
(function () {
  const g = $('grab'); let y0 = 0, h0 = 0, id = null, moved = false;
  g.addEventListener('pointerdown', e => { if (!PHONE.matches) return; id = e.pointerId; y0 = e.clientY; h0 = sheetEl.getBoundingClientRect().height; moved = false; sheetEl.classList.add('dragging'); try { g.setPointerCapture(id); } catch (_) { } });
  g.addEventListener('pointermove', e => { if (e.pointerId !== id) return; const dy = y0 - e.clientY, H = sheetHeights(); if (Math.abs(dy) > 5) moved = true; setSheetH(Math.max(H.peek, Math.min(H.full, h0 + dy))); });
  const end = e => {
    if (e.pointerId !== id) return; id = null; sheetEl.classList.remove('dragging');
    if (!moved) { sheetTo(sheetState === 'peek' ? 'half' : 'peek'); return; }
    const H = sheetHeights(); let best = 'peek'; for (const k of ['half', 'full']) if (Math.abs(H[k] - sheetH) < Math.abs(H[best] - sheetH)) best = k; sheetTo(best);
  };
  g.addEventListener('pointerup', end); g.addEventListener('pointercancel', end);
  g.addEventListener('click', e => { if (e.detail === 0) sheetTo(sheetState === 'peek' ? 'half' : 'peek'); });
  qEl.addEventListener('focus', () => { if (PHONE.matches) sheetTo('full'); });
  PHONE.addEventListener('change', () => { if (PHONE.matches) sheetTo(sheetState); else { appEl.style.removeProperty('--sh'); sheetH = 0; } });
  addEventListener('resize', () => { if (PHONE.matches) sheetTo(sheetState); });
  sheetTo('peek');
})();

/* ---------- labels on the model ---------- */
const LBL = [], lblBox = $('labels');
function addLabel(px, pz, h, place) {
  const s = document.createElement('button'), t = el('span'); s.className = 'lbl'; s.type = 'button'; s.appendChild(bubble(place)); s.appendChild(t);
  s.addEventListener('click', () => goTo(place)); lblBox.appendChild(s);
  const l = { el: s, t, place, v: new THREE.Vector3(X(px), h, Z(pz)), w: 0, pri: 0, far: false }; nameLabel(l); s.hidden = true; LBL.push(l);
}
function nameLabel(l) {
  const n = nm(l.place); l.t.textContent = n; l.el.title = n; l.el.setAttribute('aria-label', n);
  const hid = l.el.hidden; l.el.hidden = false; l.el.classList.remove('far'); l.w = (l.el.offsetWidth || n.length * 8 + 40) + 8; l.el.hidden = hid; if (l.far) l.el.classList.add('far');
}
PLACES.forEach(p => { if (p.lbl) addLabel(p.lbl[0], p.lbl[1], p.lbl[2], p); });

/* ---------- language switch: text, direction, and everything drawn from the data ---------- */
function applyLang(lg) {
  LANG = lg; try { localStorage.setItem('krc-lang', lg); } catch (_) { }
  const d = L('rtl', 'ltr'), de = document.documentElement; de.lang = lg; de.dir = d; appEl.dir = d; appEl.lang = lg;
  document.title = L('خريطة مركز الفروسية', 'Kuwait Riding Center map');
  document.querySelectorAll('[data-ar]').forEach(e => { e.textContent = L(e.dataset.ar, e.dataset.en); });
  document.querySelectorAll('[data-lar]').forEach(e => { const v = L(e.dataset.lar, e.dataset.len); e.setAttribute('aria-label', v); if (e.hasAttribute('title')) e.title = v; });
  qEl.placeholder = L('إلى أين؟ مكان أو بوكس مثل D-9', 'Where to? A place, or a box like D-9'); qEl.setAttribute('aria-label', L('ابحث عن مكان أو بوكس', 'Search for a place or a box'));
  const lb = $('lang'); lb.textContent = L('English', 'عربي'); lb.lang = L('en', 'ar'); lb.setAttribute('aria-label', L('Switch to English', 'التبديل إلى العربية'));
  [...tabsEl.children].forEach((b, i) => { b.lastChild.textContent = L(CATS[i][1], CATS[i][2]); });
  Object.keys(MODELS).forEach(k => { $('mc_' + k).textContent = chipText(k); });
  buildFrom(); renderList();
  if (route) { route.steps = stepsFor(route.path, route.target); $('pin').textContent = nm(route.target); }
  renderResult(); LBL.forEach(nameLabel); setFold(folded);
  if (cw > 1) resize();
}
$('lang').addEventListener('click', () => applyLang(L('en', 'ar')));

/* ---------- desktop panel folds down to its header, so the map gets nearly the whole page ---------- */
let folded = false;
function setFold(v) {
  folded = v; sheetEl.classList.toggle('collapsed', v); appEl.classList.toggle('folded', v);
  const b = $('fold'), t = v ? L('توسيع القائمة', 'Expand the panel') : L('تصغير القائمة', 'Collapse the panel'); b.setAttribute('aria-expanded', !v); b.setAttribute('aria-label', t); b.title = t;
}
$('brand').addEventListener('click', e => { if (!PHONE.matches) setFold(!folded); });
qEl.addEventListener('focus', () => { if (folded) setFold(false); });
if (LANG !== 'ar') applyLang(LANG);

/* ---------- controls ---------- */
$('mOrbit').addEventListener('click', () => { if (mode === 'walk') { ob.x = wk.x; ob.z = wk.z; ob.az = wk.yaw + Math.PI; ob.dist = Math.min(ob.dist, 120); } setMode('orbit'); });
$('mWalk').addEventListener('click', () => {
  if (mode === 'orbit') {
    if (route) { wk.x = route.pts[0][0]; wk.z = route.pts[0][1]; const b = route.pts[Math.min(1, route.pts.length - 1)]; wk.yaw = route.total > 0.5 ? Math.atan2(b[1] - wk.z, b[0] - wk.x) : 0; }
    else if (ob.dist < 200 && !blocked(ob.x, ob.z)) { wk.x = ob.x; wk.z = ob.z; wk.yaw = ob.az + Math.PI; } else { wk.x = X(30); wk.z = Z(495); wk.yaw = 0; } wk.pitch = 0.06;
    toast(HINT.walk);
  }
  setMode('walk');
});
$('zIn').addEventListener('click', () => { goal = null; ob.dist = Math.max(18, ob.dist * 0.75); });
$('zOut').addEventListener('click', () => { goal = null; ob.dist = Math.min(560, ob.dist / 0.75); });
$('home').addEventListener('click', () => { setMode('orbit'); const g = { ...HOME }; if (noMotion) Object.assign(ob, g); else goal = g; });
$('full').addEventListener('click', () => { try { if (document.fullscreenElement) document.exitFullscreen(); else { const r = stage.requestFullscreen && stage.requestFullscreen(); if (r && r.catch) r.catch(() => { }); } } catch (e) { } });

$('cardGo').addEventListener('click', startGuide);
$('north').addEventListener('click', () => { if (mode === 'walk') { wk.yaw = -Math.PI / 2; goal = null; } else goal = { x: ob.x, z: ob.z, az: Math.PI / 2, pol: ob.pol, dist: ob.dist }; });
$('mini').addEventListener('click', e => {
  const r = $('mini').getBoundingClientRect(), x = ((e.clientX - r.left) / r.width - 0.5) * GW, z = ((e.clientY - r.top) / r.height - 0.5) * GH;
  if (mode === 'walk') { if (!blocked(x, z)) { wk.x = x; wk.z = z; stopGuide(); } else toast(L('هذا المكان داخل مبنى. اختر نقطة في الممر.', 'That spot is inside a building. Pick a point on a path.')); }
  else goal = { x, z, az: ob.az, pol: ob.pol, dist: Math.min(ob.dist, 140) };
});
let miniK = '';
function updateMini() {
  const walking = mode === 'walk', x = walking ? wk.x : ob.x, z = walking ? wk.z : ob.z, hd = walking ? wk.yaw : ob.az + Math.PI, m = $('mini');
  const k = (x * 2 | 0) + ',' + (z * 2 | 0) + ',' + (hd * 50 | 0) + mode; if (k === miniK) return; miniK = k;
  const px = (x / GW + 0.5) * m.clientWidth, py = (z / GH + 0.5) * m.clientHeight;
  $('miniDot').style.transform = 'translate(' + px.toFixed(1) + 'px,' + py.toFixed(1) + 'px) rotate(' + hd.toFixed(3) + 'rad)';
  $('needle').style.transform = 'rotate(' + (-Math.PI / 2 - hd).toFixed(3) + 'rad)';
}
const ptr = new Map(); let pinch = 0;
function clampOrbit() { ob.pol = Math.min(1.42, Math.max(0.1, ob.pol)); ob.dist = Math.min(700, Math.max(18, ob.dist)); ob.x = Math.min(GW / 2, Math.max(-GW / 2, ob.x)); ob.z = Math.min(GH / 2, Math.max(-GH / 2, ob.z)); }
function pan(dx, dy) { const s = ob.dist * 0.0017, rx = Math.sin(ob.az), rz = -Math.cos(ob.az), fx = -Math.cos(ob.az), fz = -Math.sin(ob.az); ob.x += -rx * dx * s + fx * dy * s; ob.z += -rz * dx * s + fz * dy * s; }
canvas.addEventListener('pointerdown', e => { active = true; goal = null; if (guide.on) stopGuide(); try { canvas.setPointerCapture(e.pointerId); } catch (_) { } ptr.set(e.pointerId, { x: e.clientX, y: e.clientY, b: e.button, sh: e.shiftKey }); pinch = 0; });
canvas.addEventListener('pointermove', e => {
  const p = ptr.get(e.pointerId); if (!p) return; const dx = e.clientX - p.x, dy = e.clientY - p.y; p.x = e.clientX; p.y = e.clientY;
  if (ptr.size === 1) {
    if (mode === 'walk') { wk.yaw -= dx * 0.0042; wk.pitch = Math.min(1.2, Math.max(-1.0, wk.pitch + dy * 0.0042)); }
    else if (p.b === 2 || p.sh) pan(dx, dy);
    else { ob.az += dx * 0.0052; ob.pol -= dy * 0.0045; }
  } else if (ptr.size === 2 && mode === 'orbit') {
    const a = [...ptr.values()], dd = Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y);
    if (pinch) ob.dist *= pinch / dd; pinch = dd; pan(dx * 0.5, dy * 0.5);
  }
  clampOrbit();
});
const up = e => { ptr.delete(e.pointerId); pinch = 0; };
canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);
canvas.addEventListener('contextmenu', e => e.preventDefault());
stage.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') active = false; });
canvas.addEventListener('wheel', e => { if (!active || mode !== 'orbit') return; e.preventDefault(); goal = null; ob.dist *= Math.exp(e.deltaY * 0.0012); clampOrbit(); }, { passive: false });
addEventListener('keydown', e => {
  if (!active || mode !== 'walk') return; const t = e.target && e.target.tagName; if (t === 'INPUT' || t === 'SELECT') return; const k = e.key.toLowerCase();
  if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'w', 'a', 's', 'd', 'shift'].includes(k)) { keys[k] = true; if (guide.on && k !== 'shift') stopGuide(); if (k.startsWith('arrow')) e.preventDefault(); }
});
addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false; });
addEventListener('blur', () => { keys = {}; });
(function () {
  const joy = $('joy'), knob = $('knob'); let id = null;
  function set(e) { const r = joy.getBoundingClientRect(); let x = (e.clientX - r.left - r.width / 2) / (r.width / 2), y = (e.clientY - r.top - r.height / 2) / (r.height / 2); const l = Math.hypot(x, y); if (l > 1) { x /= l; y /= l; } jv.x = x; jv.y = y; knob.style.transform = 'translate(' + x * 33 + 'px,' + y * 33 + 'px)'; }
  joy.addEventListener('pointerdown', e => { id = e.pointerId; active = true; if (guide.on) stopGuide(); try { joy.setPointerCapture(id); } catch (_) { } set(e); e.preventDefault(); });
  joy.addEventListener('pointermove', e => { if (e.pointerId === id) set(e); });
  const end = e => { if (e.pointerId !== id) return; id = null; jv.x = jv.y = 0; knob.style.transform = ''; };
  joy.addEventListener('pointerup', end); joy.addEventListener('pointercancel', end);
})();

/* ---------- route drawn on the ground ---------- */
/* forest green route with an ivory edge, terracotta destination, brass box highlight: the page palette */
const TEAL = [0.16, 0.31, 0.22], PALE = [0.99, 0.97, 0.92], INK = [0.78, 0.36, 0.24], BOXHL = [0.86, 0.70, 0.40];
const routeGeo = new THREE.BufferGeometry();
const routeMesh = new THREE.Mesh(routeGeo, new THREE.MeshBasicMaterial({ vertexColors: true, depthTest: false, depthWrite: false, toneMapped: false, fog: false }));
routeMesh.renderOrder = 1; routeMesh.frustumCulled = false; routeMesh.visible = false; scene.add(routeMesh);
function dq(a, c, p, q, r, s, col) { for (const v of [p, q, r, p, r, s]) { a.push(v[0], v[1], v[2]); c.push(col[0], col[1], col[2]); } }
function ribbon(a, c, pts, wd, y, col) {
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i - 1], q = pts[i]; let dx = q[0] - p[0], dz = q[1] - p[1]; const l = Math.hypot(dx, dz); if (l < 0.01) continue; dx /= l; dz /= l;
    const nx = -dz * wd / 2, nz = dx * wd / 2, ex = dx * wd / 2, ez = dz * wd / 2;
    dq(a, c, [p[0] - ex + nx, y, p[1] - ez + nz], [q[0] + ex + nx, y, q[1] + ez + nz], [q[0] + ex - nx, y, q[1] + ez - nz], [p[0] - ex - nx, y, p[1] - ez - nz], col);
  }
}
function disc(a, c, x, z, r, y, col) { for (let i = 0; i < 20; i++) { const a0 = i / 20 * 6.2832, a1 = (i + 1) / 20 * 6.2832; for (const v of [[x, y, z], [x + Math.cos(a0) * r, y, z + Math.sin(a0) * r], [x + Math.cos(a1) * r, y, z + Math.sin(a1) * r]]) { a.push(...v); c.push(...col); } } }
function buildRoute(t) {
  const a = [], c = [], p = route.pts, wd = mode === 'walk' ? 1.0 : Math.min(5.5, Math.max(1.1, ob.dist * 0.013));
  if (route.rect) { const r = route.rect; dq(a, c, [r[0], 0.06, r[3]], [r[2], 0.06, r[3]], [r[2], 0.06, r[1]], [r[0], 0.06, r[1]], BOXHL); }
  if (route.box) { const r = DBOX[route.box].rect; dq(a, c, [r[0], 0.06, r[3]], [r[2], 0.06, r[3]], [r[2], 0.06, r[1]], [r[0], 0.06, r[1]], BOXHL); }
  ribbon(a, c, p, wd * 1.5, 0.05, PALE); ribbon(a, c, p, wd, 0.06, TEAL);
  const sp = wd * 3.4; let s = noMotion ? sp / 2 : (t * wd * 1.5) % sp;
  for (; s < route.total - wd; s += sp) {
    const q = pointAt(s), q2 = pointAt(s + 0.3); let dx = q2[0] - q[0], dz = q2[1] - q[1]; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l; const nx = -dz, nz = dx;
    for (const v of [[q[0] + dx * wd * 0.42, 0.07, q[1] + dz * wd * 0.42], [q[0] - dx * wd * 0.25 + nx * wd * 0.34, 0.07, q[1] - dz * wd * 0.25 + nz * wd * 0.34], [q[0] - dx * wd * 0.25 - nx * wd * 0.34, 0.07, q[1] - dz * wd * 0.25 - nz * wd * 0.34]]) { a.push(...v); c.push(...PALE); }
  }
  disc(a, c, p[0][0], p[0][1], wd * 1.15, 0.07, [1, 1, 1]); disc(a, c, p[0][0], p[0][1], wd * 0.75, 0.08, TEAL);
  const e = p[p.length - 1]; disc(a, c, e[0], e[1], wd * 1.35, 0.07, [1, 1, 1]); disc(a, c, e[0], e[1], wd * 0.95, 0.08, INK);
  routeGeo.setAttribute('position', new THREE.Float32BufferAttribute(a, 3)); routeGeo.setAttribute('color', new THREE.Float32BufferAttribute(c.map(linear), 3));
}

/* ---------- loop ---------- */
function resize() {
  const r = stage.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, COARSE ? 1.5 : 2); cw = Math.max(1, Math.round(r.width)); ch = Math.max(1, Math.round(r.height));
  renderer.setPixelRatio(dpr); renderer.setSize(cw, ch, false);
  if (composer) { composer.setPixelRatio(dpr); composer.setSize(cw, ch); }
  sheetW = PHONE.matches ? 0 : sheetEl.getBoundingClientRect().width; applyView();
}
/* the panel covers part of the canvas, so the camera's centre is shifted into the part that stays visible */
const vp = { x: 0, y: 0 }; let sheetW = 0;
/* on phones the top bar and mini map cover about 100px, so the centre sits between them and the sheet */
const PHONE_TOP = 100;
function padTarget() { return PHONE.matches ? [0, Math.max(0, Math.min(sheetH, ch * 0.62) - PHONE_TOP)] : [sheetW && !folded ? sheetW + 32 : 0, 0]; }
function applyView() {
  /* widen the field of view by the same amount, so shifting the centre does not also zoom in */
  camera.fov = 2 * Math.atan(Math.tan(25 * Math.PI / 180) * (ch + vp.y) / ch) * 180 / Math.PI;
  camera.aspect = (cw + vp.x) / (ch + vp.y); camera.setViewOffset(cw + vp.x, ch + vp.y, LANG === 'en' ? 0 : vp.x, vp.y, cw, ch);
}
new ResizeObserver(resize).observe(stage); resize();
if (cw / ch < 0.9) { HOME.dist = 270; ob.dist = 270; }
let visible = true; new IntersectionObserver(en => { visible = en[0].isIntersecting; }).observe(stage);
let last = performance.now(); const pinEl = $('pin');
const angLerp = (a, b, t) => { const d = ((b - a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI; return a + d * t; };
const v3 = new THREE.Vector3();
function proj(v) { v3.copy(v).project(camera); const w = v3.z < 1 ? 1 : -1; return [v3.x, v3.y, w]; }
renderer.shadowMap.needsUpdate = true;
let dbgN = 0, lastFrame = 0;
/* keep drawing at a low rate when the browser pauses animation frames (a background window) */
setInterval(() => { if (performance.now() - lastFrame > 900) { try { frame2(performance.now()); } catch (e) { } } }, 1000);
function frame(now) {
  requestAnimationFrame(frame);
  try { frame2(now); if (++dbgN % 60 === 1 && location.hash === '#debug') { const l = $('loading'); l.hidden = false; l.textContent = 'tris ' + renderer.info.render.triangles + ' calls ' + renderer.info.render.calls + ' size ' + cw + 'x' + ch + ' vis ' + visible + ' hid ' + document.hidden + ' n ' + dbgN; } }
  catch (e) { const l = $('loading'); l.hidden = false; l.textContent = 'خطأ: ' + e.message; throw e; }
}
function frame2(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now; lastFrame = performance.now(); if (cw <= 1) resize(); if (!visible) return;
  let eye, tgt;
  if (mode === 'orbit') {
    if (goal) {
      const t = 1 - Math.exp(-dt * 3.6); ob.x += (goal.x - ob.x) * t; ob.z += (goal.z - ob.z) * t; ob.pol += (goal.pol - ob.pol) * t; ob.dist += (goal.dist - ob.dist) * t; ob.az = angLerp(ob.az, goal.az, t);
      if (Math.abs(goal.dist - ob.dist) < 0.4 && Math.hypot(goal.x - ob.x, goal.z - ob.z) < 0.3 && Math.abs(goal.pol - ob.pol) < 0.01) goal = null;
    }
    const sp = Math.sin(ob.pol); eye = [ob.x + ob.dist * sp * Math.cos(ob.az), ob.dist * Math.cos(ob.pol) + 1.5, ob.z + ob.dist * sp * Math.sin(ob.az)]; tgt = [ob.x, 1.5, ob.z];
  } else {
    if (guide.on && route) {
      guide.s += guide.speed * dt; const q = pointAt(guide.s), q2 = pointAt(guide.s + 3.5); wk.x = q[0]; wk.z = q[1];
      if (Math.hypot(q2[0] - q[0], q2[1] - q[1]) > 0.2) wk.yaw = angLerp(wk.yaw, Math.atan2(q2[1] - q[1], q2[0] - q[0]), 1 - Math.exp(-dt * 3.2));
      wk.pitch += (0.02 - wk.pitch) * (1 - Math.exp(-dt * 3));
      if (guide.s >= route.total) { stopGuide(); wk.yaw = Math.atan2(route.pin[1] - wk.z, route.pin[0] - wk.x) || wk.yaw; toast(L('وصلت: ', 'You have arrived: ') + nm(route.target) + '.'); }
    } else {
      const f = -jv.y + ((keys.w || keys.arrowup) ? 1 : 0) - ((keys.s || keys.arrowdown) ? 1 : 0), st = jv.x + ((keys.d || keys.arrowright) ? 1 : 0) - ((keys.a || keys.arrowleft) ? 1 : 0);
      if (f || st) {
        const spd = (keys.shift ? 12 : 5.5) * dt, cy = Math.cos(wk.yaw), sy = Math.sin(wk.yaw), nx = wk.x + (cy * f - sy * st) * spd, nz = wk.z + (sy * f + cy * st) * spd;
        if (!blocked(nx, wk.z)) wk.x = nx; if (!blocked(wk.x, nz)) wk.z = nz;
      }
    }
    const ey = 1.7 + (Math.hypot(wk.x - PAV.x, wk.z - PAV.z) < PAV.r ? PAV.h : 0), cp = Math.cos(wk.pitch);
    eye = [wk.x, ey, wk.z]; tgt = [wk.x + Math.cos(wk.yaw) * cp, ey + Math.sin(wk.pitch), wk.z + Math.sin(wk.yaw) * cp];
  }
  camera.position.set(eye[0], eye[1], eye[2]); camera.lookAt(tgt[0], tgt[1], tgt[2]);
  { const pt = padTarget(), k = noMotion ? 1 : 1 - Math.exp(-dt * 8); vp.x += (pt[0] - vp.x) * k; vp.y += (pt[1] - vp.y) * k; applyView(); }
  camera.near = mode === 'walk' ? 0.15 : 1.0; camera.updateProjectionMatrix();
  scene.fog.density = mode === 'orbit' ? 0.0011 * Math.min(1, 320 / ob.dist) : 0.0011; /* thinner haze when pulled far back */
  if (route) { buildRoute(now / 1000); routeMesh.visible = true; } else routeMesh.visible = false;
  if (MESH.droof) MESH.droof.visible = !(route && route.barnD && mode === 'orbit');
  { const open = route && route.plan && mode === 'orbit' ? route.plan : null; if (open !== roofOpen) { roofOpen = open; for (const k in ROOFSET) ROOFSET[k].forEach(m => { m.visible = k !== open; }); renderer.shadowMap.needsUpdate = true; } }
  if (composer) composer.render(); else renderer.render(scene, camera);
  updateMini();
  /* labels */
  const lim = mode === 'walk' ? 42 : ob.dist * 2.6 + 40, cand = [], placed = [];
  if (route) {
    const pr = proj(new THREE.Vector3(route.pin[0], route.box ? 2.7 : route.rect ? 7.5 : 5, route.pin[1]));
    if (pr[2] > 0 && Math.abs(pr[0]) < 1.1 && Math.abs(pr[1]) < 1.1) { const px = (pr[0] * 0.5 + 0.5) * cw, py = (-pr[1] * 0.5 + 0.5) * ch; pinEl.style.transform = 'translate(-50%,-100%) translate(' + px.toFixed(1) + 'px,' + (py - 8).toFixed(1) + 'px)'; if (pinEl.hidden) pinEl.hidden = false; placed.push({ sx: px, sy: py - 22, cw: pinEl.offsetWidth + 10 }); }
    else if (!pinEl.hidden) pinEl.hidden = true;
  }
  for (const l of LBL) {
    const pr = proj(l.v), dd = camera.position.distanceTo(l.v); l.on = false;
    if (pr[2] > 0 && Math.abs(pr[0]) < 1.02 && Math.abs(pr[1]) < 0.94 && dd < lim && dd > 8) { l.sx = (pr[0] * 0.5 + 0.5) * cw; l.sy = (-pr[1] * 0.5 + 0.5) * ch; l.d = dd + l.pri * 40; cand.push(l); }
  }
  cand.sort((p, q) => p.d - q.d);
  /* the nearest names are written out; further ones shrink to their icon */
  let named = 0;
  for (const l of cand) {
    const far = mode === 'orbit' && named >= (PHONE.matches ? 5 : 10) && camera.position.distanceTo(l.v) > 110, w = far ? 34 : l.w;
    let ok = true; for (const q3 of placed) { if (Math.abs(l.sx - q3.sx) < (w + q3.cw) / 2 && Math.abs(l.sy - q3.sy) < 28) { ok = false; break; } }
    if (ok) {
      l.cw = w; placed.push(l); l.on = true; if (!far) named++;
      if (far !== l.far) { l.far = far; l.el.classList.toggle('far', far); }
      l.el.style.transform = 'translate(-50%,-50%) translate(' + l.sx.toFixed(1) + 'px,' + l.sy.toFixed(1) + 'px)';
    }
  }
  for (const l of LBL) if (l.el.hidden === l.on) l.el.hidden = !l.on;
}
setMode('orbit');
if (location.hash === '#debug') window.KRC = { ob, wk, setMode, X, Z, S, renderer, scene, MAT, MESH, sun, hemi, groundMat, gtao, THREE };
requestAnimationFrame(frame);
setTimeout(loaderDone, 15000);
