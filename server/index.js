// One call to stand up a multiplayer game server: static files for the
// game's client, the shared client kit at /rtg/, a WebSocket at /ws, and
// /health for the host's health checks.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { RoomManager, BUILD, PALETTE } from './rooms.js';

export { RoomManager, BUILD, PALETTE };

const KIT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../client');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
};

/**
 * @param {object} opts
 * @param {Record<string, object>} opts.games  gameId → game module (see GAME_API.md)
 * @param {string} opts.clientDir  directory with the game's index.html and assets
 * @param {number} [opts.port]  defaults to $PORT, then 3000
 * @param {string} [opts.kitMount]  URL prefix for the client kit (default "/rtg")
 */
export function createGameServer({ games, clientDir, port = Number(process.env.PORT) || 3000, kitMount = '/rtg' }) {
  const rooms = new RoomManager(games);
  const root = path.resolve(clientDir);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, build: BUILD, rooms: rooms.rooms.size }));
      return;
    }
    let rel = decodeURIComponent(url.pathname);
    let base = root;
    if (rel.startsWith(`${kitMount}/`)) {
      base = KIT_DIR;
      rel = rel.slice(kitMount.length);
    }
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.join(base, path.normalize(rel));
    if (!file.startsWith(base)) {
      res.writeHead(403).end();
      return;
    }
    try {
      let body = await readFile(file);
      // Stamp pages with the build they were served from, so the client kit
      // can tell when it's talking to a newer server.
      if (file.endsWith('.html')) body = body.toString().replaceAll('__BUILD__', BUILD);
      res.writeHead(200, {
        'content-type': MIME[path.extname(file)] || 'application/octet-stream',
        'cache-control': 'no-cache',
      });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
    }
  });

  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws) => rooms.connect(ws));

  server.listen(port, () => console.log(`game server listening on :${port} (build ${BUILD})`));

  return {
    server,
    rooms,
    close() {
      rooms.stop();
      wss.close();
      server.close();
    },
  };
}
