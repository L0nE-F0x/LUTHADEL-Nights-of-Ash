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

const buffers = new Map<number, Sample[]>();   // peer id -> recent timestamped snapshots
const _interp = new Map<number, PeerState>();  // reused output of netInterpolated()
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

export function netStart() {
  const url = serverUrl();
  if (!url) return;
  try {
    const sock = new WebSocket(url);
    ws = sock;
    sock.onopen = () => { connected = true; console.info('[net] connected', url); };
    sock.onclose = () => { connected = false; if (ws === sock) ws = null; buffers.clear(); };
    sock.onerror = () => { /* no server running — stay single-player, no noise */ };
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
      } else if (m.t === 'leave') { buffers.delete(m.id as number); }
    };
  } catch { ws = null; }
}

// throttled to ~20 Hz; only sends while connected
export function netSend(x: number, y: number, z: number, yaw: number, dt: number) {
  if (!connected || !ws) return;
  _accum += dt;
  if (_accum < 0.05) return;
  _accum = 0;
  ws.send(JSON.stringify({ t: 'state', s: { x: +x.toFixed(2), y: +y.toFixed(2), z: +z.toFixed(2), yaw: +yaw.toFixed(3) } }));
}

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
