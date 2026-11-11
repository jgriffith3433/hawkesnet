// The bad-network leg for /demo (public/demo.html + public/demo-lab.mjs): the `bad-network` scenario.
// Wired from demo.html like lab-playtest.mjs and orbs-playtest.mjs; the shared demo-playtest.mjs stays free of it.
//
// Player goal: on a bad mobile network (250 ms, 5% loss) other players still glide without teleporting, and scores agree.
//   0. One client is a phone: 390x844, steered only by touch (the floating stick). On a phone-sized run (Studio's phone twin)
//      that is this page. On any other run (a desktop is 1280x720 and a page cannot resize itself) the scenario opens a
//      390x844 frame of /demo on the page, in its own room, and plays the leg through that page: its canvas, its input layer,
//      its Network lab. When no phone client can be had the check fails, and so does the run: it never passes on arrow keys.
//   1. The phone client gets the Network lab at 250 ms latency and 5% loss (its own sends and receives only).
//   2. For 60 s its player chases orbs by real touch input and a second client in the same room chases them too. Every
//      drawn frame, the scenario measures how far the other player's dot moved on screen, in CSS px: the largest
//      single-frame jump is the number that says "it glided" or "it teleported". Over JUMP_LIMIT_PX the run fails. The
//      same dot's network position (before the page keeps dots apart) is measured beside it, so a failure says where it came from.
//   3. The lab goes off, both drivers stop, and the two clients' scores (round, phase, one score per player) must agree.
//      Lost messages are allowed to arrive late (the room re-sends its state every few seconds), not to stay different.
//
// A "client" below is the page's kit (demo.html's `window.hawkesNetBadNet`): { main, openPeer, orbs, lab, view, canvas, aim,
// myPos, phone, viewport, raf, inputs, untilReady }, each a function. The page passes its own kit, and the frame's page has its own.
// The pure parts (createJumpMeter, scoresMatch, nearestOrb, isPhoneViewport, judgeTouchLeg) have no page in them and run in Node's tests too.

export const BAD_LATENCY_MS = 250;
export const BAD_LOSS_PCT = 5;
export const LEG_MS = 60_000;
export const WARMUP_MS = 2_000; // the lab's 250 ms starts all at once: frames already on their way land, then the feed settles. Measured apart, as `remoteJumpOnsetPx`.
export const JUMP_LIMIT_PX = 40;
export const SETTLE_MS = 15_000;
export const STALL_FRAME_MS = 200; // a frame this late is the browser stalling (a GC pause, a hidden tab), not the netcode
export const MIN_TRAVEL_PX = 800; // the other player has to have really moved, or a still dot would pass with 0 px
export const MIN_FRAMES = 120;
export const PHONE_W = 390;
export const PHONE_H = 844;
export const MIN_TOUCH_GESTURES = 20; // a 60 s chase by stick is a few hundred touches; fewer means it was not steered by touch
const SPEED = 260; // arena units a second: the demo's own top speed for keys and for the full stick

/**
 * Largest single-frame jump of one drawn dot. Feed it one `frame(ms, x, y)` per drawn frame (x, y in CSS px) and `gap()`
 * when the dot isn't drawn. A frame later than `stallMs` after the one before is counted as stalled and starts over
 * (the browser stopped, which says nothing about the netcode); a freeze that ends in a snap shows as a big jump on a
 * frame that came on time, so it still counts. `result().from` / `.to` are the two positions of the largest jump.
 */
