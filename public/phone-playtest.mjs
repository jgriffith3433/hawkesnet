// Phone comfort checks for /demo (floating stick, safe-area HUD, collapsed panel, no sideways scroll).
// Wired from demo.html; shared demo-playtest.mjs stays free of hawkesnet-only checks.
//
// Studio must run this at device phone (390×844, touch). Past phone checks that ran at 1280×720 never showed a drag;
// this scenario fails loudly unless the viewport is phone-sized, then drags the stick with pointerType touch.

export const PHONE_W = 390;
export const PHONE_H = 844;

function phoneApi() {
  const a = typeof window !== 'undefined' ? window.hawkesNetPhone : null;
  if (!a || typeof a.phoneMode !== 'function' || typeof a.stick !== 'function') {
    throw new Error('the demo has no hawkesNetPhone API');
  }
  return a;
}

function orbsApi() {
  const a = typeof window !== 'undefined' ? window.hawkesNetOrbs : null;
  if (!a || typeof a.snapshot !== 'function' || typeof a.wire !== 'function') {
    throw new Error('the demo has no hawkesNetOrbs API');
  }
  return a;
}

/**
 * Acceptance criteria for phone comfort on the orb demo.
 * Real touch pointer events on the floating stick; no teleport. Named scenes for phone-sized screenshots.
 */
