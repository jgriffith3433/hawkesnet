// /demo drain reconnect (public/demo.html + public/drain-playtest.mjs): Reconnecting banner after a draining notice.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startTestHub } from './helper.ts';

const html = fs.readFileSync(new URL('../public/demo.html', import.meta.url), 'utf8');
const bot = fs.readFileSync(new URL('../public/demo-playtest.mjs', import.meta.url), 'utf8');
const drain = fs.readFileSync(new URL('../public/drain-playtest.mjs', import.meta.url), 'utf8');
const hub = await startTestHub();
after(async () => { await hub.stop(); });

test('the demo wires a Reconnecting banner and the drain playtest', () => {
  assert.match(html, /id="banner"|hawkesNetBanner/);
  assert.match(html, /Reconnecting/);
  assert.match(html, /addDrainScenario/);
  assert.match(html, /import\('\/drain-playtest\.mjs'\)/);
  assert.doesNotMatch(html, /setInterval\([^)]*fetch/);
});

test('shared demo-playtest stays free of drain checks; they live in drain-playtest', () => {
  assert.doesNotMatch(bot, /drain-playtest|addDrainScenario|hawkesNetBanner/);
  assert.match(drain, /drainChecks/);
  assert.match(drain, /addDrainScenario/);
  assert.match(drain, /id: 'drain'/);
  assert.match(drain, /draining/);
  assert.match(drain, /reconnectMs/);
});

test('the hub serves drain-playtest.mjs', async () => {
  const r = await fetch(`${hub.url}/drain-playtest.mjs`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') ?? '', /javascript/);
  assert.match(await r.text(), /addDrainScenario/);
});
