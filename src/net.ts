// =====================================================================================
// Client networking (Phase 1 relay, with entity interpolation). Sends our position ~20×/s
// and reconstructs every other player smoothly by rendering them ~100 ms in the past,
// interpolating between buffered snapshots (the standard fix for jittery remote motion).
//
// PROD-SAFE: with no server configured it does nothing — the deployed Netlify site stays
// pure single-player. `npm run dev` auto-tries ws://<host>:8090; a hosted build connects only
// if VITE_SERVER_URL is set. A failed/absent connection just leaves you single-player.
// =====================================================================================

export type PeerState = { x: number; y: number; z: number; yaw: number };
type Sample = PeerState & { t: number };

const INTERP_DELAY = 100;   // ms in the past we render remote players, so we always interpolate

export type FireEvent = { id: number; x: number; y: number; z: number; dx: number; dy: number; dz: number };
const buffers = new Map<number, Sample[]>();   // peer id -> recent timestamped snapshots
const _interp = new Map<number, PeerState>();  // reused output of netInterpolated()
let _fires: FireEvent[] = [];                  // coinshots from other players, drained each frame
let _hits: { dmg: number; from: number }[] = []; // coinshots that struck ME, drained each frame
let _shoves: { fx: number; fy: number; fz: number; strength: number; pull: boolean }[] = []; // Allomantic knockback dealt to ME
let ws: WebSocket | null = null;
let myId = 0;
let connected = false;
let _accum = 0;

function serverUrl(): string | null {
  const env = import.meta.env as unknown as { VITE_SERVER_URL?: string; DEV?: boolean };
  if (env.VITE_SERVER_URL) return env.VITE_SERVER_URL;
  if (env.DEV) return `ws://${location.hostname}:8090`;   // local relay during development
  return null;                                            // hosted with no server → single-player
}

let _retry = 0;
export function netStart() {
  const url = serverUrl();
  if (url) connect(url);
}
function scheduleReconnect(url: string) {
  // backoff 1s,2s,4s… capped at 15s — recovers when a sleeping free host wakes / restarts
  const delay = Math.min(15000, 1000 * 2 ** _retry++);
  setTimeout(() => { if (!connected) connect(url); }, delay);
}
function connect(url: string) {
  let sock: WebSocket;
  try { sock = new WebSocket(url); } catch { scheduleReconnect(url); return; }
  ws = sock;
  sock.onopen = () => { connected = true; _retry = 0; console.info('[net] connected', url); };
  sock.onclose = () => { connected = false; if (ws === sock) ws = null; buffers.clear(); scheduleReconnect(url); };
  sock.onerror = () => { /* a close follows → reconnect; no console noise */ };
  sock.onmessage = (e) => {
    let m: { t: string; [k: string]: unknown };
    try { m = JSON.parse(e.data as string); } catch { return; }
    if (m.t === 'hello') { myId = m.id as number; }
    else if (m.t === 'snapshot') {
      const now = performance.now();
      for (const p of m.players as { id: number; s: PeerState }[]) {
        if (p.id === myId) continue;
        let b = buffers.get(p.id);
        if (!b) { b = []; buffers.set(p.id, b); }
        b.push({ x: p.s.x, y: p.s.y, z: p.s.z, yaw: p.s.yaw, t: now });
        if (b.length > 12) b.shift();
      }
    } else if (m.t === 'fire') {
      const s = m.s as { x: number; y: number; z: number; dx: number; dy: number; dz: number };
      _fires.push({ id: m.id as number, x: s.x, y: s.y, z: s.z, dx: s.dx, dy: s.dy, dz: s.dz });
    } else if (m.t === 'hit') {
      if ((m.target as number) === myId) _hits.push({ dmg: m.dmg as number, from: m.from as number });
    } else if (m.t === 'shove') {
      if ((m.target as number) === myId) _shoves.push({ fx: m.fx as number, fy: m.fy as number, fz: m.fz as number, strength: m.strength as number, pull: !!m.pull });
    } else if (m.t === 'leave') { buffers.delete(m.id as number); }
  };
}