export async function phoneChecks({
  check, until, wait, metric, event = () => {}, scene = () => {},
  main, stickDrag,
}) {
  const phone = phoneApi();
  const orbs = orbsApi();
  orbs.wire(main);

  await check('The playtest runs at 390×844 (phone device)', async () => {
    const w = innerWidth, h = innerHeight;
    metric('phoneW', w); metric('phoneH', h);
    if (Math.abs(w - PHONE_W) > 8 || Math.abs(h - PHONE_H) > 20) {
      throw new Error(`viewport is ${w}×${h}, wanted ${PHONE_W}×${PHONE_H} (run with Studio device: phone — past checks at 1280×720 never showed a drag)`);
    }
    if (!phone.phoneMode()) throw new Error('phoneMode is off at phone size');
    event('phone-viewport', `${w}×${h}`);
    scene('phone-arena');
    return `${w}×${h}, phoneMode on`;
  });

  await check('At 390×844 the arena, timer and score fit with no sideways scroll', async () => {
    const sw = document.documentElement.scrollWidth, cw = document.documentElement.clientWidth;
    metric('phoneScrollOverflow', Math.max(0, sw - cw));
    if (sw > cw + 1) throw new Error(`page scrolls sideways: scrollWidth ${sw} > clientWidth ${cw}`);
    await until(() => orbs.snapshot(main).phase === 'play' || orbs.snapshot(main).orbs.length >= 5, 10000, 'a play round with orbs');
    const view = window.hawkesNetDemoView;
    const hud = view?.hud;
    if (!hud || hud.safe == null) throw new Error('arena HUD has no safe-area padding');
    if (view?.round?.phase === 'play' && (hud.timerLeft == null || hud.timerLeft < 0)) {
      throw new Error(`timer leftSec missing (${hud.timerLeft})`);
    }
    if (typeof hud.score !== 'number') throw new Error('score is not on the phone HUD');
    // Timer and score sit inside the canvas safe padding (top band).
    if (hud.safe.t < 8 || hud.safe.l < 8) throw new Error(`safe padding too small: t=${hud.safe.t} l=${hud.safe.l}`);
    event('phone-hud', `timer ${hud.timerLeft ?? '–'} score ${hud.score} safe t${Math.round(hud.safe.t)}/l${Math.round(hud.safe.l)}; no sideways scroll`);
    scene('phone-hud');
    return `no sideways scroll (${cw} px), timer + score in safe area`;
  });

  await check('The side panel is collapsed into a Room button outside the stick zone', async () => {
    const btn = phone.panelButton();
    if (!btn || getComputedStyle(btn).display === 'none') throw new Error('Room toggle is hidden at phone size');
    if (phone.panelOpen()) phone.setPanelOpen(false);
    await wait(40);
    if (phone.panelOpen()) throw new Error('side panel still open after collapse');
    const hits = phone.controlsInStickZone();
    if (hits.length) throw new Error(`tap target(s) inside the stick zone: ${hits.join(', ')}`);
    event('panel-collapsed', `Room button visible, stick zone clear`);
    return 'Room button shown, panel closed, stick zone free of buttons';
  });

  await check('A thumb drag on the floating stick moves the player and can collect an orb', async () => {
    if (typeof stickDrag !== 'function') throw new Error('stickDrag helper missing');
    await until(() => orbs.snapshot(main).orbs.length >= 1 && orbs.snapshot(main).phase === 'play', 10000, 'orbs in a play round');
    const before = orbs.snapshot(main);
    const scoreBefore = before.scores[main.id] || 0;
    // Place the player near an orb, then stick-drag into it (real touch path — no teleport into the orb).
    const target = before.orbs[0];
    const startX = Math.max(40, target.x - 110), startY = target.y;
    phone.setPos(startX, startY);
    main.pose([startX, 0, startY], 0);
    await wait(80);
    const pos0 = phone.pos();
    let sawRing = false, maxMag = 0;
    // Press in the lower half and pull toward the orb.
    const ou = 0.42, ov = 0.72;
    const ang = Math.atan2(target.y - pos0.y, target.x - pos0.x);
    const path = [
      [ou, ov],
      [ou + Math.cos(ang) * 0.12, Math.min(0.9, Math.max(0.55, ov + Math.sin(ang) * 0.08))],
      [ou + Math.cos(ang) * 0.2, Math.min(0.92, Math.max(0.55, ov + Math.sin(ang) * 0.12))],
    ];
    // Start the touch drag first; name the scene only once the stick is live so screenshots show the ring.
    let sceneNamed = false;
    const drag = stickDrag(path, 1400, {
      type: 'touch',
      sample: () => {
        const s = phone.stick();
        if (s) {
          sawRing = true;
          maxMag = Math.max(maxMag, s.mag);
          if (!sceneNamed) { sceneNamed = true; scene('phone-stick'); event('stick-down', `mag ${s.mag.toFixed(2)} at lower half`); }
        }
      },
    });
    await until(() => sceneNamed || phone.stick(), 800, 'the floating stick to appear');
    await wait(220); // hold phone-stick for the runner's screenshot
    await drag;
    await wait(100);
    const moved = Math.hypot(phone.pos().x - pos0.x, phone.pos().y - pos0.y);
    metric('stickMoveUnits', Math.round(moved));
    metric('stickMaxMag', Math.round(maxMag * 100) / 100);
    if (!sawRing) throw new Error('the floating stick ring never appeared');
    if (maxMag < phone.stickDead) throw new Error(`stick stayed in the dead zone (max mag ${maxMag.toFixed(2)})`);
    if (moved < 30) throw new Error(`stick drag moved the player only ${Math.round(moved)} units`);
    event('stick-moved', `moved ${Math.round(moved)} units, maxMag ${maxMag.toFixed(2)}`);

    // Keep steering with the stick until the orb is collected (or time out).
    const t0 = performance.now();
    while (performance.now() - t0 < 3500 && (orbs.snapshot(main).scores[main.id] || 0) <= scoreBefore) {
      const p = phone.pos();
      const o = orbs.snapshot(main).orbs.find((x) => x.id === target.id) || orbs.snapshot(main).orbs[0];
      if (!o) break;
      const a = Math.atan2(o.y - p.y, o.x - p.x);
      const u0 = 0.45, v0 = 0.75;
      await stickDrag([
        [u0, v0],
        [u0 + Math.cos(a) * 0.18, Math.min(0.92, Math.max(0.55, v0 + Math.sin(a) * 0.12))],
      ], 400, { type: 'touch' });
    }
    await until(() => (orbs.snapshot(main).scores[main.id] || 0) > scoreBefore, 2000, "this player's score to rise after stick collect");
    const after = orbs.snapshot(main);
    metric('phoneCollectScore', after.scores[main.id] || 0);
    event('stick-collect', `score ${scoreBefore}→${after.scores[main.id]}`);
    scene('phone-collect');
    await wait(350); // hold so the collect screenshot catches the stick / burst
    return `moved ${Math.round(moved)} units, collected an orb (${scoreBefore}→${after.scores[main.id]})`;
  });
}

