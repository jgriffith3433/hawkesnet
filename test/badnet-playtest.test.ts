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
  assert.match(html, /window\.hawkesNetBadNet = badNetKit/);
  assert.match(html, /addBadNetworkScenario\(playtest, \{ kit: badNetKit \}\)/);
  assert.match(html, /inputSeen/);
  assert.match(html, /nx: it\.nx \?\? it\.x/); // the network position of each dot, before the page keeps dots apart
  assert.match(src, /openPhoneFrame/);
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
  let watcher: any, mover: any, walk: ReturnType<typeof setInterval> | null = null, frames: ReturnType<typeof setInterval> | null = null;
  try {
    watcher = await join(room, { ...opts, name: 'Watcher', sub: 'bad-w' });
    lab.attach(watcher);
    mover = await join(room, { ...opts, name: 'Mover', sub: 'bad-m' });
    await new Promise<void>((res, rej) => {
      const t0 = Date.now();
      const t = setInterval(() => {
        if (watcher.peers.has(mover.id) && mover.peers.has(watcher.id)) { clearInterval(t); res(); }
        else if (Date.now() - t0 > 8000) { clearInterval(t); rej(new Error('peers did not meet')); }
      }, 20);
    });
    const track = watcher.sync.track({ pos: [0, 1, 2] });
    watcher.onPose((id: string, s: any, at: number) => { if (id === mover.id) track.push(at, [s.p[0], s.p[1], s.p[2]], id); });
    // The mover walks a loop at the demo's top speed (260 units a second), a pose every 33 ms like the demo's frame loop.
    let x = 200, y = 300, a = 0;
    walk = setInterval(() => { a += 0.02; x += Math.cos(a) * 260 * 0.033; y += Math.sin(a) * 260 * 0.033; mover.pose([x, 0, y], 0); }, 33);
    await new Promise((r) => setTimeout(r, 800));
    lab.set({ latency: BAD_LATENCY_MS, jitter: 0, loss: BAD_LOSS_PCT });
    const meter = createJumpMeter(), onset = createJumpMeter();
    let warm = true;
    frames = setInterval(() => { const s = track.sample(), m = warm ? onset : meter; if (s) m.frame(performance.now(), s[0], s[2]); else m.gap(); }, 16);
    await new Promise((r) => setTimeout(r, WARMUP_MS));
    warm = false; meter.gap();
    await new Promise((r) => setTimeout(r, 12_000));
    if (frames) clearInterval(frames); frames = null;
    if (walk) clearInterval(walk); walk = null;
    const r = meter.result();
    console.log('bad-network jump (node, 12 s):', JSON.stringify(r), 'onset', JSON.stringify(onset.result()));
    assert.ok(r.frames > 400, `${r.frames} frames`);
    assert.ok(r.travelPx > 800, `travelled ${r.travelPx}`);
    assert.ok(r.maxPx <= JUMP_LIMIT_PX, `largest jump ${r.maxPx} px`);
    lab.set({ latency: 0, jitter: 0, loss: 0 });
  } finally {
    if (frames) clearInterval(frames);
    if (walk) clearInterval(walk);
    await Promise.all([mover?.leave?.(), watcher?.leave?.()].filter(Boolean));
  }
});

test('a phone viewport is 390x844 (a few px of toolbar allowed); anything else is not', async () => {
  const { isPhoneViewport } = await import('../public/badnet-playtest.mjs');
  assert.equal(isPhoneViewport({ w: 390, h: 844 }), true);
  assert.equal(isPhoneViewport({ w: 390, h: 830 }), true);
  assert.equal(isPhoneViewport({ w: 1280, h: 720 }), false);
  assert.equal(isPhoneViewport({ w: 844, h: 390 }), false);
  assert.equal(isPhoneViewport(null), false);
});

test('steered by touch: enough stick touches and no key at all; a desktop run on arrow keys does not count', async () => {
  const { judgeTouchLeg } = await import('../public/badnet-playtest.mjs');
  assert.equal(judgeTouchLeg({ touch: 240, stick: 240, key: 0, mouse: 0 }).ok, true);
  assert.equal(judgeTouchLeg({ touch: 0, stick: 0, key: 240 }).ok, false); // the 1280x720 arrow-key run of beta
  assert.match(judgeTouchLeg({ touch: 0, stick: 0, key: 240 }).why, /arrow key/);
  assert.equal(judgeTouchLeg({ touch: 240, stick: 240, key: 1 }).ok, false);
  assert.equal(judgeTouchLeg({ touch: 5, stick: 5 }).ok, false);
  assert.equal(judgeTouchLeg({ touch: 240, stick: 3 }).ok, false); // touches, but not on the floating stick
  assert.equal(judgeTouchLeg(undefined).ok, false);
});

test('jump meter names where its largest jump was', async () => {
  const { createJumpMeter } = await import('../public/badnet-playtest.mjs');
  const m = createJumpMeter();
  m.frame(0, 10, 20); m.frame(16, 13, 20); m.frame(32, 73, 20);
  assert.deepEqual(m.result().from, [13, 20]);
  assert.deepEqual(m.result().to, [73, 20]);
  assert.equal(createJumpMeter().result().from, null);
});

