import './style.css';
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

const rand = (a: number, b: number) => a + Math.random() * (b - a);
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
  for (let i = 0; i < 9000; i++) { g.fillStyle = `rgba(0,0,0,${rand(0.05, 0.2)})`; g.fillRect(Math.random() * S, Math.random() * S, rand(1, 2.2), rand(1, 2.2)); }
  // broad damp patches — wet stone reflects the lamplight; wrapped so they tile too
  for (let i = 0; i < 11; i++) {
    const px = Math.random() * S, py = Math.random() * S, pr = rand(45, 130);
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

const KEEP_GLASS = ['#c0392b', '#caa13a', '#2e6da4', '#4a8f5a', '#7d3c98', '#bd5a26', '#3b8686'];

function facadeSet(wWorld: number, hWorld: number, isKeep: boolean): THREE.Material[] {
  const floors = Math.max(3, Math.round(hWorld / 3.2));
  const cols = Math.max(2, Math.round(wWorld / 2.6));
  const cell = 64;
  const cw = cell * cols, ch = cell * floors;
  const map = document.createElement('canvas'); map.width = cw; map.height = ch;
  const emis = document.createElement('canvas'); emis.width = cw; emis.height = ch;
  const hgt = document.createElement('canvas'); hgt.width = cw; hgt.height = ch;
  const g = map.getContext('2d')!, ge = emis.getContext('2d')!, gh = hgt.getContext('2d')!;

  g.fillStyle = isKeep ? '#241a12' : '#160f09'; g.fillRect(0, 0, cw, ch);
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
      g.fillStyle = Math.random() < 0.5 ? `rgba(0,0,0,${rand(0, 0.13)})` : `rgba(74,60,44,${rand(0, 0.07)})`;
      g.fillRect(x + bo, y, course, course);
    }
  }

  // windows: recessed frames, with lit leaded/stained glass
  const mx = cell * 0.26, top = cell * 0.30;
  for (let r = 0; r < floors; r++) {
    for (let c = 0; c < cols; c++) {
      const x = c * cell + mx, y = r * cell + top;
      const ww = cell - mx * 2, wh = cell - top - cell * 0.14;
      gh.fillStyle = '#5a5a5a'; gh.fillRect(x - 5, y - 5, ww + 10, wh + 10); // raised stone surround
      gh.fillStyle = '#0e0e0e'; gh.fillRect(x - 2, y - 2, ww + 4, wh + 4);   // deep recess
      g.fillStyle = '#0a0806'; g.fillRect(x - 4, y - 4, ww + 8, wh + 8);
      const lit = isKeep ? Math.random() < 0.58 : Math.random() < 0.16;
      if (lit) {
        const col = isKeep ? KEEP_GLASS[(Math.random() * KEEP_GLASS.length) | 0] : '#e0a64a';
        g.fillStyle = col; g.fillRect(x, y, ww, wh);
        ge.fillStyle = col; ge.fillRect(x, y, ww, wh);
        g.strokeStyle = ge.strokeStyle = 'rgba(6,5,4,0.85)';
        g.lineWidth = ge.lineWidth = isKeep ? 2 : 1.4;
        const div = isKeep ? 3 : 2;
        for (let k = 1; k < div; k++) {
          const fx = x + ww * k / div;
          g.beginPath(); g.moveTo(fx, y); g.lineTo(fx, y + wh); g.stroke();
          ge.beginPath(); ge.moveTo(fx, y); ge.lineTo(fx, y + wh); ge.stroke();
          const fy = y + wh * k / div;
          g.beginPath(); g.moveTo(x, fy); g.lineTo(x + ww, fy); g.stroke();
          ge.beginPath(); ge.moveTo(x, fy); ge.lineTo(x + ww, fy); ge.stroke();
        }
      } else {
        g.fillStyle = '#080706'; g.fillRect(x, y, ww, wh);
        gh.fillStyle = '#0c0c0c'; gh.fillRect(x, y, ww, wh);
      }
    }
  }

  // soot streaks running down + top-darkening, "like paint down a canvas"
  for (let i = 0; i < cw / 9; i++) {
    const sx = Math.random() * cw, sw = rand(3, 11), sh = rand(ch * 0.25, ch * 0.85);
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
    emissiveIntensity: isKeep ? 1.7 : 1.0, normalMap: normalTex,
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
scene.fog = new THREE.FogExp2(FOG, 0.0125);

const camera = new THREE.PerspectiveCamera(72, window.innerWidth / window.innerHeight, 0.1, 900);
camera.position.set(0, 1.7, 30);

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
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      float l = dot(c, vec3(0.299, 0.587, 0.114));
      // lift shadows toward cold blue, push highlights toward warm ember
      c += vec3(-0.012, 0.0, 0.03) * (1.0 - l);
      c += vec3(0.03, 0.012, -0.02) * l;
      c *= bright;                                  // tin brightens the night
      c += tin * 0.05 * vec3(0.6, 0.8, 1.0);        // tin lends a cold clarity
      // soft vignette (eases open while burning tin)
      vec2 d = vUv - 0.5;
      float v = smoothstep(1.1, 0.25, dot(d, d) * 4.0);
      c *= mix(mix(0.74, 0.9, tin), 1.0, v);
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
    new THREE.SphereGeometry(500, 32, 16),
    new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, fog: false, depthWrite: false }),
  );
  sky.userData.sky = true;   // never a shadow caster/receiver
  scene.add(sky);
}

