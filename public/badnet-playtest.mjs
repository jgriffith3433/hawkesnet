// The bad-network leg for /demo (public/demo.html + public/demo-lab.mjs): the `bad-network` scenario.
// Wired from demo.html like lab-playtest.mjs and orbs-playtest.mjs; the shared demo-playtest.mjs stays free of it.
//
// Player goal: on a bad mobile network (250 ms, 5% loss) other players still glide without teleporting, and scores agree.
//   1. This page's client gets the Network lab at 250 ms latency and 5% loss (its own sends and receives only).
//   2. For 60 s this page's player chases orbs by real input (the floating stick by touch at 390x844, arrow keys otherwise)
//      and a second client in the same room chases them too. Every drawn frame, this page measures how far the other
//      player's dot moved on screen, in CSS px: the largest single-frame jump is the number that says "it glided" or "it
//      teleported". Over JUMP_LIMIT_PX the run fails.
//   3. The lab goes off, both drivers stop, and the two clients' scores (round, phase, one score per player) must agree.
//      Lost messages are allowed to arrive late (the room re-sends its state every few seconds), not to stay different.
//
// The pure parts (createJumpMeter, scoresMatch, nearestOrb) have no page in them and run in Node's tests too.

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
const SPEED = 260; // arena units a second: the demo's own top speed for keys and for the full stick

/**
 * Largest single-frame jump of one drawn dot. Feed it one `frame(ms, x, y)` per drawn frame (x, y in CSS px) and `gap()`
 * when the dot isn't drawn. A frame later than `stallMs` after the one before is counted as stalled and starts over
 * (the browser stopped, which says nothing about the netcode); a freeze that ends in a snap shows as a big jump on a
 * frame that came on time, so it still counts.
 */
