// Home screen (name, room code, create/join/rejoin) and lobby (players,
// who's host, host-only settings, start) — the Jackbox-style front door
// every game shares. Games describe their settings with a small schema;
// this renders and wires it. Players see the host role by its title
// (room.hostTitle, "Game Master" unless the game names it).
import { esc, store, toast } from './util.js';

const NAME_KEY = 'rtg.name';

/**
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} [opts.tagline]
 * @param {string} [opts.logo]     image URL
 * @param {string} [opts.howTo]    HTML for a "How it plays" box
 * @param {object} conn            from connect()
 */
export function renderHome({ title, tagline = '', logo = '', howTo = '' }, conn) {
  const session = conn.session();
  return `
  <main class="rtg-home">
    <header class="rtg-hero">
      ${logo ? `<img class="rtg-logo" src="${esc(logo)}" alt="" width="140" height="140">` : ''}
      <h1>${esc(title)}</h1>
      ${tagline ? `<p class="rtg-tag">${esc(tagline)}</p>` : ''}
    </header>
    <section class="rtg-panel rtg-join">
      <label class="rtg-field"><span>Your name</span>
        <input id="rtg-name" maxlength="24" autocomplete="nickname" placeholder="e.g. Sam" value="${esc(store.get(NAME_KEY) || '')}">
      </label>
      <div class="rtg-join-row">
        <input id="rtg-code" class="rtg-code" maxlength="4" placeholder="CODE" value="${esc(conn.urlRoom)}" aria-label="Room code">
        <button class="rtg-btn primary" data-rtg="join">Join room</button>
      </div>
      <div class="rtg-or"><span>or</span></div>
      <button class="rtg-btn" data-rtg="create">Create a new room</button>
      ${session ? `<button class="rtg-btn ghost" data-rtg="rejoin">↩ Rejoin room ${esc(session.code)}</button>` : ''}
    </section>
    ${howTo ? `<section class="rtg-how">${howTo}</section>` : ''}
  </main>`;
}

/**
 * Settings schema: an array (or a function of the room returning one) of
 *   { key, label, options: [{ value, label }] }
 */
