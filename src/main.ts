import './style.css';
import { mulberry32 } from './rng';
import { stepPlayer, steelLeap, surfaceAt, resolveWalls, metalsNear, newPlayerState, GRID, gkey } from './sim';
import type { Metal, Roof, SimWorld, PlayerState, PlayerInput } from './sim';
import { netStart, netSend, netPeers, netConnected, netInterpolated } from './net';
import * as combat from './combat';
import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';

/* ===================================================================
   LUTHADEL — Nights of Ash
   A first-person walk through the misted streets of the Final Empire.
   Unofficial, non-commercial Mistborn fan project.
   All in-world geometry, art and text here is original.
=================================================================== */

// ONE fixed, canonical Luthadel — the same city every load, like a proper FPS map, so players
// learn it and get better over time. `rnd()` is a seeded PRNG on a constant SEED used for ALL
// world-gen, so the layout is deterministic (the render loop uses no randomness). That
// determinism is also what lets every client build the identical map for multiplayer — the
// server only has to sync players, never the world.
const SEED = 1337;
const rng = mulberry32(SEED);
const rnd = () => rng();
const rand = (a: number, b: number) => a + rnd() * (b - a);
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

// ---- procedural textures (so the project ships with no image assets) ----

function softSprite(inner: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, inner);
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// a billowing mist puff — overlapping soft blobs, so it reads as cloud not disc
function mistPuff(): THREE.CanvasTexture {
  const S = 128;
  const c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d')!;
  for (let i = 0; i < 16; i++) {
    const x = rand(S * 0.28, S * 0.72), y = rand(S * 0.34, S * 0.66), r = rand(S * 0.1, S * 0.28);
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, `rgba(224,220,214,${rand(0.06, 0.14)})`);
    gr.addColorStop(1, 'rgba(224,220,214,0)');
    g.fillStyle = gr; g.fillRect(0, 0, S, S);
  }
  // mask to a soft circle so the square sprite edge can never show
  g.globalCompositeOperation = 'destination-in';
  const mask = g.createRadialGradient(S / 2, S / 2, S * 0.08, S / 2, S / 2, S * 0.5);
  mask.addColorStop(0, 'rgba(0,0,0,1)'); mask.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = mask; g.fillRect(0, 0, S, S);
  g.globalCompositeOperation = 'source-over';
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// turn a grayscale height canvas into a tangent-space normal map (Sobel)
function heightToNormal(src: HTMLCanvasElement, strength = 2): THREE.CanvasTexture {
  const w = src.width, h = src.height;
  const sd = src.getContext('2d')!.getImageData(0, 0, w, h).data;
  const out = document.createElement('canvas'); out.width = w; out.height = h;
  const og = out.getContext('2d')!;
  const od = og.createImageData(w, h);
  const H = (x: number, y: number) => sd[(((y + h) % h) * w + ((x + w) % w)) * 4] / 255;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (H(x - 1, y) - H(x + 1, y)) * strength;
      const dy = (H(x, y - 1) - H(x, y + 1)) * strength;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * w + x) * 4;
      od.data[i] = (dx / len * 0.5 + 0.5) * 255;
      od.data[i + 1] = (dy / len * 0.5 + 0.5) * 255;
      od.data[i + 2] = (1 / len * 0.5 + 0.5) * 255;
      od.data[i + 3] = 255;
    }
  }
  og.putImageData(od, 0, 0);
  const t = new THREE.CanvasTexture(out);            // linear data — no sRGB
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

// cobblestone: colour + normal (real relief) + roughness (wet, lamp-catching patches)
function cobbleSet() {
  const S = 512;
  const col = document.createElement('canvas'); col.width = col.height = S;
  const hgt = document.createElement('canvas'); hgt.width = hgt.height = S;
  const rgh = document.createElement('canvas'); rgh.width = rgh.height = S;
  const g = col.getContext('2d')!, gh = hgt.getContext('2d')!, gr = rgh.getContext('2d')!;
  g.fillStyle = '#080705'; g.fillRect(0, 0, S, S);          // soot-clogged grooves
  gh.fillStyle = '#202020'; gh.fillRect(0, 0, S, S);        // groove floor sits low
  gr.fillStyle = '#bdbdbd'; gr.fillRect(0, 0, S, S);        // mostly rough/dry
  // toroidal-wrapped ellipse so the texture tiles with NO seam (the old centre-line bug)
  const ell = (ctx: CanvasRenderingContext2D, cx: number, cy: number, rx: number, ry: number, rot: number) => {
    for (let ox = -S; ox <= S; ox += S) for (let oy = -S; oy <= S; oy += S) {
      if (cx + ox + rx < 0 || cx + ox - rx > S || cy + oy + ry < 0 || cy + oy - ry > S) continue;
      ctx.beginPath(); ctx.ellipse(cx + ox, cy + oy, rx, ry, rot, 0, 7); ctx.fill();
    }
  };
  // tightly-packed, flat-topped setts (overlap so only thin grooves remain)
  const tile = 24;
  for (let y = 0; y < S; y += tile) {
    const off = ((y / tile) % 2) ? tile / 2 : 0;
    for (let x = 0; x < S; x += tile) {
      const cx = x + off + tile / 2 + rand(-2.5, 2.5), cy = y + tile / 2 + rand(-2.5, 2.5);
      const rx = tile * 0.57 + rand(-2, 2), ry = tile * 0.54 + rand(-2, 2), rot = rand(-0.45, 0.45);
      const shade = rand(0.5, 1), base = (20 * shade) | 0;
      g.fillStyle = `rgb(${base + 12},${base + 9},${base + 4})`; ell(g, cx, cy, rx, ry, rot);
      const hv = (150 + rand(-14, 16)) | 0;                  // flat top; grooves do the relief
      gh.fillStyle = `rgb(${hv},${hv},${hv})`; ell(gh, cx, cy, rx, ry, rot);
    }
  }
  for (let i = 0; i < 9000; i++) { g.fillStyle = `rgba(0,0,0,${rand(0.05, 0.2)})`; g.fillRect(rnd() * S, rnd() * S, rand(1, 2.2), rand(1, 2.2)); }
  // broad damp patches — wet stone reflects the lamplight; wrapped so they tile too
  for (let i = 0; i < 11; i++) {
    const px = rnd() * S, py = rnd() * S, pr = rand(45, 130);
    for (let ox = -S; ox <= S; ox += S) for (let oy = -S; oy <= S; oy += S) {
      const pg = gr.createRadialGradient(px + ox, py + oy, 0, px + ox, py + oy, pr);
      pg.addColorStop(0, 'rgba(80,80,95,0.62)'); pg.addColorStop(1, 'rgba(80,80,95,0)');
      gr.fillStyle = pg; gr.fillRect(px + ox - pr, py + oy - pr, pr * 2, pr * 2);
    }
  }
  // blur the height for smooth groove walls — tile the source 3×3 so the blur stays seamless
  const hb = document.createElement('canvas'); hb.width = hb.height = S;
  const gb = hb.getContext('2d')!; gb.filter = 'blur(1.6px)';
  for (let ox = -S; ox <= S; ox += S) for (let oy = -S; oy <= S; oy += S) gb.drawImage(hgt, ox, oy);
  const map = new THREE.CanvasTexture(col); map.colorSpace = THREE.SRGBColorSpace;
  const normalMap = heightToNormal(hb, 1.5);
  const roughnessMap = new THREE.CanvasTexture(rgh);
  for (const t of [map, normalMap, roughnessMap]) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(64, 64); t.anisotropy = 8; }
  return { map, normalMap, roughnessMap };
}

// Each Great House lights its keep in a coherent two-tone palette, most of the glass
// warm with candle/limelight behind it — never a random rainbow. (Per Coppermind, keep
// windows are tall, deep-set & arched, with leaded stained-glass *scenes*; skaa live in
// soot-blackened tenements with plain shuttered windows and no coloured glass at all.)
type House = { a: string; b: string };
const HOUSES: House[] = [
  { a: '#9c3327', b: '#c79a3a' },  // crimson & gold
  { a: '#2f5fa0', b: '#3f8a7e' },  // sapphire & teal
  { a: '#3f7a46', b: '#c79a3a' },  // green & gold
  { a: '#5d3a8e', b: '#9c3327' },  // violet & crimson
  { a: '#2f5fa0', b: '#7d4f9e' },  // blue & violet
  { a: '#b06a22', b: '#c79a3a' },  // amber & gold (a warm house)
];
const WARM_A = '#eab15c', WARM_B = '#c98a3a';   // candle/limelight behind clear or pale glass

// a round-arched, deep-set window outline (rectangle wx..wx+w / wy..wy+h, plus a
// semicircular arch of radius w/2 rising above the springline wy)
function archWinPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  const r = w / 2;
  ctx.beginPath();
  ctx.moveTo(x, y + h);
  ctx.lineTo(x, y);
  ctx.arc(x + r, y, r, Math.PI, 2 * Math.PI, false);
  ctx.lineTo(x + w, y + h);
  ctx.closePath();
}

// one grand keep window: a deep stone archway (or an occasional round oculus), filled with
// leaded, variegated stained glass in the house palette, or warm candlelit glass, or dark.
function drawKeepWindow(g: CanvasRenderingContext2D, ge: CanvasRenderingContext2D, gh: CanvasRenderingContext2D, x0: number, y0: number, cell: number, house: House) {
  if (rnd() < 0.15) return;                  // a blank bay — breaks the regular grid
  const ww = cell * 0.46, wx = x0 + (cell - ww) / 2;
  const wy = y0 + cell * 0.34, wh = cell * 0.56;      // springline & vertical height
  const round = rnd() < 0.10;                // an occasional rose-window oculus
  const cx = wx + ww / 2, cyR = wy + wh * 0.45, rR = ww * 0.52;
  const trace = (ctx: CanvasRenderingContext2D, d: number) => {
    if (round) { ctx.beginPath(); ctx.arc(cx, cyR, rR + d, 0, Math.PI * 2); ctx.closePath(); }
    else archWinPath(ctx, wx - d, wy - d, ww + 2 * d, wh + 2 * d);
  };
  trace(gh, 6); gh.fillStyle = '#5e5e5e'; gh.fill();   // raised buttressed surround
  trace(gh, 1); gh.fillStyle = '#0d0d0d'; gh.fill();   // deep recess
  trace(g, 3); g.fillStyle = '#0a0806'; g.fill();      // stone reveal

  const roll = rnd();
  if (roll < 0.34) { trace(g, 0); g.fillStyle = '#070605'; g.fill(); return; }   // unlit
  const stained = roll > 0.60;                          // ~40% of lit windows are stained glass

  for (const ctx of [g, ge]) {
    ctx.save(); trace(ctx, 0); ctx.clip();
    const bx = wx - ww, by = wy - ww, bw = ww * 3, bh = wh + ww * 2;
    if (stained) {
      const grad = ctx.createLinearGradient(0, wy - ww * 0.5, 0, wy + wh);
      grad.addColorStop(0, house.a); grad.addColorStop(0.5, house.b); grad.addColorStop(1, house.a);
      ctx.fillStyle = grad; ctx.fillRect(bx, by, bw, bh);
      ctx.globalAlpha = 0.5;                            // colour blotches → a glass "scene", not a flat pane
      const pal = [house.a, house.b, WARM_A];
      for (let i = 0; i < 4; i++) {
        ctx.fillStyle = pal[i % 3];
        ctx.beginPath(); ctx.arc(wx + rand(0.2, 0.8) * ww, wy + rand(-0.1, 0.9) * wh, rand(0.12, 0.3) * ww, 0, 6.283); ctx.fill();
      }
      ctx.globalAlpha = 1;
      const wc = ctx.createRadialGradient(cx, wy + wh * 0.6, 0, cx, wy + wh * 0.6, ww * 0.7);
      wc.addColorStop(0, 'rgba(240,200,130,0.5)'); wc.addColorStop(1, 'rgba(240,200,130,0)');  // warm heart
      ctx.fillStyle = wc; ctx.fillRect(bx, by, bw, bh);
    } else {
      const grad = ctx.createLinearGradient(0, wy - ww * 0.5, 0, wy + wh);
      grad.addColorStop(0, WARM_B); grad.addColorStop(1, WARM_A);
      ctx.fillStyle = grad; ctx.fillRect(bx, by, bw, bh);
    }
    ctx.strokeStyle = 'rgba(8,6,5,0.9)'; ctx.lineWidth = stained ? 2.5 : 2;   // leaded cames
    ctx.beginPath();
    ctx.moveTo(cx, wy - (round ? rR : ww / 2)); ctx.lineTo(cx, wy + wh);
    for (let k = 1; k <= 2; k++) { const ty = wy + wh * k / 3; ctx.moveTo(wx, ty); ctx.lineTo(wx + ww, ty); }
    if (!round) { ctx.moveTo(wx, wy); ctx.lineTo(cx, wy - ww * 0.5); ctx.moveTo(wx + ww, wy); ctx.lineTo(cx, wy - ww * 0.5); }
    ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, wy + wh * 0.32, ww * 0.16, 0, 6.283); ctx.stroke();   // a leaded medallion
    ctx.restore();
  }
}

