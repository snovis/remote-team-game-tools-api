// Client side of the room protocol: one WebSocket, automatic reconnect and
// rejoin, a server-synced clock, and the build check (badge + reload after
// a deploy). Games build their UI on top of the `sync` snapshots this emits.
import { store } from './util.js';

// The page's own build, stamped into <meta name="build" content="__BUILD__">
// by the server that served it.
const PAGE_BUILD = document.querySelector('meta[name="build"]')?.content || 'unknown';
const shortBuild = (id) => (/^[0-9a-f]{7,}$/.test(id) ? id.slice(0, 7) : id.startsWith('local') ? 'local' : id);

/**
 * @param {object} opts
 * @param {string} opts.gameId        the game module's key on the server
 * @param {(msg) => void} opts.onSync called with every sync snapshot
 * @param {(message: string) => void} [opts.onError]
 * @param {(online: boolean) => void} [opts.onStatus]
 * @param {() => void} [opts.onLeft]  called after leaving or when a saved room is gone
 * @param {boolean} [opts.badge=true] show the build badge (bottom-right)
 */
export function connect({ gameId, onSync, onError = () => {}, onStatus = () => {}, onLeft = () => {}, badge = true }) {
  const SESSION_KEY = `rtg.${gameId}.session`;
  const urlRoom = new URLSearchParams(location.search).get('room')?.toUpperCase() || '';
  let ws = null;
  let retry = 0;
  let offset = 0;
  let sync = null;
  let online = false;

  const conn = {
    /** Room code from the page URL (?room=ABCD), if any. */
    urlRoom,
    get sync() { return sync; },
    get online() { return online; },
    /** Server time in ms. Use for every countdown and animation. */
    now: () => Date.now() + offset,
    session: () => store.get(SESSION_KEY),
    send,
    act: (action) => send({ t: 'action', action }),
    create: (name) => send({ t: 'create', game: gameId, name }),
    join: (code, name) => send({ t: 'join', code, name }),
    rejoin() {
      const s = store.get(SESSION_KEY);
      if (s) send({ t: 'rejoin', code: s.code, token: s.token });
    },
    setSettings: (settings) => send({ t: 'settings', settings }),
    start: () => send({ t: 'start' }),
    toLobby: () => send({ t: 'lobby' }),
    leave({ forget = true } = {}) {
      send({ t: 'leave' });
      if (forget) store.del(SESSION_KEY);
      sync = null;
      history.replaceState(null, '', location.pathname);
      onLeft();
    },
  };

  function send(msg) {
    if (ws?.readyState === 1) ws.send(JSON.stringify(msg));
    else onError('Reconnecting…');
  }

  function open() {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws.onopen = () => {
      online = true;
      retry = 0;
      onStatus(true);
      const s = store.get(SESSION_KEY);
      // Back into our room after a reconnect, or after a reload onto its URL.
      if (s && (sync || s.code === urlRoom)) send({ t: 'rejoin', code: s.code, token: s.token });
    };
    ws.onmessage = (e) => handle(JSON.parse(e.data));
    ws.onclose = () => {
      online = false;
      onStatus(false);
      setTimeout(open, Math.min(1000 * 2 ** retry++, 8000));
    };
  }

  function handle(msg) {
    switch (msg.t) {
      case 'hello':
        if (badge) showBuild(msg.build);
        if (msg.build !== PAGE_BUILD) {
          // A deploy happened while this page was open: reload once per new
          // build. If that somehow doesn't help, the red badge stays up.
          let tried = null;
          try { tried = sessionStorage.getItem('rtg.reloadedFor'); } catch { /* ignore */ }
          if (tried !== msg.build) {
            try { sessionStorage.setItem('rtg.reloadedFor', msg.build); } catch { /* ignore */ }
            location.reload();
          }
        }
        return;
      case 'joined':
        store.set(SESSION_KEY, { code: msg.code, token: msg.token });
        history.replaceState(null, '', `?room=${msg.code}`);
        return;
      case 'rejoinFailed':
        store.del(SESSION_KEY);
        if (sync) {
          sync = null;
          onError('That game has ended.');
          onLeft();
        }
        return;
      case 'sync':
        offset = msg.serverNow - Date.now();
        sync = msg;
        onSync(msg);
        return;
      case 'error':
        onError(msg.message);
        return;
    }
  }

  open();
  return conn;
}

// Version badge (bottom-right): green hash when this page matches the
// server, red "old version" when it doesn't.
function showBuild(serverBuild) {
  let el = document.getElementById('rtg-build');
  if (!el) {
    el = document.createElement('button');
    el.id = 'rtg-build';
    el.addEventListener('click', () => { if (el.classList.contains('stale')) location.reload(); });
    document.body.appendChild(el);
  }
  const stale = serverBuild && serverBuild !== PAGE_BUILD;
  el.classList.toggle('stale', !!stale);
  el.textContent = stale ? `⚠ old version ${shortBuild(PAGE_BUILD)} · tap to reload` : `✓ ${shortBuild(PAGE_BUILD)}`;
  el.title = stale ? `This page is ${PAGE_BUILD}; the server is ${serverBuild}.` : `Page and server both on ${PAGE_BUILD}`;
}