// throttled to ~20 Hz; only sends while connected
export function netSend(x: number, y: number, z: number, yaw: number, dt: number) {
  if (!connected || !ws) return;
  _accum += dt;
  if (_accum < 0.05) return;
  _accum = 0;
  ws.send(JSON.stringify({ t: 'state', s: { x: +x.toFixed(2), y: +y.toFixed(2), z: +z.toFixed(2), yaw: +yaw.toFixed(3) } }));
}

// tell everyone we flicked a coinshot from (x,y,z) along unit dir (dx,dy,dz)
export function netFire(x: number, y: number, z: number, dx: number, dy: number, dz: number) {
  if (!connected || !ws) return;
  ws.send(JSON.stringify({ t: 'fire', s: { x: +x.toFixed(2), y: +y.toFixed(2), z: +z.toFixed(2), dx: +dx.toFixed(3), dy: +dy.toFixed(3), dz: +dz.toFixed(3) } }));
}
// drain the coinshots received from other players since last frame
export function netTakeFires(): FireEvent[] { const a = _fires; _fires = []; return a; }
export function netId(): number { return myId; }

// tell the server one of my coins struck player `target`
export function netHit(target: number, dmg: number) {
  if (!connected || !ws) return;
  ws.send(JSON.stringify({ t: 'hit', target, dmg }));
}
// drain the hits that landed on me since last frame
export function netTakeHits(): { dmg: number; from: number }[] { const a = _hits; _hits = []; return a; }

// tell the server I steel-pushed / iron-pulled player `target`, from my position (fx,fy,fz)
export function netShove(target: number, fx: number, fy: number, fz: number, strength: number, pull: boolean) {
  if (!connected || !ws) return;
  ws.send(JSON.stringify({ t: 'shove', target, fx: +fx.toFixed(2), fy: +fy.toFixed(2), fz: +fz.toFixed(2), strength, pull }));
}
// drain the knockback impulses dealt to me since last frame
export function netTakeShoves(): { fx: number; fy: number; fz: number; strength: number; pull: boolean }[] { const a = _shoves; _shoves = []; return a; }

function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2; else if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

// every peer's state, interpolated to (now - INTERP_DELAY). Returns a reused Map<id, state>.
export function netInterpolated(): Map<number, PeerState> {
  _interp.clear();
  const renderT = performance.now() - INTERP_DELAY;
  for (const [id, b] of buffers) {
    if (!b.length) continue;
    const first = b[0], last = b[b.length - 1];
    if (renderT <= first.t) { _interp.set(id, { x: first.x, y: first.y, z: first.z, yaw: first.yaw }); continue; }
    if (renderT >= last.t) { _interp.set(id, { x: last.x, y: last.y, z: last.z, yaw: last.yaw }); continue; }
    let s0 = first, s1 = last;
    for (let i = 0; i < b.length - 1; i++) {
      if (b[i].t <= renderT && b[i + 1].t >= renderT) { s0 = b[i]; s1 = b[i + 1]; break; }
    }
    const a = (renderT - s0.t) / ((s1.t - s0.t) || 1);
    _interp.set(id, {
      x: s0.x + (s1.x - s0.x) * a,
      y: s0.y + (s1.y - s0.y) * a,
      z: s0.z + (s1.z - s0.z) * a,
      yaw: lerpAngle(s0.yaw, s1.yaw, a),
    });
  }
  return _interp;
}

// raw latest state per peer (for debugging / __lutha)
export function netPeers(): Map<number, PeerState> {
  const m = new Map<number, PeerState>();
  for (const [id, b] of buffers) if (b.length) { const s = b[b.length - 1]; m.set(id, { x: s.x, y: s.y, z: s.z, yaw: s.yaw }); }
  return m;
}

export function netConnected(): boolean { return connected; }