export function createJumpMeter({ stallMs = STALL_FRAME_MS } = {}) {
  let last = null, frames = 0, stalled = 0, max = 0, maxAt = 0, travel = 0, first = null, maxFrameMs = 0, from = null, to = null;
  return {
    frame(t, x, y) {
      if (first === null) first = t;
      if (last) {
        const dt = t - last.t;
        if (dt > stallMs) stalled++;
        else {
          const d = Math.hypot(x - last.x, y - last.y);
          frames++; travel += d; if (dt > maxFrameMs) maxFrameMs = dt;
          if (d > max) { max = d; maxAt = t - first; from = [last.x, last.y]; to = [x, y]; }
        }
      }
      last = { t, x, y };
    },
    gap() { last = null; },
    result: () => ({
      maxPx: Math.round(max * 10) / 10, atMs: Math.round(maxAt), frames, stalledFrames: stalled, travelPx: Math.round(travel), maxFrameMs: Math.round(maxFrameMs),
      from: from && from.map(Math.round), to: to && to.map(Math.round),
    }),
  };
}

/** Whether a viewport ({ w, h } in CSS px) is the phone's 390x844 (a few px of scrollbar or toolbar allowed). */
export function isPhoneViewport(vp) {
  return Boolean(vp) && Math.abs(vp.w - PHONE_W) <= 8 && Math.abs(vp.h - PHONE_H) <= 20;
}

/**
 * Whether the leg was steered by touch: `inputs` is what the page's own input layer counted ({ touch, stick, key, mouse }). Needs at
 * least `min` touch gestures on the floating stick and no arrow key at all. Returns { ok, why }.
 */
export function judgeTouchLeg(inputs, min = MIN_TOUCH_GESTURES) {
  const i = { touch: 0, stick: 0, key: 0, mouse: 0, ...(inputs ?? {}) };
  if (i.key > 0) return { ok: false, why: `the client was steered with ${i.key} arrow key press(es), not by touch alone` };
  if (i.touch < min) return { ok: false, why: `only ${i.touch} touch gesture(s) reached the page's input layer (need ${min})` };
  if (i.stick < min) return { ok: false, why: `only ${i.stick} of the touches were on the floating stick (need ${min})` };
  return { ok: true, why: `${i.touch} touch gestures, ${i.stick} on the floating stick, no keys` };
}

/** One score board as a comparable object: the round, the phase, and one number per player id (a missing player is 0). */
const board = (s) => ({ round: s?.round ?? 0, phase: s?.phase ?? '', scores: { ...(s?.scores ?? {}) } });

/** Whether two clients' orb snapshots (hawkesNetOrbs.snapshot) agree on the round, the phase and every player's score. */
export function scoresMatch(a, b) {
  const x = board(a), y = board(b), diffs = [];
  if (x.round !== y.round) diffs.push(`round ${x.round} / ${y.round}`);
  if (x.phase !== y.phase) diffs.push(`phase ${x.phase || '–'} / ${y.phase || '–'}`);
  for (const id of new Set([...Object.keys(x.scores), ...Object.keys(y.scores)])) {
    const p = x.scores[id] || 0, q = y.scores[id] || 0;
    if (p !== q) diffs.push(`${id} ${p} / ${q}`);
  }
  return { match: diffs.length === 0, diffs, why: diffs.length ? `the clients differ: ${diffs.join(', ')}` : 'same round, phase and scores' };
}

/** The orb nearest to (x, y) in a snapshot's list, or null. */
export function nearestOrb(orbs, x, y) {
  let best = null, bd = Infinity;
  for (const o of orbs ?? []) { const d = Math.hypot(o.x - x, o.y - y); if (d < bd) { bd = d; best = o; } }
  return best;
}

const showScores = (s) => JSON.stringify(board(s).scores);

/**
 * Opens /demo in a visible 390x844 frame on this page, in a room of its own, and returns { kit, close }: the frame page's client kit.
 * The frame is scaled down by CSS to fit a short window (its own viewport stays 390x844, which is what the page lays out for and
 * what the leg measures in). Throws when the frame does not load or the page in it does not join its room.
 */