// ---- badNetworkChecks on fake clients (no page): who plays the leg, and what fails it
async function harness({ ownViewport, openPhone, snapAt = null, keysOnly = false, legMs = 2400 }: any) {
  const { badNetworkChecks } = await import('../public/badnet-playtest.mjs');
  const lines: { text: string; ok: boolean; why: string }[] = [], metrics: Record<string, any> = {}, events: any[] = [];
  const check = async (text: string, fn: () => Promise<any>) => {
    const l = { text, ok: false, why: '' }; lines.push(l);
    try { const w = await fn(); l.ok = true; l.why = String(w ?? ''); } catch (e: any) { l.why = String(e?.message ?? e); }
    return l.ok;
  };
  const until = (test: () => any, ms: number, what: any) => new Promise<number>((res, rej) => {
    const t0 = performance.now();
    const tick = () => { let v = false; try { v = test(); } catch { /* not yet */ } if (v) return res(performance.now() - t0); if (performance.now() - t0 > ms) return rej(new Error(`timed out waiting for ${typeof what === 'function' ? what() : what}`)); setTimeout(tick, 10); };
    tick();
  });
  const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  return { badNetworkChecks, lines, metrics, events, check, until, wait, legMs, ownViewport, openPhone, snapAt, keysOnly };
}

// A client kit with a room, a drawn other player that walks a smooth loop (and snaps once at `snapAt` ms when asked), orbs and a stick.
// Motion and raf use a synthetic 16 ms clock so a busy box (setTimeout late) cannot turn a smooth sine into a >40 px jump.
function fakeKit({ w = 390, h = 844, phone = true, keysOnly = false, snapAt = null as number | null }) {
  const t0 = performance.now();
  let clock = 0, frameI = 0;
  const inputs = { touch: 0, stick: 0, key: 0, mouse: 0, pen: 0 };
  const lab: any = { s: { latency: 0, jitter: 0, loss: 0 }, set(v: any) { this.s = { ...v }; }, get() { return { ...this.s, active: Boolean(this.s.latency || this.s.loss) }; }, close() {} };
  const bot: any = { id: 'bot', peers: new Map([['me', {}]]), transport: 'relay', pose() {}, async leave() { bot.left = true; } };
  const main: any = { id: 'me', peers: new Map([['bot', {}]]), transport: 'relay', migrate() {} };
  const score = (who: string) => Math.floor((performance.now() - t0) / (who === 'me' ? 400 : 500));
  const orbs = {
    wire() {}, hostRoundTick() {}, touchAt() { return false; },
    snapshot() { return { round: 1, phase: 'play', orbs: [{ id: 'o', x: 400, y: 300 }], scores: { me: score('me'), bot: score('bot') } }; },
  };
  const view = () => {
    // Sine advances one step per drawn frame (not wall time), so a late setTimeout cannot invent a >40 px jump.
    // snapAt stays wall-clock so the "failing jump" case still fires during the measured leg (after the 2 s warm-up).
    const t = frameI * 16, snap = snapAt !== null && (performance.now() - t0) > snapAt ? 160 : 0;
    const x = 450 + 400 * Math.sin(t * 0.01) + snap; // 26 px a frame at most, at 390 px wide
    return { w: 960, h: 600, items: [{ id: 'bot', x, y: 300, nx: x - snap, ny: 300 }] };
  };
  return {
    main: () => main, orbs: () => orbs, lab: () => lab, view, canvas: () => ({ getBoundingClientRect: () => ({ width: 390, height: 244 }) }),
    openPeer: async () => bot, phone: () => phone, viewport: () => ({ w, h }),
    raf: (f: any) => { setTimeout(() => { frameI++; clock += 16; f(clock); }, 16); },
    myPos: () => [100, 0, 100],
    aim: async (_dx: number, _dy: number, ms: number) => { if (keysOnly) inputs.key++; else { inputs.touch++; inputs.stick++; } await new Promise((r) => setTimeout(r, Math.min(ms, 60))); }, // the real aim holds the stick for ms (250); the fake is quicker so a short leg still counts enough touches
    inputs: () => ({ ...inputs }), untilReady: async () => {}, bot, lab_: lab,
  };
}

