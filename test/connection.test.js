import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { RoomManager, BUILD } from '../server/rooms.js';

// The client kit's connection.js, run against a real RoomManager: just
// enough of a browser (storage, URL, history, WebSocket) to watch its
// join flow end to end.

const storage = new Map();
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
};
globalThis.document = { querySelector: (sel) => (sel === 'meta[name="build"]' ? { content: BUILD } : null) };
globalThis.location = { search: '', protocol: 'http:', host: 'test', pathname: '/', reload() {} };
globalThis.history = { url: '/', replaceState(state, title, url) { this.url = url; } };

let server = null; // the RoomManager the next browser socket talks to

// The server's end of one browser connection (same shape as rooms.test.js).
class ServerSocket extends EventEmitter {
  constructor(browser) { super(); this.browser = browser; this.readyState = 1; }
  send(data) { this.browser.onmessage?.({ data }); }
  ping() {}
  terminate() { this.close(); }
  close() { this.readyState = 3; this.emit('close'); }
}

// What connection.js gets from `new WebSocket(url)`: opens on the next
// microtask, then hears the server's hello, like a real one.
class BrowserSocket {
  constructor() {
    this.readyState = 0;
    this.peer = new ServerSocket(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.();
      server.connect(this.peer);
    });
  }
  send(data) { this.peer.emit('message', data); }
  close() {}
}
globalThis.WebSocket = BrowserSocket;

const { connect } = await import('../client/connection.js');

// Server-side players, as in rooms.test.js.
class FakeSocket extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.sent = []; }
  send(data) { this.sent.push(JSON.parse(data)); }
  ping() {}
  terminate() { this.close(); }
  close() { this.readyState = 3; this.emit('close'); }
  say(msg) { this.emit('message', JSON.stringify(msg)); }
  last(t) { return [...this.sent].reverse().find((m) => m.t === t); }
}

// A drop-in arena that starts itself and seats latecomers.
const arena = {
  title: 'Arena',
  minPlayers: 1,
  maxPlayers: 30,
  autoStart: true,
  joinInProgress: true,
  create: (settings, ctx) => ({ seats: ctx.players.map((p) => p.id), over: false }),
  join(state, player) { state.seats.push(player.id); },
  handle() {},
  view: (state, pid) => ({ seats: state.seats, mine: state.seats.indexOf(pid) }),
};
const locked = { ...arena, autoStart: false, joinInProgress: false, minPlayers: 2 };

// A room Ann made on the server, and a fresh browser page for someone else.
function room(gameId) {
  storage.clear();
  history.url = '/';
  location.search = '';
  server = new RoomManager({ arena, locked }, { tickMs: 1e9 });
  const ann = new FakeSocket();
  server.connect(ann);
  ann.say({ t: 'create', game: gameId, name: 'Ann' });
  return { rooms: server, ann, code: ann.last('joined').code };
}

async function page(gameId) {
  const events = { syncs: [], errors: [], left: 0 };
  const conn = connect({
    gameId,
    badge: false,
    onSync: (s) => events.syncs.push(s),
    onError: (m) => events.errors.push(m),
    onLeft: () => events.left++,
  });
  await new Promise((r) => setTimeout(r, 0)); // let the socket open
  return { conn, events };
}

const session = (gameId) => JSON.parse(storage.get(`rtg.${gameId}.session`) ?? 'null');

test('a ?room= link into a running joinInProgress game: Join lands you in the game', async () => {
  const { rooms, ann, code } = room('arena');
  location.search = `?room=${code}`;
  const { conn, events } = await page('arena');
  assert.equal(conn.urlRoom, code, 'the home screen pre-fills the code');
  assert.equal(conn.sync, null, 'no saved seat, so no automatic rejoin');
  conn.join(conn.urlRoom, 'Bo');
  assert.deepEqual(events.errors, []);
  const saved = session('arena');
  assert.equal(saved.code, code, 'the session is saved for reloads');
  assert.equal(history.url, `?room=${code}`);
  assert.equal(events.syncs.length, 1);
  const s = conn.sync;
  assert.equal(s.room.started, true);
  assert.equal(s.room.joinInProgress, true);
  assert.deepEqual(s.game.seats, [ann.last('joined').playerId, s.you], 'the game gave Bo a place');
  assert.equal(s.game.mine, 1);
  assert.equal(rooms.rooms.get(code).player(s.you).token, saved.token);
  rooms.stop();
});

test('Join with a seat already saved for that room takes the seat back', async () => {
  const { rooms, ann, code } = room('arena');
  const { conn } = await page('arena');
  conn.join(code, 'Bo');
  const bo = conn.sync.you;
  // Leave mid-game the way the kit's Leave button does: the seat and the
  // saved session both stay, and the page goes back to the home screen.
  conn.leave({ forget: false });
  assert.equal(conn.sync, null);
  assert.equal(session('arena').code, code);
  conn.join(code.toLowerCase(), 'Bo');
  assert.equal(conn.sync.you, bo, 'the same seat, not a second Bo');
  assert.equal(ann.last('sync').room.players.length, 2);
  assert.deepEqual(conn.sync.game.seats, [ann.last('joined').playerId, bo]);
  rooms.stop();
});

test('Join with a saved seat that is gone joins as someone new', async () => {
  const { rooms, ann, code } = room('arena');
  storage.set('rtg.arena.session', JSON.stringify({ code, token: 'stale' }));
  const { conn, events } = await page('arena');
  conn.join(code, 'Bo');
  assert.deepEqual(events.errors, []);
  assert.equal(events.left, 0);
  assert.equal(conn.sync.room.players.length, 2);
  assert.equal(conn.sync.game.mine, 1);
  assert.notEqual(session('arena').token, 'stale');
  assert.equal(ann.last('sync').room.players.length, 2);
  rooms.stop();
});

test('a locked game still says so on Join', async () => {
  const { rooms, ann, code } = room('locked');
  const b = new FakeSocket();
  rooms.connect(b);
  b.say({ t: 'join', code, name: 'Bo' });
  ann.say({ t: 'start' });
  const { conn, events } = await page('locked');
  conn.join(code, 'Cy');
  assert.deepEqual(events.errors, ['That game has already started. Rooms lock once the game begins.']);
  assert.equal(conn.sync, null);
  assert.equal(session('locked'), null);
  rooms.stop();
});