/**
 * Adds the `phone` scenario to hawkesPlaytest without changing shared demo-playtest.mjs.
 */
export function addPhoneScenario(api, {
  where = typeof location !== 'undefined' ? location.host : 'Hawkes Net',
  main,
  stickDrag,
  untilReady,
} = {}) {
  const scenario = {
    id: 'phone',
    title: 'Phone comfort: floating stick, safe HUD, collapsed panel at 390×844',
    seconds: 50,
    tags: ['full', 'phone'],
    description: 'Must run at Studio device phone (390×844, touch). Checks no sideways scroll, timer and score in the safe area, Room button instead of the side panel, no tap targets in the stick zone, then drags the floating stick with touch pointer events to move and collect an orb. Scenes: phone-arena, phone-hud, phone-stick, phone-collect.',
  };
  const original = { scenarios: api.scenarios, start: api.start, state: api.state, report: api.report, stop: api.stop };
  let run = null;
  const r1 = (n) => Math.round(n * 10) / 10;
  const now = () => (run ? (performance.now() - run.t0) / 1000 : 0);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const panel = typeof document === 'undefined' ? null : document.createElement('div');
  if (panel) {
    panel.id = 'hawkes-net-phone-playtest';
    panel.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:99999;max-width:min(360px,90vw);background:rgba(10,12,16,.86);color:#e8eaed;font:12px/1.5 ui-monospace,Menlo,monospace;padding:8px 12px;border-radius:8px;display:none;pointer-events:none';
  }
  const show = () => {
    if (!run || !panel) return;
    if (!panel.isConnected) document.body.appendChild(panel);
    panel.style.display = 'block';
    const head = run.done ? (run.state.status === 'won' ? '<b style="color:#9fe870">PASS</b>' : `<b style="color:#ff7b72">${run.state.status === 'lost' ? 'FAIL' : run.state.status.toUpperCase()}</b>`) : '<b style="color:#ffd84d">running</b>';
    panel.innerHTML = `Playtest phone on ${esc(where)} · ${head}<br>` + run.lines.map((l) => `${l.ok === true ? '<span style="color:#9fe870">✓</span>' : l.ok === false ? '<span style="color:#ff7b72">✗</span>' : '…'} ${esc(l.text)}${l.why ? ` <span style="color:#9aa1ad">(${esc(l.why)})</span>` : ''}`).join('<br>');
  };
  const event = (type, detail) => { run.events.push({ t: r1(now()), type, ...(detail === undefined ? {} : { detail: String(detail) }) }); run.moved = performance.now(); };
  const scene = (name) => { run.state.scene = name; event('scene', name); };
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
    if (id !== 'phone') { run = null; panel?.remove(); return original.start(id, options); }
    if (!run?.done && original.stop) original.stop();
    run = { t0: performance.now(), moved: performance.now(), done: false, lines: [], log: [], events: [], problems: [], metrics: {}, note: '',
      state: { ready: true, status: 'running', progress: 0, scene: 'phone-arena' } };
    const me = run;
    event('start', 'phone'); scene('phone-arena'); show();
    try {
      if (untilReady) await untilReady(until);
      const room = typeof main === 'function' ? main() : main;
      if (!room) throw new Error('demo room is not ready');
      await phoneChecks({
        check, until, wait,
        metric: (k, v) => { me.metrics[k] = v; },
        event, scene, main: room, stickDrag,
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
    return { scenario: 'phone', outcome: run.done ? run.state.status : 'stuck', seconds: r1(run.seconds ?? now()), metrics: { ...run.metrics },
      events: run.events.slice(), problems: run.problems.slice(), log: [...run.lines.map((l) => `${l.ok ? 'PASS' : l.ok === false ? 'FAIL' : '...'} ${l.text}${l.why ? ` (${l.why})` : ''}`), ...run.log] };
  };
  api.stop = () => { if (mine()) finish('done'); return original.stop(); };
  return api;
}
