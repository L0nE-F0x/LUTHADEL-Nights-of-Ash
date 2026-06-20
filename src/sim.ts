// =====================================================================================
// Shared deterministic simulation (Phase 0b).
//
// The player physics — walking, steel-push / iron-pull, the steel-leap, gravity, rooftop
// landing, wall collision, containment — as a PURE function of (world, state, input).
// No three.js camera/controls, no renderer, no DOM: given the same inputs it produces the
// same result, so the client (prediction) and the future authoritative server can run the
// *exact same* `stepPlayer`. See PVP_ARCHITECTURE.md.
//
// (It still uses THREE.Vector3 as a plain math type for metal positions — three runs fine
// in Node — but nothing here touches the camera, controls, scene or DOM.)
// =====================================================================================
import * as THREE from 'three';

export type Metal = { pos: THREE.Vector3; r: number };
export type Roof = { minX: number; maxX: number; minZ: number; maxZ: number; top: number; _t?: number };

// the collision/anchor world the sim reads (built once from a seed; identical on every peer)
export type SimWorld = {
  METALS: Metal[];
  metalGrid: Map<number, Metal[]>;
  roofGrid: Map<number, Roof[]>;
  bounds: { XW: number; ZB: number; ZF: number };
};

// the full physics state of one player — plain numbers, trivially serialised over the wire
export type PlayerState = {
  x: number; y: number; z: number;     // position (eye)
  vx: number; vz: number;              // camera-space walk velocity (old `velocity`)
  vy: number;                          // vertical velocity
  px: number; pz: number;              // world-space allomantic momentum (old `pullVel`)
  grounded: boolean;
  target: THREE.Vector3 | null;        // (out) the push/pull anchor this step, for the renderer
  leaped: boolean;                     // (out) a steel-leap launched this step (flash the sight)
};

// everything the player did this frame — this is what the client sends the server
export type PlayerInput = {
  fwd: number;        // (W?1:0) - (S?1:0)
  strafe: number;     // (D?1:0) - (A?1:0)
  yaw: number; pitch: number;
  pewter: boolean; pushing: boolean; pulling: boolean; jump: boolean;
  dt: number;
};

export const EYE = 1.7;          // eye height above whatever surface is underfoot
export const GRAVITY = 18;       // m/s² — floaty, mistcloak feel
export const LEAP_RANGE = 20;    // how far a steel-leap reaches for an anchor below
export const GRID = 24;          // spatial-hash cell size (m)
export const gkey = (cx: number, cz: number) => cx * 100000 + cz;

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export function newPlayerState(x: number, y: number, z: number): PlayerState {
  return { x, y, z, vx: 0, vz: 0, vy: 0, px: 0, pz: 0, grounded: true, target: null, leaped: false };
}

// height of whatever you'd stand on at (x,z): a rooftop if you're over one, else the street (0)
export function surfaceAt(w: SimWorld, x: number, z: number): number {
  let s = 0;
  const a = w.roofGrid.get(gkey(Math.floor(x / GRID), Math.floor(z / GRID)));
  if (a) for (let i = 0; i < a.length; i++) { const r = a[i]; if (x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ && r.top > s) s = r.top; }
  return s;
}

// shove the player out of any building footprint they're inside while below its roofline
let _wallTick = 0;
export function resolveWalls(w: SimWorld, s: PlayerState) {
  const M = 0.4; // player half-width
  _wallTick++;   // mark, so a footprint spanning several cells is handled once
  const c0x = Math.floor((s.x - M) / GRID), c1x = Math.floor((s.x + M) / GRID);
  const c0z = Math.floor((s.z - M) / GRID), c1z = Math.floor((s.z + M) / GRID);
  for (let cx = c0x; cx <= c1x; cx++) for (let cz = c0z; cz <= c1z; cz++) {
    const a = w.roofGrid.get(gkey(cx, cz));
    if (!a) continue;
    for (let i = 0; i < a.length; i++) {
      const r = a[i];
      if (r._t === _wallTick) continue; r._t = _wallTick;
      if (s.y >= r.top + EYE - 0.05) continue;                 // feet at/above this roof — no wall
      if (s.x <= r.minX - M || s.x >= r.maxX + M) continue;
      if (s.z <= r.minZ - M || s.z >= r.maxZ + M) continue;
      const dl = s.x - (r.minX - M), dr = (r.maxX + M) - s.x;
      const db = s.z - (r.minZ - M), df = (r.maxZ + M) - s.z;
      const mx = Math.min(dl, dr), mz = Math.min(db, df);
      if (mx < mz) s.x = dl < dr ? r.minX - M : r.maxX + M;
      else s.z = db < df ? r.minZ - M : r.maxZ + M;
    }
  }
}

const _near: Metal[] = [];
export function metalsNear(w: SimWorld, x: number, z: number, range: number): Metal[] {
  _near.length = 0;
  const c0x = Math.floor((x - range) / GRID), c1x = Math.floor((x + range) / GRID);
  const c0z = Math.floor((z - range) / GRID), c1z = Math.floor((z + range) / GRID);
  for (let cx = c0x; cx <= c1x; cx++) for (let cz = c0z; cz <= c1z; cz++) {
    const a = w.metalGrid.get(gkey(cx, cz));
    if (a) for (let i = 0; i < a.length; i++) _near.push(a[i]);
  }
  return _near;
}