export async function openPhoneFrame({ until, path = '/demo', doc = document, win = window } = {}) {
  const frame = doc.createElement('iframe');
  const k = Math.min(1, Math.max(0.35, (win.innerHeight - 16) / PHONE_H));
  frame.title = 'Hawkes Net demo, the phone client under playtest';
  frame.style.cssText = `position:fixed;right:12px;top:8px;width:${PHONE_W}px;height:${PHONE_H}px;border:0;outline:2px solid #7db1ff;border-radius:10px;background:#0b0d11;z-index:99997;transform:scale(${k});transform-origin:top right`;
  frame.src = `${path}?room=bn-${Math.random().toString(36).slice(2, 8)}`;
  const close = () => { try { frame.contentWindow?.hawkesNetLab?.set({ latency: 0, jitter: 0, loss: 0 }); } catch { /* gone */ } frame.remove(); };
  try {
    const loaded = new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`${path} did not load in a ${PHONE_W}x${PHONE_H} frame in 20 s`)), 20000);
      frame.addEventListener('load', () => { clearTimeout(t); res(); }, { once: true });
    });
    doc.body.appendChild(frame);
    await loaded;
    await until(() => frame.contentWindow?.hawkesNetBadNet, 15000, 'the page in the phone frame to offer its client');
    const kit = frame.contentWindow.hawkesNetBadNet;
    await kit.untilReady(until);
    return { kit, close };
  } catch (e) { close(); throw e; }
}

/**
 * The checks. `own` is this page's client kit; `openPhone(until)` returns { kit, close } for a phone client when this page is not one
 * (see openPhoneFrame). Everything that touches a page comes in through the kit, so the page decides how its player is moved (`aim`)
 * and what is drawn (`view`). `register(fn)` is told what to run if the scenario is stopped half way.
 */