// =================== lighting ===================
scene.add(new THREE.HemisphereLight(0x3a2418, 0x0a0808, 0.8));
scene.add(new THREE.AmbientLight(0x171009, 0.55));   // lift the deep shadows just off black
const moon = new THREE.DirectionalLight(0x8a93c4, 0.7);
moon.position.set(-46, 86, 34);
moon.target.position.set(0, 0, -8);
scene.add(moon.target);
moon.castShadow = SHADOWS;                            // the one shadow-caster over the district
moon.shadow.mapSize.set(1024, 1024);                 // balanced; press \ to disable on weak GPUs
moon.shadow.camera.near = 20;
moon.shadow.camera.far = 260;
moon.shadow.camera.left = -95; moon.shadow.camera.right = 95;
moon.shadow.camera.top = 95; moon.shadow.camera.bottom = -95;
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
type Metal = { pos: THREE.Vector3; r: number };
const METALS: Metal[] = [];
const addMetal = (x: number, y: number, z: number, r = 1) =>
  METALS.push({ pos: new THREE.Vector3(x, y, z), r });

// building footprints, collected as we raise the street — used later for
// landing on rooftops and for not walking through walls while leaping.
type Roof = { minX: number; maxX: number; minZ: number; maxZ: number; top: number };
const ROOFS: Roof[] = [];

// warm pools of lantern light — placed along the streets once the district exists
const lampGlow = softSprite('rgba(255,182,92,0.9)');
const lampPostMat = new THREE.MeshStandardMaterial({ color: 0x100c08, roughness: 1, metalness: 0 });
// Posts + glowing halos are cheap, so place them densely; real PointLights are
// costly in forward rendering, so only `lit` lamps emit one (perf on weak GPUs).
function placeLamp(lx: number, lz: number, lit = true) {
  if (lit) {
    const pl = new THREE.PointLight(0xffb259, 36, 32, 2);
    pl.position.set(lx, 4.4, lz); scene.add(pl);
  }
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: lampGlow, transparent: true, opacity: lit ? 0.85 : 0.5, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  halo.scale.set(lit ? 2.4 : 1.7, lit ? 2.4 : 1.7, 1); halo.position.set(lx, 4.4, lz); scene.add(halo);
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.16, 4.4, 6), lampPostMat);
  post.position.set(lx, 2.2, lz); scene.add(post);
  addMetal(lx, 4.2, lz, 1.6); // the lantern's heavy iron bracket
}

// =================== ground ===================
{
  const cob = cobbleSet();
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(500, 500),
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
const trimMat = new THREE.MeshStandardMaterial({ color: 0x0c0906, roughness: 1, metalness: 0 });
const spireMat = new THREE.MeshStandardMaterial({ color: 0x09060b, roughness: 1, metalness: 0 });
// pre-bake a few façade material sets and reuse them across the district (cheap)
const tenPool = Array.from({ length: 6 }, () => facadeSet(8, 10, false));
const keepPool = Array.from({ length: 5 }, () => facadeSet(12, 22, true));
const pickMat = (a: THREE.Material[][]) => a[(Math.random() * a.length) | 0];

function placeBuilding(cx: number, cz: number, w: number, d: number, h: number, isKeep: boolean) {
  const yaw = rand(-0.035, 0.035);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), pickMat(isKeep ? keepPool : tenPool));
  mesh.position.set(cx, h / 2, cz); mesh.rotation.y = yaw; scene.add(mesh);
  ROOFS.push({ minX: cx - w / 2, maxX: cx + w / 2, minZ: cz - d / 2, maxZ: cz + d / 2, top: h });

  const cor = new THREE.Mesh(new THREE.BoxGeometry(w + 0.7, 0.7, d + 0.7), trimMat);
  cor.position.set(cx, h - 0.3, cz); cor.rotation.y = yaw; scene.add(cor);

  if (isKeep) {
    const ns = 4 + (Math.random() * 4 | 0);
    for (let s = 0; s < ns; s++) {
      const sh = rand(3, 7), sr = rand(0.3, 0.6);
      const spike = new THREE.Mesh(new THREE.ConeGeometry(sr, sh, 4), spireMat);
      spike.position.set(cx + rand(-w / 2 + 0.7, w / 2 - 0.7), h + sh / 2, cz + rand(-d / 2 + 0.7, d / 2 - 0.7));
      scene.add(spike);
    }
    const csh = rand(7, 12);
    const cspike = new THREE.Mesh(new THREE.ConeGeometry(rand(0.5, 0.9), csh, 4), spireMat);
    cspike.position.set(cx, h + csh / 2, cz); scene.add(cspike);
  } else {
    const roof = new THREE.Mesh(gableRoof(w + 0.5, d + 0.6, rand(1.6, 2.8)), roofMat);
    roof.position.set(cx, h, cz); roof.rotation.y = yaw; scene.add(roof);
  }

  // metals: door fittings on both street faces, barred windows, a rooftop vent
  addMetal(cx - w / 2, 1.5, cz + rand(-d / 3, d / 3), 1.0);
  addMetal(cx + w / 2, 1.5, cz + rand(-d / 3, d / 3), 1.0);
  for (let b = 0; b < (isKeep ? 3 : 2); b++) {
    addMetal(cx + (Math.random() < 0.5 ? -1 : 1) * w / 2, rand(3, h - 2), cz + rand(-d / 2.5, d / 2.5), isKeep ? 1.1 : 0.8);
  }
  addMetal(cx + rand(-w / 3, w / 3), h + 0.3, cz + rand(-d / 3, d / 3), 1.3);
}