// one skaa window: a plain timber-shuttered opening, soot-dark, rarely a dim candle within
function drawHovelWindow(g: CanvasRenderingContext2D, ge: CanvasRenderingContext2D, gh: CanvasRenderingContext2D, x0: number, y0: number, cell: number) {
  if (rnd() < 0.12) return;                  // blank wall
  const ww = cell * 0.30, wh = cell * 0.34;
  const wx = x0 + (cell - ww) / 2, wy = y0 + cell * 0.46;
  gh.fillStyle = '#4a4a4a'; gh.fillRect(wx - 3, wy - 3, ww + 6, wh + 6);   // shallow timber frame
  gh.fillStyle = '#0e0e0e'; gh.fillRect(wx - 1, wy - 1, ww + 2, wh + 2);
  g.fillStyle = '#0a0806'; g.fillRect(wx - 2, wy - 2, ww + 4, wh + 4);
  g.fillStyle = '#1c140d'; g.fillRect(wx, wy, ww, wh);                       // closed wooden shutters
  g.strokeStyle = 'rgba(0,0,0,0.6)'; g.lineWidth = 1.2;
  g.beginPath();
  g.moveTo(wx + ww / 2, wy); g.lineTo(wx + ww / 2, wy + wh);                 // shutter split
  for (let k = 1; k <= 2; k++) { const ty = wy + wh * k / 3; g.moveTo(wx, ty); g.lineTo(wx + ww, ty); }  // planks
  g.stroke();
  if (rnd() < 0.14) {                                                // a dim candle through the gap
    g.fillStyle = '#c8853a'; g.fillRect(wx + ww / 2 - 1.5, wy + 2, 3, wh - 4);
    ge.fillStyle = '#5e3a14'; ge.fillRect(wx + ww / 2 - 1.5, wy + 2, 3, wh - 4);
  }
}

function facadeSet(wWorld: number, hWorld: number, isKeep: boolean): THREE.Material[] {
  const cell = isKeep ? 92 : 60;                                          // grander bays on the keeps
  const floors = isKeep ? Math.max(3, Math.round(hWorld / 3.6)) : Math.max(3, Math.round(hWorld / 3.0));
  const cols = isKeep ? Math.max(2, Math.round(wWorld / 3.6)) : Math.max(2, Math.round(wWorld / 2.4));
  const cw = cell * cols, ch = cell * floors;
  const map = document.createElement('canvas'); map.width = cw; map.height = ch;
  const emis = document.createElement('canvas'); emis.width = cw; emis.height = ch;
  const hgt = document.createElement('canvas'); hgt.width = cw; hgt.height = ch;
  const g = map.getContext('2d')!, ge = emis.getContext('2d')!, gh = hgt.getContext('2d')!;

  g.fillStyle = isKeep ? '#241a12' : '#140d08'; g.fillRect(0, 0, cw, ch);   // skaa stone is darker, sootier
  ge.fillStyle = '#000'; ge.fillRect(0, 0, cw, ch);
  gh.fillStyle = '#888'; gh.fillRect(0, 0, cw, ch);

  // ashlar masonry — stone courses with recessed mortar, into colour + height
  const course = cell * 0.5;
  for (let y = 0; y <= ch; y += course) {
    gh.fillStyle = '#1e1e1e'; gh.fillRect(0, y - 1.5, cw, 3);
    g.fillStyle = 'rgba(0,0,0,0.42)'; g.fillRect(0, y - 1.5, cw, 3);
    const bo = ((y / course) % 2) ? course * 0.5 : 0;
    for (let x = -course; x <= cw; x += course) {
      gh.fillStyle = '#1e1e1e'; gh.fillRect(x + bo - 1.5, y, 3, course);
      g.fillStyle = 'rgba(0,0,0,0.32)'; g.fillRect(x + bo - 1.5, y, 3, course);
      g.fillStyle = rnd() < 0.5 ? `rgba(0,0,0,${rand(0, 0.13)})` : `rgba(74,60,44,${rand(0, 0.07)})`;
      g.fillRect(x + bo, y, course, course);
    }
  }

  // windows — keeps get tall, deep-set, arched stained-glass in a coherent house palette
  // (mostly warm candle/limelight); skaa get plain shuttered openings, no coloured glass
  const house = isKeep ? HOUSES[(rnd() * HOUSES.length) | 0] : null;
  for (let r = 0; r < floors; r++) {
    for (let c = 0; c < cols; c++) {
      if (isKeep) drawKeepWindow(g, ge, gh, c * cell, r * cell, cell, house!);
      else drawHovelWindow(g, ge, gh, c * cell, r * cell, cell);
    }
  }

  // soot streaks running down + top-darkening, "like paint down a canvas" (heavier on skaa walls)
  for (let i = 0; i < (isKeep ? cw / 10 : cw / 6); i++) {
    const sx = rnd() * cw, sw = rand(3, 11), sh = rand(ch * 0.25, ch * 0.85);
    const grd = g.createLinearGradient(0, 0, 0, sh);
    grd.addColorStop(0, 'rgba(4,3,2,0.5)'); grd.addColorStop(1, 'rgba(4,3,2,0)');
    g.fillStyle = grd; g.fillRect(sx, 0, sw, sh);
  }
  const topdark = g.createLinearGradient(0, 0, 0, ch);
  topdark.addColorStop(0, 'rgba(0,0,0,0.55)'); topdark.addColorStop(0.42, 'rgba(0,0,0,0.12)');
  topdark.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = topdark; g.fillRect(0, 0, cw, ch);

  const mapTex = new THREE.CanvasTexture(map); mapTex.colorSpace = THREE.SRGBColorSpace;
  const emisTex = new THREE.CanvasTexture(emis); emisTex.colorSpace = THREE.SRGBColorSpace;
  const normalTex = heightToNormal(hgt, 1.7);
  const facade = new THREE.MeshStandardMaterial({
    map: mapTex, emissiveMap: emisTex, emissive: 0xffffff,
    emissiveIntensity: isKeep ? 0.85 : 0.5, normalMap: normalTex,   // calmer glass — was blinding up close
    normalScale: new THREE.Vector2(0.85, 0.85), roughness: 0.95, metalness: 0,
  });
  const dark = new THREE.MeshStandardMaterial({ color: 0x0a0806, roughness: 1 });
  // BoxGeometry face order: +X, -X, +Y(top), -Y(bottom), +Z, -Z
  return [facade, facade, dark, dark, facade, facade];
}

// a peaked roof prism (ridge running along z) sitting on top of a building
function gableRoof(w: number, d: number, peak: number): THREE.BufferGeometry {
  const hw = w / 2, hd = d / 2;
  const v = new Float32Array([
    -hw, 0, -hd, -hw, 0, hd, 0, peak, hd, -hw, 0, -hd, 0, peak, hd, 0, peak, -hd, // left slope
    hw, 0, hd, hw, 0, -hd, 0, peak, -hd, hw, 0, hd, 0, peak, -hd, 0, peak, hd,     // right slope
    -hw, 0, -hd, 0, peak, -hd, hw, 0, -hd,                                          // front gable
    hw, 0, hd, 0, peak, hd, -hw, 0, hd,                                             // back gable
  ]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(v, 3));
  geo.computeVertexNormals();
  return geo;
}

// =================== scene / renderer ===================

const app = document.getElementById('app')!;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));   // cap fill cost on hi-DPI
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.28;
// Shadow maps look great on a real GPU but cripple a software renderer (e.g. the
// headless preview's SwiftShader), so auto-detect and only enable on real hardware.
const _gl = renderer.getContext();
const _dbg = _gl.getExtension('WEBGL_debug_renderer_info');
const _rname = _dbg ? String(_gl.getParameter(_dbg.UNMASKED_RENDERER_WEBGL)) : '';
const SHADOWS = !/swiftshader|llvmpipe|software|basic render|microsoft basic/i.test(_rname)
  && localStorage.getItem('lutha_noshadow') !== '1';   // press \ to toggle (e.g. on a weak GPU)
renderer.shadowMap.enabled = SHADOWS;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;   // soft moonlight shadows
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const FOG = 0x140d0a;
scene.fog = new THREE.FogExp2(FOG, 0.010);   // a touch thinner, so the avenue reveals its depth into the mist

const camera = new THREE.PerspectiveCamera(72, window.innerWidth / window.innerHeight, 0.1, 1600);
camera.position.set(0, 1.7, 44);

// =================== cinematic post-processing ===================
// Bloom is what sells the "lit glass blazing through mist" look; the grade pass
// adds split-tone (cold shadows / warm lamplight), a soft vignette and ash-grain.
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));

const bloom = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth >> 1, window.innerHeight >> 1),  // half-res: cheap, still soft
  0.7,   // strength
  0.6,   // radius
  0.12,  // threshold — the dark city stays dark, only lights/glass bloom
);
composer.addPass(bloom);
composer.addPass(new OutputPass());

