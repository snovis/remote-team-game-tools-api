# Handoff: starting a new remote-team game

For a fresh Claude Code session starting a new game on this architecture.
Read this whole file, then [GAME_API.md](GAME_API.md), then copy
[`examples/hidden-number`](examples/hidden-number). Written 2026-09-25 at
the end of the session that built Good Day / Bad Day and extracted this
package.

---

## 1. What already exists

| Thing | Where |
|---|---|
| Engine package (this repo) | `snovis/remote-team-game-tools-api`, tag `v0.1.0` |
| Reference game | `snovis/empathy-poker` — "Good Day / Bad Day", tag `v0.1.2` |
| Live game | https://empathy-poker-production.up.railway.app (`release` branch) |
| Dev game | https://empathy-poker-dev-production.up.railway.app (`dev` branch) |
| Hosting | Railway workspace "Rymare Projects", project `empathy-poker` (services `empathy-poker` → `release`, `empathy-poker-dev` → `dev`) |

Empathy Poker still carries its **own copy** of the engine (its
`server/rooms.js` and client code predate this package). Migrating it onto
the package is a later task — don't touch it from a new-game session.

Empathy Poker is the best place to steal from when you need more than the
package gives you: the poker-table theme and checker tokens
(`client/style.css`), drag-and-drop with forgiving drop targets, the
face-down deal and flip, the live "who's placed what" grid, the
progressive reveal, and a Node player bot for testing (§6).

## 2. The architecture in one screen

- **Server is authoritative.** Rules, randomness, timers, and secrets live
  in the game module. Clients render `view(state, playerId)` snapshots and
  send `conn.act({...})`. Hidden information never leaves the server.
- **One Node process per game**, `createGameServer({ games, clientDir })`:
  static client at `/`, kit at `/rtg/`, WebSocket at `/ws`, `/health`.
- **Rooms live in memory.** A deploy or restart ends every game in
  progress. (Saving state across deploys is a known wish, not built.)
- **Server clock everywhere.** Put `ctx.now` timestamps in `view()`
  (deadlines, `spunAt`, `dealtAt`) and animate from `conn.now()`, so every
  screen and every reconnecting player sees the same moment. Re-renders
  re-derive animation progress from the clock instead of restarting it.
- **Build sync.** `index.html` carries `<meta name="build" content="__BUILD__">`;
  the server stamps it and says its build on connect. Stale pages reload
  once; a badge shows `✓ <hash>` or red "old version". **Always tell Scott
  the short hash you deployed** so he can check the badge.

## 3. Setting up a new game (do these in order)

1. **Scott creates the GitHub repo.** Claude's GitHub connector cannot
   create repositories (403). Ask for an *empty* repo (no README/license).
   Then `add_repo` it with push access; if the path already exists
   locally, add the remote and push instead of cloning.
2. **Scaffold from the example:**
   - `package.json`: `"type": "module"`, `"start": "node server.js"`,
     `"test": "node --test test/"`, dependency
     `"remote-team-game-tools-api": "github:snovis/remote-team-game-tools-api#v0.1.0"`.
     This repo is **public**, so Railway's `npm install` fetches it with
     no token. Pin a tag; bump it deliberately when the engine changes.
   - `server.js`, `game.js`, `client/index.html` (with the build meta),
     `client/app.js`, `client/style.css`, `test/game.test.js`.
   - `railway.json`: `{ "deploy": { "startCommand": "npm start", "healthcheckPath": "/health", "restartPolicyType": "ON_FAILURE" } }`
   - Copy `.github/workflows/tag-release.yml` from this repo (see §4).
3. **Branches:** `dev` and `release` (Scott's convention; `main` is
   meaningless). Develop and push on `dev`; promote by pushing the same
   commit to `release`.
4. **Railway (via the Railway MCP tools):** in workspace "Rymare
   Projects", create a project (or add to an existing one), then two
   services — `<game>` following `release` and `<game>-dev` following
   `dev` (`create-service`, `connect-service-source` with `branch`,
   `generate-domain`). Confirm deploys with `list-deployments` and poll the
   URL until the page's build meta matches your commit.
5. **Network:** this sandbox's network policy blocks hosts by default.
   To test the live URLs from the container (curl, bot player), Scott
   must allow the `*.up.railway.app` host(s) in the environment settings.

## 4. Environment gotchas (learned the hard way)

- **Tags can't be pushed from the session** (the git proxy drops tag
  pushes; the connector's tag tools are read-only). The workaround is
  already built: `tag-release.yml` creates `v<package.json version>` and a
  GitHub Release whenever `release` moves to a version with no tag. So:
  **bump the version, push to `release`, done.** Never ask Scott to tag.