// fill a city block with a 1–2 × 1–2 cluster of packed buildings
function fillBlock(x0: number, x1: number, z0: number, z1: number, keepChance: number) {
  const bw = x1 - x0, bd = z1 - z0, gap = 1.3;
  const nx = bw > 15 ? 2 : 1, nz = bd > 15 ? 2 : 1;
  const cwid = (bw - gap * (nx - 1)) / nx, cdep = (bd - gap * (nz - 1)) / nz;
  for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
    const isKeep = Math.random() < keepChance;
    const inset = rand(0.3, 1.1);
    const w = Math.max(4, cwid - inset * 2), d = Math.max(4, cdep - inset * 2);
    const h = isKeep ? rand(16, 26) : rand(7, 12);
    placeBuilding(x0 + i * (cwid + gap) + cwid / 2, z0 + j * (cdep + gap) + cdep / 2, w, d, h, isKeep);
  }
}

// ---- the walled district: a grid of blocks, the main avenue (x≈0) runs to the palace ----
const XW = 42, ZB = 46, ZF = -62;        // district half-width, back (+Z), front (−Z)
const xBlocks: [number, number][] = [[-42, -32], [-23, -6], [6, 23], [32, 42]];
const zBlocks: [number, number][] = [[29, 46], [-3, 20], [-35, -12], [-62, -45]];
const MKT_XI = 2, MKT_ZI = 1;            // this block is left open as the market square
const BALL_XI = 1, BALL_ZI = 1;          // this block holds the grand "ball" keep
for (let xi = 0; xi < xBlocks.length; xi++) for (let zi = 0; zi < zBlocks.length; zi++) {
  if (xi === MKT_XI && zi === MKT_ZI) continue;
  if (xi === BALL_XI && zi === BALL_ZI) continue;
  const keepChance = (zi >= 1 && xi >= 1 && xi <= 2) ? 0.28 : 0.12; // keeps cluster centre/front
  fillBlock(xBlocks[xi][0], xBlocks[xi][1], zBlocks[zi][0], zBlocks[zi][1], keepChance);
}

// the market square: canvas-roofed stalls
{
  const [mx0, mx1] = xBlocks[MKT_XI], [mz0, mz1] = zBlocks[MKT_ZI];
  for (let i = 0; i < 8; i++) {
    const sx = rand(mx0 + 1.5, mx1 - 1.5), sz = rand(mz0 + 1.5, mz1 - 1.5), sh = rand(1.8, 2.3);
    const post = new THREE.Mesh(new THREE.BoxGeometry(2.4, sh, 1.8), trimMat);
    post.position.set(sx, sh / 2, sz); scene.add(post);
    const awn = new THREE.Mesh(gableRoof(3.1, 2.5, 0.7), roofMat);
    awn.position.set(sx, sh, sz); scene.add(awn);
    addMetal(sx, sh - 0.2, sz, 0.7);
  }
  // a soot-blackened fountain at the heart of the market, its water gone dark with ash
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
  placeLamp((mx0 + mx1) / 2, (mz0 + mz1) / 2);
}

// a noble ball glimpsed through a keep's grand windows, off the avenue
const ballDancers: { m: THREE.Group; z0: number; ph: number }[] = [];
{
  const bx = -13, bz = 8;
  placeBuilding(bx, bz, 13, 15, 26, true);          // the grand keep
  const faceX = bx + 13 / 2 + 0.06;                  // its avenue-facing wall
  const win = new THREE.Mesh(new THREE.PlaneGeometry(8, 9), new THREE.MeshBasicMaterial({ color: 0xd1a052 }));
  win.position.set(faceX, 7.5, bz); win.rotation.y = Math.PI / 2; win.userData.noShadow = true; scene.add(win);
  const lead = new THREE.MeshBasicMaterial({ color: 0x0a0806 });
  for (let k = -1; k <= 1; k++) {
    const v = new THREE.Mesh(new THREE.PlaneGeometry(0.14, 9), lead);
    v.position.set(faceX + 0.02, 7.5, bz + k * 2.5); v.rotation.y = Math.PI / 2; v.userData.noShadow = true; scene.add(v);
    const h = new THREE.Mesh(new THREE.PlaneGeometry(8, 0.14), lead);
    h.position.set(faceX + 0.02, 7.5 + k * 2.8, bz); h.rotation.y = Math.PI / 2; h.userData.noShadow = true; scene.add(h);
  }
  const dmat = new THREE.MeshStandardMaterial({ color: 0x0b0907, roughness: 1 });
  for (let i = 0; i < 6; i++) {
    const d = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.7, 3, 6), dmat); body.position.y = 0.55; body.userData.noShadow = true; d.add(body);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 8, 8), dmat); head.position.y = 1.05; head.userData.noShadow = true; d.add(head);
    const z0 = bz - 3 + i * 1.2;
    d.position.set(faceX + 0.4, 4.3, z0); scene.add(d);
    ballDancers.push({ m: d, z0, ph: rand(0, 6.28) });
  }
  addMetal(faceX, 2, bz, 1.0);                        // a door fitting below the hall
}

