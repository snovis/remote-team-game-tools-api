import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { RoomManager, BUILD, HOST_GRACE_MS, PALETTE } from '../server/rooms.js';

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

// ---- autoStart and joinInProgress: a game that's running from the moment
// the room is made, and that latecomers can join

// A drop-in arena: everyone gets a seat, in join order. It records every
// create() and join() call so tests can check what the game was given.
function arena(extra = {}) {
  const calls = { create: [], join: [] };
  const game = {
    title: 'Arena',
    minPlayers: 2, // autoStart doesn't wait for this; the Start button does
    maxPlayers: 3,
    autoStart: true,
    joinInProgress: true,
    defaultSettings: { speed: 'slow' },
    normalizeSettings: (s) => ({ speed: s.speed === 'fast' ? 'fast' : 'slow' }),
    create(settings, ctx) {
      calls.create.push({ settings, players: ctx.players });
      return { seats: ctx.players.map((p) => p.id), over: false };
    },
    join(state, player, ctx) {
      calls.join.push({ player, players: ctx.players, connected: ctx.isConnected(player.id), hostId: ctx.hostId });
      state.seats.push(player.id);
    },
    handle(state, pid, a) {
      if (a.type === 'end') { state.over = true; return; }
      return 'Unknown action.';
    },
    view: (state, pid) => ({ seats: state.seats, mine: state.seats.indexOf(pid), over: state.over }),
    ...extra,
  };
  return { game, calls };
}

const syncs = (ws) => ws.sent.filter((m) => m.t === 'sync');
const indexOf = (ws, t) => ws.sent.findIndex((m) => m.t === t);

test('autoStart: making the room starts the game, so the creator never sees the lobby', () => {
  const { game, calls } = arena();
  const { rooms, join } = setup({ arena: game });
  const a = join(); a.say({ t: 'create', game: 'arena', name: 'Ann' });
  const { playerId: ann } = a.last('joined');
  assert.equal(syncs(a).length, 1, 'one sync, and it is already the game');
  assert.ok(indexOf(a, 'joined') < indexOf(a, 'sync'), 'joined comes first, as always');
  const sync = a.last('sync');
  assert.equal(sync.room.started, true);
  assert.equal(sync.room.hostId, ann);
  assert.equal(sync.room.ownerId, ann);
  assert.deepEqual(sync.game, { seats: [ann], mine: 0, over: false });
  // Built exactly like Start builds it: normalized settings, the room's players.
  assert.equal(calls.create.length, 1);
  assert.deepEqual(calls.create[0].settings, { speed: 'slow' });
  assert.deepEqual(calls.create[0].players.map((p) => [p.name, p.connected]), [['Ann', true]]);
  assert.equal(calls.join.length, 0, 'the creator is in create(), not join()');
  rooms.stop();
});

test('joinInProgress: a latecomer gets joined, a place from join(), then one sync', () => {
  const { game, calls } = arena();
  const { rooms, join } = setup({ arena: game });
  const a = join(); a.say({ t: 'create', game: 'arena', name: 'Ann' });
  const { code, playerId: ann } = a.last('joined');
  const annSyncs = syncs(a).length;
  const b = join(); b.say({ t: 'join', code: code.toLowerCase(), name: '  Bo ' });
  assert.equal(b.last('error'), undefined);
  const joined = b.last('joined');
  assert.equal(joined.code, code);
  assert.ok(joined.token);
  const bo = joined.playerId;
  // join() ran once, with the newcomer (id, name, color: never the token)
  // and a ctx that already has them, connected.
  assert.equal(calls.join.length, 1);
  assert.deepEqual(calls.join[0].player, { id: bo, name: 'Bo', color: PALETTE[1] });
  assert.deepEqual(calls.join[0].players.map((p) => [p.name, p.connected]), [['Ann', true], ['Bo', true]]);
  assert.equal(calls.join[0].connected, true);
  assert.equal(calls.join[0].hostId, ann);
  // Bo's first sync is the game with his place already in it.
  assert.equal(syncs(b).length, 1);
  assert.ok(indexOf(b, 'joined') < indexOf(b, 'sync'));
  const sync = b.last('sync');
  assert.equal(sync.you, bo);
  assert.equal(sync.room.started, true);
  assert.equal(sync.room.joinInProgress, true);
  assert.deepEqual(sync.game, { seats: [ann, bo], mine: 1, over: false });
  // Everyone else hears about it in that same one sync.
  assert.equal(syncs(a).length, annSyncs + 1);
  assert.deepEqual(a.last('sync').game.seats, [ann, bo]);
  assert.equal(a.last('sync').room.players.length, 2);
  assert.equal(a.last('sync').room.hostId, ann, 'joining never moves the host role');
  rooms.stop();
});

