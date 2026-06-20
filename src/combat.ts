// =====================================================================================
// Shared combat core (Phase 2/3) — pure, deterministic, engine-free, server-authoritative.
//
// Mistborn fight with metal and motion: a steel-pushed COIN becomes a fast projectile
// (a "coinshot"), and you can shove/yank a player who's carrying metal. These are the rules
// the authoritative server will run (the client only renders the results). Nothing here
// touches three.js, the camera, or the DOM — it's plain math over `SimWorld`/`PlayerState`.
//
// Balance values are first-pass guesses; tune them once it's playable. See PVP_ARCHITECTURE.md.
// =====================================================================================
import type { SimWorld, PlayerState } from './sim';
import { surfaceAt, GRAVITY } from './sim';

export type Projectile = {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  owner: number;       // player id who flicked it (never hits its own owner)
  life: number;        // seconds remaining
  alive: boolean;
};

export const COIN_SPEED = 60;      // m/s — a hard steel-push sends a coin fast & fairly flat
export const COIN_GRAVITY = GRAVITY * 0.5;   // coins arc, but less than a body
export const COIN_DAMAGE = 34;     // ~3 clean hits to down a full-health Mistborn
export const COIN_LIFE = 3;        // seconds before it falls spent
export const PLAYER_RADIUS = 0.55; // torso hit sphere
export const MAX_HEALTH = 100;

// flick a coin from (x,y,z) along a unit direction (dx,dy,dz)
export function spawnCoin(owner: number, x: number, y: number, z: number, dx: number, dy: number, dz: number): Projectile {
  return { x, y, z, vx: dx * COIN_SPEED, vy: dy * COIN_SPEED, vz: dz * COIN_SPEED, owner, life: COIN_LIFE, alive: true };
}

// advance a coin one tick: arc + travel, spend on lifetime or when it strikes ground/roof.
// returns true while still flying, false once spent (then it should be removed).
export function stepProjectile(w: SimWorld, p: Projectile, dt: number): boolean {
  if (!p.alive) return false;
  p.life -= dt;
  if (p.life <= 0) { p.alive = false; return false; }
  p.vy -= COIN_GRAVITY * dt;
  p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
  if (p.y <= surfaceAt(w, p.x, p.z) + 0.05) { p.alive = false; return false; }   // struck the cobbles / a rooftop
  return true;
}

// does coin `p` strike player `s` this tick? (sphere around the torso, a little below the eye)
export function coinHitsPlayer(p: Projectile, s: PlayerState): boolean {
  const dx = p.x - s.x, dy = p.y - (s.y - 0.7), dz = p.z - s.z;
  return dx * dx + dy * dy + dz * dz <= PLAYER_RADIUS * PLAYER_RADIUS;
}

// steel-push (shove away) / iron-pull (yank toward) an enemy who is carrying metal — the
// classic Allomantic duel. `strength` is an impulse into their world-space momentum + vy.
export function applyAllomanticImpulse(s: PlayerState, fromX: number, fromY: number, fromZ: number, strength: number, pull: boolean) {
  let dx = s.x - fromX, dy = s.y - fromY, dz = s.z - fromZ;
  const d = Math.hypot(dx, dy, dz) || 1;
  dx /= d; dy /= d; dz /= d;
  const sgn = pull ? -1 : 1;
  s.px += sgn * dx * strength;
  s.pz += sgn * dz * strength;
  s.vy += sgn * dy * strength;
  s.grounded = false;
}

// apply damage; returns true if this blow downs the player
export function damage(health: number, amount: number): { health: number; downed: boolean } {
  const h = Math.max(0, health - amount);
  return { health: h, downed: h <= 0 };
}
