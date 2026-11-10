// Moment-feedback checks for /demo (particles/+1/sound/pulse on collect, mute + unlock, join pop-in / leave fade).
// Wired from demo.html; shared demo-playtest.mjs stays free of hawkesnet-only checks (same pattern as site-playtest.mjs).

function feedbackApi() {
  const a = typeof window !== 'undefined' ? window.hawkesNetFeedback : null;
  if (!a || typeof a.lastCollect !== 'function' || typeof a.unlockAudio !== 'function') {
    throw new Error('the demo has no hawkesNetFeedback API');
  }
  return a;
}

function orbsApi() {
  const a = typeof window !== 'undefined' ? window.hawkesNetOrbs : null;
  if (!a || typeof a.snapshot !== 'function' || typeof a.touchAt !== 'function') {
    throw new Error('the demo has no hawkesNetOrbs API');
  }
  return a;
}

/**
 * Acceptance criteria for demo moment feedback. Uses real key/pointer to unlock audio, steers onto an orb by pose
 * (same path as the orb game), opens a peer for join/leave FX, and checks Mute via localStorage without leaving /demo.
 */
export async function feedbackChecks({ check, main, until, wait, metric, event = () => {}, openPeer, keyHold, pointerTap, driveTo }) {
  const fx = feedbackApi();
  const orbs = orbsApi();
  orbs.wire(main);

  await check('No pickup sound plays before the first tap or key', async () => {
    await wait(200);
    if (fx.unlocked()) throw new Error('audio was already unlocked before a player gesture');
    if (fx.soundsPlayed() !== 0) throw new Error(`heard ${fx.soundsPlayed()} sound(s) before unlock`);
    event('audio-locked', 'no sound before gesture');
    return 'audio still locked, 0 sounds';
  });

  await check('A real key or tap unlocks audio', async () => {
    if (typeof keyHold === 'function') await keyHold('ArrowRight', 40);
    else if (typeof pointerTap === 'function') await pointerTap([0.5, 0.5]);
    else {
      dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }));
    }
    await until(() => fx.unlocked(), 2000, 'audio to unlock after a key or tap');
    event('audio-unlocked', 'after real input');
    metric('audioUnlocked', 1);
    return 'unlocked after real input';
  });

  await check('Collecting an orb shows a particle burst, a +1 pop, a short arena pulse, and plays a pickup sound', async () => {
    await until(() => orbs.snapshot(main).orbs.length >= 5, 8000, 'orbs to appear');
    const before = orbs.snapshot(main);
    const target = before.orbs[0] && { ...before.orbs[0] };
    if (!target) throw new Error('no orb to collect');
    const scoreBefore = before.scores[main.id] || 0;
    const soundsBefore = fx.soundsPlayed();
    // Real pointer/key path when the page provides it; otherwise the same pose+touch path the orb checks use.
    if (typeof driveTo === 'function') {
      await driveTo(target.x, target.y);
      orbs.touchAt(main, target.x, target.y);
    } else {
      for (let i = 0; i < 48; i++) {
        const u = (i + 1) / 48;
        const x = target.x - 90 + 90 * u, y = target.y;
        main.pose([x, 0, y], 0);
        if (Math.hypot(x - target.x, y - target.y) <= 22) orbs.touchAt(main, x, y);
        await wait(25);
        if ((orbs.snapshot(main).scores[main.id] || 0) > scoreBefore) break;
      }
    }
    await until(() => (orbs.snapshot(main).scores[main.id] || 0) > scoreBefore, 4000, "this player's score to rise");
    await until(() => {
      const c = fx.lastCollect();
      return c && c.at > performance.now() - 2500 && fx.particles() > 0 && fx.pops() > 0;
    }, 4000, 'a collect burst and +1 pop');
    await until(() => fx.pulseActive() || (fx.lastCollect()?.pulseMs > 0 && performance.now() - fx.lastCollect().at < 500), 800, 'the soft arena pulse');
    const c = fx.lastCollect();
    if (!c) throw new Error('no collect feedback recorded');
    if (Math.hypot(c.x - target.x, c.y - target.y) > 8) throw new Error(`burst at ${Math.round(c.x)},${Math.round(c.y)} not on orb ${Math.round(target.x)},${Math.round(target.y)}`);
    await until(() => fx.soundsPlayed() > soundsBefore, 1500, 'the pickup sound to play');
    metric('collectParticles', c.particles);
    metric('collectSound', fx.soundsPlayed() - soundsBefore);
    event('collect-fx', `burst ${c.particles} +1 at ${Math.round(c.x)},${Math.round(c.y)} sound +${fx.soundsPlayed() - soundsBefore}`);
    // Hold so Studio's 1280×720 / 390×844 screenshots and clip catch the burst.
    await wait(450);
    return `burst ${c.particles}, +1 pop, pulse, sound (total ${fx.soundsPlayed()})`;
  });

  await check('Mute is remembered in localStorage and stops further pickup sounds', async () => {
    const soundsBefore = fx.soundsPlayed();
    fx.setMuted(true);
    let stored = '';
    try { stored = localStorage.getItem(fx.muteKey); } catch { throw new Error('localStorage threw'); }
    if (stored !== '1') throw new Error(`localStorage ${fx.muteKey} is "${stored}", wanted "1"`);
    const reread = fx.rereadMute();
    if (!reread || !fx.muted()) throw new Error('reread after "reload" did not keep Mute on');
    // Fire another collect while muted: visuals ok, no new sound.
    const snap = orbs.snapshot(main);
    const target = snap.orbs[0];
    if (target) {
      main.pose([target.x, 0, target.y], 0);
      orbs.touchAt(main, target.x, target.y);
      await wait(400);
    }
    if (fx.soundsPlayed() !== soundsBefore) throw new Error(`Mute on but sounds went ${soundsBefore}→${fx.soundsPlayed()}`);
    fx.setMuted(false);
    try { if (localStorage.getItem(fx.muteKey) !== '0') throw new Error('Unmute did not write 0'); } catch (e) { if (e.message?.includes('Unmute')) throw e; }
    event('mute', `stored ${stored}, reread kept mute, no sound while muted`);
    metric('muteRemembered', 1);
    return 'Mute stored, survives reread, blocks sound';
  });

  if (openPeer) {
    let peer = null;
    try {
      await check('A joining player pops in with a ring instead of appearing cold', async () => {
        peer = await openPeer();
        // Pose at once so layout draws the dot; pop-in arms on the first pose (ring is on a real peer, not empty air).
        const spot = [720, 0, 420];
        const hold = (async () => { for (let i = 0; i < 24; i++) { if (!peer) return; peer.pose(spot, 0); await wait(40); } })();
        const ms = await until(() => {
          const drawn = (window.hawkesNetDemoView?.items || []).some((it) => it.id === peer.id);
          const joining = fx.peerIn().includes(peer.id) || (window.hawkesNetDemoView?.items || []).some((it) => it.id === peer.id && it.joining);
          return drawn && joining;
        }, 8000, 'join pop-in ring on a drawn peer');
        event('peer-join-fx', peer.id);
        metric('joinFxMs', Math.round(ms));
        await wait(400); // ring visible on the clip
        await hold;
        return `pop-in for ${peer.id} after ${Math.round(ms)} ms`;
      });
      await check('A leaving player fades out instead of vanishing', async () => {
        const id = peer.id;
        // Keep posing so leave captures a real last sample (not the arena-centre fallback).
        for (let i = 0; i < 6; i++) { peer.pose([720, 0, 420], 0); await wait(30); }
        await peer.leave();
        peer = null;
        const ms = await until(() => fx.leavers().includes(id), 3000, 'leave fade FX on a drawn peer');
        event('peer-leave-fx', id);
        metric('leaveFxMs', Math.round(ms));
        await wait(360); // fade visible on the clip
        return `fade-out for ${id} after ${Math.round(ms)} ms`;
      });
    } finally {
      try { await peer?.leave(); } catch { /* gone */ }
    }
  }

  await check('Particle and pixel-ratio caps stay on for 60 fps', async () => {
    const caps = fx.caps;
    if (!caps || caps.maxParticles > 64 || caps.dprMax > 2) throw new Error(`caps too high: ${JSON.stringify(caps)}`);
    if (fx.dpr() > 2) throw new Error(`devicePixelRatio in use is ${fx.dpr()}, cap is 2`);
    if (fx.particles() > caps.maxParticles) throw new Error(`${fx.particles()} particles over cap ${caps.maxParticles}`);
    metric('fxDpr', fx.dpr());
    metric('fxMaxParticles', caps.maxParticles);
    return `dpr ${fx.dpr()}≤2, particles ≤${caps.maxParticles}`;
  });
}

