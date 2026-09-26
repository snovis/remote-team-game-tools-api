// Game-agnostic room layer: Jackbox-style room codes, joining, rejoining,
// the host role (grace period, hand-off, take-back), player colors, a server
// tick, and per-player sync snapshots.
// A game plugs in as a module (see GAME_API.md); this file knows nothing
// about any particular game.
import crypto from 'node:crypto';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O: easy to read aloud
const DEFAULT_MAX_PLAYERS = 30;
const TICK_MS = 250;
const EMPTY_ROOM_TTL_MS = 30 * 60 * 1000;
const HEARTBEAT_MS = 25 * 1000;

// A host whose connection drops keeps the role this long before it moves
// on, so a network blip doesn't hand the controls to someone else. The
// client backs off 1, 2, 4, then 8 s, so it retries 1, 3, 7 and 15 s after
// a drop: four tries fit inside the grace period.
export const HOST_GRACE_MS = 20 * 1000;

// What players call the host unless the game module names it (hostTitle).
export const DEFAULT_HOST_TITLE = 'Game Master';

// Which code this server is running. Railway sets RAILWAY_GIT_COMMIT_SHA;
// elsewhere every start gets a fresh "local-…" ID so pages still notice
// restarts.
export const BUILD = process.env.RAILWAY_GIT_COMMIT_SHA || process.env.BUILD_ID || `local-${Date.now()}`;

// 30 distinct player colors, assigned in join order.
export const PALETTE = [
  '#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4',
  '#42d4f4', '#f032e6', '#bfef45', '#fabed4', '#469990',
  '#dcbeff', '#9a6324', '#fffac8', '#800000', '#aaffc3',
  '#808000', '#ffd8b1', '#000075', '#a9a9a9', '#ffe119',
  '#ff6f61', '#6b5b95', '#88b04b', '#f7cac9', '#92a8d1',
  '#955251', '#b565a7', '#009b77', '#dd4124', '#45b8ac',
];

const randomId = () => crypto.randomBytes(9).toString('base64url');

export class RoomManager {
  // games: { [gameId]: gameModule }
  constructor(games, { tickMs = TICK_MS } = {}) {
    this.games = games;
    this.rooms = new Map();
    this.sockets = new Set();
    this.timers = [
      setInterval(() => this.tick(), tickMs),
      setInterval(() => this.heartbeat(), HEARTBEAT_MS),
    ];
    this.timers.forEach((t) => t.unref?.());
  }

  stop() {
    this.timers.forEach(clearInterval);
  }

  newCode() {
    for (;;) {
      let code = '';
      for (let i = 0; i < 4; i++) code += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
      if (!this.rooms.has(code)) return code;
    }
  }

