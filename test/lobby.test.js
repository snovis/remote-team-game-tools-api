import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.location = { origin: 'https://game.test', pathname: '/' };
const { renderLobby, settingsSummary } = await import('../client/lobby.js');

const fields = [
  { key: 'race', label: 'Race', options: [{ value: 'cross', label: 'Cross Country: first to the finish', short: 'Cross Country' }, { value: 'sprint', label: 'Sprint' }] },
  { key: 'bots', label: 'Bots', options: [{ value: 0, label: 'No bots', short: '' }, { value: 3, label: '3 bots' }] },
  { key: 'secret', label: 'Secret', summary: false, options: [{ value: 'x', label: 'X' }] },
];

test('the summary is each chosen option, short label first, skipping what asks to be left out', () => {
  assert.deepEqual(settingsSummary(fields, { race: 'cross', bots: 3, secret: 'x' }), ['Cross Country', '3 bots']);
  assert.deepEqual(settingsSummary(fields, { race: 'sprint', bots: 0 }), ['Sprint'], 'an empty short leaves it out');
});

const sync = (you) => ({
  you,
  room: {
    code: 'ABCD', hostId: 'h', ownerId: 'h', hostTitle: 'Head Gardener', hostAway: false, joinInProgress: true,
    settings: { race: 'cross', bots: 3, secret: 'x' },
    players: [{ id: 'h', name: 'Ann', color: '#f00', connected: true }, { id: 'p', name: 'Bo', color: '#0f0', connected: true }],
  },
});

test('the host gets the dropdowns; everyone else gets the summary', () => {
  const host = renderLobby(sync('h'), { schema: fields, minPlayers: 1 });
  assert.match(host, /<select data-rtg-setting="race">/);
  assert.doesNotMatch(host, /rtg-summary/);
  const player = renderLobby(sync('p'), { schema: fields, minPlayers: 1 });
  assert.doesNotMatch(player, /data-rtg-setting/);
  assert.match(player, /<ul class="rtg-summary"><li>Cross Country<\/li><li>3 bots<\/li><\/ul>/);
  assert.match(player, /Head Gardener picks/);
});

test('a game panel goes after the players; a watcher gets the summary and a close button', () => {
  const html = renderLobby(sync('p'), { schema: fields, panel: (s) => `<section id="teams">${s.room.code}</section>` });
  assert.ok(html.indexOf('id="teams"') > html.indexOf('rtg-players'));
  assert.ok(html.indexOf('id="teams"') < html.indexOf('rtg-summary'));
  const screen = renderLobby({ ...sync(null), watching: true }, { schema: fields });
  assert.match(screen, /rtg-summary/);
  assert.match(screen, /Close the big screen/);
  // with nobody holding the role (hostId null), the big screen still isn't host
  const orphan = sync(null);
  orphan.room.hostId = null;
  assert.doesNotMatch(renderLobby({ ...orphan, watching: true }, { schema: fields }), /data-rtg="start"|data-rtg-setting/);
});