- **Deploys restart the server and end live games.** Before pushing to a
  branch someone is playing on, check `/health` (`rooms` count) or ask.
  Scott's standing rule: deploy freely to `dev`; promote to `release`
  when no one's mid-game.
- **A page that stays open across a deploy keeps running old code** unless
  the build-sync reload works — this is why the badge exists. When Scott
  reports "still broken", first check whether he's on the new build.
- **Self-host fonts** (npm `@fontsource/*` → `client/fonts/*.woff2`,
  `@font-face` in CSS). Google Fonts is blocked in the sandbox, so tests
  would measure fallback fonts and miss real-font layout bugs.
- **Playwright:** Chromium is preinstalled; install `playwright-core` in
  the scratchpad and launch with
  `executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'`.
  Don't `playwright install`. Edge = Chromium, so tests cover Scott's
  desktop browser.
- **`pkill -f "<pattern>"` can kill your own shell** when the pattern
  appears in the command line. Kill by PID or run servers with
  `run_in_background`.
- **Image generation:** there's an `OPENROUTER_API_KEY` in the
  environment, but `openrouter.ai` was blocked by the network policy last
  time. Hand-drawn SVG worked well (logo, coin faces, card backs) and
  stays crisp at favicon size.

## 5. What Scott wants from a game (his feedback, distilled)

- **It must look like a game, not a web page.** Pick a board-game
  aesthetic up front (Empathy Poker: green felt, wood rail, real playing
  cards, checker tokens, chunky 3D buttons, Luckiest Guy + Fredoka).
  Beige form panels read as "drone factory web page."
- **JavaScript animations are required** — Web Animations API + canvas
  confetti (`fx` in the kit). Deal cards face-down then flip, fly tokens,
  drumroll the big reveal, count scores up.
- **Calm layout — nothing bounces.** Reserve space for anything that
  appears later (empty card spots, fixed-height bars, min-heights on
  hint/countdown lines); never render a timer blank between syncs; use
  overlays (wheel) instead of swapping sections. Verify by recording
  element positions every animation frame during play.
- **Phone-first.** Test at 390px wide with touch. Nothing may widen the
  page (`minmax(0, 1fr)` grid columns, tables scroll in their own box).
  Drop decorative frames on phones.
- **Drag and drop** with generous drop targets (nearest target within
  ~56px), text selection disabled on the play area, tap as a fallback.
- **Everyone sees the table.** Show everyone's progress live (face-down),
  and reveal progressively with running tallies rather than one mass flip.
- **Flexible rules where real people differ** (e.g. reveal in any order).
- **Visible version badge** so he can trust what he's looking at.

## 6. How to verify before saying "done"

- `npm test` for rules (hidden info, timers, scoring, rotation).
- Multi-browser Playwright run: create/join/start/play a full round with
  2–3 contexts (one at 390×844 with `isMobile`/`hasTouch`), screenshot key
  moments, and **look at the screenshots**.
- For layout complaints, measure (bounding rects per frame, page
  `scrollWidth` vs viewport), don't guess.
- **Player bot for playing with Scott:** a Node script using `ws` +
  `https-proxy-agent` (the container's egress proxy is in `HTTPS_PROXY`)
  that joins a room code and plays by the protocol. Empathy Poker's bot
  pattern: log each phase, act after human-ish delays, place tokens one at
  a time. Needs the Railway host allowed in the network policy.
- After deploying, poll the URL until `<meta name="build">` equals your
  commit, then give Scott the 7-character hash.

## 7. Working with Scott

- Once he's given a design, **build — don't drag him into architecture
  questions.** Make reasonable calls, state them in a line, keep going.
  Ask only for things that are genuinely his (names, visibility, money,
  what the game should feel like), one question at a time.
- He'll send feedback mid-turn while you work. Fold it in; acknowledge
  briefly.
- When something breaks, say plainly what happened (e.g. "the restarts
  were my deploys"), fix it, and show evidence it's fixed.
- Warm, direct, no apology spirals, no numbered lists of his mistakes.
- Pending on Empathy Poker (not for new-game sessions): rename to
  **Best Day / Worst Day** (on hold until he says go), saved state across
  deploys, calmer phone screen, migrate onto this package.

## 8. Kickoff prompt template

Paste into a new session with the game's repo attached (plus this repo):

> Build **<Game Name>**, a multiplayer party game for remote teams on
> video calls, using `snovis/remote-team-game-tools-api` (read its
> HANDOFF.md, GAME_API.md, and examples/hidden-number first). Design
> doc: <paste or link>. Repo: `snovis/<repo>` (empty). Set up `dev` and
> `release` branches and two Railway services in the "Rymare Projects"
> workspace as HANDOFF.md §3 describes, deploy to dev as you go, and give
> me the dev URL and build hash when a full round is playable on a phone.