export function createJumpMeter({ stallMs = STALL_FRAME_MS } = {}) {
  let last = null, frames = 0, stalled = 0, max = 0, maxAt = 0, travel = 0, first = null, maxFrameMs = 0;
  return {
    frame(t, x, y) {
      if (first === null) first = t;
      if (last) {
        const dt = t - last.t;
        if (dt > stallMs) stalled++;
        else {
          const d = Math.hypot(x - last.x, y - last.y);
          frames++; travel += d; if (dt > maxFrameMs) maxFrameMs = dt;
          if (d > max) { max = d; maxAt = t - first; }
        }
      }
      last = { t, x, y };
    },
    gap() { last = null; },
    result: () => ({ maxPx: Math.round(max * 10) / 10, atMs: Math.round(maxAt), frames, stalledFrames: stalled, travelPx: Math.round(travel), maxFrameMs: Math.round(maxFrameMs) }),
  };
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
 * The checks. `main` is this page's room (the client with the lab), `bot` the second client. Everything that touches
 * the page comes in as an argument, so the page decides how its player is moved (`aim`) and what is drawn (`view`).
 */
export async function badNetworkChecks({
  check, until, wait, metric, event = () => {}, scene = () => {}, warn = () => {},
  main, openPeer, orbs, lab, view, canvas, aim, myPos, phone, legMs = LEG_MS,
}) {
  const w = innerWidth, h = innerHeight;
  const phoneVp = Math.abs(w - PHONE_W) <= 8 && Math.abs(h - PHONE_H) <= 20;
  const touchPhone = phoneVp && Boolean(typeof phone === 'function' ? phone() : phone);
  metric('badNetViewport', `${w}x${h}`);
  metric('badNetPhone', touchPhone ? 1 : 0);
  metric('badNetTouchPoints', navigator.maxTouchPoints ?? 0);
  metric('remoteJumpLimitPx', JUMP_LIMIT_PX);
  lab.set({ latency: 0, jitter: 0, loss: 0 });
  lab.close();

  let bot = null;
  try {
    await check('A second player joined this room, and this page draws it', async () => {
      bot = await openPeer('Far player');
      orbs.wire(bot);
      const ms = await until(() => main.peers.has(bot.id) && bot.peers.has(main.id) && view()?.items?.some((i) => i.id === bot.id), 20000, 'both players to see each other and this page to draw the other');
      metric('badNetJoinMs', Math.round(ms));
      return `${Math.round(ms)} ms`;
    });
    if (!bot) return;

    // The lab shims this client's socket and its peer to peer link as a guest, but a peer to peer host hears the others straight off
    // its own channels. On the relay every pose this client sees comes through the shim, so the leg plays there (smoke does the same move).
    await check('The room is on the relay, so everything this client sees crosses its bad network', async () => {
      if (main.transport !== 'relay') {
        main.migrate('bad-network');
        const ms = await until(() => main.transport === 'relay' && bot.transport === 'relay' && main.peers.has(bot.id) && bot.peers.has(main.id), 20000, () => `both players on the relay (now ${main.transport} / ${bot.transport})`);
        metric('badNetMigrateMs', Math.round(ms));
      }
      await until(() => view()?.items?.some((i) => i.id === bot.id), 5000, 'this page to draw the other player on the relay');
      return `transport ${main.transport}`;
    });

    await check(touchPhone ? 'One client plays at 390x844 by touch (the floating stick)' : 'One client plays at 390x844 by touch', async () => {
      if (!touchPhone) {
        // The viewport is the runner's: a desktop run can't be a phone. Studio's phone twin plays this same leg at 390x844.
        warn(`this run is ${w}x${h}, not ${PHONE_W}x${PHONE_H} touch: the leg ran with arrow keys. Run the phone device for the touch leg.`);
        return `${w}x${h}: arrow keys (the phone device plays it at ${PHONE_W}x${PHONE_H} by touch)`;
      }
      scene('bad-network-phone');
      return `${w}x${h}, touch layout, stick drag input`;
    });

    // ---- the leg
    let jump = null, awards = null, endMs = 0, gapAtEnd = null;
    await check(`For ${legMs / 1000} s at ${BAD_LATENCY_MS} ms latency and ${BAD_LOSS_PCT}% loss both players chase orbs and the other player's dot is measured every frame`, async () => {
      lab.set({ latency: BAD_LATENCY_MS, jitter: 0, loss: BAD_LOSS_PCT });
      const on = lab.get();
      if (on.latency !== BAD_LATENCY_MS || on.loss !== BAD_LOSS_PCT || !on.active) throw new Error(`the lab is ${JSON.stringify(on)}`);
      metric('badNetLatencyMs', on.latency); metric('badNetLossPct', on.loss);
      event('bad-network-on', `${on.latency} ms, ${on.loss}% loss`);
      scene('bad-network-leg');
      const meter = createJumpMeter(), onset = createJumpMeter();
      let running = true, lastView = null, warm = true;
      const raf = (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (f) => setTimeout(() => f(performance.now()), 16));
      const onFrame = (ts) => {
        if (!running) return;
        const v = view();
        if (v && v !== lastView) { // the page makes a new view object each frame it draws
          lastView = v;
          const it = v.items?.find((i) => i.id === bot.id);
          const cr = canvas().getBoundingClientRect();
          if (it && cr.width > 0) (warm ? onset : meter).frame(ts, it.x * (cr.width / (v.w || 960)), it.y * (cr.height / (v.h || 600)));
          else (warm ? onset : meter).gap();
        }
        raf(onFrame);
      };
      raf(onFrame);
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
      // This page's player chases orbs through real input: a quarter second of keys or stick toward the nearest orb, again and again.
      let driver = Promise.resolve();
      const drive = async () => {
        while (running) {
          const p = myPos(), snap = orbs.snapshot(main), o = snap.phase === 'play' ? nearestOrb(snap.orbs, p[0], p[2]) : null;
          if (!o) { await wait(150); continue; }
          await aim(o.x - p[0], o.y - p[2], 250);
        }
      };
      driver = drive().catch(() => {});
      // Scores the way this page sees them: every rise of a player's number counts as an award (a new round starts over).
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
      jump = meter.result(); awards = seen;
      gapAtEnd = scoresMatch(orbs.snapshot(main), orbs.snapshot(bot));
      metric('remoteJumpMaxPx', jump.maxPx);
      metric('remoteJumpAtMs', jump.atMs);
      metric('badNetFrames', jump.frames);
      metric('badNetStalledFrames', jump.stalledFrames);
      metric('badNetMaxFrameMs', jump.maxFrameMs);
      metric('badNetTravelPx', jump.travelPx);
      metric('badNetLegMs', endMs);
      event('bad-network-end', `largest remote jump ${jump.maxPx} px at ${(jump.atMs / 1000).toFixed(1)} s over ${jump.frames} frames`);
      return `${Math.round(endMs / 1000)} s, ${jump.frames} frames measured`;
    });

    await check('The other player really moved and was drawn on enough frames to measure', async () => {
      if (!jump) throw new Error('the leg did not finish');
      if (jump.frames < MIN_FRAMES) throw new Error(`only ${jump.frames} frames drew the other player (need ${MIN_FRAMES})`);
      if (jump.travelPx < MIN_TRAVEL_PX) throw new Error(`the other player moved only ${jump.travelPx} px in ${Math.round(endMs / 1000)} s (need ${MIN_TRAVEL_PX})`);
      return `${jump.frames} frames, ${jump.travelPx} px travelled${jump.stalledFrames ? `, ${jump.stalledFrames} stalled frame(s) skipped` : ''}`;
    });

    await check(`The other player glides: the largest single-frame jump stays under ${JUMP_LIMIT_PX} px`, async () => {
      if (!jump) throw new Error('the leg did not finish');
      if (jump.maxPx > JUMP_LIMIT_PX) throw new Error(`the other player jumped ${jump.maxPx} px in one frame at ${(jump.atMs / 1000).toFixed(1)} s (limit ${JUMP_LIMIT_PX} px)`);
      return `largest jump ${jump.maxPx} px (limit ${JUMP_LIMIT_PX} px)`;
    });

    await check('Both players scored during the leg, so the scores are worth comparing', async () => {
      if (!awards) throw new Error('the leg did not finish');
      metric('badNetAwardsYou', awards.main); metric('badNetAwardsOther', awards.bot);
      if (awards.main < 1 || awards.bot < 1) throw new Error(`this page saw ${awards.main} orb(s) for the player here and ${awards.bot} for the other (each needs one)`);
      return `this page saw ${awards.main} and ${awards.bot} orb(s) collected`;
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
        throw new Error(`${last?.why ?? e.message} after ${SETTLE_MS / 1000} s: this client ${showScores(a)}, the other ${showScores(b)}`);
      }
      const ms = Math.round(performance.now() - t0);
      const a = orbs.snapshot(main), b = orbs.snapshot(bot);
      metric('scoreMatch', 1); metric('scoreSettleMs', ms);
      metric('scoreYou', a.scores[main.id] || 0); metric('scoreOther', a.scores[bot.id] || 0);
      event('scores', `this client ${showScores(a)} · the other ${showScores(b)}`);
      scene('bad-network-scores');
      return `${showScores(a)} on both${ms > 150 ? ` after ${ms} ms` : ''}`;
    });
  } finally {
    lab.set({ latency: 0, jitter: 0, loss: 0 });
    try { await bot?.leave(); } catch { /* gone */ }
  }
}