export function renderLobby(sync, { schema = [], minPlayers = 2, title = '' } = {}) {
  const { room, you } = sync;
  const host = room.hostId === you;
  const gm = room.hostTitle || 'Game Master';
  const fields = typeof schema === 'function' ? schema(room) : schema;
  const link = `${location.origin}${location.pathname}?room=${room.code}`;
  const players = room.players.map((p) => `
    <li class="${p.connected ? '' : 'away'}"><span class="rtg-swatch" style="--c:${p.color}"></span><span>${esc(p.name)}</span>
      ${p.id === room.hostId ? `<em class="rtg-host-tag">★ ${esc(gm)}${room.hostAway ? ' · reconnecting…' : ''}</em>` : ''}${p.id === you ? '<em>you</em>' : ''}</li>`).join('');
  // The host can hand the role on; the room's creator can take it back.
  const others = room.players.filter((p) => p.connected && p.id !== you);
  const role = host
    ? (others.length ? `<label class="rtg-field rtg-role"><span>Make someone else ${esc(gm)}</span>
        <select data-rtg-hand><option value="">Choose a player…</option>${others.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select></label>` : '')
    : room.ownerId === you
      ? `<div class="rtg-role rtg-take"><span class="rtg-muted">You made this room, so you can be ${esc(gm)} again any time.</span>
          <button class="rtg-btn small" data-rtg="takeHost">Take back</button></div>`
      : '';
  const settings = fields.map((f) => `
    <label class="rtg-field"><span>${esc(f.label)}</span>
      <select data-rtg-setting="${esc(f.key)}" ${host ? '' : 'disabled'}>
        ${f.options.map((o) => `<option value="${esc(o.value)}" ${String(o.value) === String(room.settings[f.key]) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
      </select></label>`).join('');
  const ready = room.players.filter((p) => p.connected).length >= minPlayers;
  const hostName = room.players.find((p) => p.id === room.hostId)?.name;
  const waiting = !hostName ? `Waiting for a ${gm}…`
    : room.hostAway ? `${gm} ${hostName} is reconnecting…`
      : `Waiting for ${gm} ${hostName} to start the game…`;
  return `
  <main class="rtg-lobby">
    <header class="rtg-lobby-head">
      ${title ? `<p class="rtg-muted">${esc(title)}</p>` : ''}
      <p class="rtg-muted">Room code</p>
      <div class="rtg-big-code">${esc(room.code)}</div>
      <button class="rtg-btn small" data-rtg="copy" data-link="${esc(link)}">Copy invite link</button>
    </header>
    <section class="rtg-panel">
      <h2>Players <span class="rtg-muted">${room.players.length}</span></h2>
      <ul class="rtg-players">${players}</ul>
      ${role}
    </section>
    ${fields.length || host ? `<section class="rtg-panel">
      ${fields.length ? `<h2>Game settings${host ? '' : ` <span class="rtg-note">${esc(gm)} picks</span>`}</h2><div class="rtg-settings">${settings}</div>` : ''}
      ${host
        ? `<button class="rtg-btn primary wide" data-rtg="start" ${ready ? '' : 'disabled'}>Start game</button>
           <p class="rtg-muted rtg-center">${ready ? 'The room locks once the game starts.' : `Waiting for ${minPlayers} players…`}</p>`
        : `<p class="rtg-muted rtg-center">${esc(waiting)}</p>`}
    </section>` : ''}
    <button class="rtg-btn ghost small rtg-leave" data-rtg="leave">Leave room</button>
  </main>`;
}

/**
 * Wires every data-rtg button, the settings selects, and the name/code
 * inputs inside `root` (event delegation — safe across re-renders).
 */
export function bindShell(root, conn) {
  const nameVal = () => {
    const name = root.querySelector('#rtg-name')?.value.trim();
    if (!name) { toast('Please enter your name.'); return null; }
    store.set(NAME_KEY, name);
    return name;
  };
  root.addEventListener('click', (e) => {
    const el = e.target.closest('[data-rtg]');
    if (!el || el.disabled) return;
    switch (el.dataset.rtg) {
      case 'create': { const n = nameVal(); if (n) conn.create(n); return; }
      case 'join': {
        const code = root.querySelector('#rtg-code')?.value.trim().toUpperCase();
        if (!code) return toast('Enter the 4-letter room code.');
        const n = nameVal();
        if (n) conn.join(code, n);
        return;
      }
      case 'rejoin': return conn.rejoin();
      case 'copy':
        navigator.clipboard?.writeText(el.dataset.link).then(() => toast('Invite link copied'), () => toast(el.dataset.link));
        return;
      case 'start': return conn.start();
      case 'lobby': return conn.toLobby();
      case 'takeHost': return conn.takeHost();
      case 'handHost': return handOver(conn, el.dataset.player); // a button with data-player="<id>"
      case 'leave': {
        const g = conn.sync?.game;
        if (g && !g.over && !confirm('Leave the game? You can rejoin from the home screen.')) return;
        return conn.leave({ forget: !g || !!g.over });
      }
    }
  });
  root.addEventListener('change', (e) => {
    const key = e.target.dataset?.rtgSetting;
    if (key) conn.setSettings({ [key]: e.target.value });
    if (e.target.matches?.('[data-rtg-hand]')) {
      const id = e.target.value;
      e.target.value = '';
      if (id) handOver(conn, id);
    }
  });
  root.addEventListener('input', (e) => {
    if (e.target.id === 'rtg-name') store.set(NAME_KEY, e.target.value);
    if (e.target.id === 'rtg-code') e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, '');
  });
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !['rtg-name', 'rtg-code'].includes(e.target.id)) return;
    const code = root.querySelector('#rtg-code')?.value.trim();
    root.querySelector(`[data-rtg="${code ? 'join' : 'create'}"]`)?.click();
  });
}

// Handing the role on gives away the controls (only the room's creator
// can take it back), so ask first.
function handOver(conn, id) {
  const room = conn.sync?.room;
  const p = room?.players.find((q) => q.id === id);
  if (p && confirm(`Make ${p.name} the ${room.hostTitle || 'Game Master'}?`)) conn.handHost(id);
}
