// /demo phone comfort (public/demo.html + public/phone-playtest.mjs): floating stick, safe HUD, collapsed panel, 390×844.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startTestHub } from './helper.ts';

const html = fs.readFileSync(new URL('../public/demo.html', import.meta.url), 'utf8');
const bot = fs.readFileSync(new URL('../public/demo-playtest.mjs', import.meta.url), 'utf8');
const phone = fs.readFileSync(new URL('../public/phone-playtest.mjs', import.meta.url), 'utf8');
const hub = await startTestHub();
after(async () => { await hub.stop(); });

test('the demo wires a floating stick, safe-area HUD, collapsed Room panel, and hawkesNetPhone', () => {
  assert.match(html, /viewport-fit=cover/);
  assert.match(html, /hawkesNetPhone/);
  assert.match(html, /STICK_R|stickNorm|stick-drag/);
  assert.match(html, /panel-toggle|aria-controls="side"/);
  // Hide rule must come before the phone media block so ≤640 px can set display:inline-flex.
  assert.ok(html.indexOf('.panel-toggle { display: none; }') < html.indexOf('@media (max-width: 640px)'), 'panel-toggle hide is before the phone media rule');
  assert.match(html, /safe-area-inset-top|safeArena/);
  assert.match(html, /phoneMode/);
  assert.match(html, /controlsInStickZone/);
  assert.match(html, /addPhoneScenario/);
  assert.match(html, /import\('\/phone-playtest\.mjs'\)/);
  assert.match(html, /stickDrag/);
  assert.doesNotMatch(html, /setInterval\([^)]*fetch/);
});

test('shared demo-playtest stays free of phone checks; they live in phone-playtest', () => {
  assert.doesNotMatch(bot, /hawkesNetPhone|phone-playtest|STICK_R|phone-stick/);
  assert.match(phone, /phoneChecks/);
  assert.match(phone, /addPhoneScenario/);
  assert.match(phone, /id: 'phone'/);
  assert.match(phone, /PHONE_W = 390/);
  assert.match(phone, /PHONE_H = 844/);
  assert.match(phone, /floating stick/);
  assert.match(phone, /no sideways scroll/);
  assert.match(phone, /phone-stick/);
  assert.match(phone, /phone-collect/);
  assert.match(phone, /pointerType|type: 'touch'/);
});

test('the hub serves phone-playtest.mjs', async () => {
  const r = await fetch(`${hub.url}/phone-playtest.mjs`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') ?? '', /javascript/);
  assert.match(await r.text(), /addPhoneScenario/);
});

test('layout() extract markers stay so demo-layout.test can still cut the function out', () => {
  assert.ok(html.includes('const PAD = 4'));
  assert.ok(html.includes('let last = performance.now()'));
  const body = html.slice(html.indexOf('const PAD = 4'), html.indexOf('let last = performance.now()'));
  assert.match(body, /function layout\(/);
  assert.doesNotMatch(body, /hawkesNetPhone|AudioContext|collectFx|STICK_R/);
});