// the city wall rings the district; a gate on the avenue opens toward Kredik Shaw
{
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x0c0a08, roughness: 1, metalness: 0 });
  const WH = 15, WT = 3.5;
  const seg = (cx: number, cz: number, lx: number, lz: number, hh = WH) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(lx, hh, lz), wallMat);
    m.position.set(cx, hh / 2, cz); scene.add(m);
    ROOFS.push({ minX: cx - lx / 2, maxX: cx + lx / 2, minZ: cz - lz / 2, maxZ: cz + lz / 2, top: hh });
  };
  seg(0, ZB + 2, 2 * XW + 8, WT);                  // back wall (+Z)
  seg(-XW - 2, (ZB + ZF) / 2, WT, ZB - ZF + 8);    // left wall
  seg(XW + 2, (ZB + ZF) / 2, WT, ZB - ZF + 8);     // right wall
  seg(-25.5, ZF - 2, 37, WT);                      // front wall, left of gate
  seg(25.5, ZF - 2, 37, WT);                       // front wall, right of gate
  for (const gx of [-7, 7] as const) {             // gate towers flanking the avenue
    seg(gx, ZF - 2, 4, 5, WH + 7);
    addMetal(gx + (gx < 0 ? 1.6 : -1.6), 6, ZF - 1, 1.5); // gate ironwork
  }
}

// lamp posts line the avenue & cross-streets; only every other one is lit (perf)
let _li = 0;
for (let z = 40; z > ZF + 4; z -= 11) placeLamp(z % 22 < 11 ? -4.2 : 4.2, z, (_li++ & 1) === 0);
for (const cz of [24.5, -7.5, -40] as const) for (const lx of [-27, 27] as const) placeLamp(lx, cz, (_li++ & 1) === 0);