/** Adds the `bad-network` scenario to hawkesPlaytest without changing the shared demo-playtest.mjs. */
export function addBadNetworkScenario(api, {
  where = typeof location !== 'undefined' ? location.host : 'Hawkes Net',
  main, openPeer, orbs, lab, view, canvas, aim, myPos, phone, untilReady, legMs = LEG_MS,
} = {}) {
  const scenario = {
    id: 'bad-network',
    title: `Bad mobile network: ${BAD_LATENCY_MS} ms and ${BAD_LOSS_PCT}% loss for ${legMs / 1000} s, the other player glides and scores agree`,
    seconds: Math.round(legMs / 1000) + 50,
    tags: ['full', 'multiplayer', 'phone', 'netcode'],
    description: `Sets this client's Network lab to ${BAD_LATENCY_MS} ms and ${BAD_LOSS_PCT}% loss for ${legMs / 1000} s while this player chases orbs by real input (the floating stick by touch at 390x844) and a second client does too. Measures the other player's drawn dot on every frame and reports the largest single-frame jump in px (fails over ${JUMP_LIMIT_PX} px), then compares both clients' scores (fails when they differ).`,
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
      line.ok = false; line.why = String(e?.message ?? e).slice(0, 260);
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

  api.scenarios = () => [...original.scenarios(), { ...scenario }];
  api.start = async (id, options = {}) => {
    if (id !== 'bad-network') { run = null; panel?.remove(); return original.start(id, options); }
    if (!run?.done && original.stop) original.stop();
    run = {
      t0: performance.now(), moved: performance.now(), done: false, lines: [], log: [], events: [], problems: [], metrics: {},
      state: { ready: true, status: 'running', progress: 0, scene: 'bad-network' },
    };
    const me = run;
    event('start', 'bad-network'); scene('bad-network'); show();
    try {
      if (untilReady) await untilReady(until);
      const room = typeof main === 'function' ? main() : main;
      if (!room) throw new Error('demo room is not ready');
      await badNetworkChecks({
        check, until, wait, metric: (k, v) => { me.metrics[k] = v; }, event, scene, warn: (m) => problem('warning', m),
        main: room, openPeer, orbs: typeof orbs === 'function' ? orbs() : orbs, lab: typeof lab === 'function' ? lab() : lab,
        view, canvas, aim, myPos, phone, legMs,
      });
      me.state.progress = 1;
      finish(me.lines.every((l) => l.ok) ? 'won' : 'lost');
    } catch (e) {
      if (me === run && !me.done) { problem('bug', `bot error: ${e?.message ?? e}`); finish('error'); }
    }
  };
  api.state = () => {
    if (!run) return original.state();
    const base = original.state();
    if (!run.done && performance.now() - run.moved > 60 * 1000) { problem('bug', 'no progress for 60 s (softlock?)'); finish('stuck'); }
    // The lab is this scenario's to switch off if it is stopped half way.
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
  api.stop = () => { if (mine()) { finish('done'); try { (typeof lab === 'function' ? lab() : lab)?.set({ latency: 0, jitter: 0, loss: 0 }); } catch { /* gone */ } } return original.stop(); };
  return api;
}
