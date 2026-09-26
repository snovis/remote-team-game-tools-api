import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { RoomManager, BUILD, HOST_GRACE_MS } from '../server/rooms.js';

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

function setup(games = { secrets: secretGame }) {
  const rooms = new RoomManager(games, { tickMs: 1e9 });
  const join = () => { const ws = new FakeSocket(); rooms.connect(ws); return ws; };
  return { rooms, join };
}

// Ann makes the room (so she's its owner and host); Bo and Cy join. Date
// is mocked so tests can step through the host grace period.
function trio(t) {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const { rooms, join } = setup();
  const a = join(); a.say({ t: 'create', game: 'secrets', name: 'Ann' });
  const { code, token, playerId: ann } = a.last('joined');
  const b = join(); b.say({ t: 'join', code, name: 'Bo' });
  const c = join(); c.say({ t: 'join', code, name: 'Cy' });
  return {
    rooms, join, a, b, c, code, token, ann,
    bo: b.last('joined').playerId,
    cy: c.last('joined').playerId,
    later: (ms) => t.mock.timers.tick(ms),
  };
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
  assert.equal(sync.room.ownerId, joined.playerId, 'the creator owns the room');
  assert.equal(sync.room.hostAway, false);
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
  assert.match(b.last('error').message, /Only the Game Master/);
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

test('rejoin with the token restores the seat', () => {
  const { rooms, join } = setup();
  const a = join(); a.say({ t: 'create', game: 'secrets', name: 'Ann' });
  const { code, token, playerId: annId } = a.last('joined');
  const b = join(); b.say({ t: 'join', code, name: 'Bo' });
  a.say({ t: 'start' });
  a.say({ t: 'action', action: { type: 'set', value: 'kept' } });
  a.close();
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
  assert.match(b.last('error').message, /Only the Game Master/);
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

// ---- the host role: grace period, leaving, hand-off, take-back, title

test('a short drop keeps the host role, and nobody else gets the controls', (t) => {
  const { rooms, join, a, b, code, token, ann, bo, later } = trio(t);
  const droppedAt = Date.now();
  a.close();
  let room = b.last('sync').room;
  assert.equal(room.hostId, ann, 'still Ann');
  assert.equal(room.hostAway, true);
  assert.equal(room.hostAwayUntil, droppedAt + HOST_GRACE_MS);
  b.say({ t: 'settings', settings: { speed: 'fast' } });
  assert.match(b.last('error').message, /Only the Game Master/);
  // Someone else reconnecting inside the grace period doesn't take it.
  later(HOST_GRACE_MS - 1000);
  b.close();
  const b2 = join(); b2.say({ t: 'rejoin', code, token: rooms.rooms.get(code).player(bo).token });
  rooms.tick();
  assert.equal(b2.last('sync').room.hostId, ann);
  // Ann's back in time: nothing changes.
  const a2 = join(); a2.say({ t: 'rejoin', code, token });
  room = b2.last('sync').room;
  assert.equal(room.hostId, ann);
  assert.equal(room.hostAway, false);
  assert.equal(room.hostAwayUntil, null);
  later(HOST_GRACE_MS); rooms.tick();
  assert.equal(b2.last('sync').room.hostId, ann);
  rooms.stop();
});

test('a drop past the grace period hands the role to the next connected player', (t) => {
  const { rooms, join, a, b, c, code, token, ann, bo, later } = trio(t);
  a.say({ t: 'start' });
  a.close();
  later(HOST_GRACE_MS - 1); rooms.tick();
  assert.equal(c.last('sync').room.hostId, ann, 'not yet');
  later(1); rooms.tick();
  const room = c.last('sync').room;
  assert.equal(room.hostId, bo, 'Bo joined first, so Bo takes over');
  assert.equal(room.hostAway, false);
  // Coming back late doesn't take it back automatically.
  const a2 = join(); a2.say({ t: 'rejoin', code, token });
  assert.equal(a2.last('sync').room.hostId, bo);
  assert.equal(a2.last('sync').room.ownerId, ann);
  b.say({ t: 'action', action: { type: 'end' } });
  b.say({ t: 'lobby' });
  assert.equal(a2.last('sync').room.started, false, 'Bo has the controls now');
  rooms.stop();
});

test('leaving on purpose hands the role on at once', (t) => {
  const { rooms, a, b, c, bo, cy } = trio(t);
  a.say({ t: 'start' });
  a.say({ t: 'leave' });
  assert.equal(c.last('sync').room.hostId, bo, 'no grace period for a leave');
  assert.equal(c.last('sync').room.hostAway, false);
  b.say({ t: 'leave' });
  assert.equal(c.last('sync').room.hostId, cy);
  rooms.stop();
});

test('with nobody connected, whoever attaches first after the grace period is host', (t) => {
  const { rooms, join, a, b, c, code, bo, later } = trio(t);
  a.say({ t: 'start' });
  c.say({ t: 'leave' });
  const boToken = rooms.rooms.get(code).player(bo).token;
  a.close(); b.close();
  later(HOST_GRACE_MS); rooms.tick();
  const b2 = join(); b2.say({ t: 'rejoin', code, token: boToken });
  assert.equal(b2.last('sync').room.hostId, bo);
  rooms.stop();
});

test('the room\'s creator can take the role back whenever they\'re here', (t) => {
  const { rooms, a, b, c, ann, bo } = trio(t);
  a.say({ t: 'handHost', to: bo });
  assert.equal(c.last('sync').room.hostId, bo);
  a.say({ t: 'takeHost' });
  assert.equal(c.last('sync').room.hostId, ann);
  // Even while the current host is inside their grace period.
  a.say({ t: 'handHost', to: bo });
  b.close();
  assert.equal(c.last('sync').room.hostAway, true);
  a.say({ t: 'takeHost' });
  assert.equal(c.last('sync').room.hostId, ann);
  assert.equal(c.last('sync').room.hostAway, false);
  const errors = a.sent.filter((m) => m.t === 'error').length;
  a.say({ t: 'takeHost' });
  assert.equal(a.sent.filter((m) => m.t === 'error').length, errors, 'already host: nothing to do');
  rooms.stop();
});

test('the host can hand the role to another connected player', (t) => {
  const { rooms, a, b, c, bo, cy } = trio(t);
  a.say({ t: 'handHost', to: bo });
  assert.equal(c.last('sync').room.hostId, bo);
  b.say({ t: 'settings', settings: { speed: 'fast' } });
  assert.equal(c.last('sync').room.settings.speed, 'fast', 'the new host has the controls');
  a.say({ t: 'settings', settings: { speed: 'slow' } });
  assert.match(a.last('error').message, /Only the Game Master/, 'and the old one does not');
  b.say({ t: 'handHost', to: bo });
  assert.match(b.last('error').message, /another player/);
  b.say({ t: 'handHost', to: 'nobody' });
  assert.match(b.last('error').message, /another player/);
  c.close();
  b.say({ t: 'handHost', to: cy });
  assert.match(b.last('error').message, /Cy isn't connected/);
  assert.equal(a.last('sync').room.hostId, bo);
  rooms.stop();
});

test('only the host hands the role on, and only the creator takes it back', (t) => {
  const { rooms, a, b, c, ann, bo, cy } = trio(t);
  c.say({ t: 'handHost', to: cy });
  assert.match(c.last('error').message, /Only the Game Master can hand/);
  c.say({ t: 'takeHost' });
  assert.match(c.last('error').message, /made the room/);
  assert.equal(a.last('sync').room.hostId, ann);
  a.say({ t: 'handHost', to: bo });
  b.say({ t: 'takeHost' });
  assert.match(b.last('error').message, /made the room/, 'being host doesn\'t make you the owner');
  b.say({ t: 'handHost', to: cy });
  assert.equal(a.last('sync').room.hostId, cy, 'but any host can hand it on');
  rooms.stop();
});

test('the host title defaults to Game Master and a game can rename it', () => {
  let { rooms, join } = setup();
  const a = join(); a.say({ t: 'create', game: 'secrets', name: 'Ann' });
  assert.equal(a.last('sync').room.hostTitle, 'Game Master');
  rooms.stop();

  const racer = {
    ...secretGame,
    hostTitle: 'Race Master',
    handle: (state, pid, action, ctx) => `Ask the ${ctx.hostTitle}.`,
  };
  ({ rooms, join } = setup({ racer }));
  const r = join(); r.say({ t: 'create', game: 'racer', name: 'Ann' });
  const code = r.last('joined').code;
  const s = join(); s.say({ t: 'join', code, name: 'Bo' });
  assert.equal(s.last('sync').room.hostTitle, 'Race Master');
  s.say({ t: 'start' });
  assert.equal(s.last('error').message, 'Only the Race Master can start the game.');
  r.say({ t: 'start' });
  s.say({ t: 'action', action: {} });
  assert.equal(s.last('error').message, 'Ask the Race Master.', 'games get it in ctx too');
  rooms.stop();
});