const GradeShader = {
  uniforms: { tDiffuse: { value: null as THREE.Texture | null }, time: { value: 0 }, bright: { value: 1 }, tin: { value: 0 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float time; uniform float bright; uniform float tin; varying vec2 vUv;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
    void main(){
      vec2 d = vUv - 0.5;
      float r2 = dot(d, d);
      // chromatic aberration creeping in toward the edges (subtle — a few px at the corner)
      vec2 ca = d * r2 * 0.012;
      vec3 c;
      c.r = texture2D(tDiffuse, vUv + ca).r;
      c.g = texture2D(tDiffuse, vUv).g;
      c.b = texture2D(tDiffuse, vUv - ca).b;
      float l = dot(c, vec3(0.299, 0.587, 0.114));
      // lift shadows toward cold blue, push highlights toward warm ember
      c += vec3(-0.012, 0.0, 0.03) * (1.0 - l);
      c += vec3(0.03, 0.012, -0.02) * l;
      // a gentle filmic contrast S-curve for richer blacks and snap
      c = clamp((c - 0.5) * 1.10 + 0.5, 0.0, 8.0);
      c *= bright;                                  // tin brightens the night
      c += tin * 0.05 * vec3(0.6, 0.8, 1.0);        // tin lends a cold clarity
      // soft vignette (eases open while burning tin)
      float v = smoothstep(1.1, 0.25, r2 * 4.0);
      c *= mix(mix(0.72, 0.9, tin), 1.0, v);
      // fine drifting ash grain
      float g = hash(vUv + fract(time * 0.21));
      c += (g - 0.5) * 0.035;
      gl_FragColor = vec4(c, 1.0);
    }`,
};
const grade = new ShaderPass(GradeShader);
composer.addPass(grade);
composer.addPass(new SMAAPass(window.innerWidth, window.innerHeight));

// ---- sky dome ----
{
  const c = document.createElement('canvas'); c.width = 16; c.height = 256;
  const g = c.getContext('2d')!;
  const grd = g.createLinearGradient(0, 0, 0, 256);
  grd.addColorStop(0.00, '#070608');
  grd.addColorStop(0.40, '#0d0a09');
  grd.addColorStop(0.50, '#2b140d');
  grd.addColorStop(0.56, '#3a1810');
  grd.addColorStop(0.64, '#1a0f0b');
  grd.addColorStop(1.00, '#0a0807');
  g.fillStyle = grd; g.fillRect(0, 0, 16, 256);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(1000, 32, 16),
    new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, fog: false, depthWrite: false }),
  );
  sky.userData.sky = true;   // never a shadow caster/receiver
  scene.add(sky);
}

// ---- image-based lighting: a dark, moody reflection environment ----
// The single biggest "next-gen material" upgrade: now wet cobbles, canal water,
// copper domes and every push/pull metal catch the red horizon-glow and the cold
// moon. Kept deliberately dark so it adds gleam, not flat brightness.
{
  const W = 256, H = 128;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d')!;
  const grd = g.createLinearGradient(0, 0, 0, H);
  grd.addColorStop(0.00, '#05050b');   // zenith — faint cold
  grd.addColorStop(0.46, '#0a0808');
  grd.addColorStop(0.53, '#3c1b10');   // warm horizon band
  grd.addColorStop(0.62, '#160d0a');
  grd.addColorStop(1.00, '#070606');   // nadir
  g.fillStyle = grd; g.fillRect(0, 0, W, H);
  const sun = g.createRadialGradient(W * 0.5, H * 0.55, 0, W * 0.5, H * 0.55, W * 0.24);
  sun.addColorStop(0, 'rgba(196,74,34,0.95)'); sun.addColorStop(1, 'rgba(196,74,34,0)');   // the palace/sun glow
  g.fillStyle = sun; g.fillRect(0, 0, W, H);
  const mn = g.createRadialGradient(W * 0.17, H * 0.2, 0, W * 0.17, H * 0.2, W * 0.07);
  mn.addColorStop(0, 'rgba(150,170,215,0.85)'); mn.addColorStop(1, 'rgba(150,170,215,0)');  // the cold moon
  g.fillStyle = mn; g.fillRect(0, 0, W, H);
  const eqt = new THREE.CanvasTexture(c);
  eqt.mapping = THREE.EquirectangularReflectionMapping; eqt.colorSpace = THREE.SRGBColorSpace;
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromEquirectangular(eqt).texture;
  eqt.dispose(); pmrem.dispose();
}

// ---- the moon, a hazy disc behind the ash, motivating the moonlight & its shadows ----
{
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: softSprite('rgba(150,170,210,0.6)'), transparent: true, opacity: 0.55,
    depthWrite: false, fog: false, blending: THREE.AdditiveBlending,
  }));
  halo.scale.set(150, 150, 1); halo.position.set(-150, 285, 150); scene.add(halo);
  const disc = new THREE.Sprite(new THREE.SpriteMaterial({
    map: softSprite('rgba(206,218,242,0.98)'), transparent: true, opacity: 0.92,
    depthWrite: false, fog: false, blending: THREE.AdditiveBlending,
  }));
  disc.scale.set(44, 44, 1); disc.position.set(-150, 285, 150); scene.add(disc);
}

// =================== lighting ===================
scene.add(new THREE.HemisphereLight(0x3a2418, 0x0a0808, 0.8));
scene.add(new THREE.AmbientLight(0x171009, 0.55));   // lift the deep shadows just off black
const moon = new THREE.DirectionalLight(0x8a93c4, 0.72);
const MOON_OFF = new THREE.Vector3(-46, 86, 34);     // fixed offset; the shadow rig chases the player each frame
moon.position.copy(MOON_OFF);
moon.target.position.set(0, 0, 0);
scene.add(moon.target);
moon.castShadow = SHADOWS;                            // the one shadow-caster; its tight frustum tracks the player
moon.shadow.mapSize.set(SHADOWS ? 2048 : 1024, SHADOWS ? 2048 : 1024); // crisp over the tracked area; press \ to disable
moon.shadow.camera.near = 30;
moon.shadow.camera.far = 230;
moon.shadow.camera.left = -62; moon.shadow.camera.right = 62;
moon.shadow.camera.top = 62; moon.shadow.camera.bottom = -62;
moon.shadow.bias = -0.0004;
moon.shadow.normalBias = 0.7;
scene.add(moon);
const redGlow = new THREE.DirectionalLight(0x8a2c16, 0.35);
redGlow.position.set(0, 16, -80);
scene.add(redGlow);

// ---- allomantic metal sources -------------------------------------------
// Every scrap of metal a Mistborn could push or pull on: lamp brackets, window
// bars, door fittings, coins on the cobbles, vents on the rooftops. Burning
// steel/iron draws a blue line to each of these; steel-pushing launches off them.
const METALS: Metal[] = [];
const addMetal = (x: number, y: number, z: number, r = 1) =>
  METALS.push({ pos: new THREE.Vector3(x, y, z), r });

// building footprints, collected as we raise the street — used later for
// landing on rooftops and for not walking through walls while leaping.
const ROOFS: Roof[] = [];

// ---- spatial hash grid (built by buildGrids; queried by the shared sim in src/sim.ts) ----
// GRID/gkey/metalsNear/surfaceAt/resolveWalls now live in sim.ts; these are just the maps.
const metalGrid = new Map<number, Metal[]>();
const roofGrid = new Map<number, Roof[]>();
function buildGrids() {
  for (const m of METALS) {
    const k = gkey(Math.floor(m.pos.x / GRID), Math.floor(m.pos.z / GRID));
    let a = metalGrid.get(k); if (!a) { a = []; metalGrid.set(k, a); } a.push(m);
  }
  for (const r of ROOFS) {                          // a footprint is inserted into every cell it overlaps
    const x0 = Math.floor(r.minX / GRID), x1 = Math.floor(r.maxX / GRID);
    const z0 = Math.floor(r.minZ / GRID), z1 = Math.floor(r.maxZ / GRID);
    for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) {
      const k = gkey(cx, cz); let a = roofGrid.get(k); if (!a) { a = []; roofGrid.set(k, a); } a.push(r);
    }
  }
}

// Lantern light. LORE: Luthadel in the Final Empire (Mistborn Era 1) has NO
// electricity — every street light is an OPEN FLAME in an iron-bracketed lantern
// (electric lighting only arrives in Era 2, the Wax & Wayne books). So the glow is
// warm orange firelight, never a steady white bulb. Posts + additive halos are cheap,
// so we place them at every intersection; real PointLights are costly in forward
// rendering, so a small fixed POOL of flame-lights binds each frame to the nearest
// lamps, and a matching pool of dancing flame sprites lights the closest few.
const lampGlow = softSprite('rgba(255,150,66,0.9)');
const flameTex = softSprite('rgba(255,172,82,1)');
const lampPostMat = new THREE.MeshStandardMaterial({ color: 0x100c08, roughness: 1, metalness: 0 });
const lampPostGeo = new THREE.CylinderGeometry(0.1, 0.16, 4.6, 6);
const lampHaloMat = new THREE.SpriteMaterial({ map: lampGlow, transparent: true, opacity: 0.6, depthWrite: false, blending: THREE.AdditiveBlending });
type Lamp = { x: number; z: number; halo: THREE.Sprite };
const lamps: Lamp[] = [];
function placeLamp(lx: number, lz: number) {
  const halo = new THREE.Sprite(lampHaloMat);
  halo.scale.set(2.1, 2.1, 1); halo.position.set(lx, 4.5, lz); scene.add(halo);
  addMetal(lx, 4.3, lz, 1.6); // the lantern's heavy iron bracket — a push/pull anchor
  lamps.push({ x: lx, z: lz, halo });   // posts are drawn as one InstancedMesh once all lamps exist
}
// a fixed pool of real flame-lights that chase the player, and a matching pool of
// guttering flame sprites for the nearest lamps (the unmistakable "it's fire" tell)
const LAMP_LIGHTS = 9;
const lampPool: THREE.PointLight[] = [];
const flamePool: THREE.Sprite[] = [];
for (let i = 0; i < LAMP_LIGHTS; i++) {
  const pl = new THREE.PointLight(0xff9a3c, 0, 28, 2);
  pl.castShadow = false; scene.add(pl); lampPool.push(pl);
  const fs = new THREE.Sprite(new THREE.SpriteMaterial({
    map: flameTex, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending, color: 0xffa848,
  }));
  fs.scale.set(0.55, 1.0, 1); fs.visible = false; scene.add(fs); flamePool.push(fs);
}

// ---- volumetric light shafts (god-rays) ----
// A soft cone of glowing haze hangs under each lamp; like the real lights, only a
// pool of them exists and they chase the nearest lamps. Additive, brightest at the
// lantern and fading down + radially — cheap, but it sells the mist drinking light.
function makeShaftMat(hex: number, half: number, strength: number) {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(hex) }, uHalf: { value: half }, uStr: { value: strength } },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `uniform vec3 uColor; uniform float uHalf; uniform float uStr; varying vec3 vP;
      void main(){
        float vert = clamp((vP.y + uHalf) / (2.0 * uHalf), 0.0, 1.0);     // 1 at the lantern, 0 at the cobbles
        float rad = clamp(length(vP.xz) / uHalf, 0.0, 1.0);
        gl_FragColor = vec4(uColor, pow(vert, 1.3) * (1.0 - rad) * uStr);
      }`,
  });
}
const SHAFTS = 6;
const shaftMat = makeShaftMat(0xffc070, 2.25, 0.4);
const shaftGeo = new THREE.ConeGeometry(1.7, 4.5, 12, 1, true);
const shaftPool: THREE.Mesh[] = [];
for (let i = 0; i < SHAFTS; i++) {
  const s = new THREE.Mesh(shaftGeo, shaftMat);
  s.userData.noShadow = true; s.visible = false; scene.add(s); shaftPool.push(s);
}

// =================== ground ===================
{
  const cob = cobbleSet();
  for (const t of [cob.map, cob.normalMap, cob.roughnessMap]) t.repeat.set(200, 200);  // keep stone scale on the bigger plane
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(1600, 1600),
    new THREE.MeshStandardMaterial({
      map: cob.map, normalMap: cob.normalMap, roughnessMap: cob.roughnessMap,
      normalScale: new THREE.Vector2(0.6, 0.6),
      color: 0x6a6052, roughness: 1, metalness: 0, emissive: 0x0b0806, emissiveIntensity: 1,
    }),
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);
}

// =================== buildings (the street) ===================
const roofMat = new THREE.MeshStandardMaterial({ color: 0x130d07, roughness: 1, metalness: 0, side: THREE.DoubleSide });
const tileRoofMat = new THREE.MeshStandardMaterial({ color: 0x281009, roughness: 0.85, metalness: 0, side: THREE.DoubleSide }); // fired-clay tile, the wealthier rows
const trimMat = new THREE.MeshStandardMaterial({ color: 0x0c0906, roughness: 1, metalness: 0 });
const spireMat = new THREE.MeshStandardMaterial({ color: 0x09060b, roughness: 1, metalness: 0 });
const domeMat = new THREE.MeshStandardMaterial({ color: 0x3a2c1a, roughness: 0.5, metalness: 0.6 }); // tarnished copper/bronze roof sheeting
// pre-bake a few façade material sets and reuse them across the district (cheap)
const tenPool = Array.from({ length: 6 }, () => facadeSet(8, 10, false));
const keepPool = Array.from({ length: 6 }, () => facadeSet(12, 22, true));
const pickMat = (a: THREE.Material[][]) => a[(rnd() * a.length) | 0];

// Every keep's crowning spires are collected here and later drawn as ONE instanced mesh —
// hundreds of spear-tips across the whole skyline for the cost of a single draw call.
type Spire = { x: number; y: number; z: number; r: number; h: number; rz: number };
const spireInst: Spire[] = [];

// place one building into `parent` (a per-block Group, so whole blocks can be culled at distance)
function placeBuilding(parent: THREE.Object3D, cx: number, cz: number, w: number, d: number, h: number, isKeep: boolean) {
  const yaw = rand(-0.03, 0.03);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), pickMat(isKeep ? keepPool : tenPool));
  mesh.position.set(cx, h / 2, cz); mesh.rotation.y = yaw; parent.add(mesh);
  ROOFS.push({ minX: cx - w / 2, maxX: cx + w / 2, minZ: cz - d / 2, maxZ: cz + d / 2, top: h });

  const cor = new THREE.Mesh(new THREE.BoxGeometry(w + 0.7, 0.7, d + 0.7), trimMat);
  cor.position.set(cx, h - 0.3, cz); cor.rotation.y = yaw; parent.add(cor);

  if (isKeep) {
    const crown = rnd();
    if (crown < 0.55) {                                   // a cluster of spires
      const ns = 3 + (rnd() * 4 | 0);
      for (let s = 0; s < ns; s++)
        spireInst.push({ x: cx + rand(-w / 2 + 0.8, w / 2 - 0.8), y: h, z: cz + rand(-d / 2 + 0.8, d / 2 - 0.8), r: rand(0.3, 0.6), h: rand(3, 7), rz: rand(-0.06, 0.06) });
      spireInst.push({ x: cx, y: h, z: cz, r: rand(0.5, 0.9), h: rand(7, 12), rz: 0 });
    } else if (crown < 0.8) {                             // a great dome
      const dr = Math.min(w, d) * 0.42;
      const dome = new THREE.Mesh(new THREE.SphereGeometry(dr, 14, 9, 0, Math.PI * 2, 0, Math.PI / 2), domeMat);
      dome.position.set(cx, h, cz); parent.add(dome);
      spireInst.push({ x: cx, y: h + dr, z: cz, r: 0.4, h: rand(4, 7), rz: 0 });
    } else {                                              // a square watch-tower
      const th = rand(6, 12);
      const tw = new THREE.Mesh(new THREE.BoxGeometry(w * 0.42, th, d * 0.42), pickMat(keepPool));
      tw.position.set(cx, h + th / 2, cz); parent.add(tw);
      ROOFS.push({ minX: cx - w * 0.21, maxX: cx + w * 0.21, minZ: cz - d * 0.21, maxZ: cz + d * 0.21, top: h + th });
      spireInst.push({ x: cx, y: h + th, z: cz, r: 0.5, h: rand(4, 7), rz: 0 });
    }
  } else {
    const tile = rnd() < 0.25;
    const roof = new THREE.Mesh(gableRoof(w + 0.5, d + 0.6, rand(1.6, 2.8)), tile ? tileRoofMat : roofMat);
    roof.position.set(cx, h, cz); roof.rotation.y = yaw; parent.add(roof);
    if (rnd() < 0.6) {                            // a soot-caked chimney
      const ch = new THREE.Mesh(new THREE.BoxGeometry(0.55, rand(1.2, 2.4), 0.55), trimMat);
      ch.position.set(cx + rand(-w / 3, w / 3), h + 1.1, cz + rand(-d / 3, d / 3)); parent.add(ch);
    }
  }

  // metals: door fittings on both street faces, barred windows, a rooftop bracket
  addMetal(cx - w / 2, 1.5, cz + rand(-d / 3, d / 3), 1.0);
  addMetal(cx + w / 2, 1.5, cz + rand(-d / 3, d / 3), 1.0);
  for (let b = 0; b < (isKeep ? 3 : 2); b++)
    addMetal(cx + (rnd() < 0.5 ? -1 : 1) * w / 2, rand(3, h - 2), cz + rand(-d / 2.5, d / 2.5), isKeep ? 1.1 : 0.8);
  addMetal(cx + rand(-w / 3, w / 3), h + 0.3, cz + rand(-d / 3, d / 3), 1.3);
}

// fill a city block with a 1–2 × 1–2 cluster of packed buildings
function fillBlock(parent: THREE.Object3D, x0: number, x1: number, z0: number, z1: number, keepChance: number, tall: number) {
  const bw = x1 - x0, bd = z1 - z0, gap = 1.4;
  const nx = bw > 14 ? 2 : 1, nz = bd > 14 ? 2 : 1;
  const cwid = (bw - gap * (nx - 1)) / nx, cdep = (bd - gap * (nz - 1)) / nz;
  for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
    if (rnd() < 0.07) continue;                  // an occasional empty/ruined lot
    const isKeep = rnd() < keepChance;
    const inset = rand(0.3, 1.0);
    const w = Math.max(4, cwid - inset * 2), d = Math.max(4, cdep - inset * 2);
    const h = isKeep ? rand(16, 26) * tall : rand(7, 12);
    placeBuilding(parent, x0 + i * (cwid + gap) + cwid / 2, z0 + j * (cdep + gap) + cdep / 2, w, d, h, isKeep);
  }
}

// ---- the walled district: a parametric grid that scales to a whole city ----
// Columns march out to either side of a central avenue (x≈0) that runs to the gate;
// rows march from the back wall (+Z) toward the gate and Kredik Shaw (−Z).
const BW = 18, BD = 18, ST = 9, AV = 20, COLS = 9, ROWS = 20;
const FRONT_Z = -150;                                    // z of the front-most row of blocks
const colCenters: [number, number][] = [];              // [x0,x1] per block column (the avenue is the central gap)
for (const side of [-1, 1] as const)
  for (let i = 0; i < COLS; i++) {
    const c = side * (AV / 2 + BW / 2 + i * (BW + ST));
    colCenters.push([c - BW / 2, c + BW / 2]);
  }
const rowCenters: [number, number][] = [];              // [z0,z1] per block row, back(+Z) → front(−Z)
for (let r = 0; r < ROWS; r++) {
  const c = FRONT_Z + (ROWS - 1 - r) * (BD + ST);
  rowCenters.push([c - BD / 2, c + BD / 2]);
}
const maxXedge = AV / 2 + BW / 2 + (COLS - 1) * (BW + ST) + BW / 2;
const XW = maxXedge + 8;                                 // district half-width (+ a perimeter lane)
const ZB = rowCenters[0][1] + 8;                         // back wall (+Z)
const ZF = rowCenters[ROWS - 1][0] - 8;                  // front wall / gate (−Z)

// reserved blocks become landmarks instead of generic rows
const ci = (side: -1 | 1, i: number) => (side < 0 ? i : COLS + i);   // column-index helper
const MKT_B: [number, number] = [ci(1, 0), 2];          // market square (right, near back)
const PLAZA_B: [number, number] = [ci(-1, 0), 5];       // the Lord Ruler's plaza (left, mid)
const BALL_B: [number, number] = [ci(-1, 0), ROWS - 2]; // the noble-ball keep (left, front)
const MIN_B: [number, number] = [ci(1, 0), ROWS - 1];   // the Ministry cathedral (right, by the gate)
const CLUBS_B: [number, number] = [ci(-1, 1), 4];       // Clubs' shop (left, mid)
const reserved = new Set([MKT_B, PLAZA_B, BALL_B, MIN_B, CLUBS_B].map(b => b[0] + ',' + b[1]));
const centerOf = (b: [number, number]) => {
  const [x0, x1] = colCenters[b[0]], [z0, z1] = rowCenters[b[1]];
  return new THREE.Vector3((x0 + x1) / 2, 0, (z0 + z1) / 2);
};

// each block is its own Group so distant blocks can be hidden wholesale — the city can be
// huge while the draw-call count stays bounded to whatever's near the player.
const blockGroups: { g: THREE.Group; cx: number; cz: number }[] = [];
for (let c = 0; c < colCenters.length; c++) {
  for (let r = 0; r < rowCenters.length; r++) {
    if (reserved.has(c + ',' + r)) continue;
    const [x0, x1] = colCenters[c], [z0, z1] = rowCenters[r];
    const nearAvenue = (c % COLS) <= 1;
    const towardPalace = r >= ROWS - 4;
    const keepChance = (nearAvenue ? 0.30 : 0.10) + (towardPalace ? 0.12 : 0); // wealth gathers by the avenue & the palace
    const tall = towardPalace ? rand(1.05, 1.3) : 1.0;
    const g = new THREE.Group();
    fillBlock(g, x0, x1, z0, z1, keepChance, tall);
    scene.add(g);
    blockGroups.push({ g, cx: (x0 + x1) / 2, cz: (z0 + z1) / 2 });
  }
}

// the market square: canvas-roofed stalls around a soot-blackened fountain
{
  const [mx0, mx1] = colCenters[MKT_B[0]], [mz0, mz1] = rowCenters[MKT_B[1]];
  for (let i = 0; i < 9; i++) {
    const sx = rand(mx0 + 1.5, mx1 - 1.5), sz = rand(mz0 + 1.5, mz1 - 1.5), sh = rand(1.8, 2.3);
    const post = new THREE.Mesh(new THREE.BoxGeometry(2.4, sh, 1.8), trimMat);
    post.position.set(sx, sh / 2, sz); scene.add(post);
    const awn = new THREE.Mesh(gableRoof(3.1, 2.5, 0.7), roofMat);
    awn.position.set(sx, sh, sz); scene.add(awn);
    addMetal(sx, sh - 0.2, sz, 0.7);
  }
  const fcx = (mx0 + mx1) / 2, fcz = (mz0 + mz1) / 2;
  const basin = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.4, 0.7, 16), trimMat);
  basin.position.set(fcx, 0.35, fcz); scene.add(basin);
  const water = new THREE.Mesh(new THREE.CylinderGeometry(2.0, 2.0, 0.12, 16),
    new THREE.MeshStandardMaterial({ color: 0x0a0c0e, roughness: 0.22, metalness: 0.2 }));
  water.position.set(fcx, 0.66, fcz); water.userData.noShadow = true; scene.add(water);
  const spout = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.32, 1.7, 8), trimMat);
  spout.position.set(fcx, 1.45, fcz); scene.add(spout);
  ROOFS.push({ minX: fcx - 2.2, maxX: fcx + 2.2, minZ: fcz - 2.2, maxZ: fcz + 2.2, top: 0.7 });
  addMetal(fcx, 1.7, fcz, 1.0);
  placeLamp(mx0 + 2, mz0 + 2); placeLamp(mx1 - 2, mz1 - 2);
}

// the Lord Ruler's plaza — an open paved square about a black obelisk
{
  const p = centerOf(PLAZA_B);
  const ob = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 1.5, 10, 4), spireMat);
  ob.position.set(p.x, 5, p.z); ob.rotation.y = Math.PI / 4; scene.add(ob);
  ROOFS.push({ minX: p.x - 1.3, maxX: p.x + 1.3, minZ: p.z - 1.3, maxZ: p.z + 1.3, top: 10 });
  addMetal(p.x, 6.5, p.z, 1.4);
  for (const [ox, oz] of [[-6, -6], [6, 6], [-6, 6], [6, -6]] as const) placeLamp(p.x + ox, p.z + oz);
}

// ---- enterable buildings -------------------------------------------------------------
// A hollow shell so a landmark can be walked into: four façade walls with a doorway gap on
// one face, plus a floor & ceiling. Only thin wall-COLLIDERS go into ROOFS (no solid
// footprint), so the interior is walkable and the door gap lets you in; the spatial grid
// picks the colliders up via buildGrids(). Interior lights are proximity-gated (perf).
const interiorLights: { l: THREE.PointLight; x: number; z: number; max: number }[] = [];
function addInteriorLight(x: number, y: number, z: number, color: number, range: number, max: number) {
  const l = new THREE.PointLight(color, 0, range, 2); l.castShadow = false; l.position.set(x, y, z); scene.add(l);
  interiorLights.push({ l, x, z, max });
}
function placeEnterable(parent: THREE.Object3D, cx: number, cz: number, w: number, d: number, h: number, mats: THREE.Material | THREE.Material[], door: 'x+' | 'x-' | 'z+' | 'z-') {
  const T = 0.6, hw = w / 2, hd = d / 2, gap = 3.0, DOOR_H = 3.4;
  // the shell is seen from BOTH sides, so clone the façade to double-sided — otherwise the
  // inner faces are back-face-culled and you'd see straight through the walls from inside
  const dbl = (m: THREE.Material) => { const c = m.clone(); c.side = THREE.DoubleSide; return c; };
  const wallMats: THREE.Material | THREE.Material[] = Array.isArray(mats) ? mats.map(dbl) : dbl(mats);
  const addWall = (wx: number, wz: number, ww: number, wd: number) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(ww, h, wd), wallMats);
    m.position.set(wx, h / 2, wz); parent.add(m);
    ROOFS.push({ minX: wx - ww / 2, maxX: wx + ww / 2, minZ: wz - wd / 2, maxZ: wz + wd / 2, top: h });
  };
  const lintel = (wx: number, wz: number, ww: number, wd: number) => {       // visual-only piece above the door (no collider)
    if (h <= DOOR_H + 0.8) return;
    const m = new THREE.Mesh(new THREE.BoxGeometry(ww, h - DOOR_H, wd), wallMats);
    m.position.set(wx, (DOOR_H + h) / 2, wz); parent.add(m);
  };
  for (const face of ['z+', 'z-', 'x+', 'x-'] as const) {
    const isDoor = face === door;
    if (face === 'z+' || face === 'z-') {
      const wz = cz + (face === 'z+' ? hd : -hd);
      if (!isDoor) addWall(cx, wz, w, T);
      else { const seg = (w - gap) / 2; addWall(cx - (gap + seg) / 2, wz, seg, T); addWall(cx + (gap + seg) / 2, wz, seg, T); lintel(cx, wz, gap, T); }
    } else {
      const wx = cx + (face === 'x+' ? hw : -hw);
      if (!isDoor) addWall(wx, cz, T, d);
      else { const seg = (d - gap) / 2; addWall(wx, cz - (gap + seg) / 2, T, seg); addWall(wx, cz + (gap + seg) / 2, T, seg); lintel(wx, cz, T, gap); }
    }
  }
  const fl = new THREE.Mesh(new THREE.BoxGeometry(w - T, 0.12, d - T), new THREE.MeshStandardMaterial({ color: 0x16100a, roughness: 0.5, metalness: 0.1, side: THREE.DoubleSide }));
  fl.position.set(cx, 0.06, cz); fl.userData.noShadow = true; parent.add(fl);
  const ceil = new THREE.Mesh(new THREE.BoxGeometry(w - T, 0.3, d - T), new THREE.MeshStandardMaterial({ color: 0x0c0906, roughness: 1, side: THREE.DoubleSide }));
  ceil.position.set(cx, h - 0.15, cz); parent.add(ceil);
}

// Clubs' shop — Kelsier's crew safehouse, a soot-stained workshop you can step into
{
  const p = centerOf(CLUBS_B);
  const g = new THREE.Group();
  const w = 11, d = 12, h = 8;
  placeEnterable(g, p.x, p.z, w, d, h, pickMat(tenPool), 'x+');           // door faces the avenue side
  const cap = new THREE.Mesh(gableRoof(w + 0.5, d + 0.6, 2.2), roofMat); cap.position.set(p.x, h, p.z); g.add(cap);
  const chim = new THREE.Mesh(new THREE.BoxGeometry(1.2, 5, 1.2), trimMat);
  chim.position.set(p.x + 3, h + 2.5, p.z + 3.5); g.add(chim);
  // interior: a hearth, a long worktable, a few crates
  const hearth = new THREE.Mesh(new THREE.BoxGeometry(2.4, 2.2, 0.7), trimMat); hearth.position.set(p.x - w / 2 + 0.7, 1.1, p.z); g.add(hearth);
  const fire = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.3), new THREE.MeshBasicMaterial({ color: 0xff7a26, side: THREE.DoubleSide }));
  fire.position.set(p.x - w / 2 + 1.05, 1.0, p.z); fire.rotation.y = Math.PI / 2; fire.userData.noShadow = true; g.add(fire);
  const table = new THREE.Mesh(new THREE.BoxGeometry(4, 0.3, 1.5), trimMat); table.position.set(p.x + 0.5, 0.9, p.z - 1.5); g.add(table);
  for (const [ox, oz] of [[-1.6, -1], [1.8, 1.2], [-2, 2.3]] as const) {
    const crate = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), trimMat); crate.position.set(p.x + ox, 0.5, p.z + oz); g.add(crate);
  }
  addInteriorLight(p.x - 1, 3, p.z, 0xffa040, 16, 8);
  addMetal(p.x + 0.5, 1.0, p.z - 1.5, 0.9);                                // tools on the worktable
  scene.add(g); blockGroups.push({ g, cx: p.x, cz: p.z });
  const smoke = new THREE.Sprite(new THREE.SpriteMaterial({
    map: softSprite('rgba(120,108,92,0.5)'), transparent: true, opacity: 0.4, depthWrite: false,
  }));
  smoke.scale.set(6, 8, 1); smoke.position.set(p.x + 3, h + 7, p.z + 3.5); smoke.userData.noShadow = true; scene.add(smoke);
  placeLamp(p.x - 5, p.z);
}

// the Ministry cathedral — a towering, oppressive nave you can enter, by the gate
{
  const p = centerOf(MIN_B);
  const g = new THREE.Group();
  const w = 16, d = 16, h = 30;
  placeEnterable(g, p.x, p.z, w, d, h, pickMat(keepPool), 'x-');           // door toward the avenue
  const steeple = new THREE.Mesh(new THREE.ConeGeometry(2.4, 30, 6), spireMat);
  steeple.position.set(p.x, h + 15, p.z); g.add(steeple);
  for (const [ox, oz] of [[-7, -7], [7, -7], [-7, 7], [7, 7]] as const) {
    const buttress = new THREE.Mesh(new THREE.ConeGeometry(1.1, 14, 5), spireMat);
    buttress.position.set(p.x + ox, h + 7, p.z + oz); g.add(buttress);
  }
  // interior: two rows of soaring pillars + a raised altar lit a dim, blood red
  for (let i = 0; i < 3; i++) for (const sx of [-1, 1] as const) {
    const col = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.8, h - 1, 8), spireMat);
    col.position.set(p.x + sx * 4.5, (h - 1) / 2, p.z - 4 + i * 4.5); g.add(col);
  }
  const altar = new THREE.Mesh(new THREE.BoxGeometry(4, 1.4, 2), trimMat); altar.position.set(p.x, 0.7, p.z + d / 2 - 2.5); g.add(altar);
  const altarGlow = new THREE.Mesh(new THREE.PlaneGeometry(3, 2.2), new THREE.MeshBasicMaterial({ color: 0xc23018, side: THREE.DoubleSide }));
  altarGlow.position.set(p.x, 2.4, p.z + d / 2 - 2.65); altarGlow.userData.noShadow = true; g.add(altarGlow);
  addInteriorLight(p.x, 4, p.z + d / 2 - 3, 0x9a2c14, 22, 6);             // a cold, dim, sanguine sanctum
  addMetal(p.x, 1.2, p.z + d / 2 - 2.5, 1.2);
  scene.add(g); blockGroups.push({ g, cx: p.x, cz: p.z });
  const rose = new THREE.Sprite(new THREE.SpriteMaterial({   // a rose-window blazing on the gate-facing wall
    map: softSprite('rgba(196,60,40,0.95)'), transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  rose.scale.set(7, 7, 1); rose.position.set(p.x, 16, p.z - 8.1); scene.add(rose);
  addMetal(p.x, 16, p.z - 8, 1.4);
}

// a canal crossing the district, water gone black with ash, spanned by arched footbridges
const canalZ = (rowCenters[4][0] + rowCenters[3][1]) / 2;   // sits in the street between two rows
{
  const cwater = new THREE.Mesh(new THREE.BoxGeometry(2 * XW - 8, 0.1, 5),
    new THREE.MeshStandardMaterial({ color: 0x070a0c, roughness: 0.18, metalness: 0.35 }));
  cwater.position.set(0, 0.06, canalZ); cwater.userData.noShadow = true; scene.add(cwater);
  for (const s of [-1, 1] as const) {                        // stone embankments
    const bank = new THREE.Mesh(new THREE.BoxGeometry(2 * XW - 8, 0.5, 0.7), trimMat);
    bank.position.set(0, 0.25, canalZ + s * 2.8); scene.add(bank);
  }
  const bridgeXs = [0];
  for (let i = 0; i < COLS - 1; i++) { const gx = AV / 2 + BW + ST / 2 + i * (BW + ST); bridgeXs.push(gx, -gx); }
  for (const bx of bridgeXs) {
    const span = bx === 0 ? AV - 2 : ST + 1;
    const deck = new THREE.Mesh(new THREE.BoxGeometry(span, 0.4, 6.5), trimMat);
    deck.position.set(bx, 1.0, canalZ); scene.add(deck);
    ROOFS.push({ minX: bx - span / 2, maxX: bx + span / 2, minZ: canalZ - 3.25, maxZ: canalZ + 3.25, top: 1.2 });
    const arch = new THREE.Mesh(new THREE.TorusGeometry(2.6, 0.22, 6, 12, Math.PI), spireMat);
    arch.position.set(bx, 0.4, canalZ); arch.rotation.y = Math.PI / 2; scene.add(arch);
    addMetal(bx, 1.2, canalZ, 0.9);
  }
  placeLamp(AV / 2 + 2, canalZ); placeLamp(-(AV / 2 + 2), canalZ);
}

// Keep Tellund — a noble ball you can step into: a glittering ballroom behind the glass
const ballDancers: { m: THREE.Group; z0: number; ph: number }[] = [];
{
  const bc = centerOf(BALL_B);
  const bx = bc.x, bz = bc.z, bw = 13, bd = 15, bh = 20;
  const bg = new THREE.Group();
  placeEnterable(bg, bx, bz, bw, bd, bh, pickMat(keepPool), 'x+');         // door on the avenue (+X) face
  for (let i = 0; i < 4; i++) spireInst.push({ x: bx + rand(-bw / 2 + 1, bw / 2 - 1), y: bh, z: bz + rand(-bd / 2 + 1, bd / 2 - 1), r: rand(0.4, 0.7), h: rand(4, 8), rz: rand(-0.05, 0.05) });
  spireInst.push({ x: bx, y: bh, z: bz, r: 0.8, h: 11, rz: 0 });           // a central spire, so it still reads as a keep
  scene.add(bg); blockGroups.push({ g: bg, cx: bx, cz: bz });
  const faceX = bx + bw / 2 + 0.06;                  // the grand stained window, above the entrance (+X)
  const win = new THREE.Mesh(new THREE.PlaneGeometry(8, 9), new THREE.MeshBasicMaterial({ color: 0x8c6630, side: THREE.DoubleSide }));
  win.position.set(faceX, 11, bz); win.rotation.y = Math.PI / 2; win.userData.noShadow = true; scene.add(win);
  const lead = new THREE.MeshBasicMaterial({ color: 0x0a0806 });
  for (let k = -1; k <= 1; k++) {
    const v = new THREE.Mesh(new THREE.PlaneGeometry(0.14, 9), lead);
    v.position.set(faceX + 0.02, 11, bz + k * 2.5); v.rotation.y = Math.PI / 2; v.userData.noShadow = true; scene.add(v);
    const hb = new THREE.Mesh(new THREE.PlaneGeometry(8, 0.14), lead);
    hb.position.set(faceX + 0.02, 11 + k * 2.8, bz); hb.rotation.y = Math.PI / 2; hb.userData.noShadow = true; scene.add(hb);
  }
  for (const cz2 of [bz - 4, bz, bz + 4]) {           // chandeliers
    const ch = new THREE.Mesh(new THREE.SphereGeometry(0.5, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffd98a }));
    ch.position.set(bx, bh - 3, cz2); ch.userData.noShadow = true; bg.add(ch);
  }
  const dmat = new THREE.MeshStandardMaterial({ color: 0x0b0907, roughness: 1 });
  for (let i = 0; i < 6; i++) {                       // the high nobility, now turning on the ballroom floor
    const d = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.7, 3, 6), dmat); body.position.y = 0.55; body.userData.noShadow = true; d.add(body);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 8, 8), dmat); head.position.y = 1.05; head.userData.noShadow = true; d.add(head);
    const z0 = bz - 3 + i * 1.2;
    d.position.set(bx + rand(-3, 3), 0, z0); bg.add(d);
    ballDancers.push({ m: d, z0, ph: rand(0, 6.28) });
  }
  addInteriorLight(bx, bh * 0.6, bz, 0xffd28a, 22, 9);
  addMetal(faceX - 1, 2, bz, 1.0);
}

// the city wall rings the district; the gate on the avenue opens toward Kredik Shaw
{
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x0c0a08, roughness: 1, metalness: 0 });
  const WH = 16, WT = 4;
  const seg = (cx: number, cz: number, lx: number, lz: number, hh = WH) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(lx, hh, lz), wallMat);
    m.position.set(cx, hh / 2, cz); scene.add(m);
    ROOFS.push({ minX: cx - lx / 2, maxX: cx + lx / 2, minZ: cz - lz / 2, maxZ: cz + lz / 2, top: hh });
  };
  seg(0, ZB + 2, 2 * XW + 2 * WT, WT);                       // back wall (+Z)
  seg(-XW - WT / 2, (ZB + ZF) / 2, WT, ZB - ZF);            // left wall
  seg(XW + WT / 2, (ZB + ZF) / 2, WT, ZB - ZF);            // right wall
  const gateHalf = AV / 2 + 1;                               // the gate gap straddles the avenue
  const frontHalf = (XW - gateHalf) / 2;
  seg(-(gateHalf + frontHalf), ZF - 2, 2 * frontHalf, WT);   // front wall, left of gate
  seg(gateHalf + frontHalf, ZF - 2, 2 * frontHalf, WT);      // front wall, right of gate
  for (const gx of [-(gateHalf + 1.5), gateHalf + 1.5]) {    // gate towers flanking the avenue
    seg(gx, ZF - 2, 5, 6, WH + 8);
    addMetal(gx + (gx < 0 ? 2 : -2), 7, ZF - 1, 1.6);        // gate ironwork
  }
  for (const [cx, cz] of [[-XW, ZB], [XW, ZB], [-XW, ZF], [XW, ZF]] as const)  // corner watch-towers
    seg(cx, cz, 7, 7, WH + 10);
}

// the red glow of Kredik Shaw spilling through the gate as a great column of hazy light
{
  const gate = new THREE.Mesh(new THREE.ConeGeometry(7, 28, 18, 1, true), makeShaftMat(0xc24a22, 14, 0.26));
  gate.position.set(0, 14, ZF + 7); gate.userData.noShadow = true; scene.add(gate);
}

// lamp posts at every street intersection across the district, plus a grand line down
// the avenue. Posts + halos are cheap & always shown; the light pool (above) chases you.
{
  const streetXs = [0];
  for (let i = 0; i < COLS - 1; i++) { const gx = AV / 2 + BW + ST / 2 + i * (BW + ST); streetXs.push(gx, -gx); }
  const streetZs: number[] = [];
  for (let r = 0; r < ROWS - 1; r++) streetZs.push((rowCenters[r][0] + rowCenters[r + 1][1]) / 2);
  for (const sx of streetXs) for (const sz of streetZs) {
    if (Math.abs(sz - canalZ) < 4) continue;               // the canal already lit its own crossing
    placeLamp(sx, sz);
  }
  for (let r = 0; r < ROWS; r++) {                          // a processional line of lamps up the avenue
    const z = (rowCenters[r][0] + rowCenters[r][1]) / 2;
    placeLamp(AV / 2 - 1.5, z); placeLamp(-(AV / 2 - 1.5), z);
  }
}
// every lamp post as ONE instanced mesh — ~70 posts for a single draw call
{
  const inst = new THREE.InstancedMesh(lampPostGeo, lampPostMat, lamps.length);
  const m = new THREE.Matrix4();
  for (let i = 0; i < lamps.length; i++) inst.setMatrixAt(i, m.makeTranslation(lamps[i].x, 2.3, lamps[i].z));
  inst.instanceMatrix.needsUpdate = true;
  scene.add(inst);
}

// =================== coins on the cobbles ===================
// Loose clips and bits of metal in the gutters — the Mistborn's launch pads.
{
  const glint = softSprite('rgba(196,176,120,0.95)');
  const inBuilding = (x: number, z: number) =>
    ROOFS.some(r => x > r.minX - 0.4 && x < r.maxX + 0.4 && z > r.minZ - 0.4 && z < r.maxZ + 0.4);
  let placed = 0, tries = 0;
  while (placed < 90 && tries < 2200) {
    tries++;
    const x = rand(-XW + 2, XW - 2), z = rand(ZF + 2, ZB - 2);
    if (inBuilding(x, z)) continue;
    addMetal(x, 0.06, z, 0.55);
    const s = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glint, transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    s.scale.set(0.4, 0.4, 1); s.position.set(x, 0.06, z); scene.add(s);
    placed++;
  }
}

// =================== every keep's spires, as ONE instanced mesh (a single draw call) ===================
if (spireInst.length) {
  const inst = new THREE.InstancedMesh(new THREE.ConeGeometry(1, 1, 4), spireMat, spireInst.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3(), s = new THREE.Vector3();
  for (let i = 0; i < spireInst.length; i++) {
    const sp = spireInst[i];
    e.set(0, 0, sp.rz); q.setFromEuler(e);
    s.set(sp.r, sp.h, sp.r); p.set(sp.x, sp.y + sp.h / 2, sp.z);
    inst.setMatrixAt(i, m.compose(p, q, s));
  }
  inst.instanceMatrix.needsUpdate = true;
  scene.add(inst);
}

// =================== a fogged skyline of the city sprawling beyond the walls ===================
{
  const mat = new THREE.MeshStandardMaterial({ color: 0x09070a, roughness: 1, metalness: 0 });
  const N = 150;
  const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, N);
  inst.userData.noShadow = true;
  const m = new THREE.Matrix4(); let k = 0;
  const put = (x: number, z: number) => {
    const w = rand(7, 18), h = rand(8, 34), d = rand(7, 18);
    m.makeScale(w, h, d); m.setPosition(x, h / 2, z); inst.setMatrixAt(k++, m);
  };
  for (let i = 0; i < 55; i++) put(rand(-XW - 95, -XW - 12), rand(ZF - 30, ZB + 40)); // beyond the left wall
  for (let i = 0; i < 55; i++) put(rand(XW + 12, XW + 95), rand(ZF - 30, ZB + 40));   // beyond the right wall
  for (let i = 0; i < 40; i++) put(rand(-XW - 20, XW + 20), rand(ZB + 12, ZB + 95));  // beyond the back wall
  inst.count = k; inst.instanceMatrix.needsUpdate = true;
  scene.add(inst);
}

// =================== Kredik Shaw + the red sun on the horizon ===================
{
  const grp = new THREE.Group();
  // fog:false so the black spires loom crisp against the red horizon-glow — "black spears thrust into the sky"
  const black = new THREE.MeshStandardMaterial({ color: 0x040308, roughness: 1, metalness: 0, fog: false });

  // a broad palace base mass beneath the spires
  const base = new THREE.Mesh(new THREE.BoxGeometry(150, 44, 70), black);
  base.position.set(0, 16, -165); grp.add(base);
  const base2 = new THREE.Mesh(new THREE.BoxGeometry(86, 66, 48), black);
  base2.position.set(rand(-14, 14), 28, -172); grp.add(base2);

  // the Hill of a Thousand Spires — black spears, denser & taller toward the centre
  for (let i = 0; i < 72; i++) {
    const x = (rnd() - 0.5) * 150;
    const fall = 1 - Math.min(1, Math.abs(x) / 80) * 0.55;
    const hh = rand(46, 178) * fall;
    const thin = rnd() < 0.62;
    const rr = thin ? rand(1.0, 2.6) : rand(3, 6);
    const sp = new THREE.Mesh(new THREE.ConeGeometry(rr, hh, thin ? 4 : 6), black);
    sp.position.set(x + rand(-5, 5), hh / 2 + rand(0, 26), rand(-188, -148));
    sp.rotation.z = rand(-0.06, 0.06);  // some twisted, some straight
    sp.rotation.x = rand(-0.04, 0.04);
    grp.add(sp);
  }
  // a few thick square towers among the needles
  for (let i = 0; i < 10; i++) {
    const hh = rand(60, 130), ww = rand(7, 15);
    const tw = new THREE.Mesh(new THREE.BoxGeometry(ww, hh, ww), black);
    tw.position.set(rand(-55, 55), hh / 2, rand(-185, -150));
    grp.add(tw);
  }
  scene.add(grp);

  // the city's torchlight diffusing through the mist behind the palace — a
  // radiant dome that throws the black spires into silhouette
  const dome = new THREE.Sprite(new THREE.SpriteMaterial({
    map: softSprite('rgba(158,52,24,0.7)'), transparent: true, opacity: 0.95,
    depthWrite: false, fog: false, blending: THREE.AdditiveBlending,
  }));
  dome.scale.set(520, 280, 1); dome.position.set(0, 58, -232);
  scene.add(dome);

  // the crimson sun — a sullen disk low behind the palace
  const sc = document.createElement('canvas'); sc.width = sc.height = 128;
  const sg = sc.getContext('2d')!;
  const sgr = sg.createRadialGradient(64, 64, 0, 64, 64, 64);
  sgr.addColorStop(0, 'rgba(255,150,92,1)');
  sgr.addColorStop(0.16, 'rgba(226,82,38,0.96)');
  sgr.addColorStop(0.46, 'rgba(150,34,16,0.5)');
  sgr.addColorStop(1, 'rgba(70,12,6,0)');
  sg.fillStyle = sgr; sg.fillRect(0, 0, 128, 128);
  const sunTex = new THREE.CanvasTexture(sc); sunTex.colorSpace = THREE.SRGBColorSpace;
  const sun = new THREE.Sprite(new THREE.SpriteMaterial({
    map: sunTex, transparent: true, opacity: 1, depthWrite: false, fog: false, blending: THREE.AdditiveBlending,
  }));
  sun.scale.set(178, 178, 1);
  sun.position.set(8, 40, -300);
  scene.add(sun);

  // Ashmounts — volcanic peaks smouldering through the haze, flanking the palace
  const ashmt = new THREE.MeshStandardMaterial({ color: 0x080509, roughness: 1, metalness: 0 });
  const ember = softSprite('rgba(210,74,30,0.75)');
  for (const [mx, mz, mh] of [[-210, -250, 180], [205, -270, 200]] as const) {
    const mtn = new THREE.Mesh(new THREE.ConeGeometry(mh * 0.62, mh, 18), ashmt);
    mtn.position.set(mx, mh / 2 - 8, mz); scene.add(mtn);
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: ember, transparent: true, opacity: 0.6, depthWrite: false, fog: false, blending: THREE.AdditiveBlending,
    }));
    glow.scale.set(30, 20, 1); glow.position.set(mx, mh - 12, mz + 3); scene.add(glow);
  }
}

// =================== falling ash ===================
const ASH_N = 2200;
const FIELD = 70;
const ashPos = new Float32Array(ASH_N * 3);
const ashFall = new Float32Array(ASH_N);
const ashPhase = new Float32Array(ASH_N);
for (let i = 0; i < ASH_N; i++) {
  ashPos[i * 3] = rand(-FIELD, FIELD);
  ashPos[i * 3 + 1] = rand(0, 60);
  ashPos[i * 3 + 2] = rand(-FIELD, FIELD);
  ashFall[i] = rand(0.5, 1.7);
  ashPhase[i] = rand(0, Math.PI * 2);
}
const ashGeo = new THREE.BufferGeometry();
ashGeo.setAttribute('position', new THREE.BufferAttribute(ashPos, 3));
const ash = new THREE.Points(ashGeo, new THREE.PointsMaterial({
  size: 0.18, map: softSprite('rgba(98,90,78,1)'), transparent: true,
  opacity: 0.9, depthWrite: false, sizeAttenuation: true,
}));
ash.frustumCulled = false;
scene.add(ash);

// =================== warm embers drifting up from the forges & lamps ===================
const EMB_N = 420, EFIELD = 55;
const embPos = new Float32Array(EMB_N * 3);
const embRise = new Float32Array(EMB_N);
const embPh = new Float32Array(EMB_N);
for (let i = 0; i < EMB_N; i++) {
  embPos[i * 3] = rand(-EFIELD, EFIELD);
  embPos[i * 3 + 1] = rand(0, 18);
  embPos[i * 3 + 2] = rand(-EFIELD, EFIELD);
  embRise[i] = rand(0.25, 0.9);
  embPh[i] = rand(0, Math.PI * 2);
}
const embGeo = new THREE.BufferGeometry();
embGeo.setAttribute('position', new THREE.BufferAttribute(embPos, 3));
const embers = new THREE.Points(embGeo, new THREE.PointsMaterial({
  size: 0.14, map: softSprite('rgba(255,150,70,1)'), transparent: true,
  opacity: 0.85, depthWrite: false, sizeAttenuation: true, blending: THREE.AdditiveBlending,
}));
embers.frustumCulled = false;
scene.add(embers);

// =================== drifting mist banks ===================
// Low coiling mist that thickens the street and drinks the lamplight.
const mistTex = mistPuff();
const mists: THREE.Sprite[] = [];
const MFIELD = 60;   // mist is a local bank that wraps around the player (see the loop)
for (let i = 0; i < 80; i++) {
  const op0 = rand(0.1, 0.26);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({
    map: mistTex, transparent: true, opacity: op0, depthWrite: false,
    color: 0xb7b1a4, blending: THREE.NormalBlending,
  }));
  const sc = rand(12, 28);
  s.scale.set(sc, sc * rand(0.45, 0.62), 1);
  s.position.set(rand(-MFIELD, MFIELD), rand(0.5, 5), rand(-MFIELD, MFIELD));
  s.material.rotation = rand(0, Math.PI * 2);
  s.userData = { dx: rand(-0.3, 0.3), dz: rand(-0.24, 0.24), rot: rand(-0.05, 0.05), bob: rand(0, 6), op0 };
  scene.add(s);
  mists.push(s);
}

// =================== points of interest (original lore) ===================
type POI = { pos: THREE.Vector3; title: string; body: string };
const marketC = centerOf(MKT_B), plazaC = centerOf(PLAZA_B), ballC = centerOf(BALL_B), minC = centerOf(MIN_B), clubsC = centerOf(CLUBS_B);
const POIS: POI[] = [
  {
    pos: new THREE.Vector3(ballC.x + 9, 1.6, ballC.z),
    title: 'A Noble Ball',
    body: 'Keep Tellund blazes tonight. Through its towering windows the high nobility turn in their slow, glittering dances — silk and jewels, masks and wineglasses, a whole brilliant world sealed behind colored glass. Out in the street a skaa pauses in the falling ash to watch the silhouettes spin, then hurries on before a house guard marks the loitering.',
  },
  {
    pos: new THREE.Vector3(marketC.x, 1.6, marketC.z + 5),
    title: 'The Market',
    body: 'By day this square clatters with barrows of ash-grimed turnips and cheap tin, skaa hawking their wares beneath the watchful eyes of the Ministry. By night the stalls stand abandoned, canvas awnings sagging with soot, and only the boldest cutpurse lingers once the mist begins to climb the cobbles.',
  },
  {
    pos: new THREE.Vector3(plazaC.x, 1.6, plazaC.z + 6),
    title: "The Lord Ruler's Plaza",
    body: 'An open square paved in black stone, and at its heart an obelisk thrust at the sky like an accusing finger. The skaa cross it quickly, eyes down: it is said the Steel Ministry counts the faces that linger here too long. The Lord Ruler does not need statues of himself. The whole of Luthadel is his monument.',
  },
  {
    pos: new THREE.Vector3(clubsC.x + 7, 1.6, clubsC.z),
    title: "Clubs' Shop",
    body: 'A soot-stained workshop, no different to look at than a hundred others — a carpenter takes commissions here, and the smoke from his chimney never quite stops. But the lamps burn late behind those shutters, and the figures who slip in after dark are not here for cabinetry. Some crews plan a robbery. This one, they whisper, plans the impossible.',
  },
  {
    pos: new THREE.Vector3(minC.x - 9, 1.6, minC.z - 5),
    title: 'The Steel Ministry',
    body: 'The cathedral of the Final Empire rears black against the gate, its steeple a spear among spires. Within, the obligators keep their ledgers of every birth, bargain, and breath in Luthadel; and somewhere below, the Inquisitors wait, spikes of steel driven through their eyes, who can smell an Allomancer on the wind. Hurry past. Do not burn metal here.',
  },
  {
    pos: new THREE.Vector3(AV / 2 + 3, 1.6, canalZ + 4),
    title: 'The Ashen Canal',
    body: 'Water once ran clear through the city; now the canals lie black and still beneath a skin of ash, and the skaa haul their barges by lantern through the dark. A bridge arches overhead, slick with soot. Lean over the rail and the water gives you back nothing — no reflection, no moon, only the red smear of a distant fire and your own shadow.',
  },
  {
    pos: new THREE.Vector3(0, 1.6, ZF + 4),
    title: 'The City Gate',
    body: 'The gate stands open to the avenue, and beyond it the black palace claws at the red sky: Kredik Shaw, the Hill of a Thousand Spires, vast beyond reason. A thousand years the Lord Ruler has watched the city from within it. They say he is immortal. They say he is God. Tonight, no one in Luthadel dares say otherwise.',
  },
  {
    pos: new THREE.Vector3(-(AV / 2 + 3), 1.6, 22),
    title: 'The Mists',
    body: 'Nightfall, and the mists rise. They coil between the houses and drink the lamplight, and behind every barred door the skaa whisper the old fear — that things move out here when the world goes white. Yet a rare few walk willingly into the mist, and find that it does not harm them at all. It waits for them.',
  },
  {
    pos: new THREE.Vector3(AV / 2 + 3, 1.6, ZB - 16),
    title: 'Skaa Tenements',
    body: 'The skaa quarters. Hundreds sleep stacked in these crumbling rows, roused before the red dawn to feed the forges and the canals. They keep their eyes low, their voices lower, and their hopes quieter still. In the Final Empire, to survive is to go unnoticed by it.',
  },
  {
    pos: new THREE.Vector3(-XW + 7, 1.6, (ZB + ZF) / 2),
    title: 'The City Wall',
    body: 'The wall rings Luthadel like a clenched fist, studded with watch-towers where the Garrison stands its cold vigil. It was raised to keep enemies out — but a thousand years without a war have turned it inward, and now it mostly keeps the skaa in. From the parapet, they say, you can see the ashmounts burning on the horizon, and forget for a moment that you cannot leave.',
  },
];
for (const p of POIS) {
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: softSprite('rgba(230,150,70,0.95)'), transparent: true, opacity: 0.9,
    depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
  }));
  glow.scale.set(1.1, 1.1, 1);
  glow.position.copy(p.pos);
  glow.userData = { base: p.pos.y };
  scene.add(glow);
  (p as POI & { glow: THREE.Sprite }).glow = glow;
}

// =================== player-avatar figure (kept for Phase 1 multiplayer) ===================
// The roaming skaa/Garrison NPCs + beggars were removed — a PvP arena holds only Mistborn,
// and dropping them is a small perf win. makeFigure() stays: it becomes the networked avatar.
const clothMat = new THREE.MeshStandardMaterial({ color: 0x15110e, roughness: 1, metalness: 0 });
const guardMat = new THREE.MeshStandardMaterial({ color: 0x0d0f14, roughness: 1, metalness: 0 });
const skinMat = new THREE.MeshStandardMaterial({ color: 0x2c211a, roughness: 1, metalness: 0 });
const staffMat = new THREE.MeshStandardMaterial({ color: 0x191310, roughness: 1, metalness: 0 });

// a low-poly cloaked figure with hip/shoulder pivots so the limbs can swing
type Figure = { group: THREE.Group; legs: THREE.Group[]; arms: THREE.Group[] };
function makeFigure(guard: boolean): Figure {
  const g = new THREE.Group();
  const cloth = guard ? guardMat : clothMat;
  const hipY = 0.62, shY = 1.28;
  const legGeo = new THREE.CylinderGeometry(0.075, 0.055, 0.62, 5);
  const armGeo = new THREE.CylinderGeometry(0.055, 0.045, 0.52, 5);
  const legs: THREE.Group[] = [], arms: THREE.Group[] = [];
  for (const sx of [-0.1, 0.1]) {
    const p = new THREE.Group(); p.position.set(sx, hipY, 0);
    const leg = new THREE.Mesh(legGeo, cloth); leg.position.y = -0.31; p.add(leg);
    g.add(p); legs.push(p);
  }
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.33, 0.74, 7), cloth);
  body.position.y = hipY + 0.37; g.add(body);
  for (const sx of [-0.2, 0.2]) {
    const p = new THREE.Group(); p.position.set(sx, shY, 0);
    const arm = new THREE.Mesh(armGeo, cloth); arm.position.y = -0.26; p.add(arm);
    g.add(p); arms.push(p);
  }
  const shoulders = new THREE.Mesh(new THREE.SphereGeometry(0.27, 8, 6), cloth);
  shoulders.position.y = shY; shoulders.scale.set(1, 0.6, 0.9); g.add(shoulders);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.11, 8, 8), skinMat);
  head.position.set(0, shY + 0.17, guard ? 0 : 0.05); g.add(head);
  const hood = new THREE.Mesh(new THREE.ConeGeometry(0.19, 0.33, 9), cloth);
  hood.position.set(0, shY + 0.18, -0.02); hood.rotation.x = guard ? 0.05 : 0.22; g.add(hood);
  if (guard) {
    const staff = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.8, 5), staffMat);
    staff.position.set(0.26, hipY + 0.4, 0.04); g.add(staff);
  }
  return { group: g, legs, arms };
}

// (Roaming NPC walkers, their spawn loops and the huddled beggars were removed — only
// Mistborn fight in the mist. The atium ghost-trails went with them; atium will instead
// reveal *enemy players'* near-future once multiplayer combat lands.)

// =================== controls ===================
const controls = new PointerLockControls(camera, document.body);
const player = controls.object;
player.position.set(0, 1.7, ZB - 16);   // spawn at the back wall, the full avenue receding toward Kredik Shaw

const keys: Record<string, boolean> = {};
let loreOpen = false;

// player physics is now a pure shared sim (src/sim.ts): P = the player's sim state,
// W = the collision/anchor world it reads, inp = the per-frame input we feed it each tick.
const P: PlayerState = newPlayerState(0, 1.7, ZB - 16);
const W: SimWorld = { METALS, metalGrid, roofGrid, bounds: { XW, ZB, ZF } };
const inp: PlayerInput = { fwd: 0, strafe: 0, yaw: 0, pitch: 0, pewter: false, pushing: false, pulling: false, jump: false, dt: 0 };
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
let jumpQueued = false;

// multiplayer (Phase 1 relay): the other Mistborn, drawn as cloaked avatars
const peerAvatars = new Map<number, Figure>();
netStart();

// further allomantic powers
let pulling = false;                       // iron-pull (right-mouse): yank toward an anchor
let pushing = false;                        // steel-push (left-mouse): shove off the gazed anchor
let pullTarget: THREE.Vector3 | null = null;
let tin = false;                           // burning tin (T): heightened senses, thinner mist
let tinAmt = 0;                            // eases toward tin ? 1 : 0
let atium = false;                         // burning atium (G): shadows of the near future
const FOG0 = (scene.fog as THREE.FogExp2).density;
const EXPOSURE0 = renderer.toneMappingExposure;
const CULL2 = 175 * 175;   // hide whole blocks beyond this (they're lost in the mist anyway)
let lampTick = 0;          // throttles re-binding the lamp-light pool to the nearest lamps

// =================== allomancy: burning steel/iron ===================
// Hold to "burn metal": translucent blue lines lance from the chest to every
// metal source in range, brighter the nearer it is — the Mistborn's metal sight.
let burning = false;
let sightFlare = 0;       // brief auto-burn that flashes the lines on each leap
const SIGHT_RANGE = 34;
const SIGHT_MAX = Math.min(1200, METALS.length);   // the sight only spans nearby metals now — cap drawn segments
const sightPos = new Float32Array(SIGHT_MAX * 2 * 3);
const sightCol = new Float32Array(SIGHT_MAX * 2 * 3);
const sightGeo = new THREE.BufferGeometry();
sightGeo.setAttribute('position', new THREE.BufferAttribute(sightPos, 3));
sightGeo.setAttribute('color', new THREE.BufferAttribute(sightCol, 3));
const sight = new THREE.LineSegments(sightGeo, new THREE.LineBasicMaterial({
  vertexColors: true, transparent: true, depthWrite: false,
  blending: THREE.AdditiveBlending, opacity: 0.95,
}));
sight.frustumCulled = false;
sight.visible = false;
scene.add(sight);

// glowing nodes at each metal the lines touch, and a fat, pulsing beam to the anchor
// you're actually pushing/pulling — the upgrade from the old 1px lines to a real
// Allomantic "feel" (the bloom pass fattens all of this into proper light).
const NODE_N = 36;
const nodeTex = softSprite('rgba(150,200,255,0.95)');
const nodes: THREE.Sprite[] = [];
for (let i = 0; i < NODE_N; i++) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({
    map: nodeTex, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  s.visible = false; scene.add(s); nodes.push(s);
}
const beamMat = new THREE.MeshBasicMaterial({ color: 0x7fc4ff, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 1, 8), beamMat);
beam.userData.noShadow = true; beam.visible = false; scene.add(beam);
const _bmid = new THREE.Vector3(), _bdir = new THREE.Vector3(), _bq = new THREE.Quaternion();
const _yAxis = new THREE.Vector3(0, 1, 0);

const _chest = new THREE.Vector3();
function updateSight(t: number) {
  document.body.classList.toggle('burning', burning || pulling || pushing);
  if (!burning && !pulling && !pushing && sightFlare <= 0) {
    if (sight.visible) sight.visible = false;
    if (beam.visible) beam.visible = false;
    for (const n of nodes) if (n.visible) n.visible = false;
    return;
  }
  sight.visible = true;
  _chest.copy(player.position).y -= 0.35; // lines spring from the sternum
  const pulse = 0.82 + 0.18 * Math.sin(t * 7);
  // only the metals near the player can be in sight-range — query the grid, not all metals
  const near = metalsNear(W, player.position.x, player.position.z, 38);
  let j = 0, nodeI = 1, hasTarget = false;
  for (let i = 0; i < near.length && j < SIGHT_MAX; i++) {
    const m = near[i];
    const d = _chest.distanceTo(m.pos);
    const isTarget = m.pos === pullTarget;
    if (!(d < SIGHT_RANGE || isTarget)) continue;
    const o = j * 6; j++;
    const a = Math.max(0, 1 - d / SIGHT_RANGE);
    const b = isTarget ? pulse : Math.min(1, a * a * 1.7 * m.r) * pulse;
    sightPos[o] = _chest.x; sightPos[o + 1] = _chest.y; sightPos[o + 2] = _chest.z;
    sightPos[o + 3] = m.pos.x; sightPos[o + 4] = m.pos.y; sightPos[o + 5] = m.pos.z;
    if (isTarget) { // the anchor you're pulling on flares bright blue-white (>1 so bloom blazes)
      sightCol[o] = 0.7 * b; sightCol[o + 1] = 1.0 * b; sightCol[o + 2] = 1.3 * b;
      sightCol[o + 3] = 1.1 * b; sightCol[o + 4] = 1.25 * b; sightCol[o + 5] = 1.4 * b;
    } else {
      sightCol[o] = 0.20 * b; sightCol[o + 1] = 0.52 * b; sightCol[o + 2] = 1.2 * b;  // faint at the chest
      sightCol[o + 3] = 0.55 * b; sightCol[o + 4] = 0.95 * b; sightCol[o + 5] = 1.35 * b; // blazing at the metal
    }
    // a glowing node where the line touches metal
    if (isTarget) {
      hasTarget = true;
      const n = nodes[0]; n.visible = true; n.position.copy(m.pos); n.scale.set(1.7, 1.7, 1);
      const nm = n.material as THREE.SpriteMaterial; nm.opacity = pulse; nm.color.setRGB(0.85, 0.95, 1.0);
    } else if (nodeI < NODE_N) {
      const n = nodes[nodeI++]; n.visible = true; n.position.copy(m.pos);
      const sz = 0.45 + a * 0.7; n.scale.set(sz, sz, 1);
      const nm = n.material as THREE.SpriteMaterial; nm.opacity = 0.4 * a * a * pulse; nm.color.setRGB(0.35, 0.6, 1.0);
    }
  }
  sightGeo.setDrawRange(0, j * 2);   // draw only the active segments
  if (!hasTarget && nodes[0].visible) nodes[0].visible = false;
  for (let k = nodeI; k < NODE_N; k++) if (nodes[k].visible) nodes[k].visible = false;
  // the fat, pulsing beam to the anchor you're actually pushing/pulling on
  if (pullTarget && (pulling || pushing)) {
    beam.visible = true;
    _bmid.copy(_chest).add(pullTarget).multiplyScalar(0.5); beam.position.copy(_bmid);
    _bdir.copy(pullTarget).sub(_chest); const len = _bdir.length(); _bdir.divideScalar(len || 1);
    beam.quaternion.setFromUnitVectors(_yAxis, _bdir);
    beam.scale.set(1, len, 1);
    beamMat.opacity = 0.45 + 0.3 * Math.sin(t * 22);
  } else if (beam.visible) beam.visible = false;
  sightGeo.attributes.position.needsUpdate = true;
  sightGeo.attributes.color.needsUpdate = true;
}

// surfaceAt / resolveWalls / aimMetal / steelLeap / stepPlayer now live in src/sim.ts —
// the pure, engine-free simulation that the client and the future server both run.

addEventListener('keydown', (e) => {
  keys[e.code] = true;
  if (e.code === 'KeyE') {
    if (loreOpen) closeLore();
    else if (activePOI) openLore(activePOI);
  }
  if (e.code === 'KeyM') toggleMute();
  if (e.code === 'KeyF') burning = true;
  if (e.code === 'KeyG') atium = true;                     // burn atium — see the near future
  if (e.code === 'KeyT' && !e.repeat) tin = !tin;          // toggle tin — heightened senses
  if (e.code === 'Backslash') {                            // toggle shadow maps (weak GPUs)
    localStorage.setItem('lutha_noshadow', localStorage.getItem('lutha_noshadow') === '1' ? '0' : '1');
    location.reload();
  }
  if (e.code === 'Space') { e.preventDefault(); if (!e.repeat && controls.isLocked && !loreOpen) jumpQueued = true; }
});
addEventListener('keyup', (e) => {
  keys[e.code] = false;
  if (e.code === 'KeyF') burning = false;
  if (e.code === 'KeyG') atium = false;
});
// mouse: left steel-pushes (shove off gazed anchor), right iron-pulls (yank toward it)
addEventListener('mousedown', (e) => {
  if (e.button === 0) pushing = true;
  if (e.button === 2) pulling = true;
});
addEventListener('mouseup', (e) => {
  if (e.button === 0) pushing = false;
  if (e.button === 2) pulling = false;
});
addEventListener('contextmenu', (e) => e.preventDefault());

// =================== UI wiring ===================
const intro = document.getElementById('intro')!;
const enterBtn = document.getElementById('enterBtn')!;
const crosshair = document.getElementById('crosshair')!;
const promptEl = document.getElementById('prompt')!;
const promptLabel = document.getElementById('prompt-label')!;
const loreEl = document.getElementById('lore')!;
const loreTitle = document.getElementById('lore-title')!;
const loreBody = document.getElementById('lore-body')!;

enterBtn.addEventListener('click', () => controls.lock());
controls.addEventListener('lock', () => {
  intro.classList.add('hidden');
  crosshair.classList.remove('hidden');
  startWind();
});
controls.addEventListener('unlock', () => {
  intro.classList.remove('hidden');
  crosshair.classList.add('hidden');
  promptEl.classList.add('hidden');
});

let activePOI: POI | null = null;
function openLore(p: POI) {
  loreOpen = true;
  loreTitle.textContent = p.title;
  loreBody.textContent = p.body;
  loreEl.classList.remove('hidden');
  promptEl.classList.add('hidden');
}
function closeLore() {
  loreOpen = false;
  loreEl.classList.add('hidden');
}

// =================== ambient wind (WebAudio, guarded) ===================
let audioCtx: AudioContext | null = null;
let windGain: GainNode | null = null;
let muted = false;
function startWind() {
  if (audioCtx) return;
  try {
    audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const ctx = audioCtx;
    // pink-ish noise buffer
    const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < data.length; i++) {
      const white = rnd() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3.2;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 420; lp.Q.value = 0.6;
    windGain = ctx.createGain(); windGain.gain.value = muted ? 0 : 0.05;
    // slow gusts
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.07;
    const lfoGain = ctx.createGain(); lfoGain.gain.value = 240;
    lfo.connect(lfoGain); lfoGain.connect(lp.frequency);
    src.connect(lp); lp.connect(windGain); windGain.connect(ctx.destination);
    src.start(); lfo.start();
  } catch { /* audio is optional; ignore */ }
}
function toggleMute() {
  muted = !muted;
  if (windGain && audioCtx) windGain.gain.setTargetAtTime(muted ? 0 : 0.05, audioCtx.currentTime, 0.1);
}

// =================== resize ===================
addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
  bloom.setSize(window.innerWidth >> 1, window.innerHeight >> 1);
});

// =================== loop ===================
const clock = new THREE.Clock();
function animate() {
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;

  // movement — the entire physics step is now one pure function (shared with the server).
  // The camera owns look (mouse); we read yaw/pitch off it, run the sim, write position back.
  if (controls.isLocked && !loreOpen) {
    _euler.setFromQuaternion(camera.quaternion, 'YXZ');
    inp.fwd = (keys['KeyW'] || keys['ArrowUp'] ? 1 : 0) - (keys['KeyS'] || keys['ArrowDown'] ? 1 : 0);
    inp.strafe = (keys['KeyD'] || keys['ArrowRight'] ? 1 : 0) - (keys['KeyA'] || keys['ArrowLeft'] ? 1 : 0);
    inp.yaw = _euler.y; inp.pitch = _euler.x;
    inp.pewter = !!(keys['ShiftLeft'] || keys['ShiftRight']);
    inp.pushing = pushing; inp.pulling = pulling; inp.jump = jumpQueued; inp.dt = dt;
    jumpQueued = false;
    stepPlayer(W, P, inp);
    pullTarget = P.target;
    if (P.leaped) sightFlare = 0.7;                 // flash the steel-lines on a leap
    player.position.set(P.x, P.y, P.z);
    netSend(P.x, P.y, P.z, _euler.y, dt);           // broadcast our position to the other Mistborn
  }

  // draw the other players as cloaked avatars, smoothly interpolated ~100 ms in the past
  {
    const pr = netInterpolated();
    for (const [id, s] of pr) {
      let av = peerAvatars.get(id);
      if (!av) { av = makeFigure(false); scene.add(av.group); peerAvatars.set(id, av); }
      const px = av.group.position.x, pz = av.group.position.z;
      av.group.position.set(s.x, s.y - 1.7, s.z);    // feet under their eye; interp already smooth
      av.group.rotation.y = s.yaw;                    // face their look direction
      const sp = Math.hypot(s.x - px, s.z - pz);      // per-frame travel → limb swing
      const sw = Math.sin(t * 10) * Math.min(0.7, sp * 18);
      av.legs[0].rotation.x = sw; av.legs[1].rotation.x = -sw;
      av.arms[0].rotation.x = -sw; av.arms[1].rotation.x = sw;
    }
    for (const [id, av] of peerAvatars) if (!pr.has(id)) { scene.remove(av.group); peerAvatars.delete(id); }
  }

  // tin: ease the senses open — thinner fog & mist, a brighter, colder clarity
  tinAmt += ((tin ? 1 : 0) - tinAmt) * Math.min(1, dt * 4);
  (scene.fog as THREE.FogExp2).density = FOG0 * (1 - 0.55 * tinAmt);
  renderer.toneMappingExposure = EXPOSURE0 * (1 + 0.32 * tinAmt);
  grade.uniforms.bright.value = 1 + 0.16 * tinAmt;
  grade.uniforms.tin.value = tinAmt;
  document.body.classList.toggle('pewter', !!(keys['ShiftLeft'] || keys['ShiftRight']) && controls.isLocked && P.grounded);

  const cp = player.position;

  // the moon's shadow rig chases the player, so shadows stay crisp across the whole city
  if (SHADOWS) {
    moon.position.set(cp.x + MOON_OFF.x, MOON_OFF.y, cp.z + MOON_OFF.z);
    moon.target.position.set(cp.x, 0, cp.z);
    moon.target.updateMatrixWorld();
  }

  // bind the small pool of real lamp-lights to the nearest lamps (throttled), then flicker
  lampTick -= dt;
  if (lampTick <= 0) {
    lampTick = 0.15;
    lamps.sort((a, b) => ((a.x - cp.x) ** 2 + (a.z - cp.z) ** 2) - ((b.x - cp.x) ** 2 + (b.z - cp.z) ** 2));
    for (let i = 0; i < LAMP_LIGHTS; i++) {
      if (lamps[i]) {
        lampPool[i].position.set(lamps[i].x, 4.5, lamps[i].z);
        flamePool[i].visible = true; flamePool[i].position.set(lamps[i].x, 4.6, lamps[i].z);
      } else { lampPool[i].intensity = 0; flamePool[i].visible = false; }
    }
    for (let i = 0; i < SHAFTS; i++) {                  // shafts hang only under the closest lamps (caps additive overdraw)
      const lm = lamps[i];
      if (lm && (lm.x - cp.x) ** 2 + (lm.z - cp.z) ** 2 < 22 * 22) { shaftPool[i].visible = true; shaftPool[i].position.set(lm.x, 2.25, lm.z); }
      else shaftPool[i].visible = false;
    }
    for (let i = 0; i < lamps.length; i++) {            // distant halos are fogged to almost nothing — skip their additive fill
      const lm = lamps[i];
      lm.halo.visible = (lm.x - cp.x) ** 2 + (lm.z - cp.z) ** 2 < 145 * 145;
    }
  }
  for (let i = 0; i < LAMP_LIGHTS && lamps[i]; i++) {
    // a guttering flame — irregular, dipping; never the steady output of a bulb
    const fl = 0.78 + 0.16 * Math.sin(t * 12 + i * 1.7) + 0.10 * Math.sin(t * 24.5 + i * 4.1);
    lampPool[i].intensity = 30 * fl;
    const fs = flamePool[i];
    fs.scale.set(0.5 + 0.12 * fl, 0.9 + 0.25 * fl, 1);
    (fs.material as THREE.SpriteMaterial).opacity = 0.45 + 0.4 * fl;
  }

  // hide whole blocks lost in the mist — draw calls stay bounded no matter how big the city is
  for (const b of blockGroups) {
    const dx = b.cx - cp.x, dz = b.cz - cp.z;
    b.g.visible = dx * dx + dz * dz < CULL2;
  }

  // interior lights only burn when the player is near their building (keeps active lights low)
  for (const il of interiorLights) {
    const dx = il.x - cp.x, dz = il.z - cp.z;
    il.l.intensity = dx * dx + dz * dz < 50 * 50 ? il.max : 0;
  }

  // ash fall + recycle around the camera
  for (let i = 0; i < ASH_N; i++) {
    let y = ashPos[i * 3 + 1] - ashFall[i] * dt;
    if (y < 0) y += 60;
    ashPos[i * 3 + 1] = y;
    ashPos[i * 3] += (Math.sin(t * 0.4 + ashPhase[i]) * 0.25 + 0.12) * dt;
    let dx = ashPos[i * 3] - cp.x;
    if (dx > FIELD) ashPos[i * 3] -= 2 * FIELD; else if (dx < -FIELD) ashPos[i * 3] += 2 * FIELD;
    let dz = ashPos[i * 3 + 2] - cp.z;
    if (dz > FIELD) ashPos[i * 3 + 2] -= 2 * FIELD; else if (dz < -FIELD) ashPos[i * 3 + 2] += 2 * FIELD;
  }
  ashGeo.attributes.position.needsUpdate = true;

  // warm embers rising & swaying, recycled around the camera
  for (let i = 0; i < EMB_N; i++) {
    let y = embPos[i * 3 + 1] + embRise[i] * dt;
    if (y > 18) y -= 18;
    embPos[i * 3 + 1] = y;
    embPos[i * 3] += Math.sin(t * 0.6 + embPh[i]) * 0.18 * dt;
    embPos[i * 3 + 2] += Math.cos(t * 0.5 + embPh[i]) * 0.14 * dt;
    const dx = embPos[i * 3] - cp.x;
    if (dx > EFIELD) embPos[i * 3] -= 2 * EFIELD; else if (dx < -EFIELD) embPos[i * 3] += 2 * EFIELD;
    const dz = embPos[i * 3 + 2] - cp.z;
    if (dz > EFIELD) embPos[i * 3 + 2] -= 2 * EFIELD; else if (dz < -EFIELD) embPos[i * 3 + 2] += 2 * EFIELD;
  }
  embGeo.attributes.position.needsUpdate = true;

  // drifting, slowly coiling mist — a local bank that wraps around the player
  for (const m of mists) {
    m.position.x += m.userData.dx * dt;
    m.position.z += m.userData.dz * dt;
    m.position.y += Math.sin(t * 0.3 + m.userData.bob) * 0.06 * dt;
    m.material.rotation += m.userData.rot * dt;
    m.material.opacity = m.userData.op0 * (1 - 0.55 * tinAmt);   // tin thins the mist
    const mdx = m.position.x - cp.x;
    if (mdx > MFIELD) m.position.x -= 2 * MFIELD; else if (mdx < -MFIELD) m.position.x += 2 * MFIELD;
    const mdz = m.position.z - cp.z;
    if (mdz > MFIELD) m.position.z -= 2 * MFIELD; else if (mdz < -MFIELD) m.position.z += 2 * MFIELD;
  }

  // the noble ball — dancers swaying behind the grand keep's bright windows
  for (const d of ballDancers) {
    d.m.position.z = d.z0 + Math.sin(t * 1.1 + d.ph) * 0.6;
    d.m.position.y = Math.abs(Math.sin(t * 2.2 + d.ph)) * 0.08;   // turning on the ballroom floor
    d.m.rotation.y = Math.sin(t * 0.7 + d.ph) * 0.6;
  }

  // nearest POI prompt
  if (controls.isLocked && !loreOpen) {
    let best: POI | null = null, bestD = 6;
    for (const p of POIS) {
      const d = Math.hypot(p.pos.x - cp.x, p.pos.z - cp.z);
      if (d < bestD) { bestD = d; best = p; }
      const gl = (p as POI & { glow: THREE.Sprite }).glow;
      gl.position.y = gl.userData.base + Math.sin(t * 1.5 + p.pos.z) * 0.12;
    }
    activePOI = best;
    if (best) { promptLabel.textContent = best.title; promptEl.classList.remove('hidden'); }
    else promptEl.classList.add('hidden');
  }

  if (sightFlare > 0) sightFlare -= dt;
  updateSight(t);

  grade.uniforms.time.value = t;
  composer.render();
  requestAnimationFrame(animate);
}

// every building, wall, roof and figure casts & receives the moon's shadow; and tune
// how strongly each surface drinks the reflection environment — matte soot stays dull,
// wet stone / water / copper domes / metal gleam with the red horizon & cold moon.
scene.traverse((o) => {
  const mesh = o as THREE.Mesh;
  if (mesh.isMesh && !o.userData.sky && !o.userData.noShadow) { o.castShadow = true; o.receiveShadow = true; }
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const mm of mats) {
    const sm = mm as THREE.MeshStandardMaterial;
    if (sm && (sm as unknown as { isMeshStandardMaterial?: boolean }).isMeshStandardMaterial)
      sm.envMapIntensity = (sm.metalness > 0.1 || sm.roughness < 0.45) ? 0.9 : 0.32;
  }
});

buildGrids();   // index every ROOFS footprint + METALS point into the spatial grid before the loop
animate();

// dev-only handle so the scene can be driven/inspected from the preview harness
if (import.meta.env.DEV) {
  (window as any).__lutha = {
    THREE, scene, camera, controls, player, renderer, composer, bloom, grade,
    METALS, ROOFS, lamps, lampPool, flamePool, blockGroups, shaftPool, embers, nodes, beam, SEED,
    burn: (v: boolean) => { burning = v; },
    pull: (v: boolean) => { pulling = v; },
    shove: (v: boolean) => { pushing = v; },
    tinOn: (v: boolean) => { tin = v; },
    atiumOn: (v: boolean) => { atium = v; },
    P, W,
    push: () => { const ok = steelLeap(W, P, false); player.position.set(P.x, P.y, P.z); return ok; },
    step: (i: Partial<PlayerInput>) => { Object.assign(inp, { fwd: 0, strafe: 0, yaw: 0, pitch: 0, pewter: false, pushing: false, pulling: false, jump: false, dt: 1 / 60 }, i); stepPlayer(W, P, inp); player.position.set(P.x, P.y, P.z); return { x: +P.x.toFixed(2), y: +P.y.toFixed(2), z: +P.z.toFixed(2), vy: +P.vy.toFixed(2), grounded: P.grounded }; },
    state: () => ({ y: +P.y.toFixed(2), vy: +P.vy.toFixed(2), grounded: P.grounded, tinAmt: +tinAmt.toFixed(2), pulling, target: pullTarget ? pullTarget.toArray().map(n => +n.toFixed(1)) : null }),
    surfaceAt: (x: number, z: number) => surfaceAt(W, x, z),
    metalsNear: (x: number, z: number, r: number) => metalsNear(W, x, z, r).slice(),
    gridStats: () => ({ metalCells: metalGrid.size, roofCells: roofGrid.size }),
    resolveWalls: () => { resolveWalls(W, P); player.position.set(P.x, P.y, P.z); return { x: +P.x.toFixed(2), z: +P.z.toFixed(2) }; },
    interiorLights,
    set: (x: number, y: number, z: number) => { P.x = x; P.y = y; P.z = z; P.vx = P.vz = P.vy = P.px = P.pz = 0; player.position.set(x, y, z); },
    keys, peerAvatars, combat,
    net: () => ({ connected: netConnected(), peers: [...netPeers().entries()], avatars: peerAvatars.size }),
    diag: () => ({ isLocked: controls.isLocked, loreOpen, keysDown: Object.keys(keys).filter(k => keys[k]) }),
    key: (code: string, down: boolean) => { keys[code] = down; },
  };
}