test('joinInProgress without a join() hook still lets latecomers in', () => {
  const { game } = arena({ join: undefined });
  const { rooms, join } = setup({ arena: game });
  const a = join(); a.say({ t: 'create', game: 'arena', name: 'Ann' });
  const b = join(); b.say({ t: 'join', code: a.last('joined').code, name: 'Bo' });
  assert.ok(b.last('joined'));
  assert.equal(b.last('sync').game.mine, -1, 'no place in the game, but in the room');
  assert.equal(a.last('sync').room.players.length, 2);
  rooms.stop();
});

test('games without joinInProgress still lock at start, join() hook or not', () => {
  const calls = [];
  const { rooms, join } = setup({ secrets: { ...secretGame, join: () => calls.push('join') } });
  const a = join(); a.say({ t: 'create', game: 'secrets', name: 'Ann' });
  const code = a.last('joined').code;
  assert.equal(a.last('sync').game, null, 'no autoStart: the lobby, as before');
  assert.equal(a.last('sync').room.joinInProgress, false);
  join().say({ t: 'join', code, name: 'Bo' });
  a.say({ t: 'start' });
  const c = join(); c.say({ t: 'join', code, name: 'Cy' });
  assert.equal(c.last('error').message, 'That game has already started. Rooms lock once the game begins.');
  assert.equal(c.last('joined'), undefined);
  assert.equal(a.last('sync').room.players.length, 2);
  assert.deepEqual(calls, []);
  rooms.stop();
});

test('a running joinInProgress game still refuses joins once it is full', () => {
  const { game, calls } = arena(); // maxPlayers: 3
  const { rooms, join } = setup({ arena: game });
  const a = join(); a.say({ t: 'create', game: 'arena', name: 'Ann' });
  const code = a.last('joined').code;
  for (const n of ['Bo', 'Cy']) join().say({ t: 'join', code, name: n });
  const d = join(); d.say({ t: 'join', code, name: 'Di' });
  assert.equal(d.last('error').message, 'That room is full.');
  assert.equal(d.last('joined'), undefined);
  assert.equal(calls.join.length, 2, 'join() only for the ones who got in');
  assert.equal(a.last('sync').game.seats.length, 3);
  rooms.stop();
});

test('rejoining a running joinInProgress game takes your seat back without another join()', () => {
  const { game, calls } = arena();
  const { rooms, join } = setup({ arena: game });
  const a = join(); a.say({ t: 'create', game: 'arena', name: 'Ann' });
  const code = a.last('joined').code;
  const b = join(); b.say({ t: 'join', code, name: 'Bo' });
  const { playerId: bo, token } = b.last('joined');
  b.close();
  assert.equal(a.last('sync').room.players.find((p) => p.id === bo).connected, false);
  const b2 = join(); b2.say({ t: 'rejoin', code, token });
  assert.equal(b2.last('joined').playerId, bo);
  assert.equal(b2.last('sync').game.mine, 1, 'same seat');
  // Leaving mid-game keeps the seat too, so the saved token still works.
  b2.say({ t: 'leave' });
  const b3 = join(); b3.say({ t: 'rejoin', code, token });
  assert.equal(b3.last('joined').playerId, bo);
  assert.equal(calls.join.length, 1, 'join() is for newcomers only');
  assert.equal(a.last('sync').room.players.length, 2);
  rooms.stop();
});

test('after Play again an autoStart room waits in the lobby like any other', () => {
  const { game, calls } = arena();
  const { rooms, join } = setup({ arena: game });
  const a = join(); a.say({ t: 'create', game: 'arena', name: 'Ann' });
  const code = a.last('joined').code;
  a.say({ t: 'action', action: { type: 'end' } });
  a.say({ t: 'lobby' });
  assert.equal(a.last('sync').game, null);
  // Joining the lobby is ordinary joining: no join() call.
  const b = join(); b.say({ t: 'join', code, name: 'Bo' });
  assert.equal(b.last('sync').game, null);
  assert.equal(calls.join.length, 0);
  // And Start works as it always has.
  a.say({ t: 'start' });
  assert.equal(b.last('sync').game.seats.length, 2);
  assert.equal(calls.create.length, 2);
  rooms.stop();
});
