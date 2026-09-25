// Prize wheels driven by the server clock: every screen (and anyone who
// reconnects mid-spin) sees the same spin land on the same segment.
//
// Server side, a spin is just { index, spunAt } — pick the index with a
// server-side random, stamp spunAt with the server's Date.now().
import { esc } from './util.js';

const easeOutQuart = (k) => 1 - (1 - k) ** 4;
const IDLE_DEG_PER_MS = 1 / 60;

/** Current angle of a wheel with n segments. */
export function wheelAngle(n, spin, spinMs, t) {
  const seg = 360 / n;
  if (!spin) return (t * IDLE_DEG_PER_MS) % 360;
  const start = (spin.spunAt * IDLE_DEG_PER_MS) % 360;
  const landing = (360 - (spin.index * seg + seg / 2)) % 360;
  const total = 360 * 5 + ((landing - start + 720) % 360);
  const k = Math.min(1, (t - spin.spunAt) / spinMs);
  return start + total * easeOutQuart(k);
}

/**
 * Wheel markup. segments: [{ label: string | string[], fill: '#hex' }]
 * spin: { index, spunAt } | null. t: server time (conn.now()).
 */
export function renderWheel(segments, spin, spinMs, t) {
  const n = segments.length;
  const seg = 360 / n;
  const slices = segments.map((w, i) => {
    const words = Array.isArray(w.label) ? w.label : String(w.label).split(' ');
    const a0 = (i * seg * Math.PI) / 180;
    const a1 = ((i + 1) * seg * Math.PI) / 180;
    const p = (a) => `${100 + 96 * Math.sin(a)},${100 - 96 * Math.cos(a)}`;
    const mid = i * seg + seg / 2;
    const long = Math.max(...words.map((x) => x.length));
    const size = n > 10 ? 6.5 : long > 9 ? 7.2 : 9;
    return `<path d="M100,100 L${p(a0)} A96,96 0 0,1 ${p(a1)} Z" style="fill:${w.fill}"/>
      <text transform="rotate(${mid} 100 100)" x="100" y="${words.length > 1 ? 30 : 34}" class="rtg-w-label" style="font-size:${size}px">
        ${words.map((word, k) => `<tspan x="100" dy="${k ? size + 2 : 0}">${esc(word)}</tspan>`).join('')}</text>`;
  }).join('');
  const pegs = segments.map((_, i) => {
    const a = (i * seg * Math.PI) / 180;
    return `<circle cx="${100 + 92 * Math.sin(a)}" cy="${100 - 92 * Math.cos(a)}" r="2.6" class="rtg-peg"/>`;
  }).join('');
  return `<div class="rtg-wheel-wrap">
    <div class="rtg-pointer">▼</div>
    <svg viewBox="0 0 200 200" class="rtg-wheel" data-n="${n}" data-ms="${spinMs}"
      ${spin ? `data-index="${spin.index}" data-spun="${spin.spunAt}"` : ''} style="transform:rotate(${wheelAngle(n, spin, spinMs, t)}deg)">
      <circle cx="100" cy="100" r="99" class="rtg-rim"/>${slices}${pegs}<circle cx="100" cy="100" r="13" class="rtg-hub"/></svg>
  </div>`;
}

/**
 * Animates whatever .rtg-wheel is in `root` each frame. onLand(index) fires
 * once per spin when it stops (not for spins that landed long ago).
 */
export function startWheels(root, now, { onLand = () => {} } = {}) {
  let lastSeg = -1;
  let landed = null;
  const frame = () => {
    requestAnimationFrame(frame);
    const el = root.querySelector('.rtg-wheel');
    if (!el) return;
    const t = now();
    const n = Number(el.dataset.n);
    const ms = Number(el.dataset.ms);
    const spin = el.dataset.spun ? { index: Number(el.dataset.index), spunAt: Number(el.dataset.spun) } : null;
    const angle = wheelAngle(n, spin, ms, t);
    el.style.transform = `rotate(${angle}deg)`;
    const under = Math.floor((((360 - (angle % 360)) % 360) / (360 / n))) % n;
    if (under !== lastSeg) {
      lastSeg = under;
      if (spin && t - spin.spunAt < ms) {
        root.querySelector('.rtg-pointer')?.animate(
          [{ transform: 'translateX(-50%) rotate(0)' }, { transform: 'translateX(-50%) rotate(-28deg)' }, { transform: 'translateX(-50%) rotate(0)' }],
          { duration: 140 },
        );
      }
    }
    if (spin && landed !== spin.spunAt && t - spin.spunAt >= ms) {
      landed = spin.spunAt;
      if (t - spin.spunAt <= ms + 2000) onLand(spin.index);
    }
  };
  requestAnimationFrame(frame);
}
