// Small helpers every game client needs.

// localStorage that never throws (private mode, blocked storage, previews).
export const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

// Escape text for innerHTML templates.
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// m:ss for countdowns.
export function clock(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

let toastTimer;
// A short message at the bottom of the screen.
export function toast(text, ms = 3200) {
  let el = document.getElementById('rtg-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'rtg-toast';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

// Yes/no questions in the page itself: the browser's confirm box looks like
// something broke. ask({ title, text, yes, no }) resolves true or false. A
// game can draw its own card with setAsk(fn), where fn takes the same
// options and returns a promise of true/false (setAsk(null) puts the kit's
// card back). The kit's card: yes on its button or Enter; no on the other
// button, Escape, or a click outside it. Nothing takes focus, so a game's
// keys keep working while it's up.
let asker = null;
export function setAsk(fn) {
  asker = typeof fn === 'function' ? fn : null;
}
export function ask(opts) {
  return asker ? asker(opts) : askCard(opts);
}
export function askCard({ title, text = '', yes = 'OK', no = 'Cancel' }) {
  document.getElementById('rtg-ask')?.remove();
  const el = document.createElement('div');
  el.id = 'rtg-ask';
  el.innerHTML = `<div class="rtg-panel rtg-ask-card" role="dialog" aria-modal="true" aria-labelledby="rtg-ask-title">
    <h2 id="rtg-ask-title">${esc(title)}</h2>${text ? `<p>${esc(text)}</p>` : ''}
    <div class="rtg-ask-row"><button class="rtg-btn" data-ask="0">${esc(no)}</button><button class="rtg-btn primary" data-ask="1">${esc(yes)}</button></div></div>`;
  document.body.appendChild(el);
  return new Promise((resolve) => {
    const done = (answer) => {
      el.remove();
      window.removeEventListener('keydown', onKey, true);
      resolve(answer);
    };
    const onKey = (e) => {
      if (e.key !== 'Escape' && e.key !== 'Enter') return;
      e.preventDefault();
      e.stopPropagation();
      done(e.key === 'Enter');
    };
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-ask]');
      if (b) done(b.dataset.ask === '1');
      else if (e.target === el) done(false);
    });
    window.addEventListener('keydown', onKey, true);
  });
}