export async function badNetworkChecks({
  check, until, wait, metric, event = () => {}, scene = () => {}, warn = () => {}, register = () => {},
  own, openPhone, legMs = LEG_MS,
}) {
  const runner = own.viewport();
  metric('remoteJumpLimitPx', JUMP_LIMIT_PX);
  metric('badNetRunnerViewport', `${runner.w}x${runner.h}`);

  let c = null, closeFrame = null, bot = null, lab = null;
  const labOff = () => { try { lab?.set({ latency: 0, jitter: 0, loss: 0 }); } catch { /* gone */ } };
  const cleanup = async () => { labOff(); try { await bot?.leave(); } catch { /* gone */ } bot = null; closeFrame?.(); closeFrame = null; };
  register(cleanup);
  try {
    // ---- the phone client: this page when it is one, else a 390x844 frame of the demo. No phone client, no pass.
    await check('One client is a phone: 390x844, steered by touch (the floating stick)', async () => {
      let framed = false;
      if (isPhoneViewport(runner) && own.phone()) c = own;
      else {
        if (!openPhone) throw new Error(`this run is ${runner.w}x${runner.h} and no phone client can be opened`);
        const f = await openPhone(until);
        c = f.kit; closeFrame = f.close; framed = true;
      }
      const v = c.viewport();
      metric('badNetViewport', `${v.w}x${v.h}`); metric('badNetPhoneFrame', framed ? 1 : 0);
      if (!isPhoneViewport(v)) { c = null; throw new Error(`the client's viewport is ${v.w}x${v.h}, not ${PHONE_W}x${PHONE_H}`); }
      if (!c.phone()) { c = null; throw new Error(`the client is ${v.w}x${v.h} but did not switch to the phone layout (no floating stick)`); }
      metric('badNetPhone', 1);
      scene('bad-network-phone');
      event('phone-client', `${v.w}x${v.h}${framed ? ` in a frame on a ${runner.w}x${runner.h} page` : ', the page itself'}`);
      return `${v.w}x${v.h}${framed ? `, in a frame on this ${runner.w}x${runner.h} page` : ', this page'}, phone layout`;
    });
    if (!c) { metric('badNetPhone', 0); return; }
    lab = c.lab();
    lab.set({ latency: 0, jitter: 0, loss: 0 });
    lab.close();
    const orbs = c.orbs();
    const main = c.main();

    await check('A second player joined the phone client\'s room, and the phone client draws it', async () => {
      bot = await c.openPeer('Far player');
      orbs.wire(bot);
      const ms = await until(() => main.peers.has(bot.id) && bot.peers.has(main.id) && c.view()?.items?.some((i) => i.id === bot.id), 20000, 'both players to see each other and the phone client to draw the other');
      metric('badNetJoinMs', Math.round(ms));
      return `${Math.round(ms)} ms`;
    });
    if (!bot) return;

    // The lab shims a client's socket and its peer to peer link as a guest, but a peer to peer host hears the others straight off
    // its own channels. On the relay every pose this client sees comes through the shim, so the leg plays there (smoke does the same move).
    await check('The room is on the relay, so everything the phone client sees crosses its bad network', async () => {
      if (main.transport !== 'relay') {
        main.migrate('bad-network');
        const ms = await until(() => main.transport === 'relay' && bot.transport === 'relay' && main.peers.has(bot.id) && bot.peers.has(main.id), 20000, () => `both players on the relay (now ${main.transport} / ${bot.transport})`);
        metric('badNetMigrateMs', Math.round(ms));
      }
      await until(() => c.view()?.items?.some((i) => i.id === bot.id), 5000, 'the phone client to draw the other player on the relay');
      return `transport ${main.transport}`;
    });

    // ---- the leg
    let jump = null, net = null, awards = null, endMs = 0, gapAtEnd = null, inputs0 = null, inputs1 = null;
    const bigJumps = [];
    await check(`For ${legMs / 1000} s at ${BAD_LATENCY_MS} ms latency and ${BAD_LOSS_PCT}% loss both players chase orbs and the other player's dot is measured every frame`, async () => {
      lab.set({ latency: BAD_LATENCY_MS, jitter: 0, loss: BAD_LOSS_PCT });
      const on = lab.get();
      if (on.latency !== BAD_LATENCY_MS || on.loss !== BAD_LOSS_PCT || !on.active) throw new Error(`the lab is ${JSON.stringify(on)}`);
      metric('badNetLatencyMs', on.latency); metric('badNetLossPct', on.loss);
      event('bad-network-on', `${on.latency} ms, ${on.loss}% loss`);
      scene('bad-network-leg');
      const meter = createJumpMeter(), onset = createJumpMeter(), netMeter = createJumpMeter();
      let running = true, lastView = null, warm = true, prev1 = null, tLeg = null;
      const onFrame = (ts) => {
        if (!running) return;
        const v = c.view();
        if (v && v !== lastView) { // the page makes a new view object each frame it draws
          lastView = v;
          const it = v.items?.find((i) => i.id === bot.id);
          const cr = c.canvas().getBoundingClientRect();
          if (it && cr.width > 0) {
            const sx = cr.width / (v.w || 960), sy = cr.height / (v.h || 600);
            const x = it.x * sx, y = it.y * sy, nx = (it.nx ?? it.x) * sx, ny = (it.ny ?? it.y) * sy;
            (warm ? onset : meter).frame(ts, x, y);
            if (!warm) {
              if (tLeg === null) tLeg = ts;
              netMeter.frame(ts, nx, ny);
              if (prev1 && ts - prev1.t <= STALL_FRAME_MS) {
                const d = Math.hypot(x - prev1.x, y - prev1.y);
                if (d > JUMP_LIMIT_PX && bigJumps.length < 6) {
                  const dn = Math.hypot(nx - prev1.nx, ny - prev1.ny), s = orbs.snapshot(main);
                  bigJumps.push({ at: Math.round(ts - tLeg), px: Math.round(d), netPx: Math.round(dn), frameMs: Math.round(ts - prev1.t), round: s.round, phase: s.phase });
                }
              }
              prev1 = { t: ts, x, y, nx, ny };
            }
          } else { (warm ? onset : meter).gap(); netMeter.gap(); prev1 = null; }
        }
        c.raf(onFrame);
      };
      c.raf(onFrame);
      // The second client chases the nearest orb at the demo's own top speed, as a player holding the stick would.
      const me = { x: 200 + Math.random() * 560, y: 150 + Math.random() * 300 };
      let lastTick = performance.now();
      const botTick = setInterval(() => {
        try {
          const t = performance.now(), dt = Math.min(0.1, (t - lastTick) / 1000); lastTick = t;
          const snap = orbs.snapshot(bot), o = snap.phase === 'play' ? nearestOrb(snap.orbs, me.x, me.y) : null;
          if (o) {
            const d = Math.hypot(o.x - me.x, o.y - me.y) || 1, step = Math.min(d, SPEED * dt);
            me.x += ((o.x - me.x) / d) * step; me.y += ((o.y - me.y) / d) * step;
          }
          bot.pose([me.x, 0, me.y], 0);
          orbs.touchAt(bot, me.x, me.y);
          orbs.hostRoundTick(bot);
        } catch { /* left */ }
      }, 33);
      // The phone client's player chases orbs through real input: a quarter second of stick toward the nearest orb, again and again.
      let driver = Promise.resolve();
      const drive = async () => {
        while (running) {
          const p = c.myPos(), snap = orbs.snapshot(main), o = snap.phase === 'play' ? nearestOrb(snap.orbs, p[0], p[2]) : null;
          if (!o) { await wait(150); continue; }
          await c.aim(o.x - p[0], o.y - p[2], 250);
        }
      };
      inputs0 = c.inputs();
      driver = drive().catch(() => {});
      // Scores the way the phone client sees them: every rise of a player's number counts as an award (a new round starts over).
      const seen = { main: 0, bot: 0 };
      let prev = null;
      let t0 = performance.now();
      let nextNote = 5000;
      try {
        await wait(WARMUP_MS);
        warm = false; meter.gap(); t0 = performance.now();
        metric('remoteJumpOnsetPx', onset.result().maxPx);
        while (performance.now() - t0 < legMs) {
          await wait(100);
          const s = orbs.snapshot(main);
          if (prev && prev.round === s.round) {
            seen.main += Math.max(0, (s.scores[main.id] || 0) - (prev.scores[main.id] || 0));
            seen.bot += Math.max(0, (s.scores[bot.id] || 0) - (prev.scores[bot.id] || 0));
          }
          prev = s;
          const el = performance.now() - t0;
          if (el >= nextNote) { // the run's timeline stays alive for the whole minute (and Studio sees progress)
            nextNote += 5000;
            const r = meter.result();
            event('bad-network', `${Math.round(el / 1000)} s: largest jump ${r.maxPx} px, ${r.frames} frames, scores ${seen.main}/${seen.bot} seen`);
          }
        }
      } finally {
        running = false; clearInterval(botTick);
      }
      endMs = Math.round(performance.now() - t0);
      await driver;
      jump = meter.result(); net = netMeter.result(); awards = seen; inputs1 = c.inputs();
      gapAtEnd = scoresMatch(orbs.snapshot(main), orbs.snapshot(bot));
      metric('remoteJumpMaxPx', jump.maxPx);
      metric('remoteJumpAtMs', jump.atMs);
      metric('remoteJumpNetworkPx', net.maxPx); // the same dot before the page keeps dots apart: the netcode's own part of the jump
      metric('badNetFrames', jump.frames);
      metric('badNetStalledFrames', jump.stalledFrames);
      metric('badNetMaxFrameMs', jump.maxFrameMs);
      metric('badNetTravelPx', jump.travelPx);
      metric('badNetLegMs', endMs);
      for (const j of bigJumps) event('bad-network-jump', `${(j.at / 1000).toFixed(1)} s: ${j.px} px drawn, ${j.netPx} px from the network position, frame ${j.frameMs} ms, round ${j.round} ${j.phase}`);
      event('bad-network-end', `largest remote jump ${jump.maxPx} px at ${(jump.atMs / 1000).toFixed(1)} s over ${jump.frames} frames (${net.maxPx} px before the page keeps dots apart)`);
      return `${Math.round(endMs / 1000)} s, ${jump.frames} frames measured`;
    });

    await check('The phone client was steered by touch alone, the whole leg', async () => {
      if (!inputs1) throw new Error('the leg did not finish');
      const d = { touch: inputs1.touch - inputs0.touch, stick: inputs1.stick - inputs0.stick, key: inputs1.key - inputs0.key, mouse: inputs1.mouse - inputs0.mouse };
      metric('badNetTouchGestures', d.touch); metric('badNetStickGestures', d.stick); metric('badNetKeyPresses', d.key);
      const j = judgeTouchLeg(d);
      if (!j.ok) throw new Error(j.why);
      return j.why;
    });

    await check('The other player really moved and was drawn on enough frames to measure', async () => {
      if (!jump) throw new Error('the leg did not finish');
      if (jump.frames < MIN_FRAMES) throw new Error(`only ${jump.frames} frames drew the other player (need ${MIN_FRAMES})`);
      if (jump.travelPx < MIN_TRAVEL_PX) throw new Error(`the other player moved only ${jump.travelPx} px in ${Math.round(endMs / 1000)} s (need ${MIN_TRAVEL_PX})`);
      return `${jump.frames} frames, ${jump.travelPx} px travelled${jump.stalledFrames ? `, ${jump.stalledFrames} stalled frame(s) skipped` : ''}`;
    });

    await check(`The other player glides: the largest single-frame jump stays under ${JUMP_LIMIT_PX} px`, async () => {
      if (!jump) throw new Error('the leg did not finish');
      if (jump.maxPx > JUMP_LIMIT_PX) {
        const where = jump.from && jump.to ? `, from ${jump.from.join(',')} to ${jump.to.join(',')}` : '';
        throw new Error(`the other player jumped ${jump.maxPx} px in one frame at ${(jump.atMs / 1000).toFixed(1)} s${where} (limit ${JUMP_LIMIT_PX} px; the network position alone moved ${net?.maxPx ?? '?'} px in a frame)`);
      }
      return `largest jump ${jump.maxPx} px (limit ${JUMP_LIMIT_PX} px)`;
    });

    await check('Both players scored during the leg, so the scores are worth comparing', async () => {
      if (!awards) throw new Error('the leg did not finish');
      metric('badNetAwardsYou', awards.main); metric('badNetAwardsOther', awards.bot);
      if (awards.main < 1 || awards.bot < 1) throw new Error(`the phone client saw ${awards.main} orb(s) for its player and ${awards.bot} for the other (each needs one)`);
      return `the phone client saw ${awards.main} and ${awards.bot} orb(s) collected`;
    });

    // ---- the end: the lab goes off, then the two clients' scores
    await check('Scores match on both clients after the bad-network leg', async () => {
      lab.set({ latency: 0, jitter: 0, loss: 0 });
      event('bad-network-off', gapAtEnd?.match ? 'scores already the same' : `at the end: ${gapAtEnd?.why}`);
      metric('scoreMatchedAtEnd', gapAtEnd?.match ? 1 : 0);
      const t0 = performance.now();
      let last = null;
      try {
        await until(() => { last = scoresMatch(orbs.snapshot(main), orbs.snapshot(bot)); return last.match; }, SETTLE_MS, () => last?.why ?? 'the scores to agree');
      } catch (e) {
        const a = orbs.snapshot(main), b = orbs.snapshot(bot);
        metric('scoreMatch', 0);
        throw new Error(`${last?.why ?? e.message} after ${SETTLE_MS / 1000} s: the phone client ${showScores(a)}, the other ${showScores(b)}`);
      }
      const ms = Math.round(performance.now() - t0);
      const a = orbs.snapshot(main), b = orbs.snapshot(bot);
      metric('scoreMatch', 1); metric('scoreSettleMs', ms);
      metric('scoreYou', a.scores[main.id] || 0); metric('scoreOther', a.scores[bot.id] || 0);
      event('scores', `the phone client ${showScores(a)} · the other ${showScores(b)}`);
      scene('bad-network-scores');
      return `${showScores(a)} on both${ms > 150 ? ` after ${ms} ms` : ''}`;
    });
  } finally {
    await cleanup();
  }
}

