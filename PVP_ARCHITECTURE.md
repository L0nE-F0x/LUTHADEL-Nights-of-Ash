# Luthadel — Allomancy PvP: architecture sketch

> Status: **design sketch** (no netcode written yet). Goal: two-or-more players, each a
> Mistborn, duel in Luthadel using Allomantic powers — first person, fast, vertical.
> This file is the plan we build against. It will change as we learn.

## 0. Where we are today (the starting point)

- **Pure front-end** static site (Vite + TS + three.js), deployed on Netlify.
- **All simulation is client-side and single-player:** movement, gravity, steel-push /
  iron-pull (`alloMove`), steel-leap (`steelPush`), rooftop/wall collision over `ROOFS`,
  the metal-sight over `METALS`, all driven from the `animate()` loop.
- The world is **procedurally generated with `Math.random()`** — so every page load builds a
  *different* Luthadel. (This is the single biggest thing that must change for multiplayer.)
- Useful pieces we can reuse: `makeFigure()` (cloaked body — becomes the **player avatar**),
  the **spatial hash grid** (`metalGrid`/`roofGrid` — the server needs the same queries),
  the **atium ghost system** (becomes the atium "see-the-future" dodge), `METALS`/`ROOFS`.

## 1. The core problem

Allomancy movement is **fast and vertical** — steel-pushes fling you across rooftops, leaps
hang in the mist. That's exactly the hardest case for netcode: large per-frame position
deltas, physics-driven motion, and players shoving *each other* around. We can't just send
positions and tween them — it'll feel like rubber. We need real prediction.

## 2. Topology — recommendation: **authoritative server**

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **Authoritative server** (Node + WebSocket) | one source of truth, no desync, hard to cheat, simple mental model | needs a backend host (not Netlify) | ✅ **start here** |
| **P2P WebRTC** (one player hosts) | no server cost, lowest latency | NAT traversal (STUN/TURN), host advantage/cheating, host-migration is hard | later, as a 1v1 "play with a friend" mode |

Go authoritative. The server owns the truth; clients predict and reconcile.

**Hosting reality:** Netlify serves the **client** only (static). The **server** is a
long-running Node process — host it on **Render / Fly.io / Railway** (free tiers exist) or a
small VPS. The client reads the server URL from an env var (`VITE_SERVER_URL`) and opens a
WebSocket to it. Local dev: run the server on `localhost:8080`, point the client at it.

## 3. Netcode model — prediction + reconciliation + interpolation

