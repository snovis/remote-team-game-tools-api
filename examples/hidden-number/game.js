// Hidden Number — the smallest complete game on the kit. Each round one
// player secretly picks 1–10; everyone else guesses before the timer runs
// out. Exact = 3 points, off by one = 1. Shows: rotation, hidden info,
// a server timer via tick(), host-only actions, and game over.
import crypto from 'node:crypto';

export const title = 'Hidden Number';
export const minPlayers = 2;
export const maxPlayers = 30;
export const defaultSettings = { rounds: 'rotation', guessSeconds: 30 };

export function normalizeSettings(s) {
  const n = Number(s.rounds);
  return {
    rounds: s.rounds === 'rotation' || !Number.isFinite(n) ? 'rotation' : Math.min(Math.max(Math.round(n), 1), 20),
    guessSeconds: [15, 30, 60].includes(Number(s.guessSeconds)) ? Number(s.guessSeconds) : 30,
  };
}

export function create(settings, ctx) {
  const order = ctx.players.map((p) => p.id);
  const state = {
    settings,
    order,
    totalRounds: settings.rounds === 'rotation' ? order.length : settings.rounds,
    round: 0,
    scores: Object.fromEntries(order.map((id) => [id, 0])),
    over: false,
    r: null,
  };
  nextRound(state, ctx);
  return state;
}

function nextRound(state, ctx) {
  if (state.round >= state.totalRounds) {
    state.over = true;
    state.r = null;
    return;
  }
  // Rotate the picker through connected players.
  let picker = null;
  for (let k = 0; k < state.order.length && !picker; k++) {
    const id = state.order[(state.round + k) % state.order.length];
    if (ctx.isConnected(id)) picker = id;
  }
  state.round++;
  state.r = { picker, phase: 'pick', secret: null, guesses: {}, deadline: null };
}

export function handle(state, pid, a, ctx) {
  const r = state.r;
  if (state.over || !r) return 'The game is over.';
  switch (a.type) {
    case 'pick': {
      if (pid !== r.picker) return 'Only the picker chooses the number.';
      if (r.phase !== 'pick') return 'Already picked.';
      const n = Number(a.number);
      if (!Number.isInteger(n) || n < 1 || n > 10) return 'Pick 1 to 10.';
      r.secret = n;
      r.phase = 'guess';
      r.deadline = ctx.now + state.settings.guessSeconds * 1000;
      return;
    }
    case 'guess': {
      if (r.phase !== 'guess' || pid === r.picker) return 'You can’t guess right now.';
      const n = Number(a.number);
      if (!Number.isInteger(n) || n < 1 || n > 10) return 'Guess 1 to 10.';
      r.guesses[pid] = n; // changeable until time's up
      return;
    }
    case 'next':
      if (!ctx.isHost) return 'Only the host starts the next round.';
      if (r.phase !== 'results') return 'Finish this round first.';
      nextRound(state, ctx);
      return;
    default:
      return 'Unknown action.';
  }
}

function score(state) {
  const r = state.r;
  for (const [id, g] of Object.entries(r.guesses)) {
    const d = Math.abs(g - r.secret);
    state.scores[id] += d === 0 ? 3 : d === 1 ? 1 : 0;
  }
  r.phase = 'results';
}

// Called ~4×/second. Return true when state changed so everyone gets a sync.
export function tick(state, ctx) {
  const r = state.r;
  if (!r || r.phase !== 'guess') return false;
  const guessers = state.order.filter((id) => id !== r.picker && ctx.isConnected(id));
  if (ctx.now >= r.deadline || guessers.every((id) => id in r.guesses)) {
    score(state);
    return true;
  }
  return false;
}

// Per-player snapshot: the secret and other players' guesses stay on the
// server until the results.
export function view(state, pid) {
  const r = state.r;
  const base = { round: state.round, totalRounds: state.totalRounds, scores: state.scores, over: state.over };
  if (!r) return base;
  const done = r.phase === 'results';
  return {
    ...base,
    phase: r.phase,
    picker: r.picker,
    deadline: r.deadline,
    secret: done || pid === r.picker ? r.secret : null,
    myGuess: r.guesses[pid] ?? null,
    guessed: Object.keys(r.guesses), // who has guessed (not what)
    guesses: done ? r.guesses : null,
  };
}