/** Adds the `bad-network` scenario to hawkesPlaytest without changing the shared demo-playtest.mjs. `kit` is this page's client kit (a function or an object). */
export function addBadNetworkScenario(api, {
  where = typeof location !== 'undefined' ? location.host : 'Hawkes Net',
  kit, openPhone = (until) => openPhoneFrame({ until }), legMs = LEG_MS,
} = {}) {
  const scenario = {
    id: 'bad-network',
    title: `Bad mobile network: ${BAD_LATENCY_MS} ms and ${BAD_LOSS_PCT}% loss for ${legMs / 1000} s, the other player glides and scores agree`,
    seconds: Math.round(legMs / 1000) + 60,
    tags: ['full', 'multiplayer', 'phone', 'netcode'],
    description: `A ${PHONE_W}x${PHONE_H} touch client (this page on a phone run, else a ${PHONE_W}x${PHONE_H} frame of the demo on the page) gets the Network lab at ${BAD_LATENCY_MS} ms and ${BAD_LOSS_PCT}% loss for ${legMs / 1000} s while its player chases orbs by real touch on the floating stick and a second client does too. Measures the other player's drawn dot on every frame and reports the largest single-frame jump in px (fails over ${JUMP_LIMIT_PX} px), then compares both clients' scores (fails when they differ). Fails when no phone touch client ran.`,
  };
  const original = { scenarios: api.scenarios, start: api.start, state: api.state, report: api.report, stop: api.stop };
  let run = null;
  const r1 = (n) => Math.round(n * 10) / 10;
  const now = () => (run ? (performance.now() - run.t0) / 1000 : 0);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const panel = typeof document === 'undefined' ? null : document.createElement('div');
  if (panel) {
    panel.id = 'hawkes-net-badnet-playtest';
    panel.style.cssText = 'position:fixed;left:8px;top:12px;z-index:99999;max-width:min(400px,92vw);background:rgba(10,12,16,.86);color:#e8eaed;font:12px/1.5 ui-monospace,Menlo,monospace;padding:8px 12px;border-radius:8px;display:none;pointer-events:none';
  }
  const show = () => {
    if (!run || !panel) return;
    if (!panel.isConnected) document.body.appendChild(panel);
    panel.style.display = 'block';
    const head = run.done ? (run.state.status === 'won' ? '<b style="color:#9fe870">PASS</b>' : `<b style="color:#ff7b72">${run.state.status === 'lost' ? 'FAIL' : run.state.status.toUpperCase()}</b>`) : '<b style="color:#ffd84d">running</b>';
    panel.innerHTML = `Playtest bad-network on ${esc(where)} · ${head}<br>` + run.lines.map((l) => `${l.ok === true ? '<span style="color:#9fe870">✓</span>' : l.ok === false ? '<span style="color:#ff7b72">✗</span>' : '…'} ${esc(l.text)}${l.why ? ` <span style="color:#9aa1ad">(${esc(l.why)})</span>` : ''}`).join('<br>');
  };
  const event = (type, detail) => { if (!run) return; run.events.push({ t: r1(now()), type, ...(detail === undefined ? {} : { detail: String(detail) }) }); run.moved = performance.now(); };
  const scene = (name) => { run.state.scene = name; event('scene', name); };
  const problem = (severity, message) => { if (!run.problems.some((p) => p.message === message)) { run.problems.push({ severity, message }); event('problem', `${severity}: ${message}`); } };
  const finish = (outcome) => {
    if (run.done) return;
    run.done = true; run.state.status = outcome; run.seconds = now();
    run.state.note = outcome === 'won' ? 'all checks passed' : `${run.lines.filter((l) => l.ok === false).length} check(s) failed`;
    event('finish', outcome); show();
  };
  async function check(text, fn) {
    const line = { text, ok: null, why: '' };
    run.lines.push(line); show(); event('check', text);
    try {
      const why = await fn();
      line.ok = true; line.why = typeof why === 'string' ? why : '';
      event('pass', text); run.metrics.checksPassed = (run.metrics.checksPassed ?? 0) + 1;
    } catch (e) {
      if (String(e?.message) === 'playtest stopped') throw e;
      line.ok = false; line.why = String(e?.message ?? e).slice(0, 320);
      problem('bug', `${text}: ${line.why}`); event('fail', text); run.metrics.checksFailed = (run.metrics.checksFailed ?? 0) + 1;
    }
    show();
    return line.ok;
  }
  const wait = (ms) => new Promise((res, rej) => { const r = run; setTimeout(() => (r === run && !r.done ? res() : rej(new Error('playtest stopped'))), ms); });
  const until = (test, ms, what) => new Promise((res, rej) => {
    const r = run, t0 = performance.now();
    const tick = () => {
      if (r !== run || r.done) return rej(new Error('playtest stopped'));
      let v = false; try { v = test(); } catch { /* not yet */ }
      if (v) return res(performance.now() - t0);
      if (performance.now() - t0 > ms) return rej(new Error(`timed out after ${Math.round(ms / 1000)} s waiting for ${typeof what === 'function' ? what() : what}`));
      setTimeout(tick, 40);
    };
    tick();
  });
  const mine = () => run && !run.done;
  const ownKit = () => (typeof kit === 'function' ? kit() : kit);

  api.scenarios = () => [...original.scenarios(), { ...scenario }];
  api.start = async (id, options = {}) => {
    if (id !== 'bad-network') { run = null; panel?.remove(); return original.start(id, options); }
    if (!run?.done && original.stop) original.stop();
    run = {
      t0: performance.now(), moved: performance.now(), done: false, lines: [], log: [], events: [], problems: [], metrics: {}, cleanup: null,
      state: { ready: true, status: 'running', progress: 0, scene: 'bad-network' },
    };
    const me = run;
    event('start', 'bad-network'); scene('bad-network'); show();
    try {
      const own = ownKit();
      if (!own) throw new Error('demo page is not ready');
      await own.untilReady(until);
      await badNetworkChecks({
        check, until, wait, metric: (k, v) => { me.metrics[k] = v; }, event, scene, warn: (m) => problem('warning', m),
        register: (fn) => { me.cleanup = fn; }, own, openPhone, legMs,
      });
      me.state.progress = 1;
      finish(me.lines.length && me.lines.every((l) => l.ok) ? 'won' : 'lost');
    } catch (e) {
      if (me === run && !me.done) { problem('bug', `bot error: ${e?.message ?? e}`); finish('error'); }
    }
  };
  api.state = () => {
    if (!run) return original.state();
    const base = original.state();
    if (!run.done && performance.now() - run.moved > 60 * 1000) { problem('bug', 'no progress for 60 s (softlock?)'); finish('stuck'); }
    return { ...run.state, ready: base.ready, metrics: { ...run.metrics } };
  };
  api.report = () => {
    if (!run) return original.report();
    return {
      scenario: 'bad-network',
      outcome: run.done ? run.state.status : 'stuck',
      seconds: r1(run.seconds ?? now()),
      metrics: { ...run.metrics },
      events: run.events.slice(),
      problems: run.problems.slice(),
      log: [...run.lines.map((l) => `${l.ok ? 'PASS' : l.ok === false ? 'FAIL' : '...'} ${l.text}${l.why ? ` (${l.why})` : ''}`), ...run.log],
    };
  };
  // Stopped half way: the lab goes off and the phone frame closes (the checks' own cleanup).
  api.stop = () => { if (mine()) { finish('done'); try { run.cleanup?.(); } catch { /* gone */ } } return original.stop(); };
  return api;
}