The standard competitive-FPS model (a la Quake/Source; see Gabriel Gambetta's "Fast-Paced
Multiplayer"). Three pieces:

1. **Client-side prediction (your own player):** apply your input locally *immediately* by
   running the shared sim — no waiting for the server, so controls feel instant.
2. **Server reconciliation:** the server is authoritative. Each input is tagged with a
   sequence number; the server replies with the authoritative state + "last input I
   processed." The client rewinds to that state and **replays** any inputs the server
   hasn't acknowledged yet. If client and server agreed, you see nothing; if they differed
   (you hit something you predicted you wouldn't), you get a small correction.
3. **Entity interpolation (other players):** render remote players ~100 ms in the past,
   interpolating between the last two snapshots, so their motion is smooth despite arriving
   as discrete updates.
4. **Lag compensation (for hits):** when resolving a coinshot, the server **rewinds** every
   other player to where the shooter saw them (using their timestamp), so well-aimed shots
   land even at 80 ms ping.

Tick rates to start: **server sim 60 Hz**, **snapshot broadcast ~20–30 Hz**, client renders
at display rate. Inputs sent every client frame (or batched at ~60 Hz).

## 4. Determinism & the shared simulation (the foundation)

Prediction only works if the client and server compute the **same** result from the same
input. So the physics must become a **pure, shared, deterministic step function** that both
run:

```
stepPlayer(state: PlayerState, input: Input, world: World, dt: number): PlayerState
```

- Extract today's loop physics — gravity, `alloMove` push/pull accel, `steelPush` leap,
  `resolveWalls`, `surfaceAt`, containment — into `shared/sim.ts`. The client loop and the
  server tick both call it. Rendering stays in the client; the sim has **no three.js**.
- The **world must match** on both ends. Today `Math.random()` makes that impossible. Fix:
  a **seeded PRNG** (e.g. mulberry32) so one `seed` → one identical Luthadel. The server
  picks the seed per match and sends it on join; both sides generate the same `ROOFS` /
  `METALS` / spatial grid. (Cosmetic-only things — ash, embers, NPC walkers, textures —
  don't need to match and can stay client-only.)
- Determinism caveat: JS floats can differ across machines in theory. In practice, same
  V8/engine math is consistent enough, and **server authority + reconciliation tolerates
  small drift** (it just corrects). We don't need lockstep/fixed-point to start.

`Input` is tiny and serializable: `{ seq, dtKeys (W/A/S/D/Shift/Space), yaw, pitch,
buttons (push/pull/burn), aimDir }`. Never trust client *positions* — only inputs.

## 5. Combat — make it distinctly *Mistborn*

Mistborn don't carry guns; the fight is metal, motion, and mind. Proposed kit:

- **Coinshots (primary ranged):** flick a coin and steel-push it — a fast projectile.
  Server-authoritative projectile sim + lag-compensated hits. Coins are **ammo** (limited).
- **Push / pull players:** if a target carries metal (coins, weapons, vials), you can
  steel-push them (knockback, fling off a rooftop) or iron-pull them toward you. The classic
  Allomantic duel: **pushing a coin someone pushed at you, back at them** — model coin
  "ownership"/repush for that mind-game.
- **Pewter (bruise):** sprint, leap higher, survive hits, melee with a dueling cane/obsidian.
- **Tin:** pierce the mist, sense nearby burners (situational awareness vs concealment).
- **Atium (the trump card):** reuse our **ghost system** — briefly see opponents' near-future
  → near-perfect dodge for a few seconds. Rare **map pickup**, not a default — it turns a
  fight. Two atium burners cancel out (canon).
- **Metal reserves as the economy:** burning steel/pewter/iron/tin/atium **depletes** a
  reserve (mana/ammo hybrid). Refill at **metal-vial pickups** around the city. Running dry
  mid-leap is a real, dramatic risk. HUD shows reserves + health.
- **Mobility = skill:** the map *is* the weapon — push off lamps, bridge rails, window bars
  (all already in `METALS`) to reposition, ambush from the mist, fight across rooftops.

Match modes to start: **free-for-all deathmatch** and **1v1 duel**; rounds later.

## 6. Project structure

```
shared/        # no three.js, no DOM — pure logic, imported by BOTH client and server
  sim.ts       #   stepPlayer(), projectile step, constants (gravity, ranges)
  world.ts     #   seeded gen of ROOFS/METALS + spatial grid (the collision world)
  protocol.ts  #   message types + (de)serialization
  rng.ts       #   seeded PRNG (mulberry32)
server/        # Node + ws — authoritative
  index.ts     #   room(s), 60 Hz tick, input intake, snapshots, hit resolution, lag-comp
src/           # existing client; gains a netcode layer
  net.ts       #   socket, send inputs, reconcile, interpolate remotes
  remote.ts    #   spawn/animate other players (reuse makeFigure), projectiles, HUD
  main.ts      #   render + call shared sim for local prediction
```

Vite + a TS server share types cleanly via the `shared/` package.

## 7. Protocol (start simple, optimize later)

- **Transport:** WebSocket (TCP) to start — reliable, ordered, trivial. Move hot paths to
  **WebRTC DataChannel** (unreliable/unordered, UDP-like) later for lower latency.
- **Format:** JSON first (2–8 players is fine); switch to a packed **binary** (ArrayBuffer)
  if bandwidth bites.
- **Messages:** `join{seed,id}` → `input{seq,...}` (C→S) ; `snapshot{tick, players[], projectiles[], events[]}`, `hit`, `death`, `spawn` (S→C).

## 8. Phased roadmap (each phase is testable on its own)

- **Phase 0 — Determinism refactor (no networking).** Extract physics → `shared/sim.ts`;
  seed the world (`shared/world.ts` + `rng.ts`) so a seed reproduces the city; split
  "sim state" from "render." Verify single-player still plays identically. *This is the
  concrete next coding step and needs no server.*
- **Phase 1 — Movement sync (hard part first).** Minimal Node WS server; 2 browser tabs see
  each other move, with **local prediction + reconciliation** for self and **interpolation**
  for the remote. Prove fast Allomancy motion syncs smoothly. *Milestone: it feels good.*
- **Phase 2 — Combat.** Coinshot projectiles (server-authoritative + lag-comp), health,
  push/pull-the-player, death/respawn.
- **Phase 3 — Mistborn systems.** Metal reserves + HUD, vial pickups, atium dodge, modes
  (deathmatch / duel), killfeed, sound.
- **Phase 4 — Scale & robustness.** Binary protocol, WebRTC option, multiple rooms/lobby,
  reconnection, input validation / anti-cheat hardening.

## 9. Risks & open questions

- **Determinism drift** across machines (mitigated by authority + reconciliation; revisit if
  corrections feel frequent).
- **Coupled physics** when two players push/pull each other — the server must resolve the
  pair authoritatively in one tick.
- **Verticality** stresses prediction/interpolation (big deltas) — budget time tuning it.
- **Cost/ops:** a server that sleeps on a free tier adds cold-start lag; a tiny always-on
  VPS may be worth it.
- **Scope:** this is a months-of-evenings project. Phase 0 + 1 is the real proof; if the
  movement feels good networked, the rest is "just" content and tuning.

## 10. Progress

- ✅ **Phase 0a** — seeded, reproducible world; now locked to ONE fixed seed (`SEED = 1337`)
  so it's a single canonical Luthadel and every client builds the identical map.
- ✅ **Phase 0b** — physics is a pure, engine-free `stepPlayer` in `src/sim.ts`.
- ✅ **Phase 1 (first cut)** — relay multiplayer: `server/index.mjs` (ws relay) + `src/net.ts`
  (prod-safe client) + `makeFigure` avatars in `main.ts`. Verified end-to-end locally **and live**
  (Render relay + Netlify client, `VITE_SERVER_URL=wss://luthadel-nights-of-ash.onrender.com`).
- ✅ **Phase 2A** — networked **coinshots**: left-click flicks a coin (`combat.spawnCoin`/
  `stepProjectile`), the server relays `{t:'fire'}` so everyone sees everyone's coins. (Steel-push
  moved to **hold Q** so left-click is coinshot-only — no more sight-line flicker per shot.)
- ✅ **Phase 2B (first cut — client-side / trust-based hit-reg)** — the shooter tests its own coins
  vs the **interpolated** peer positions (`coinHitsPlayer` vs `netInterpolated()`) → `{t:'hit'}`
  relay → victim applies `combat.damage` (34 dmg, ~3 to down) → `respawn()` at ≤0 HP; combat HUD
  (health bar + damage vignette + hit-confirm + downed banner), shown only while connected.
  ⚠️ Limits: per-frame sphere check (fast coins can tunnel; no lag-comp), and a coin that hits on
  my screen keeps flying on peers' screens (no despawn relay). Both are fixed by server authority.
- ✅ **Phase 2C** — push/pull **players** (Allomantic knockback): hold Q / right-click while
  aiming at a Mistborn (`aimPeer` gaze-cone test vs interpolated peers) to blast them — edge-
  triggered, one impulse per press → `{t:'shove'}` relay → victim applies
  `applyAllomanticImpulse` + lift, shover takes a smaller self-recoil (push = fly apart, pull =
  yank together). Verified by a relay smoke test + a real-sim physics test (≈5.3 m knockback).
  Still trust-based (see 2B limits). Tunables live by the combat state in `main.ts`.
- ⏳ **Authority** — make the server authoritative (it imports `sim.ts` and runs `stepPlayer`);
  client prediction + reconciliation + snapshot interpolation; then combat. Needs the
  collision world on the server — extract the deterministic `ROOFS`/`METALS` gen into a
  shared engine-free `world.ts` (the gen currently lives in `main.ts`, intertwined with mesh
  building; the client keeps the meshes, both sides share the layout/collision data). This is
  the main backend task to do together.

## 11. Deploying the relay server (free)

The client is already prod-safe: with no `VITE_SERVER_URL` it stays single-player, so the
Netlify site is unaffected until a server exists.

**Render (simplest, free; sleeps when idle):** push to GitHub → Render → New + → *Blueprint*
→ this repo (`render.yaml`) → Apply. Copy the live URL.

**Fly.io (free allowance, always-on, lower latency):** `flyctl` → `fly launch` (uses
`fly.toml` + `Dockerfile`) → `fly deploy`. Copy `https://<app>.fly.dev`.

**Wire the client to it:** set `VITE_SERVER_URL` to the server's **wss://** URL (Render:
`wss://<svc>.onrender.com`, Fly: `wss://<app>.fly.dev`) in Netlify → Site settings →
Environment variables, then redeploy the client. See `.env.example`.

The relay is plain JS (`ws` only). When Phase 2 makes the server authoritative it will import
`sim.ts` (TypeScript) — at that point add a TS step (e.g. `tsx`, or precompile) to the
server's start command; the `Dockerfile` already copies `src/` in anticipation.