// =================== coins on the cobbles ===================
// Loose clips and bits of metal in the gutters — the Mistborn's launch pads.
{
  const glint = softSprite('rgba(196,176,120,0.95)');
  const inBuilding = (x: number, z: number) =>
    ROOFS.some(r => x > r.minX - 0.4 && x < r.maxX + 0.4 && z > r.minZ - 0.4 && z < r.maxZ + 0.4);
  let placed = 0, tries = 0;
  while (placed < 46 && tries < 800) {
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

// =================== Kredik Shaw + the red sun on the horizon ===================
{
  const grp = new THREE.Group();
  const black = new THREE.MeshStandardMaterial({ color: 0x040308, roughness: 1, metalness: 0 });

  // a broad palace base mass beneath the spires
  const base = new THREE.Mesh(new THREE.BoxGeometry(150, 44, 70), black);
  base.position.set(0, 16, -165); grp.add(base);
  const base2 = new THREE.Mesh(new THREE.BoxGeometry(86, 66, 48), black);
  base2.position.set(rand(-14, 14), 28, -172); grp.add(base2);

  // the Hill of a Thousand Spires — black spears, denser & taller toward the centre
  for (let i = 0; i < 72; i++) {
    const x = (Math.random() - 0.5) * 150;
    const fall = 1 - Math.min(1, Math.abs(x) / 80) * 0.55;
    const hh = rand(46, 178) * fall;
    const thin = Math.random() < 0.62;
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

// =================== drifting mist banks ===================
// Low coiling mist that thickens the street and drinks the lamplight.
const mistTex = mistPuff();
const mists: THREE.Sprite[] = [];
for (let i = 0; i < 70; i++) {
  const op0 = rand(0.1, 0.26);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({
    map: mistTex, transparent: true, opacity: op0, depthWrite: false,
    color: 0xb7b1a4, blending: THREE.NormalBlending,
  }));
  const sc = rand(10, 24);
  s.scale.set(sc, sc * rand(0.45, 0.62), 1);
  s.position.set(rand(-XW + 4, XW - 4), rand(0.5, 4.4), rand(ZF + 4, ZB - 4));
  s.material.rotation = rand(0, Math.PI * 2);
  s.userData = { dx: rand(-0.28, 0.28), dz: rand(-0.22, 0.22), x0: s.position.x, rot: rand(-0.05, 0.05), bob: rand(0, 6), op0 };
  scene.add(s);
  mists.push(s);
}

// =================== points of interest (original lore) ===================
type POI = { pos: THREE.Vector3; title: string; body: string };
const POIS: POI[] = [
  {
    pos: new THREE.Vector3(4.8, 1.6, 6),
    title: 'A Noble Keep',
    body: 'A keep of one of the Great Houses. Behind walls of soot-darkened stone, the nobility dance beneath windows of colored glass — reds and golds spilling onto the cobbles like jewels no skaa will ever hold. Up there, ash is a rumor swept from the balconies by servants. Down here in the street, it is simply the weather.',
  },
  {
    pos: new THREE.Vector3(-4.6, 1.6, 30),
    title: 'Skaa Tenements',
    body: 'The skaa quarters. Hundreds sleep stacked in these crumbling rows, roused before the red dawn to feed the forges and the canals. They keep their eyes low, their voices lower, and their hopes quieter still. In the Final Empire, to survive is to go unnoticed by it.',
  },
  {
    pos: new THREE.Vector3(5.6, 1.6, 10),
    title: 'The Market',
    body: 'By day this square clatters with barrows of ash-grimed turnips and cheap tin, skaa hawking their wares beneath the watchful eyes of the Ministry. By night the stalls stand abandoned, canvas awnings sagging with soot, and only the boldest cutpurse lingers once the mist begins to climb the cobbles.',
  },
  {
    pos: new THREE.Vector3(-4.6, 1.6, -22),
    title: 'The Mists',
    body: 'Nightfall, and the mists rise. They coil between the houses and drink the lamplight, and behind every barred door the skaa whisper the old fear — that things move out here when the world goes white. Yet a rare few walk willingly into the mist, and find that it does not harm them at all. It waits for them.',
  },
  {
    pos: new THREE.Vector3(0, 1.6, -57),
    title: 'The City Gate',
    body: 'The gate stands open to the avenue, and beyond it the black palace claws at the red sky: Kredik Shaw, the Hill of a Thousand Spires, vast beyond reason. A thousand years the Lord Ruler has watched the city from within it. They say he is immortal. They say he is God. Tonight, no one in Luthadel dares say otherwise.',
  },
  {
    pos: new THREE.Vector3(-5.6, 1.6, 8),
    title: 'A Noble Ball',
    body: 'Keep Tellund blazes tonight. Through its towering windows the high nobility turn in their slow, glittering dances — silk and jewels, masks and wineglasses, a whole brilliant world sealed behind colored glass. Out in the street a skaa pauses in the falling ash to watch the silhouettes spin, then hurries on before a house guard marks the loitering.',
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

// =================== NPCs: hooded skaa hurrying through the mist ===================
// At dusk the skaa scurry home, heads down, before the mists fully rise. Shadowy,
// stooped, cloaked against the ash — never meeting your eye.
const clothMat = new THREE.MeshStandardMaterial({ color: 0x15110e, roughness: 1, metalness: 0 });
const guardMat = new THREE.MeshStandardMaterial({ color: 0x0d0f14, roughness: 1, metalness: 0 });
const skinMat = new THREE.MeshStandardMaterial({ color: 0x2c211a, roughness: 1, metalness: 0 });
const staffMat = new THREE.MeshStandardMaterial({ color: 0x191310, roughness: 1, metalness: 0 });
// atium future-shadows: pale, translucent echoes of where a figure is about to be
const GHOSTS = 4;
const ghostGeo = new THREE.CapsuleGeometry(0.22, 1.0, 3, 6);

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

type Walker = { f: Figure; axis: 'x' | 'z'; dir: number; speed: number; phase: number; ghosts: THREE.Mesh[] };
const walkers: Walker[] = [];
function spawnWalker(x: number, z: number, axis: 'x' | 'z', guard = false) {
  const f = makeFigure(guard);
  const dir = Math.random() < 0.5 ? 1 : -1;
  f.group.position.set(x, 0, z);
  f.group.rotation.y = axis === 'z' ? (dir > 0 ? Math.PI : 0) : (dir > 0 ? -Math.PI / 2 : Math.PI / 2);
  if (!guard) f.group.rotation.x = 0.06;               // skaa stoop forward
  f.group.scale.setScalar(guard ? 1.12 : rand(0.9, 1.06));
  scene.add(f.group);
  const ghosts: THREE.Mesh[] = [];
  for (let i = 0; i < GHOSTS; i++) {
    const gh = new THREE.Mesh(ghostGeo, new THREE.MeshBasicMaterial({
      color: 0xbfe6ff, transparent: true, opacity: 0.22 * (1 - i / GHOSTS),
      depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    gh.visible = false; gh.userData.noShadow = true; scene.add(gh); ghosts.push(gh);
  }
  walkers.push({ f, axis, dir, speed: guard ? rand(0.8, 1.0) : rand(0.7, 1.3), phase: rand(0, 6), ghosts });
}
for (const ax of [-4, 4, -27.5, 27.5] as const) spawnWalker(ax, rand(-50, 34), 'z'); // avenue + side streets
for (const cz of [24.5, -7.5, -40] as const) spawnWalker(rand(-30, 30), cz, 'x');     // cross-streets
spawnWalker(rand(-4, 4), rand(-40, 20), 'z', true);                                   // a Garrison patrol

// huddled beggars in the gutters & under the market awnings
for (const [bx, bz] of [[-5, 16], [5.2, -2], [-5, -30], [14, 6], [-28, -8]] as const) {
  const b = new THREE.Group();
  const lump = new THREE.Mesh(new THREE.SphereGeometry(0.34, 8, 6), clothMat);
  lump.position.y = 0.28; lump.scale.set(1.1, 0.66, 1); b.add(lump);
  const hd = new THREE.Mesh(new THREE.SphereGeometry(0.13, 8, 7), clothMat);
  hd.position.set(0, 0.5, 0.16); b.add(hd);
  b.position.set(bx, 0, bz); b.rotation.y = rand(0, 6); scene.add(b);
}

// =================== controls ===================
const controls = new PointerLockControls(camera, document.body);
const player = controls.object;

const keys: Record<string, boolean> = {};
const velocity = new THREE.Vector3();
const direction = new THREE.Vector3();
let loreOpen = false;

// vertical physics for steel-jumping: gravity is light, so leaps hang in the mist
const EYE = 1.7;          // eye height above whatever surface is underfoot
const GRAVITY = 18;       // m/s² — floaty, mistcloak feel
const LEAP_RANGE = 20;    // how far a steel-push can reach for an anchor
let vy = 0;               // vertical velocity
let grounded = true;

// further allomantic powers
let pulling = false;                       // iron-pull (right-mouse): yank toward an anchor
let pushing = false;                        // steel-push (left-mouse): shove off the gazed anchor
const pullVel = new THREE.Vector3();       // world-space momentum from pushing/pulling
let pullTarget: THREE.Vector3 | null = null;
let tin = false;                           // burning tin (T): heightened senses, thinner mist
let tinAmt = 0;                            // eases toward tin ? 1 : 0
let atium = false;                         // burning atium (G): shadows of the near future
const FOG0 = (scene.fog as THREE.FogExp2).density;
const EXPOSURE0 = renderer.toneMappingExposure;

// =================== allomancy: burning steel/iron ===================
// Hold to "burn metal": translucent blue lines lance from the chest to every
// metal source in range, brighter the nearer it is — the Mistborn's metal sight.
let burning = false;
let sightFlare = 0;       // brief auto-burn that flashes the lines on each leap
const SIGHT_RANGE = 34;
const sightPos = new Float32Array(METALS.length * 2 * 3);
const sightCol = new Float32Array(METALS.length * 2 * 3);
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

const _chest = new THREE.Vector3();
function updateSight(t: number) {
  document.body.classList.toggle('burning', burning || pulling || pushing);
  if (!burning && !pulling && !pushing && sightFlare <= 0) { sight.visible = false; return; }
  sight.visible = true;
  _chest.copy(player.position).y -= 0.35; // lines spring from the sternum
  const pulse = 0.82 + 0.18 * Math.sin(t * 7);
  for (let i = 0; i < METALS.length; i++) {
    const m = METALS[i];
    const o = i * 6;
    const d = _chest.distanceTo(m.pos);
    const isTarget = m.pos === pullTarget;
    if (d < SIGHT_RANGE || isTarget) {
      const a = Math.max(0, 1 - d / SIGHT_RANGE);
      const b = isTarget ? pulse : Math.min(1, a * a * 1.7 * m.r) * pulse;
      sightPos[o] = _chest.x; sightPos[o + 1] = _chest.y; sightPos[o + 2] = _chest.z;
      sightPos[o + 3] = m.pos.x; sightPos[o + 4] = m.pos.y; sightPos[o + 5] = m.pos.z;
      if (isTarget) { // the anchor you're pulling on flares bright blue-white
        sightCol[o] = 0.5 * b; sightCol[o + 1] = 0.8 * b; sightCol[o + 2] = 1.0 * b;
        sightCol[o + 3] = 0.85 * b; sightCol[o + 4] = 0.95 * b; sightCol[o + 5] = 1.0 * b;
      } else {
        sightCol[o] = 0.16 * b; sightCol[o + 1] = 0.40 * b; sightCol[o + 2] = 0.95 * b; // faint at the chest
        sightCol[o + 3] = 0.42 * b; sightCol[o + 4] = 0.74 * b; sightCol[o + 5] = 1.0 * b; // bright at the metal
      }
    } else {
      // collapse to a zero-length, unlit segment so it draws nothing
      sightPos[o] = sightPos[o + 3] = m.pos.x;
      sightPos[o + 1] = sightPos[o + 4] = m.pos.y;
      sightPos[o + 2] = sightPos[o + 5] = m.pos.z;
      for (let k = 0; k < 6; k++) sightCol[o + k] = 0;
    }
  }
  sightGeo.attributes.position.needsUpdate = true;
  sightGeo.attributes.color.needsUpdate = true;
}

// height of whatever you'd stand on at (x,z): a rooftop if you're over one, else the street (0)
function surfaceAt(x: number, z: number): number {
  let s = 0;
  for (const r of ROOFS) {
    if (x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ && r.top > s) s = r.top;
  }
  return s;
}

// shove the player out of any building footprint they're inside while below its roof
function resolveWalls() {
  const p = player.position;
  const M = 0.4; // player half-width
  for (const r of ROOFS) {
    if (p.y >= r.top + EYE - 0.05) continue;                 // feet at/above this roof — no wall
    if (p.x <= r.minX - M || p.x >= r.maxX + M) continue;
    if (p.z <= r.minZ - M || p.z >= r.maxZ + M) continue;
    // inside the expanded footprint: eject along the axis of least penetration
    const dl = p.x - (r.minX - M), dr = (r.maxX + M) - p.x;
    const db = p.z - (r.minZ - M), df = (r.maxZ + M) - p.z;
    const mx = Math.min(dl, dr), mz = Math.min(db, df);
    if (mx < mz) p.x = dl < dr ? r.minX - M : r.maxX + M;
    else p.z = db < df ? r.minZ - M : r.maxZ + M;
  }
}

// steel-push: launch off the strongest metal anchor below you (or a dropped coin)
const _coin = new THREE.Vector3();
function steelPush() {
  if (loreOpen || !controls.isLocked) return;
  const p = player.position;
  let best: THREE.Vector3 | null = null, bestScore = -1, bestUp = 0;
  for (let i = 0; i < METALS.length; i++) {
    const m = METALS[i], mp = m.pos;
    const dx = p.x - mp.x, dy = p.y - mp.y, dz = p.z - mp.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist > LEAP_RANGE || dist < 0.6) continue;
    const up = dy / dist;            // >0 means the metal is below you
    if (up < 0.25) continue;         // can only launch upward off metal beneath you
    const score = (up * m.r) / Math.max(2.5, dist);
    if (score > bestScore) { bestScore = score; best = mp; bestUp = up; }
  }
  // nothing underfoot but you're near the ground? flip a coin down and push it (a coinshot)
  if (!best && p.y < 3) { best = _coin.set(p.x, 0.02, p.z); bestUp = 1; }
  if (!best) return;
  const power = (keys['ShiftLeft'] || keys['ShiftRight']) ? 1.32 : 1; // pewter leaps higher
  vy = Math.max(vy, (15 + bestUp * 10) * power);  // strong, mist-hanging launch
  velocity.z -= 9 * power;                         // surge forward where you're looking
  sightFlare = 0.7;                                // flash the steel-lines on launch
  grounded = false;
}

// the metal nearest your gaze, within reach — the anchor a push/pull acts on
const _fwd = new THREE.Vector3(), _to = new THREE.Vector3();
function aimMetal(): THREE.Vector3 | null {
  camera.getWorldDirection(_fwd);
  const p = player.position;
  let best: THREE.Vector3 | null = null, bestScore = -Infinity;
  for (let i = 0; i < METALS.length; i++) {
    const m = METALS[i];
    _to.copy(m.pos).sub(p);
    const dist = _to.length();
    if (dist < 1.4 || dist > 36) continue;
    _to.divideScalar(dist);                  // normalize
    const align = _to.dot(_fwd);             // 1 = straight where you're looking
    if (align < 0.55) continue;
    const score = align * 2.2 + m.r - dist * 0.03;
    if (score > bestScore) { bestScore = score; best = m.pos; }
  }
  return best;
}
// iron-pull (toward) / steel-shove (away): yank or kick yourself off the gazed anchor
function alloMove(dt: number, away: boolean) {
  if (loreOpen || !controls.isLocked) { pullTarget = null; return; }
  const best = aimMetal(); pullTarget = best;
  if (!best) return;
  const p = player.position;
  if (away) _to.copy(p).sub(best); else _to.copy(best).sub(p);
  const dist = _to.length(); if (dist < 0.001) return; _to.divideScalar(dist);
  const accel = 30 * dt;
  pullVel.x += _to.x * accel;
  pullVel.z += _to.z * accel;
  vy += _to.y * accel;                       // through gravity's vy
  grounded = false;
  sightFlare = Math.max(sightFlare, 0.15);   // light the lines while burning iron/steel
}

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
  if (e.code === 'Space') { e.preventDefault(); if (!e.repeat) steelPush(); }
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
      const white = Math.random() * 2 - 1;
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

  // movement
  if (controls.isLocked && !loreOpen) {
    const pewter = keys['ShiftLeft'] || keys['ShiftRight'];
    const speed = pewter ? 16 : 8;            // pewter lets you sprint
    const damp = grounded ? 9 : 1.3;          // glide through the air on a leap
    velocity.x -= velocity.x * damp * dt;
    velocity.z -= velocity.z * damp * dt;
    // ternaries, not Number(): an unpressed key is `undefined`, and Number(undefined)
    // is NaN, which poisons `direction` and silently kills movement.
    direction.z = (keys['KeyW'] || keys['ArrowUp'] ? 1 : 0) - (keys['KeyS'] || keys['ArrowDown'] ? 1 : 0);
    direction.x = (keys['KeyD'] || keys['ArrowRight'] ? 1 : 0) - (keys['KeyA'] || keys['ArrowLeft'] ? 1 : 0);
    direction.normalize();
    const accel = (grounded ? 1 : 0.45) * speed * dt * 8;   // a little air control
    if (direction.z) velocity.z -= direction.z * accel;
    if (direction.x) velocity.x -= direction.x * accel;
    controls.moveRight(-velocity.x * dt);
    controls.moveForward(-velocity.z * dt);

    // steel-push / iron-pull: shove off or yank toward the gazed anchor, then coast
    pullTarget = null;
    if (pulling) alloMove(dt, false); else if (pushing) alloMove(dt, true);
    player.position.x += pullVel.x * dt;
    player.position.z += pullVel.z * dt;
    pullVel.multiplyScalar(Math.max(0, 1 - ((pulling || pushing) ? 2.6 : 4.5) * dt));

    // gravity + vertical integration
    vy -= GRAVITY * dt;
    player.position.y += vy * dt;

    // land on whatever's underfoot — a rooftop, or the street
    const floor = surfaceAt(player.position.x, player.position.z) + EYE;
    if (player.position.y <= floor) { player.position.y = floor; vy = 0; grounded = true; }
    else grounded = false;

    resolveWalls();   // don't pass through building walls mid-leap

    // contain to the walled district; buildings & walls block via resolveWalls()
    player.position.x = clamp(player.position.x, -(XW + 1), XW + 1);
    player.position.z = clamp(player.position.z, ZF - 1, ZB + 1);
  }

  // tin: ease the senses open — thinner fog & mist, a brighter, colder clarity
  tinAmt += ((tin ? 1 : 0) - tinAmt) * Math.min(1, dt * 4);
  (scene.fog as THREE.FogExp2).density = FOG0 * (1 - 0.55 * tinAmt);
  renderer.toneMappingExposure = EXPOSURE0 * (1 + 0.32 * tinAmt);
  grade.uniforms.bright.value = 1 + 0.16 * tinAmt;
  grade.uniforms.tin.value = tinAmt;
  document.body.classList.toggle('pewter', !!(keys['ShiftLeft'] || keys['ShiftRight']) && controls.isLocked && grounded);

  // ash fall + recycle around the camera
  const cp = player.position;
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

  // drifting, slowly coiling mist
  for (const m of mists) {
    m.position.x += m.userData.dx * dt;
    m.position.z += m.userData.dz * dt;
    m.position.y += Math.sin(t * 0.3 + m.userData.bob) * 0.06 * dt;
    m.material.rotation += m.userData.rot * dt;
    m.material.opacity = m.userData.op0 * (1 - 0.55 * tinAmt);   // tin thins the mist
    if (Math.abs(m.position.x - m.userData.x0) > 17) m.userData.dx *= -1;
  }

  // skaa & guards walking the streets, legs and arms swinging
  for (const wk of walkers) {
    const g = wk.f.group, sp = wk.speed;
    if (wk.axis === 'z') g.position.z += wk.dir * sp * dt; else g.position.x += wk.dir * sp * dt;
    const ph = t * sp * 3.2 + wk.phase, sw = Math.sin(ph) * 0.5;
    wk.f.legs[0].rotation.x = sw; wk.f.legs[1].rotation.x = -sw;
    wk.f.arms[0].rotation.x = -sw * 0.7; wk.f.arms[1].rotation.x = sw * 0.7;
    g.position.y = Math.abs(Math.sin(ph)) * 0.04;        // a little bob
    if (wk.axis === 'z') {
      if (g.position.z > ZB - 4) g.position.z = ZF + 4; else if (g.position.z < ZF + 4) g.position.z = ZB - 4;
    } else {
      if (g.position.x > XW - 4) g.position.x = -(XW - 4); else if (g.position.x < -(XW - 4)) g.position.x = XW - 4;
    }
    // atium: translucent echoes of where this figure is about to be
    for (let i = 0; i < GHOSTS; i++) {
      const gh = wk.ghosts[i];
      if (!atium) { if (gh.visible) gh.visible = false; continue; }
      const ahead = (i + 1) * 0.5;
      gh.visible = true;
      gh.position.set(g.position.x, 0.92, g.position.z);
      if (wk.axis === 'z') gh.position.z += wk.dir * sp * ahead; else gh.position.x += wk.dir * sp * ahead;
    }
  }

  // the noble ball — dancers swaying behind the grand keep's bright windows
  for (const d of ballDancers) {
    d.m.position.z = d.z0 + Math.sin(t * 1.1 + d.ph) * 0.6;
    d.m.position.y = 4.3 + Math.abs(Math.sin(t * 2.2 + d.ph)) * 0.09;
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

// every building, wall, roof and figure casts & receives the moon's shadow
scene.traverse((o) => {
  if ((o as THREE.Mesh).isMesh && !o.userData.sky && !o.userData.noShadow) { o.castShadow = true; o.receiveShadow = true; }
});

animate();

// dev-only handle so the scene can be driven/inspected from the preview harness
if (import.meta.env.DEV) {
  (window as any).__lutha = {
    THREE, scene, camera, controls, player, renderer, composer, bloom, grade,
    METALS, ROOFS,
    burn: (v: boolean) => { burning = v; },
    pull: (v: boolean) => { pulling = v; },
    shove: (v: boolean) => { pushing = v; },
    tinOn: (v: boolean) => { tin = v; },
    atiumOn: (v: boolean) => { atium = v; },
    push: () => steelPush(),
    state: () => ({ y: +player.position.y.toFixed(2), vy: +vy.toFixed(2), grounded, tinAmt: +tinAmt.toFixed(2), pulling, target: pullTarget ? pullTarget.toArray().map(n => +n.toFixed(1)) : null }),
    surfaceAt: (x: number, z: number) => surfaceAt(x, z),
    set: (x: number, y: number, z: number) => { player.position.set(x, y, z); vy = 0; pullVel.set(0, 0, 0); },
    walkers, keys,
    diag: () => ({ isLocked: controls.isLocked, loreOpen, keysDown: Object.keys(keys).filter(k => keys[k]) }),
    key: (code: string, down: boolean) => { keys[code] = down; },
  };
}