/**
 * Adds the `feedback` scenario to hawkesPlaytest without changing shared demo-playtest.mjs.
 */
export function addFeedbackScenario(api, {
  where = typeof location !== 'undefined' ? location.host : 'Hawkes Net',
  main,
  openPeer,
  keyHold,
  pointerTap,
  driveTo,
  untilReady,
} = {}) {
  const scenario = {
    id: 'feedback',
    title: 'Orb collect burst/+1/sound, Mute remembered, join pop-in and leave fade',
    seconds: 45,
    tags: ['full', 'feedback'],
    description: 'Unlocks audio with a real key or tap, collects an orb and checks a particle burst, +1 pop, soft arena pulse and pickup sound, checks Mute in localStorage, then opens a peer to see join pop-in and leave fade.',
  };
  const original = { scenarios: api.scenarios, start: api.start, state: api.state, report: api.report, stop: api.stop };
  let run = null;
  const r1 = (n) => Math.round(n * 10) / 10;
  const now = () => (run ? (performance.now() - run.t0) / 1000 : 0);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const panel = typeof document === 'undefined' ? null : document.createElement('div');
  if (panel) {
    panel.id = 'hawkes-net-feedback-playtest';
    panel.style.cssText = 'position:fixed;right:12px;top:12px;z-index:99999;max-width:420px;background:rgba(10,12,16,.86);color:#e8eaed;font:12px/1.5 ui-monospace,Menlo,monospace;padding:8px 12px;border-radius:8px;display:none;pointer-events:none';
  }
  const show = () => {
    if (!run || !panel) return;
    if (!panel.isConnected) document.body.appendChild(panel);
    panel.style.display = 'block';
    const head = run.done ? (run.state.status === 'won' ? '<b style="color:#9fe870">PASS</b>' : `<b style="color:#ff7b72">${run.state.status === 'lost' ? 'FAIL' : run.state.status.toUpperCase()}</b>`) : '<b style="color:#ffd84d">running</b>';
    panel.innerHTML = `Playtest feedback on ${esc(where)} · ${head}<br>` + run.lines.map((l) => `${l.ok === true ? '<span style="color:#9fe870">✓</span>' : l.ok === false ? '<span style="color:#ff7b72">✗</span>' : '…'} ${esc(l.text)}${l.why ? ` <span style="color:#9aa1ad">(${esc(l.why)})</span>` : ''}`).join('<br>');
  };
  const event = (type, detail) => { run.events.push({ t: r1(now()), type, ...(detail === undefined ? {} : { detail: String(detail) }) }); run.moved = performance.now(); };
  const problem = (message) => { if (!run.problems.some((p) => p.message === message)) { run.problems.push({ severity: 'bug', message }); event('problem', `bug: ${message}`); } };
  const finish = (outcome) => {
    if (run.done) return;
    run.done = true; run.state.status = outcome; run.seconds = now();
    run.state.note = outcome === 'won' ? (run.note || 'all checks passed') : `${run.lines.filter((l) => l.ok === false).length} check(s) failed`;
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
      line.ok = false; line.why = String(e?.message ?? e).slice(0, 220);
      problem(`${text}: ${line.why}`); event('fail', text); run.metrics.checksFailed = (run.metrics.checksFailed ?? 0) + 1;
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
    if (id !== 'feedback') { run = null; panel?.remove(); return original.start(id, options); }
    if (!run?.done && original.stop) original.stop();
    run = { t0: performance.now(), moved: performance.now(), done: false, lines: [], log: [], events: [], problems: [], metrics: {}, note: '',
      state: { ready: true, status: 'running', progress: 0, scene: 'Demo' } };
    const me = run;
    event('start', 'feedback'); event('scene', 'Demo'); show();
    try {
      if (untilReady) await untilReady(until);
      const room = typeof main === 'function' ? main() : main;
      if (!room) throw new Error('demo room is not ready');
      await feedbackChecks({
        check, until, wait,
        metric: (k, v) => { me.metrics[k] = v; },
        event, main: room, openPeer, keyHold, pointerTap, driveTo,
      });
      finish(me.lines.every((l) => l.ok) ? 'won' : 'lost');
    } catch (e) {
      if (me === run && !me.done) { problem(`bot error: ${e?.message ?? e}`); finish('error'); }
    }
  };
  api.state = () => {
    if (!run) return original.state();
    const base = original.state();
    if (!run.done && performance.now() - run.moved > 60 * 1000) { problem('no progress for 60 s (softlock?)'); finish('stuck'); }
    return { ...run.state, ready: base.ready, metrics: { ...run.metrics } };
  };
  api.report = () => {
    if (!run) return original.report();
    return { scenario: 'feedback', outcome: run.done ? run.state.status : 'stuck', seconds: r1(run.seconds ?? now()), metrics: { ...run.metrics },
      events: run.events.slice(), problems: run.problems.slice(), log: [...run.lines.map((l) => `${l.ok ? 'PASS' : l.ok === false ? 'FAIL' : '...'} ${l.text}${l.why ? ` (${l.why})` : ''}`), ...run.log] };
  };
  api.stop = () => { if (mine()) finish('done'); return original.stop(); };
  return api;
}
