# remote-team-game-tools-api

Everything a remote-team multiplayer party game needs **except the game**.

- Jackbox-style rooms: 4-letter codes, invite links, lobby, host-only settings, room lock at start
- Rejoin your seat after a disconnect or reload; host handoff when the host drops
- 30 distinct player colors; server tick for timers; per-player views so hidden info stays hidden
- Build sync: pages know which build they're on, reload after a deploy, and show a ✓/⚠ badge
- Client kit: connection + server clock, home/lobby screens, prize wheels, animation/confetti kit, toasts

New session starting a game? Read **[HANDOFF.md](HANDOFF.md)** first.

Start with **[GAME_API.md](GAME_API.md)**, then copy
[`examples/hidden-number`](examples/hidden-number).

```sh
npm install
npm test          # room-layer tests
npm run example   # Hidden Number on http://localhost:3000
```

Extracted from [Good Day / Bad Day](https://github.com/snovis/empathy-poker).
