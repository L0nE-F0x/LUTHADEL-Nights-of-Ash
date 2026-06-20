// =====================================================================================
// Luthadel — Phase 1 relay server.
//
// The simplest multiplayer that works: because the city is a FIXED seed, every client
// already builds the identical Luthadel — so the server doesn't sync the world at all, it
// just relays each player's position/orientation to everyone else (~20 Hz snapshots).
//
// This is a RELAY (each client is authoritative over its own movement) — a stepping stone.
// Phase 2 makes it authoritative (the server runs sim.ts' stepPlayer) with reconciliation
// + lag-compensated hits. See PVP_ARCHITECTURE.md.
//
// Run:  npm run server        (defaults to ws://localhost:8090)
// =====================================================================================
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT) || 8090;
const wss = new WebSocketServer({ port: PORT });

let nextId = 1;
const clients = new Map(); // ws -> { id, state }

wss.on('connection', (ws) => {
  const id = nextId++;
  clients.set(ws, { id, state: null });
  ws.send(JSON.stringify({ t: 'hello', id }));
  console.log(`player ${id} joined (${clients.size} online)`);

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.t === 'state') { const c = clients.get(ws); if (c) c.state = msg.s; }
    } catch { /* ignore malformed */ }
  });

  ws.on('close', () => {
    clients.delete(ws);
    const m = JSON.stringify({ t: 'leave', id });
    for (const sock of clients.keys()) if (sock.readyState === 1) sock.send(m);
    console.log(`player ${id} left (${clients.size} online)`);
  });
});

// broadcast a snapshot of every player who has sent a state, 20×/s
setInterval(() => {
  const players = [];
  for (const c of clients.values()) if (c.state) players.push({ id: c.id, s: c.state });
  if (!players.length) return;
  const m = JSON.stringify({ t: 'snapshot', players });
  for (const ws of clients.keys()) if (ws.readyState === 1) ws.send(m);
}, 50);

console.log(`Luthadel relay server listening on ws://localhost:${PORT}`);
