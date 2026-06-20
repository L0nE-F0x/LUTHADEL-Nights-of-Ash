// =====================================================================================
// Client networking (Phase 1, relay). Sends our position to the server ~20×/s and keeps the
// latest state of every other player for the renderer to draw as an avatar.
//
// PROD-SAFE: with no server configured it does nothing — the deployed Netlify site stays
// pure single-player. In `npm run dev` it auto-tries ws://<host>:8090 (the local relay); in
// a hosted build it connects only if VITE_SERVER_URL is set. A failed/absent connection just
// leaves you in single-player, never an error.
// =====================================================================================

export type PeerState = { x: number; y: number; z: number; yaw: number };

const peers = new Map<number, PeerState>();
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
    sock.onclose = () => { connected = false; if (ws === sock) ws = null; peers.clear(); };
    sock.onerror = () => { /* no server running — stay single-player, no noise */ };
    sock.onmessage = (e) => {
      let m: { t: string; [k: string]: unknown };
      try { m = JSON.parse(e.data as string); } catch { return; }
      if (m.t === 'hello') { myId = m.id as number; }
      else if (m.t === 'snapshot') {
        for (const p of m.players as { id: number; s: PeerState }[]) {
          if (p.id !== myId) peers.set(p.id, p.s);
        }
      } else if (m.t === 'leave') { peers.delete(m.id as number); }
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

export function netPeers(): Map<number, PeerState> { return peers; }
export function netConnected(): boolean { return connected; }
