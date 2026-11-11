// /demo's bad-network leg (public/badnet-playtest.mjs): 250 ms + 5% loss on one client, the largest single-frame jump of the
// other player's drawn dot in px (limit 40), and both clients' scores. The page parts need a browser (Studio plays them);
// here: the wiring, the pure measuring, and the same measurement on the real SDK through the lab shim.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startTestHub } from './helper.ts';

const html = fs.readFileSync(new URL('../public/demo.html', import.meta.url), 'utf8');
const bot = fs.readFileSync(new URL('../public/demo-playtest.mjs', import.meta.url), 'utf8');
const src = fs.readFileSync(new URL('../public/badnet-playtest.mjs', import.meta.url), 'utf8');
const hub = await startTestHub();
after(async () => { await hub.stop(); });

test('the demo wires the bad-network scenario; the shared playtest and the lab stay as they were', () => {
  assert.match(html, /import\('\/badnet-playtest\.mjs'\)/);
  assert.match(html, /addBadNetworkScenario\(playtest/);
  assert.match(html, /stickAim/);
  assert.match(html, /const aim = /);
  assert.doesNotMatch(bot, /badnet|bad-network|remoteJump/);
  assert.match(src, /id: 'bad-network'/);
  assert.match(src, /remoteJumpMaxPx/);
  assert.match(src, /JUMP_LIMIT_PX = 40/);
  assert.match(src, /LEG_MS = 60_000/);
  assert.match(src, /BAD_LATENCY_MS = 250/);
  assert.match(src, /BAD_LOSS_PCT = 5/);
  assert.match(src, /Scores match on both clients/);
  assert.match(src, /390x844/);
  assert.doesNotMatch(html, /setInterval\([^)]*fetch/);
});

test('the hub serves badnet-playtest.mjs', async () => {
  const r = await fetch(`${hub.url}/badnet-playtest.mjs`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') ?? '', /javascript/);
  assert.match(await r.text(), /addBadNetworkScenario/);
});

test('jump meter: a smooth walk stays small, one snap shows as itself, a stalled frame is skipped, a gap starts over', async () => {
  const { createJumpMeter, JUMP_LIMIT_PX } = await import('../public/badnet-playtest.mjs');
  const m = createJumpMeter();
  for (let i = 0; i < 120; i++) m.frame(i * 16, i * 3, 100); // 3 px a frame
  assert.equal(m.result().maxPx, 3);
  assert.equal(m.result().frames, 119);
  m.frame(121 * 16, 120 * 3 + 55, 100); // a 55 px snap on a frame that came on time
  assert.equal(m.result().maxPx, 58); // the snap plus that frame's own 3 px walk
  assert.ok(m.result().maxPx > JUMP_LIMIT_PX);
  const s = createJumpMeter();
  s.frame(0, 0, 0); s.frame(16, 4, 0);
  s.frame(16 + 900, 400, 0); // the browser stopped for 900 ms, then drew the dot far along: not the netcode's jump
  s.frame(16 + 916, 404, 0);
  assert.equal(s.result().stalledFrames, 1);
  assert.equal(s.result().maxPx, 4);
  const g = createJumpMeter();
  g.frame(0, 0, 0); g.gap(); g.frame(16, 500, 500); g.frame(32, 503, 500);
  assert.equal(g.result().maxPx, 3);
  assert.equal(g.result().travelPx, 3);
  assert.equal(createJumpMeter().result().frames, 0);
});

test('scores match: same round, phase and per-player numbers; a missing player is 0; any difference says which', async () => {
  const { scoresMatch } = await import('../public/badnet-playtest.mjs');
  const a = { round: 2, phase: 'play', scores: { p1: 3, p2: 1 } };
  assert.equal(scoresMatch(a, { round: 2, phase: 'play', scores: { p2: 1, p1: 3 } }).match, true);
  assert.equal(scoresMatch({ round: 1, phase: 'play', scores: { p1: 0 } }, { round: 1, phase: 'play', scores: {} }).match, true);
  const d = scoresMatch(a, { round: 2, phase: 'play', scores: { p1: 3, p2: 2 } });
  assert.equal(d.match, false);
  assert.match(d.why, /p2 1 \/ 2/);
  assert.match(scoresMatch(a, { ...a, round: 3 }).why, /round 2 \/ 3/);
  assert.match(scoresMatch(a, { ...a, phase: 'result' }).why, /phase play \/ result/);
  assert.equal(scoresMatch(null, undefined).match, true);
});

test('nearestOrb picks the closest orb, or none', async () => {
  const { nearestOrb } = await import('../public/badnet-playtest.mjs');
  assert.equal(nearestOrb([], 0, 0), null);
  assert.equal(nearestOrb([{ id: 'a', x: 100, y: 0 }, { id: 'b', x: 20, y: 10 }], 0, 0)?.id, 'b');
});

test('250 ms and 5% loss on the watching client: the other player\'s drawn dot never jumps more than 40 px in a frame', async () => {
  const { createLab } = await import('../public/demo-lab.mjs');
  const { join } = await import('../sdk/js/hawkes-net.mjs');
  const { createJumpMeter, JUMP_LIMIT_PX, BAD_LATENCY_MS, BAD_LOSS_PCT, WARMUP_MS } = await import('../public/badnet-playtest.mjs');
  const opts = { project: 'netdemo', endpoint: hub.endpoint, transport: 'relay' as const, log: false, leaveOnHide: false };
  const room = `bad-${Math.random().toString(36).slice(2, 7)}`;
  const lab = createLab();
  const watcher = await join(room, { ...opts, name: 'Watcher', sub: 'bad-w' });
  lab.attach(watcher);
  const mover = await join(room, { ...opts, name: 'Mover', sub: 'bad-m' });
  await new Promise<void>((res) => { const t = setInterval(() => { if (watcher.peers.has(mover.id) && mover.peers.has(watcher.id)) { clearInterval(t); res(); } }, 20); });
  const track = watcher.sync.track({ pos: [0, 1, 2] });
  watcher.onPose((id: string, s: any, at: number) => { if (id === mover.id) track.push(at, [s.p[0], s.p[1], s.p[2]], id); });
  // The mover walks a loop at the demo's top speed (260 units a second), a pose every 33 ms like the demo's frame loop.
  let x = 200, y = 300, a = 0;
  const walk = setInterval(() => { a += 0.02; x += Math.cos(a) * 260 * 0.033; y += Math.sin(a) * 260 * 0.033; mover.pose([x, 0, y], 0); }, 33);
  await new Promise((r) => setTimeout(r, 800));
  lab.set({ latency: BAD_LATENCY_MS, jitter: 0, loss: BAD_LOSS_PCT });
  const meter = createJumpMeter(), onset = createJumpMeter();
  let warm = true;
  const frames = setInterval(() => { const s = track.sample(), m = warm ? onset : meter; if (s) m.frame(performance.now(), s[0], s[2]); else m.gap(); }, 16);
  await new Promise((r) => setTimeout(r, WARMUP_MS));
  warm = false; meter.gap();
  await new Promise((r) => setTimeout(r, 12_000));
  clearInterval(frames); clearInterval(walk);
  const r = meter.result();
  console.log('bad-network jump (node, 12 s):', JSON.stringify(r), 'onset', JSON.stringify(onset.result()));
  assert.ok(r.frames > 400, `${r.frames} frames`);
  assert.ok(r.travelPx > 800, `travelled ${r.travelPx}`);
  assert.ok(r.maxPx <= JUMP_LIMIT_PX, `largest jump ${r.maxPx} px`);
  lab.set({ latency: 0, jitter: 0, loss: 0 });
  await mover.leave(); await watcher.leave();
});
