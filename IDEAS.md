# Game ideas backlog

Scott's ideas for future remote-team games on this engine. Each one is a
candidate for its own repo + session (see HANDOFF.md). Newest at the top.

## Sorting & perception (cooperative)

### Ito-style cooperative number sorting
Inspired by the card game **Ito**. Everyone secretly gets a number (e.g.
1–100). A theme is revealed ("dogs", "animals", "things you'd bring to a
desert island"…). Each player describes their number *only* as something
in that theme ("mine's a golden retriever"). The team then tries to place
everyone in order, lowest to highest, without saying numbers. Cooperative:
the whole table wins or loses together.
- Engine fit: hidden per-player numbers in `view()`, a shared drag-to-order
  line everyone can see, a host "lock our order" + dramatic left-to-right
  reveal.

### Wavelength-style team subjective sorting
Like **Wavelength**: a clue-giver sees a hidden target on a spectrum
between two poles ("underrated ↔ overrated") and gives a one-word clue;
the team debates and moves a shared dial to guess the target. Cooperative
or two teams.
- Engine fit: server-held target, one shared dial all players can nudge
  (last-write-wins or host confirms), server-clock reveal animation.

Both sit close to Good Day / Bad Day's heart — perspective-taking and
subjective ranking — and could reuse its card and reveal presentation.

## Physics / dexterity

### Jenga-style block pulling
Take turns pulling blocks from a tower in a shared physics puzzle; the
player who topples it loses (or the team survives N rounds).

### House of cards (the reverse of Jenga)
Take turns *adding* pieces to a stack and hope it doesn't fall.

Physics notes for both: the server must be authoritative, so run a
deterministic physics step on the server (or have the active player's
client simulate and the server verify/relay the result) and stream the
settled state to everyone. Turn-based keeps latency forgiving.
