// Hidden Number client — everything except the game screen comes from the kit.
import { connect, renderHome, renderLobby, bindShell, esc, clock, toast, fx } from '/rtg/rtg.js';

const app = document.getElementById('app');
const SCHEMA = (room) => [
  { key: 'rounds', label: 'Rounds', options: [{ value: 'rotation', label: `Everyone picks once (${room.players.length})` }, ...[1, 3, 5].map((n) => ({ value: n, label: `${n} rounds` }))] },
  { key: 'guessSeconds', label: 'Guess timer', options: [15, 30, 60].map((n) => ({ value: n, label: `${n} seconds` })) },
];

const conn = connect({
  gameId: 'hidden-number',
  onSync: (msg) => { celebrate(prev, msg); prev = msg; render(); },
  onError: toast,
  onLeft: render,
});
let prev = null;
bindShell(app, conn);

function name(id) { return conn.sync.room.players.find((p) => p.id === id)?.name ?? '?'; }

function render() {
  const s = conn.sync;
  if (!s) app.innerHTML = renderHome({ title: 'Hidden Number', tagline: 'Read your friends, one digit at a time.' }, conn);
  else if (!s.game) app.innerHTML = renderLobby(s, { schema: SCHEMA, minPlayers: 2, title: 'Hidden Number' });
  else app.innerHTML = renderGame(s);
}

function numberGrid(action, chosen) {
  return `<div class="hn-grid">${Array.from({ length: 10 }, (_, i) => i + 1)
    .map((n) => `<button class="rtg-btn ${chosen === n ? 'chosen' : ''}" data-hn="${action}" data-n="${n}">${n}</button>`).join('')}</div>`;
}

function renderGame(s) {
  const g = s.game;
  const scores = `<section class="rtg-panel hn-scores"><h2>Scores</h2><ol>${Object.entries(g.scores)
    .sort((a, b) => b[1] - a[1]).map(([id, v]) => `<li><span class="rtg-swatch" style="--c:${s.room.players.find((p) => p.id === id)?.color}"></span>${esc(name(id))}<b>${v}</b></li>`).join('')}</ol></section>`;
  if (g.over) {
    return `<main class="hn"><h1 style="color:var(--rtg-title)">Final scores</h1>${scores}
      ${s.room.hostId === s.you ? '<button class="rtg-btn primary" data-rtg="lobby">Play again</button>' : ''}</main>`;
  }
  const me = s.you;
  const picker = g.picker === me;
  let body;
  if (g.phase === 'pick') {
    body = picker ? `<h2>Pick a secret number</h2>${numberGrid('pick')}` : `<p>Waiting for ${esc(name(g.picker))} to pick…</p>`;
  } else if (g.phase === 'guess') {
    body = picker
      ? `<h2>Your number: ${g.secret}</h2><p class="rtg-muted">${g.guessed.length} guessed so far</p>`
      : `<h2>Guess ${esc(name(g.picker))}’s number</h2>${numberGrid('guess', g.myGuess)}`;
  } else {
    body = `<h2>It was ${g.secret}!</h2><ul>${Object.entries(g.guesses).map(([id, n]) => `<li>${esc(name(id))}: ${n}${n === g.secret ? ' 🎯' : ''}</li>`).join('')}</ul>
      ${s.room.hostId === me ? '<button class="rtg-btn primary" data-hn="next">Next round</button>' : ''}`;
  }
  return `<main class="hn">
    <div class="hn-bar"><span>Round ${g.round}/${g.totalRounds}</span>
      <span class="hn-timer" data-deadline="${g.deadline ?? ''}">${g.phase === 'guess' ? clock(g.deadline - conn.now()) : ''}</span>
      <button class="rtg-btn ghost small" data-rtg="leave">Leave</button></div>
    <section class="rtg-panel">${body}</section>${scores}</main>`;
}

// Countdown ticks between syncs, using the server clock.
setInterval(() => {
  const el = app.querySelector('.hn-timer[data-deadline]');
  if (el?.dataset.deadline) el.textContent = clock(Number(el.dataset.deadline) - conn.now());
}, 250);

function celebrate(before, after) {
  const g = after?.game;
  if (g?.phase === 'results' && before?.game?.phase === 'guess' && g.guesses?.[after.you] === g.secret) {
    setTimeout(() => fx.confetti(), 50);
  }
}

app.addEventListener('click', (e) => {
  const el = e.target.closest('[data-hn]');
  if (!el) return;
  const type = el.dataset.hn;
  conn.act(type === 'next' ? { type } : { type, number: Number(el.dataset.n) });
});

render();
