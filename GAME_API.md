# Building a game on remote-team-game-tools-api

This package is everything a remote-team party game needs **except the
game**: Jackbox-style rooms, joining and rejoining, host handoff, player
colors, a server clock, per-player hidden information, build sync after
deploys, the home/lobby screens, prize wheels, and an animation kit.

You write two things: a **game module** (server rules) and a **game
screen** (client UI). The smallest complete example is
[`examples/hidden-number`](examples/hidden-number) — copy it to start.

## 1. Server: `createGameServer`

```js
// server.js
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGameServer } from 'remote-team-game-tools-api';
import * as myGame from './game.js';

const here = path.dirname(fileURLToPath(import.meta.url));
createGameServer({ games: { 'my-game': myGame }, clientDir: path.join(here, 'client') });
```

It serves `clientDir` at `/`, the client kit at `/rtg/`, the room protocol
at `/ws`, and `GET /health` (`{ ok, build, rooms }`). It listens on
`$PORT` (default 3000). Every `.html` file has `__BUILD__` replaced with
the running build ID.

## 2. The game module contract

The server is authoritative: all rules, randomness, timers, and secrets
live here. Clients only render what `view()` gives them.

```js
export const title = 'My Game';          // shown in the lobby
export const minPlayers = 2;             // host can't start with fewer
export const maxPlayers = 30;            // joins refused beyond this
export const defaultSettings = { rounds: 'rotation' };

// Clean up whatever the host picked (never trust the client).
export function normalizeSettings(settings) { return settings; }

// Host pressed Start. Return your state object. Set state.over = true
// when the game ends (that unlocks the host's "Play again").
export function create(settings, ctx) { return { over: false }; }

// A player sent conn.act(action). Mutate state. Return an error string
// to reject (shown to that player as a toast), or nothing to accept.
// Every accepted action triggers a sync to everyone.
export function handle(state, playerId, action, ctx) {}

// Optional. Called ~4×/second. Use for timers and deadlines. Return
// true when you changed state so everyone gets a sync.
export function tick(state, ctx) { return false; }

// What `playerId` is allowed to see. Called per player on every sync —
// this is where hidden information stays hidden.
export function view(state, playerId, ctx) { return {}; }
```

`ctx` is `{ now, hostId, players: [{ id, name, color, connected }], isConnected(id) }`;
in `handle` it also has `isHost` (the acting player is the host).

**Rules of thumb**

- Use `ctx.now` for all timestamps (deadlines, animation start times),
  and send them in `view()`. Clients convert with `conn.now()`, so every
  screen stays in sync.
- Random picks (dice, wheels, decks) happen on the server:
  `crypto.randomInt(n)`. A wheel spin is `{ index, spunAt: ctx.now }`.
- Players can disconnect any time. Check `ctx.isConnected(id)` before
  waiting on someone, and let the host act for or skip a missing player.
- The room locks once the game starts; disconnected players rejoin
  their seat with their saved token.

## 3. Client: the kit at `/rtg/`

```html
<meta name="build" content="__BUILD__">   <!-- required for build sync -->
<link rel="stylesheet" href="/rtg/rtg.css">
<script type="module" src="app.js"></script>
```

```js
import { connect, renderHome, renderLobby, bindShell, renderWheel, startWheels,
         esc, clock, toast, store, fx } from '/rtg/rtg.js';

const app = document.getElementById('app');
const conn = connect({ gameId: 'my-game', onSync: render, onError: toast, onLeft: render });
bindShell(app, conn);   // wires create/join/rejoin/copy/start/leave/lobby + settings

function render() {
  const s = conn.sync;
  if (!s) app.innerHTML = renderHome({ title: 'My Game', tagline: '…', logo: 'logo.svg' }, conn);
  else if (!s.game) app.innerHTML = renderLobby(s, { schema: SETTINGS, minPlayers: 2 });
  else app.innerHTML = renderMyGame(s);   // yours
}
```

| Piece | What it does |
|---|---|
| `connect({ gameId, onSync, onError, onStatus, onLeft })` | One WebSocket; reconnects with backoff; rejoins your seat after a reconnect or a reload onto `?room=CODE`; `conn.now()` is server time; `conn.act(action)` sends to your `handle()`. |
| Build sync | The server says its build on connect. If the page is older it reloads once; a badge bottom-right shows `✓ <hash>` or a red "old version · tap to reload". |
| `renderHome` / `renderLobby` / `bindShell` | Name + room code + create/join/rejoin; lobby with players, invite link, host-only settings (`schema`: `[{ key, label, options: [{ value, label }] }]` or a function of the room), Start. |
| `renderWheel(segments, spin, spinMs, t)` + `startWheels(root, conn.now, { onLand })` | Server-clock prize wheel with a ticking pointer. |
| `fx` | `fx.play(selector, keyframes, opts)` (re-render-safe Web Animations), `fx.fly(fromRect, toRect)`, `fx.burstAt(el)`, `fx.confetti()`, `fx.countUp(selector, from, to)`. |
| `esc`, `clock(ms)`, `toast(text)`, `store` | HTML escaping, `m:ss`, a toast, safe localStorage. |

`sync` looks like:

```js
{ t: 'sync', serverNow, you, room: { code, gameId, game, hostId, settings, started, players }, game: view(...) | null }
```

Theme by overriding `--rtg-*` variables (see `client/rtg.css`) or any
`.rtg-*` class.

## 4. Deploy

One Railway service per game, following a branch:

- `npm start` → your `server.js`; health check `/health`.
- Railway sets `RAILWAY_GIT_COMMIT_SHA`, which becomes the build ID the
  badge shows.
- Suggested flow: work on `dev` (its own Railway service), promote by
  fast-forwarding `release`. Bump `package.json` `version` before
  promoting; `.github/workflows/tag-release.yml` then tags `v<version>`
  and publishes a GitHub Release.
- Rooms live in memory: a deploy ends games in progress (pages reload
  onto the new build automatically).

## 5. Installing

```sh
npm install github:snovis/remote-team-game-tools-api#v0.1.0
```

Pin a tag or commit so an engine change never surprises a live game.
