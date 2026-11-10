// /demo moment feedback (public/demo.html + public/feedback-playtest.mjs): collect burst/+1/sound/pulse, Mute, join/leave FX.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startTestHub } from './helper.ts';

const html = fs.readFileSync(new URL('../public/demo.html', import.meta.url), 'utf8');
const bot = fs.readFileSync(new URL('../public/demo-playtest.mjs', import.meta.url), 'utf8');
const feedback = fs.readFileSync(new URL('../public/feedback-playtest.mjs', import.meta.url), 'utf8');
const hub = await startTestHub();
after(async () => { await hub.stop(); });

test('the demo wires moment feedback, Mute, and hawkesNetFeedback', () => {
  assert.match(html, /hawkesNetFeedback/);
  assert.match(html, /collectFx/);
  assert.match(html, /playPickup|AudioContext/);
  assert.match(html, /MUTE_KEY|hawkes-net-demo-mute/);
  assert.match(html, /id="mute"/);
  assert.match(html, /devicePixelRatio/);
  assert.match(html, /MAX_PARTICLES/);
  assert.match(html, /peerIn\.set/);
  assert.match(html, /leavers\.push/);
  assert.match(html, /addFeedbackScenario/);
  assert.match(html, /import\('\/feedback-playtest\.mjs'\)/);
  assert.doesNotMatch(html, /setInterval\([^)]*fetch/);
});

test('shared demo-playtest stays free of feedback checks; they live in feedback-playtest', () => {
  assert.doesNotMatch(bot, /hawkesNetFeedback|feedback-playtest|collectFx|hawkes-net-demo-mute/);
  assert.match(feedback, /feedbackChecks/);
  assert.match(feedback, /addFeedbackScenario/);
  assert.match(feedback, /id: 'feedback'/);
  assert.match(feedback, /No pickup sound plays before/);
  assert.match(feedback, /Mute is remembered/);
  assert.match(feedback, /joining player pops in/);
  assert.match(feedback, /leaving player fades/);
});

test('the hub serves feedback-playtest.mjs', async () => {
  const r = await fetch(`${hub.url}/feedback-playtest.mjs`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') ?? '', /javascript/);
  assert.match(await r.text(), /addFeedbackScenario/);
});

test('layout() extract markers stay so demo-layout.test can still cut the function out', () => {
  assert.ok(html.includes('const PAD = 4'));
  assert.ok(html.includes('let last = performance.now()'));
  const body = html.slice(html.indexOf('const PAD = 4'), html.indexOf('let last = performance.now()'));
  assert.match(body, /function layout\(/);
  assert.doesNotMatch(body, /hawkesNetFeedback|AudioContext|collectFx/);
});