test('a desktop run opens a 390x844 frame, plays the leg there by touch, and every check passes', async () => {
  const frame = fakeKit({});
  let closed = 0, opened = 0;
  const own = fakeKit({ w: 1280, h: 720, phone: false });
  const h = await harness({});
  await h.badNetworkChecks({
    check: h.check, until: h.until, wait: h.wait, metric: (k: string, v: any) => { h.metrics[k] = v; }, event: (t: string, d: string) => h.events.push({ t, d }),
    own, openPhone: async () => { opened++; return { kit: frame, close: () => { closed++; } }; }, legMs: 2400,
  });
  const failed = h.lines.filter((l) => !l.ok);
  assert.deepEqual(failed, [], JSON.stringify(failed));
  assert.equal(opened, 1);
  assert.equal(closed, 1, 'the frame is closed after the leg');
  assert.equal(h.metrics.badNetPhone, 1);
  assert.equal(h.metrics.badNetPhoneFrame, 1);
  assert.equal(h.metrics.badNetViewport, '390x844');
  assert.equal(h.metrics.badNetRunnerViewport, '1280x720');
  assert.ok(h.metrics.badNetTouchGestures >= 20, `${h.metrics.badNetTouchGestures} touches`);
  assert.equal(h.metrics.badNetKeyPresses, 0);
  assert.ok(h.metrics.remoteJumpMaxPx > 0 && h.metrics.remoteJumpMaxPx <= 40, `${h.metrics.remoteJumpMaxPx}`);
  assert.equal(h.metrics.scoreMatch, 1);
  assert.equal(frame.bot.left, true, 'the second client left');
  assert.equal(frame.lab_.get().active, false, 'the lab is off again');
  assert.equal(own.lab_.get().active, false, 'the desktop page\'s own lab was never turned on');
});

test('a page that is already a phone plays the leg itself, with no frame', async () => {
  const own = fakeKit({});
  const h = await harness({});
  await h.badNetworkChecks({
    check: h.check, until: h.until, wait: h.wait, metric: (k: string, v: any) => { h.metrics[k] = v; },
    own, openPhone: async () => { throw new Error('must not open a frame'); }, legMs: 2400,
  });
  assert.deepEqual(h.lines.filter((l) => !l.ok), []);
  assert.equal(h.metrics.badNetPhoneFrame, 0);
  assert.equal(h.metrics.badNetViewport, '390x844');
});

test('a jump over 40 px fails the run, and says where; a client steered by keys fails too, even with a smooth dot', async () => {
  const run = async (opts: { snapAt?: number; keysOnly?: boolean }) => {
    const h = await harness({});
    const frame = fakeKit({ snapAt: opts.snapAt ?? null, keysOnly: opts.keysOnly });
    await h.badNetworkChecks({
      check: h.check, until: h.until, wait: h.wait, metric: (k: string, v: any) => { h.metrics[k] = v; }, event: (t: string, d: string) => h.events.push({ t, d }),
      own: fakeKit({ w: 1280, h: 720, phone: false }), openPhone: async () => ({ kit: frame, close() {} }), legMs: 2400,
    });
    return h;
  };
  const [snap, keys] = await Promise.all([run({ snapAt: 3200 }), run({ keysOnly: true })]);
  const glide = snap.lines.find((l) => /glides/.test(l.text))!;
  assert.equal(glide.ok, false);
  assert.match(glide.why, /jumped [\d.]+ px in one frame/);
  assert.ok(snap.metrics.remoteJumpMaxPx > 40, `${snap.metrics.remoteJumpMaxPx}`);
  assert.ok(snap.metrics.remoteJumpNetworkPx <= 40, 'the snap was drawn only: the network position stayed smooth');
  assert.ok(snap.events.some((e: any) => e.t === 'bad-network-jump'));
  assert.equal(snap.lines.filter((l) => !l.ok).length, 1, 'only the jump check fails');
  const touch = keys.lines.find((l) => /steered by touch alone/.test(l.text))!;
  assert.equal(touch.ok, false);
  assert.match(touch.why, /arrow key/);
});

test('no phone client, no pass: a desktop run that cannot open the frame fails at the phone check and plays no leg', async () => {
  const run = async (own: any, openPhone: any) => {
    const h = await harness({});
    await h.badNetworkChecks({ check: h.check, until: h.until, wait: h.wait, metric: (k: string, v: any) => { h.metrics[k] = v; }, own, openPhone, legMs: 2400 });
    return h;
  };
  const noFrame = await run(fakeKit({ w: 1280, h: 720, phone: false }), undefined);
  assert.equal(noFrame.lines.length, 1);
  assert.equal(noFrame.lines[0].ok, false);
  assert.match(noFrame.lines[0].why, /1280x720/);
  assert.equal(noFrame.metrics.badNetPhone, 0);
  const brokenFrame = await run(fakeKit({ w: 1280, h: 720, phone: false }), async () => { throw new Error('/demo did not load in a 390x844 frame in 20 s'); });
  assert.equal(brokenFrame.lines.length, 1);
  assert.equal(brokenFrame.lines[0].ok, false);
  const wrongSize = await run(fakeKit({ w: 1280, h: 720, phone: false }), async () => ({ kit: fakeKit({ w: 800, h: 600 }), close() {} }));
  assert.equal(wrongSize.lines.length, 1);
  assert.match(wrongSize.lines[0].why, /800x600/);
  const noStick = await run(fakeKit({ w: 1280, h: 720, phone: false }), async () => ({ kit: fakeKit({ phone: false }), close() {} }));
  assert.equal(noStick.lines.length, 1);
  assert.match(noStick.lines[0].why, /phone layout/);
});
