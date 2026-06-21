// =====================================================================================
// Luthadel — Phase 1 relay server (host-ready).
//
// Because the city is a FIXED seed, every client already builds the identical Luthadel — so
// the server doesn't sync the world, it just relays each player's position/orientation to
// everyone else (~20 Hz snapshots). It's a RELAY (each client is authoritative over its own
// movement) — a stepping stone; Phase 2 makes it authoritative (runs sim.ts) with client
// prediction + reconciliation + lag-compensated hits. See PVP_ARCHITECTURE.md.
//
// An HTTP server wraps the WebSocket server so cloud hosts (Render/Fly) can health-check the
// port. PORT comes from the host's env (Render/Fly set it); defaults to 8090 locally.
//
// Run locally:  npm run server      (ws://localhost:8090)
// =====================================================================================
import http from 'node:http';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT) || 8090;

const server = http.createServer((req, res) => {
  // a plain 200 so platform health checks pass (and you can eyeball it in a browser)
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end(`Luthadel relay up — ${clients.size} online\n`);
});

const wss = new WebSocketServer({ server });

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
      const c = clients.get(ws);
      if (!c) return;
      if (msg.t === 'state') { c.state = msg.s; }
      else if (msg.t === 'fire') {                 // a coinshot — relay it to everyone else
        const out = JSON.stringify({ t: 'fire', id: c.id, s: msg.s });
        for (const sock of clients.keys()) if (sock !== ws && sock.readyState === 1) sock.send(out);
      }
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

server.listen(PORT, () => console.log(`Luthadel relay listening on :${PORT}`));