  connect(ws) {
    // Tell the page which build it's talking to, so it can reload after a deploy.
    send(ws, { t: 'hello', build: BUILD });
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    this.sockets.add(ws);
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      try {
        this.onMessage(ws, msg);
      } catch (err) {
        console.error(err);
        send(ws, { t: 'error', message: 'Something went wrong on the server.' });
      }
    });
    ws.on('close', () => {
      this.sockets.delete(ws);
      const { room, playerId } = ws.session || {};
      if (room) room.detach(playerId, ws);
    });
  }

  heartbeat() {
    for (const ws of this.sockets) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* closed */ }
    }
  }

  onMessage(ws, msg) {
    const fail = (message) => send(ws, { t: 'error', message });
    switch (msg.t) {
      case 'create': {
        const game = this.games[msg.game];
        if (!game) return fail('Unknown game.');
        const name = cleanName(msg.name);
        if (!name) return fail('Please enter your name.');
        const room = new Room(this.newCode(), msg.game, game);
        this.rooms.set(room.code, room);
        room.addPlayer(ws, name);
        return;
      }
      case 'join': {
        const room = this.rooms.get(String(msg.code || '').trim().toUpperCase());
        if (!room) return fail('No room with that code.');
        const name = cleanName(msg.name);
        if (!name) return fail('Please enter your name.');
        if (room.state) return fail('That game has already started. Rooms lock once the game begins.');
        if (room.players.length >= (room.game.maxPlayers ?? DEFAULT_MAX_PLAYERS)) return fail('That room is full.');
        room.addPlayer(ws, name);
        return;
      }
      case 'rejoin': {
        const room = this.rooms.get(String(msg.code || '').trim().toUpperCase());
        const player = room?.players.find((p) => p.token === msg.token);
        if (!player) return send(ws, { t: 'rejoinFailed' });
        room.attach(player, ws);
        return;
      }
    }
    const { room, playerId } = ws.session || {};
    if (!room) return fail('You are not in a room.');
    room.onMessage(playerId, msg, fail);
  }

  tick() {
    const now = Date.now();
    for (const [code, room] of this.rooms) {
      if (room.players.every((p) => !p.ws)) {
        room.emptySince ??= now;
        if (now - room.emptySince > EMPTY_ROOM_TTL_MS) this.rooms.delete(code);
        continue;
      }
      room.emptySince = null;
      room.checkHost(now);
      if (room.state && room.game.tick?.(room.state, room.ctx())) room.broadcast();
    }
  }
}

export class Room {
  constructor(code, gameId, game) {
    this.code = code;
    this.gameId = gameId;
    this.game = game;
    this.players = [];
    this.hostId = null;
    this.ownerId = null; // who created the room: can take the host role back
    this.hostAwaySince = null; // when the host's connection dropped
    this.settings = { ...(game.defaultSettings || {}) };
    this.state = null;
    this.emptySince = null;
  }

  addPlayer(ws, name) {
    const used = new Set(this.players.map((p) => p.color));
    const player = {
      id: randomId(),
      token: randomId(),
      name,
      color: PALETTE.find((c) => !used.has(c)) || PALETTE[this.players.length % PALETTE.length],
      ws: null,
    };
    this.players.push(player);
    if (!this.hostId) this.hostId = player.id;
    if (!this.ownerId) this.ownerId = player.id;
    this.attach(player, ws);
  }

  attach(player, ws) {
    if (player.ws && player.ws !== ws) {
      player.ws.session = null;
      try { player.ws.close(); } catch { /* ignore */ }
    }
    player.ws = ws;
    ws.session = { room: this, playerId: player.id };
    send(ws, { t: 'joined', code: this.code, playerId: player.id, token: player.token });
    if (player.id === this.hostId) this.hostAwaySince = null; // back within the grace period
    else if (this.hostOpen(Date.now())) this.setHost(player.id);
    this.broadcast();
  }

  detach(playerId, ws) {
    const player = this.player(playerId);
    if (!player || player.ws !== ws) return;
    player.ws = null;
    // The host keeps the role through a short drop; checkHost() hands it on
    // if they aren't back within the grace period.
    if (this.hostId === playerId) this.hostAwaySince = Date.now();
    this.broadcast();
  }

  player(id) {
    return this.players.find((p) => p.id === id);
  }

  get hostTitle() {
    return String(this.game.hostTitle || DEFAULT_HOST_TITLE);
  }

  setHost(id) {
    this.hostId = id;
    this.hostAwaySince = null;
  }

  // Nobody holds the host role: there's no host, or the host dropped and
  // hasn't come back within the grace period.
  hostOpen(now) {
    const host = this.player(this.hostId);
    if (host?.ws) return false;
    return !host || this.hostAwaySince === null || now - this.hostAwaySince >= HOST_GRACE_MS;
  }

  // Runs on the manager's tick: once the grace period is up, the role goes
  // to the first connected player in join order. With nobody connected it
  // waits, and whoever attaches next takes it.
  checkHost(now) {
    if (this.hostAwaySince === null || !this.hostOpen(now)) return;
    const next = this.players.find((p) => p.ws);
    if (!next) return;
    this.setHost(next.id);
    this.broadcast();
  }

