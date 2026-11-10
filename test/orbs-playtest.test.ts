// /demo's host-authoritative orb game (public/demo.html + public/orbs-playtest.mjs): wiring, shared playtest hook,
// and the pure helpers the playtest uses so a reskin without sync.state/action can't pass.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startTestHub } from './helper.ts';

const html = fs.readFileSync(new URL('../public/demo.html', import.meta.url), 'utf8');
const bot = fs.readFileSync(new URL('../public/demo-playtest.mjs', import.meta.url), 'utf8');
const orbs = fs.readFileSync(new URL('../public/orbs-playtest.mjs', import.meta.url), 'utf8');
const hub = await startTestHub();
after(async () => { await hub.stop(); });

test('the demo wires orbs on sync.state / sync.action and exposes hawkesNetOrbs', () => {
  assert.match(html, /sync\.state\('orbs'/);
  assert.match(html, /sync\.action\('orb-touch'/);
  assert.match(html, /sync\.action\('orb-award'/);
  assert.match(html, /sync\.action\('orb-round-end'/);
  assert.match(html, /sync\.action\('orb-round-start'/);
  assert.match(html, /window\.hawkesNetOrbs/);
  assert.match(html, /wireOrbs\(net\)/);
  assert.match(html, /touchAt\(net,/);
  assert.match(html, /beginTestRound/);
  assert.match(html, /hostRoundTick/);
  assert.match(html, /afterTwoPlayers/);
  assert.match(html, /orbChecks/);
  assert.match(html, /roundChecks/);
  assert.match(html, /ROUND_SEC/);
  assert.match(html, /import\('\/orbs-playtest\.mjs'\)/);
  assert.doesNotMatch(html, /setInterval\([^)]*fetch/);
});

test('shared demo-playtest gains afterTwoPlayers only; orb checks stay in orbs-playtest', () => {
  assert.match(bot, /afterTwoPlayers/);
  assert.doesNotMatch(bot, /orb-touch|hawkesNetOrbs|orbs-playtest|orb-round/);
  assert.match(orbs, /Both players see the same 5 orbs/);
  assert.match(orbs, /within half a second/);
  assert.match(orbs, /joins mid-round/);
  assert.match(orbs, /SCORE_MS = 500/);
  assert.match(orbs, /roundChecks/);
  assert.match(orbs, /SHORT_ROUND_SEC = 8/);
  assert.match(orbs, /winner's name and a sorted scoreboard/);
  assert.match(orbs, /scores reset/);
  assert.match(orbs, /host leaves mid-round/);
});

test('the hub serves orbs-playtest.mjs', async () => {
  const r = await fetch(`${hub.url}/orbs-playtest.mjs`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') ?? '', /javascript/);
  const text = await r.text();
  assert.match(text, /orbChecks/);
  assert.match(text, /roundChecks/);
});