// the metal nearest the gaze (forward derived from yaw/pitch, matching getWorldDirection)
export function aimMetal(w: SimWorld, s: PlayerState, yaw: number, pitch: number): THREE.Vector3 | null {
  const cp = Math.cos(pitch);
  const fx = -cp * Math.sin(yaw), fy = Math.sin(pitch), fz = -cp * Math.cos(yaw);
  let best: THREE.Vector3 | null = null, bestScore = -Infinity;
  const near = metalsNear(w, s.x, s.z, 36);
  for (let i = 0; i < near.length; i++) {
    const m = near[i];
    let tx = m.pos.x - s.x, ty = m.pos.y - s.y, tz = m.pos.z - s.z;
    const dist = Math.hypot(tx, ty, tz);
    if (dist < 1.4 || dist > 36) continue;
    tx /= dist; ty /= dist; tz /= dist;
    const align = tx * fx + ty * fy + tz * fz;
    if (align < 0.55) continue;
    const score = align * 2.2 + m.r - dist * 0.03;
    if (score > bestScore) { bestScore = score; best = m.pos; }
  }
  return best;
}

// the steel-leap (Space): launch off the strongest metal anchor below you (or a coinshot)
const _coin = new THREE.Vector3();
export function steelLeap(w: SimWorld, s: PlayerState, pewter: boolean): boolean {
  let best: THREE.Vector3 | null = null, bestScore = -1, bestUp = 0;
  const near = metalsNear(w, s.x, s.z, LEAP_RANGE);
  for (let i = 0; i < near.length; i++) {
    const m = near[i], mp = m.pos;
    const dx = s.x - mp.x, dy = s.y - mp.y, dz = s.z - mp.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist > LEAP_RANGE || dist < 0.6) continue;
    const up = dy / dist;            // >0 means the metal is below you
    if (up < 0.25) continue;
    const score = (up * m.r) / Math.max(2.5, dist);
    if (score > bestScore) { bestScore = score; best = mp; bestUp = up; }
  }
  if (!best && s.y < 3) { best = _coin; bestUp = 1; }   // near the ground: flip a coin & push it
  if (!best) return false;
  const power = pewter ? 1.32 : 1;
  s.vy = Math.max(s.vy, (15 + bestUp * 10) * power);
  s.vz -= 9 * power;                                     // surge forward where you're looking
  s.grounded = false;
  return true;
}

// the whole per-frame physics step. Pure: mutates only `s` from (w, s, inp).
export function stepPlayer(w: SimWorld, s: PlayerState, inp: PlayerInput) {
  const dt = inp.dt;
  // a steel-leap takes effect before the walk damping (matches the old event-driven timing)
  s.leaped = inp.jump ? steelLeap(w, s, inp.pewter) : false;

  // walk: camera-space velocity with damping + a little air control
  const speed = inp.pewter ? 16 : 8;
  const damp = s.grounded ? 9 : 1.3;
  s.vx -= s.vx * damp * dt;
  s.vz -= s.vz * damp * dt;
  let dx = inp.strafe, dz = inp.fwd;
  const dl = Math.hypot(dx, dz); if (dl > 0) { dx /= dl; dz /= dl; }
  const accel = (s.grounded ? 1 : 0.45) * speed * dt * 8;
  if (dz) s.vz -= dz * accel;
  if (dx) s.vx -= dx * accel;
  // apply that camera-space velocity to world position (replicates controls.moveRight/Forward)
  const sy = Math.sin(inp.yaw), cy = Math.cos(inp.yaw);
  const mR = -s.vx * dt, mF = -s.vz * dt;
  s.x += mR * cy - mF * sy;
  s.z += -mR * sy - mF * cy;

  // steel-push (away) / iron-pull (toward) off the gazed anchor
  let target: THREE.Vector3 | null = null;
  if (inp.pulling || inp.pushing) {
    const best = aimMetal(w, s, inp.yaw, inp.pitch); target = best;
    if (best) {
      let tx: number, ty: number, tz: number;
      if (inp.pushing) { tx = s.x - best.x; ty = s.y - best.y; tz = s.z - best.z; }
      else { tx = best.x - s.x; ty = best.y - s.y; tz = best.z - s.z; }
      const dist = Math.hypot(tx, ty, tz);
      if (dist >= 0.001) {
        const a = 30 * dt / dist;
        s.px += tx * a; s.pz += tz * a; s.vy += ty * a;
        s.grounded = false;
      }
    }
  }
  s.target = target;
  s.x += s.px * dt; s.z += s.pz * dt;
  const pd = Math.max(0, 1 - ((inp.pulling || inp.pushing) ? 2.6 : 4.5) * dt);
  s.px *= pd; s.pz *= pd;

  // gravity + vertical integration
  s.vy -= GRAVITY * dt;
  s.y += s.vy * dt;

  // land on whatever's underfoot — a rooftop, or the street
  const floor = surfaceAt(w, s.x, s.z) + EYE;
  if (s.y <= floor) { s.y = floor; s.vy = 0; s.grounded = true; }
  else s.grounded = false;

  resolveWalls(w, s);                                    // don't pass through walls mid-leap
  s.x = clamp(s.x, -(w.bounds.XW + 1), w.bounds.XW + 1); // contain to the walled district
  s.z = clamp(s.z, w.bounds.ZF - 1, w.bounds.ZB + 1);
}
