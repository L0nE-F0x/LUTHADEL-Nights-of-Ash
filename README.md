# Luthadel — Nights of Ash

A 3D, first-person walk through the misted streets of **Luthadel**, capital of the Final Empire: ash falling from a red sun, glowing stained-glass keeps, skaa tenements, and the black spires of Kredik Shaw looming on the horizon. Built with [Vite](https://vitejs.dev), TypeScript and [three.js](https://threejs.org).

> Inspired by a viral demo of "walk inside your favorite novel." This is the *Mistborn* version.

## Run it

```bash
npm install
npm run dev
```

Then open the local URL Vite prints (usually http://localhost:5173). Click **Enter the Mist** to lock the mouse.

| Key | Action |
| --- | --- |
| `W A S D` | walk |
| Mouse | look |
| `Shift` | **burn pewter** — sprint, and leap higher |
| `F` | **burn steel** — see the blue Allomantic lines to nearby metal |
| left-click / right-click | **steel-push / iron-pull** — shove off, or yank toward, the metal you're aiming at (ascend, cross gaps) |
| `Space` | **steel-leap** — push off the metal beneath you and bound onto the rooftops |
| `T` | **burn tin** — heighten the senses: the mist thins and the night sharpens |
| `G` | **burn atium** — see translucent shadows of where things will be a moment from now |
| `E` | read an inscription when one is near |
| `M` | mute/unmute the wind &nbsp;·&nbsp; `\` toggle shadows |
| `Esc` | release the cursor |

## Build

```bash
npm run build      # outputs static files to dist/
npm run preview    # preview the production build
```

The `dist/` folder is a plain static site — drop it on Netlify, Vercel, GitHub Pages, etc.

## Multiplayer (experimental — an Allomancy PvP arena)

The goal is a first-person arena where two-plus Mistborn duel with Allomancy in a **fixed,
shared Luthadel** (one canonical map, same every load, so players learn it).

- **Architecture:** see [`PVP_ARCHITECTURE.md`](PVP_ARCHITECTURE.md). The physics is a pure,
  engine-free sim ([`src/sim.ts`](src/sim.ts)) that the client and server both run; combat
  (coinshots, push/pull, health) lives in [`src/combat.ts`](src/combat.ts).
- **Try it locally** (relay first cut — see each other move):
  ```bash
  npm run server     # relay on ws://localhost:8090
  npm run dev        # client on :5180  (separate terminal)
  ```
  Open two browser tabs on :5180.
- **Host the relay (free):** Render (`render.yaml`) or Fly.io (`fly.toml` + `Dockerfile`), then
  point the client at it via `VITE_SERVER_URL` (see [`.env.example`](.env.example)). The
  deployed site stays **single-player** until that's set, so it never breaks.

## How it's made

- **No image/audio assets ship with the project.** Every texture is drawn procedurally on a `<canvas>` at load — including baked **normal and roughness maps**, so the cobbles catch the lamplight in real relief and wet stone glistens — and the ambient wind is synthesized with the Web Audio API.
- A cinematic **post-processing pipeline** (bloom, a split-tone colour grade, vignette + ash-grain, and SMAA) is what makes the stained glass blaze through the mist.
- The world layout and atmosphere were **informed by reading the books** (1–3), but everything rendered here — geometry, art, NPCs, and all in-app text — is **original**. No passages from the novels are reproduced.

## Roadmap ideas

- ✅ Allomancy: steel-sight, steel-leap, **iron-pull** & **aimed steel-push**, **pewter**, **tin**, **atium** (shadows of the near future), and a **glowing metal-sight** — bloom-bright lines, light-nodes, and a fat pulsing push/pull beam *(done)* — next: thrown coins.
- ✅ A graphics pass — bloom, **image-based reflections**, a **chromatic-aberration + filmic colour grade**, PBR materials, **player-tracking moonlight shadow maps**, peaked & tile roofs, spired/domed/towered keeps, a crisp looming Kredik Shaw, coiling mist, **god-ray light-shafts**, **rising embers**, a hazy **moon**, and walking hooded-skaa + Garrison NPCs *(done)*.
- ✅ A much bigger city — a **parametric district** (~180 buildings, scalable) with a grand avenue, a market & fountain, the Lord Ruler's plaza, **Clubs' shop**, the **Ministry cathedral**, an **ashen canal with arched bridges**, the **noble ball**, the walled gate with corner towers, and a fogged skyline beyond — kept smooth by block-culling, a chasing light-pool, follow-shadows & instancing *(done)* — next: interiors, curved streets, an even larger map.
- 🔜 Multiplayer Allomancy **PvP**: fixed shared map ✅, pure shared sim ✅, relay so players see each other move ✅, combat core (coinshots / knockback / health) ✅ — next: an authoritative server with prediction + reconciliation, then live combat (needs a hosted server).
- A day/ash-storm cycle and heavier mist.
- Other eras: the Elendel of the *Wax & Wayne* books as a second zone.
- Mobile/touch controls.

## Disclaimer

This is an **unofficial, non-commercial fan project**. *Mistborn*, Luthadel, Kredik Shaw, and the world of the Final Empire are © **Brandon Sanderson / Dragonsteel Entertainment**. This project is made by a fan out of love for the books, is not endorsed by or affiliated with the author or publisher, and is **not for sale**. If you represent the rights holders and would like it changed or taken down, that request will be honored.
