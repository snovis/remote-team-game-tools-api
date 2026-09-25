// JS animation layer: Web Animations API effects that survive re-renders,
// flying token "ghosts", and a canvas particle system for confetti/bursts.

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- re-render-proof element animations ----------
// Each effect is keyed to a selector and a start time. After every render we
// re-attach it to the fresh DOM and fast-forward to where it should be.
let effects = [];

export function play(selector, keyframes, { duration = 500, delay = 0, stagger = 0, easing = 'ease-out' } = {}) {
  if (reduced) return;
  const fx = { selector, keyframes, duration, delay, stagger, easing, start: performance.now() };
  effects.push(fx);
  attach(fx);
}

function attach(fx) {
  const els = document.querySelectorAll(fx.selector);
  els.forEach((el, i) => {
    const anim = el.animate(fx.keyframes, {
      duration: fx.duration, delay: fx.delay + fx.stagger * i, easing: fx.easing, fill: 'backwards',
    });
    anim.currentTime = performance.now() - fx.start;
  });
}

export function afterRender() {
  const t = performance.now();
  effects = effects.filter((fx) => t - fx.start < fx.delay + fx.duration + fx.stagger * 40);
  effects.forEach(attach);
}

// ---------- flying token ghosts ----------
// Ghosts live on <body>, outside the re-rendered app, so a sync mid-flight
// never cuts them off.
export function fly(fromRect, toRect, { color, label, duration = 380 } = {}) {
  if (reduced || !fromRect || !toRect) return Promise.resolve();
  const size = toRect.width;
  const ghost = document.createElement('span');
  ghost.className = 'disc ghost';
  ghost.style.cssText = `--c:${color};position:fixed;left:${toRect.left}px;top:${toRect.top}px;width:${size}px;height:${size}px;margin:0;z-index:60;pointer-events:none;`;
  ghost.textContent = label;
  document.body.appendChild(ghost);
  const dx = fromRect.left + fromRect.width / 2 - (toRect.left + size / 2);
  const dy = fromRect.top + fromRect.height / 2 - (toRect.top + size / 2);
  const s0 = fromRect.width / size;
  const lift = Math.min(-40, -Math.abs(dy) * 0.25);
  const anim = ghost.animate([
    { transform: `translate(${dx}px, ${dy}px) scale(${s0})` },
    { transform: `translate(${dx * 0.5}px, ${dy * 0.5 + lift}px) scale(${s0 * 1.25}) rotate(-12deg)`, offset: 0.5 },
    { transform: 'translate(0, 0) scale(1.15)', offset: 0.85 },
    { transform: 'translate(0, 0) scale(1)' },
  ], { duration, easing: 'cubic-bezier(.3,.7,.4,1)' });
  return anim.finished.then(() => ghost.remove(), () => ghost.remove());
}

// ---------- particles ----------
let canvas, ctx, parts = [], raf = 0;

function ensureCanvas() {
  if (canvas) return;
  canvas = document.createElement('canvas');
  canvas.className = 'fx-canvas';
  document.body.appendChild(canvas);
  ctx = canvas.getContext('2d');
  const size = () => {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = innerWidth * dpr;
    canvas.height = innerHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  size();
  addEventListener('resize', size);
}

const CONFETTI = ['#ff5a5f', '#ffb400', '#00a699', '#7b61ff', '#fc642d', '#3ec1d3', '#e84393', '#6ab04c'];

function spawn(p) {
  parts.push({
    x: p.x, y: p.y, vx: p.vx, vy: p.vy,
    rot: Math.random() * Math.PI * 2, vr: (Math.random() - 0.5) * 0.35,
    w: 6 + Math.random() * 6, h: 4 + Math.random() * 5,
    color: p.color || CONFETTI[(Math.random() * CONFETTI.length) | 0],
    emoji: p.emoji, size: p.size || 22, life: 0, maxLife: p.maxLife || 200,
    gravity: p.gravity ?? 0.22, drag: p.drag ?? 0.985,
  });
  if (!raf) raf = requestAnimationFrame(step);
}

function step() {
  ctx.clearRect(0, 0, innerWidth, innerHeight);
  parts = parts.filter((p) => p.life < p.maxLife && p.y < innerHeight + 60);
  for (const p of parts) {
    p.life++;
    p.vx *= p.drag;
    p.vy = p.vy * p.drag + p.gravity;
    p.x += p.vx;
    p.y += p.vy;
    p.rot += p.vr;
    const fade = Math.min(1, (p.maxLife - p.life) / 30);
    ctx.save();
    ctx.globalAlpha = fade;
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    if (p.emoji) {
      ctx.font = `${p.size}px system-ui, "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(p.emoji, 0, 0);
    } else {
      ctx.fillStyle = p.color;
      ctx.scale(1, Math.cos(p.life * 0.15)); // paper flutter
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
    }
    ctx.restore();
  }
  raf = parts.length ? requestAnimationFrame(step) : 0;
  if (!raf) ctx.clearRect(0, 0, innerWidth, innerHeight);
}

// A radial pop from a point — for reveals and landings.
export function burst(x, y, { count = 28, power = 7, emoji = null, colors = null, size = 20 } = {}) {
  if (reduced) return;
  ensureCanvas();
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2;
    const v = power * (0.4 + Math.random() * 0.8);
    spawn({
      x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - power * 0.35,
      emoji: Array.isArray(emoji) ? emoji[i % emoji.length] : emoji,
      color: colors ? colors[i % colors.length] : null, size, maxLife: 90, gravity: 0.18,
    });
  }
}

export function burstAt(el, opts) {
  if (!el) return;
  const r = el.getBoundingClientRect();
  burst(r.left + r.width / 2, r.top + r.height / 2, opts);
}

// Full-screen celebration raining from the top edge.
export function confetti({ count = 160, duration = 1400 } = {}) {
  if (reduced) return;
  ensureCanvas();
  const t0 = performance.now();
  const drip = () => {
    const n = Math.ceil(count / (duration / 16));
    for (let i = 0; i < n; i++) {
      spawn({ x: Math.random() * innerWidth, y: -20, vx: (Math.random() - 0.5) * 4, vy: 2 + Math.random() * 4, maxLife: 400, gravity: 0.08, drag: 0.995 });
    }
    if (performance.now() - t0 < duration) requestAnimationFrame(drip);
  };
  drip();
  // Side cannons.
  for (let i = 0; i < 40; i++) {
    spawn({ x: 0, y: innerHeight * 0.7, vx: 6 + Math.random() * 9, vy: -(8 + Math.random() * 9), maxLife: 260 });
    spawn({ x: innerWidth, y: innerHeight * 0.7, vx: -(6 + Math.random() * 9), vy: -(8 + Math.random() * 9), maxLife: 260 });
  }
}

// Counts a number element up from `from` to its final value.
// Takes a selector so it keeps working if the element is re-rendered mid-count.
export function countUp(selector, from, to, duration = 900) {
  if (reduced || from === to) return;
  const t0 = performance.now();
  const tick = (t) => {
    const k = Math.min(1, (t - t0) / duration);
    const eased = 1 - (1 - k) ** 3;
    const el = document.querySelector(selector);
    if (el) el.textContent = Math.round(from + (to - from) * eased);
    if (k < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

export { reduced };
