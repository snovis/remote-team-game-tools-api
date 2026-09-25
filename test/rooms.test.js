import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { RoomManager, BUILD } from '../server/rooms.js';

// A stand-in WebSocket: records what the server sends, lets tests send.
class FakeSocket extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.sent = []; }
  send(data) { this.sent.push(JSON.parse(data)); }
  ping() {}
  terminate() { this.close(); }
  close() { this.readyState = 3; this.emit('close'); }
  say(msg) { this.emit('message', JSON.stringify(msg)); }
  last(t) { return [...this.sent].reverse().find((m) => m.t === t); }
}

// Minimal game: each player has a secret; view shows only your own.
const secretGame = {
  title: 'Secrets',
  minPlayers: 2,
  maxPlayers: 3,
  defaultSettings: { speed: 'slow' },
  normalizeSettings: (s) => ({ speed: s.speed === 'fast' ? 'fast' : 'slow' }),
  create: (settings, ctx) => ({ settings, secrets: {}, over: false, ticks: 0 }),
  handle(state, pid, a) {
    if (a.type === 'set') { state.secrets[pid] = a.value; return; }
    if (a.type === 'end') { state.over = true; return; }
    return 'Unknown action.';
  },
  tick(state) { state.ticks++; return false; },
  view: (state, pid) => ({ mine: state.secrets[pid] ?? null, count: Object.keys(state.secrets).length, over: state.over }),
};

function setup() {
  const rooms = new RoomManager({ secrets: secretGame }, { tickMs: 1e9 });
  const join = () => { const ws = new FakeSocket(); rooms.connect(ws); return ws; };
  return { rooms, join };
}

test('hello carries the build; create gives a 4-letter code and makes you host', () => {
  const { rooms, join } = setup();
  const a = join();
  assert.equal(a.sent[0].t, 'hello');
  assert.equal(a.sent[0].build, BUILD);
  a.say({ t: 'create', game: 'secrets', name: '  Ann  ' });
  const joined = a.last('joined');
  assert.match(joined.code, /^[A-HJ-NP-Z]{4}$/);
  const sync = a.last('sync');
  assert.equal(sync.room.hostId, joined.playerId);
  assert.equal(sync.room.players[0].name, 'Ann');
  assert.deepEqual(sync.room.settings, { speed: 'slow' });
  rooms.stop();
});

test('join, host-only settings, start, per-player hidden views', () => {
  const { rooms, join } = setup();
  const a = join(); a.say({ t: 'create', game: 'secrets', name: 'Ann' });
  const code = a.last('joined').code;
  const b = join(); b.say({ t: 'join', code: code.toLowerCase(), name: 'Bo' });
  assert.equal(b.last('sync').room.players.length, 2);
  b.say({ t: 'settings', settings: { speed: 'fast' } });
  assert.match(b.last('error').message, /host/);
  a.say({ t: 'settings', settings: { speed: 'fast' } });
  assert.equal(b.last('sync').room.settings.speed, 'fast');
  a.say({ t: 'start' });
  a.say({ t: 'action', action: { type: 'set', value: 'ann-secret' } });
  b.say({ t: 'action', action: { type: 'set', value: 'bo-secret' } });
  assert.equal(a.last('sync').game.mine, 'ann-secret');
  assert.equal(b.last('sync').game.mine, 'bo-secret');
  assert.ok(!JSON.stringify(b.sent).includes('ann-secret'), 'Bo never receives Ann’s secret');
  b.say({ t: 'action', action: { type: 'nope' } });
  assert.equal(b.last('error').message, 'Unknown action.');
  rooms.stop();
});

test('rooms lock at start; full rooms refuse joins', () => {
  const { rooms, join } = setup();
  const a = join(); a.say({ t: 'create', game: 'secrets', name: 'Ann' });
  const code = a.last('joined').code;
  for (const n of ['Bo', 'Cy']) join().say({ t: 'join', code, name: n });
  const d = join(); d.say({ t: 'join', code, name: 'Di' });
  assert.match(d.last('error').message, /full/);
  a.say({ t: 'start' });
  const e = join(); e.say({ t: 'join', code, name: 'Ed' });
  assert.match(e.last('error').message, /already started/);
  rooms.stop();
});

test('rejoin with the token restores the seat; host passes on when the host drops', () => {
  const { rooms, join } = setup();
  const a = join(); a.say({ t: 'create', game: 'secrets', name: 'Ann' });
  const { code, token, playerId: annId } = a.last('joined');
  const b = join(); b.say({ t: 'join', code, name: 'Bo' });
  const boId = b.last('joined').playerId;
  a.say({ t: 'start' });
  a.say({ t: 'action', action: { type: 'set', value: 'kept' } });
  a.close();
  assert.equal(b.last('sync').room.hostId, boId, 'host handed to Bo');
  assert.equal(b.last('sync').room.players.find((p) => p.id === annId).connected, false);
  const a2 = join(); a2.say({ t: 'rejoin', code, token });
  assert.equal(a2.last('joined').playerId, annId);
  assert.equal(a2.last('sync').game.mine, 'kept', 'state survives a reconnect');
  const x = join(); x.say({ t: 'rejoin', code, token: 'wrong' });
  assert.ok(x.last('rejoinFailed'));
  rooms.stop();
});

test('back to lobby only after game over, by the host', () => {
  const { rooms, join } = setup();
  const a = join(); a.say({ t: 'create', game: 'secrets', name: 'Ann' });
  const code = a.last('joined').code;
  const b = join(); b.say({ t: 'join', code, name: 'Bo' });
  a.say({ t: 'start' });
  a.say({ t: 'lobby' });
  assert.match(a.last('error').message, /after the game/);
  a.say({ t: 'action', action: { type: 'end' } });
  b.say({ t: 'lobby' });
  assert.match(b.last('error').message, /host/);
  a.say({ t: 'lobby' });
  assert.equal(b.last('sync').game, null);
  assert.equal(b.last('sync').room.started, false);
  rooms.stop();
});

test('tick drives the game clock', () => {
  const { rooms, join } = setup();
  const a = join(); a.say({ t: 'create', game: 'secrets', name: 'Ann' });
  join().say({ t: 'join', code: a.last('joined').code, name: 'Bo' });
  a.say({ t: 'start' });
  const room = [...rooms.rooms.values()][0];
  rooms.tick(); rooms.tick();
  assert.equal(room.state.ticks, 2);
  rooms.stop();
});