  ctx() {
    return {
      now: Date.now(),
      hostId: this.hostId,
      hostTitle: this.hostTitle,
      players: this.players.map(({ id, name, color, ws }) => ({ id, name, color, connected: !!ws })),
      isConnected: (id) => !!this.player(id)?.ws,
    };
  }

  normalize(settings) {
    return this.game.normalizeSettings ? this.game.normalizeSettings(settings) : settings;
  }

  onMessage(playerId, msg, fail) {
    const isHost = playerId === this.hostId;
    const title = this.hostTitle;
    switch (msg.t) {
      case 'leave': {
        const player = this.player(playerId);
        if (player?.ws) player.ws.session = null;
        if (!this.state) this.players = this.players.filter((p) => p.id !== playerId);
        else if (player) player.ws = null;
        // Leaving on purpose hands the role on right away: no grace period.
        if (this.hostId === playerId) this.setHost(this.players.find((p) => p.ws)?.id ?? null);
        this.broadcast();
        return;
      }
      case 'handHost': {
        if (!isHost) return fail(`Only the ${title} can hand the role to someone else.`);
        const to = this.player(msg.to);
        if (!to || to.id === playerId) return fail('Pick another player.');
        if (!to.ws) return fail(`${to.name} isn't connected right now.`);
        this.setHost(to.id);
        this.broadcast();
        return;
      }
      case 'takeHost':
        // The room's creator can pull the role back whenever they're here.
        if (playerId !== this.ownerId) return fail(`Only the player who made the room can take back the ${title} role.`);
        if (isHost) return;
        this.setHost(playerId);
        this.broadcast();
        return;
      case 'settings':
        if (!isHost || this.state) return fail(`Only the ${title} can change settings before the game starts.`);
        this.settings = this.normalize({ ...this.settings, ...msg.settings });
        this.broadcast();
        return;
      case 'start': {
        if (!isHost || this.state) return fail(`Only the ${title} can start the game.`);
        // Anyone who left the lobby before start is dropped.
        this.players = this.players.filter((p) => p.ws);
        const min = this.game.minPlayers ?? 2;
        if (this.players.length < min) return fail(`You need at least ${min} players.`);
        this.state = this.game.create(this.normalize(this.settings), this.ctx());
        this.broadcast();
        return;
      }
      case 'lobby':
        if (!isHost || !this.state?.over) return fail(`Only the ${title} can return to the lobby after the game.`);
        this.state = null;
        this.broadcast();
        return;
      case 'action': {
        if (!this.state) return fail('The game has not started.');
        const err = this.game.handle(this.state, playerId, msg.action || {}, { ...this.ctx(), isHost });
        if (err) return fail(err);
        this.broadcast();
        return;
      }
      default:
        return fail('Unknown message.');
    }
  }

  // Every player gets their own snapshot: game.view() decides what each
  // player may see, so hidden information never leaves the server.
  broadcast() {
    const ctx = this.ctx();
    const base = {
      t: 'sync',
      serverNow: ctx.now,
      room: {
        code: this.code,
        gameId: this.gameId,
        game: this.game.title,
        hostId: this.hostId,
        hostTitle: ctx.hostTitle,
        // The host dropped and is inside the grace period (or nobody's here
        // to take over). hostAwayUntil is the server time the role moves on.
        hostAway: this.hostAwaySince !== null,
        hostAwayUntil: this.hostAwaySince === null ? null : this.hostAwaySince + HOST_GRACE_MS,
        ownerId: this.ownerId,
        settings: this.settings,
        started: !!this.state,
        players: ctx.players,
      },
    };
    for (const p of this.players) {
      if (!p.ws) continue;
      send(p.ws, { ...base, you: p.id, game: this.state ? this.game.view(this.state, p.id, ctx) : null });
    }
  }
}

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function cleanName(name) {
  return String(name || '').replace(/\s+/g, ' ').trim().slice(0, 24);
}
