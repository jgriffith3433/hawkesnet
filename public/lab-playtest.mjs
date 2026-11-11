// Network lab checks for /demo: latency / jitter / loss on this client only, Lab on chip, phone bottom sheet.
// Wired from demo.html; shared demo-playtest.mjs stays free of hawkesnet-only checks.

export const PHONE_W = 390;
export const PHONE_H = 844;
export const LAB_LATENCY_MS = 250;
export const LAB_TOL_MS = 50;
export const LAB_GAP_MS = 100;

function labApi() {
  const a = typeof window !== 'undefined' ? window.hawkesNetLab : null;
  if (!a || typeof a.set !== 'function' || typeof a.get !== 'function') {
    throw new Error('the demo has no hawkesNetLab API');
  }
  return a;
}

function tap(el, type = 'touch') {
  if (!el) throw new Error('missing tap target');
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  const base = { clientX: x, clientY: y, pointerId: type === 'mouse' ? 3 : 9, pointerType: type, isPrimary: true, bubbles: true, cancelable: true, button: 0, buttons: 1 };
  el.dispatchEvent(new PointerEvent('pointerdown', base));
  el.dispatchEvent(new PointerEvent('pointerup', { ...base, buttons: 0 }));
  el.click();
}

/**
 * Acceptance criteria for the Network lab panel.
 * Real pointer/key input for moves and panel taps. Named scenes for desktop and 390×844 screenshots.
 */
export async function labChecks({
  check, until, wait, metric, event = () => {}, scene = () => {},
  main, openPeer, openInRoom, roomName, myPos, setPos, keyHold, stickDrag, phone, canvas,
}) {
  const lab = labApi();
  const phoneMode = typeof phone === 'function' ? phone() : Boolean(phone);
  const w = innerWidth, h = innerHeight;
  const phoneVp = Math.abs(w - PHONE_W) <= 8 && Math.abs(h - PHONE_H) <= 20;
  metric('labViewport', `${w}x${h}`);
  metric('labPhone', phoneVp || phoneMode ? 1 : 0);

  lab.close();
  lab.set({ latency: 0, jitter: 0, loss: 0 });
  lab.clearStamps();
  await wait(40);

  await check('Network lab starts off and hawkesPlaytest.lab sets latency / jitter / loss', async () => {
    const off = lab.get();
    if (off.active) throw new Error('lab was already active');
    const chip = document.getElementById('lab-chip');
    if (chip && !chip.hidden) throw new Error('Lab on chip visible while lab is off');
    if (typeof window.hawkesPlaytest?.lab !== 'function') throw new Error('window.hawkesPlaytest.lab missing');
    window.hawkesPlaytest.lab({ latency: 100, jitter: 30, loss: 5 });
    const on = lab.get();
    metric('labLatency', on.latency); metric('labJitter', on.jitter); metric('labLoss', on.loss);
    if (on.latency !== 100 || on.jitter !== 30 || on.loss !== 5) throw new Error(`lab set to ${JSON.stringify(on)}`);
    if (!on.active) throw new Error('lab not active after set');
    if (!chip || chip.hidden || !/Lab on/i.test(chip.textContent || '')) throw new Error('Lab on chip not visible while active');
    event('lab-on', `latency ${on.latency} jitter ${on.jitter} loss ${on.loss}`);
    scene(phoneVp ? 'lab-phone-chip' : 'lab-desktop-chip');
    window.hawkesPlaytest.lab({ latency: 0, jitter: 0, loss: 0 });
    if (lab.get().active) throw new Error('lab still active after reset');
    if (chip && !chip.hidden) throw new Error('Lab on chip still visible after reset');
    return 'lab() sets values; Lab on chip tracks active';
  });

  await check('The panel sets the same values by real taps (folded card or Lab button)', async () => {
    lab.close();
    const fab = document.getElementById('lab-toggle');
    const panel = document.getElementById('lab-panel');
    if (!panel) throw new Error('lab panel missing');
    const type = phoneVp || phoneMode ? 'touch' : 'mouse';
    if (phoneVp || phoneMode) {
      if (!fab || getComputedStyle(fab).display === 'none') throw new Error('Lab button hidden at phone size');
      tap(fab, 'touch');
      await until(() => lab.isOpen() && !panel.hidden, 2000, 'the lab bottom sheet to open');
      event('lab-sheet-open', 'from Lab button');
      scene('lab-phone-sheet');
    } else {
      const head = panel.querySelector('.lab-head');
      tap(head || panel, 'mouse');
      await until(() => lab.isOpen() && panel.classList.contains('open'), 2000, 'the lab card to unfold');
      event('lab-card-open', 'folded card');
      scene('lab-desktop-card');
    }
    const latBtn = panel.querySelector('[data-lab="latency"][data-value="250"]');
    const jitBtn = panel.querySelector('[data-lab="jitter"][data-value="0"]');
    const lossBtn = panel.querySelector('[data-lab="loss"][data-value="0"]');
    if (!latBtn || !jitBtn || !lossBtn) throw new Error('lab option buttons missing');
    tap(latBtn, type); tap(jitBtn, type); tap(lossBtn, type);
    await wait(60);
    const s = lab.get();
    if (s.latency !== 250 || s.jitter !== 0 || s.loss !== 0) throw new Error(`panel left lab at ${JSON.stringify(s)}`);
    const chip = document.getElementById('lab-chip');
    if (!chip || chip.hidden) throw new Error('Lab on chip missing after panel set 250 ms');
    return `panel set latency ${s.latency} ms; chip on`;
  });

  // Criterion 2: 250 ms latency, jitter 0 — move A→B delay and steady receive gaps.
  await check(`With latency ${LAB_LATENCY_MS} ms and jitter 0, a move reaches the other player about ${LAB_LATENCY_MS}±${LAB_TOL_MS} ms later`, async () => {
    lab.set({ latency: LAB_LATENCY_MS, jitter: 0, loss: 0 });
    lab.clearStamps();
    const peer = await openPeer('Lab peer');
    try {
      await until(() => main.peers.has(peer.id) && peer.peers.has(main.id), 15000, 'lab peer in the room');
      const recv = [];
      let collect = false;
      const off = peer.onPose((id, s) => {
        if (id !== main.id || !collect) return;
        recv.push({ t: performance.now(), x: s.p[0], y: s.p[2] });
        if (recv.length > 120) recv.shift();
      });
      // Distinct move so the peer's pose stream has a clear edge to measure against the lab wire-out stamp.
      const start = myPos();
      setPos(Math.min(900, start[0] + 180), start[2]);
      main.pose([myPos()[0], 0, myPos()[2]], 0);
      await wait(LAB_LATENCY_MS + 100); // let the setup pose clear the lab queue
      lab.clearStamps();
      recv.length = 0;
      collect = true;
      if (phoneVp || phoneMode) {
        if (typeof stickDrag !== 'function') throw new Error('stickDrag missing');
        await stickDrag([[0.4, 0.72], [0.62, 0.72], [0.78, 0.78]], 900);
      } else if (typeof keyHold === 'function') {
        await keyHold('ArrowRight', 700);
        await keyHold('ArrowDown', 500);
      } else {
        throw new Error('no drive helper');
      }
      await until(() => lab.wireOut().length >= 3 && recv.length >= 3, 8000, 'lab wire-out and peer pose samples');
      await wait(LAB_LATENCY_MS + 80);
      const outs = lab.wireOut();
      // Pair each outbound flush with the first pose the peer saw after that send left the shim.
      const delays = [];
      let ri = 0;
      for (const ot of outs) {
        while (ri < recv.length && recv[ri].t < ot) ri++;
        if (ri >= recv.length) break;
        delays.push(recv[ri].t - ot);
        ri++;
      }
      if (delays.length < 2) throw new Error(`not enough paired samples (outs ${outs.length}, recv ${recv.length})`);
      const median = delays.slice().sort((a, b) => a - b)[Math.floor(delays.length / 2)];
      metric('labOneWayMs', Math.round(median));
      metric('labDelaySamples', delays.length);
      event('lab-delay', `${Math.round(median)} ms median over ${delays.length}`);
      if (Math.abs(median - LAB_LATENCY_MS) > LAB_TOL_MS) {
        throw new Error(`one-way ${Math.round(median)} ms, wanted ${LAB_LATENCY_MS}±${LAB_TOL_MS}`);
      }
      // Gaps between received poses should stay tight with jitter 0 (SDK ~33 ms flush).
      const gaps = [];
      for (let i = 1; i < recv.length; i++) gaps.push(recv[i].t - recv[i - 1].t);
      const maxGap = Math.max(...gaps);
      metric('labMaxRecvGapMs', Math.round(maxGap));
      if (maxGap > LAB_GAP_MS) throw new Error(`peer pose gap ${Math.round(maxGap)} ms > ${LAB_GAP_MS} ms`);
      event('lab-gaps', `max ${Math.round(maxGap)} ms`);
      scene(phoneVp ? 'lab-phone-delay' : 'lab-desktop-delay');
      off();
      return `one-way ${Math.round(median)} ms, max recv gap ${Math.round(maxGap)} ms`;
    } finally {
      try { await peer.leave(); } catch { /* gone */ }
    }
  });

  // Criterion 4: another room has no added delay from this page's lab.
  await check('A client in a different room sees no added delay on its own moves', async () => {
    lab.set({ latency: LAB_LATENCY_MS, jitter: 0, loss: 0 });
    const otherRoom = `${roomName()}-lab-${Math.random().toString(36).slice(2, 7)}`;
    const a = await openInRoom(otherRoom, 'Other A');
    const b = await openInRoom(otherRoom, 'Other B');
    try {
      if (a._hawkesLab || b._hawkesLab) throw new Error('other-room clients were wrapped by the lab shim');
      await until(() => a.peers.has(b.id) && b.peers.has(a.id), 15000, 'both clients in the other room');
      const recv = [];
      const off = b.onPose((id, s) => {
        if (id !== a.id) return;
        recv.push({ t: performance.now(), x: s.p[0], y: s.p[2] });
      });
      const t0 = performance.now();
      let x = 120;
      for (let i = 0; i < 12; i++) {
        x += 25;
        a.pose([x, 0, 300 + i * 2], 0);
        await wait(40);
      }
      await until(() => recv.length >= 4, 5000, 'poses in the other room');
      const delays = recv.map((r) => r.t - t0);
      // First pose should land well under the lab latency (no shim on these clients).
      const first = delays[0];
      metric('labOtherRoomFirstMs', Math.round(first));
      metric('labOtherRoomSamples', recv.length);
      if (first > 120) throw new Error(`other room first pose at ${Math.round(first)} ms (lab would add ~${LAB_LATENCY_MS})`);
      event('lab-other-room', `first pose ${Math.round(first)} ms, n=${recv.length}`);
      scene('lab-other-room');
      off();
      return `other room first pose ${Math.round(first)} ms (no lab delay)`;
    } finally {
      try { await a.leave(); } catch { /* */ }
      try { await b.leave(); } catch { /* */ }
    }
  });

  // [phone] Criterion 3: bottom sheet from Lab button; closed sheet does not overlay the arena.
  await check('At 390×844 the lab opens as a bottom sheet from a small button, and closing it clears the arena', async () => {
    if (!phoneVp) {
      throw new Error(`viewport is ${w}×${h}, wanted ${PHONE_W}×${PHONE_H} (Studio device: phone for [phone] criteria)`);
    }
    lab.set({ latency: 100, jitter: 0, loss: 0 });
    lab.close();
    await wait(40);
    const fab = document.getElementById('lab-toggle');
    const panel = document.getElementById('lab-panel');
    const backdrop = document.getElementById('lab-backdrop');
    if (!fab || getComputedStyle(fab).display === 'none') throw new Error('Lab button not shown at phone size');
    if (fab.getBoundingClientRect().width < 40 || fab.getBoundingClientRect().height < 40) {
      throw new Error('Lab button is not a small tap target');
    }
    tap(fab, 'touch');
    await until(() => lab.isOpen() && panel && !panel.hidden && panel.classList.contains('open'), 2000, 'bottom sheet open');
    const pr = panel.getBoundingClientRect();
    if (pr.bottom < h - 8) throw new Error(`sheet not docked to the bottom (bottom ${Math.round(pr.bottom)} of ${h})`);
    if (backdrop?.hidden) throw new Error('backdrop missing while sheet is open');
    event('lab-phone-open', `sheet h=${Math.round(pr.height)}`);
    scene('lab-phone-open');
    const closeBtn = document.getElementById('lab-close');
    tap(closeBtn || backdrop, 'touch');
    await until(() => !lab.isOpen(), 2000, 'sheet to close');
    await wait(80);
    const cv = typeof canvas === 'function' ? canvas() : canvas;
    if (!lab.clearOfCanvas(cv)) throw new Error('lab sheet or overlay still overlaps the arena after close');
    if (panel && !panel.hidden && getComputedStyle(panel).display !== 'none') {
      throw new Error('lab panel still displayed after close');
    }
    if (backdrop && !backdrop.hidden) throw new Error('lab backdrop still shown after close');
    event('lab-phone-closed', 'arena clear');
    scene('lab-phone-closed');
    lab.set({ latency: 0, jitter: 0, loss: 0 });
    return 'bottom sheet from Lab button; closed with no overlay on the arena';
  });

  lab.set({ latency: 0, jitter: 0, loss: 0 });
  lab.close();
}

/**
 * Adds the `lab` scenario to hawkesPlaytest without changing shared demo-playtest.mjs.
 */
export function addLabScenario(api, {
  where = typeof location !== 'undefined' ? location.host : 'Hawkes Net',
  main,
  openPeer,
  openInRoom,
  roomName,
  myPos,
  setPos,
  keyHold,
  stickDrag,
  phone,
  canvas,
  untilReady,
} = {}) {
  const scenario = {
    id: 'lab',
    title: 'Network lab: latency / jitter / loss on this client, Lab on chip, phone bottom sheet',
    seconds: 75,
    tags: ['full', 'lab', 'phone'],
    description: 'Sets the Network lab from the panel and window.hawkesPlaytest.lab, checks the Lab on chip, measures ~250 ms one-way pose delay with steady receive gaps, checks another room is unaffected, and at 390×844 opens/closes the bottom sheet with touch so nothing overlays the arena.',
  };
  const original = { scenarios: api.scenarios, start: api.start, state: api.state, report: api.report, stop: api.stop };
  let run = null;
  const r1 = (n) => Math.round(n * 10) / 10;
  const now = () => (run ? (performance.now() - run.t0) / 1000 : 0);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const panel = typeof document === 'undefined' ? null : document.createElement('div');
  if (panel) {
    panel.id = 'hawkes-net-lab-playtest';
    panel.style.cssText = 'position:fixed;left:8px;top:12px;z-index:99999;max-width:min(400px,92vw);background:rgba(10,12,16,.86);color:#e8eaed;font:12px/1.5 ui-monospace,Menlo,monospace;padding:8px 12px;border-radius:8px;display:none;pointer-events:none';
  }
  const show = () => {
    if (!run || !panel) return;
    if (!panel.isConnected) document.body.appendChild(panel);
    panel.style.display = 'block';
    const head = run.done ? (run.state.status === 'won' ? '<b style="color:#9fe870">PASS</b>' : `<b style="color:#ff7b72">${run.state.status === 'lost' ? 'FAIL' : run.state.status.toUpperCase()}</b>`) : '<b style="color:#ffd84d">running</b>';
    panel.innerHTML = `Playtest lab on ${esc(where)} · ${head}<br>` + run.lines.map((l) => `${l.ok === true ? '<span style="color:#9fe870">✓</span>' : l.ok === false ? '<span style="color:#ff7b72">✗</span>' : '…'} ${esc(l.text)}${l.why ? ` <span style="color:#9aa1ad">(${esc(l.why)})</span>` : ''}`).join('<br>');
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
    if (id !== 'lab') { run = null; panel?.remove(); return original.start(id, options); }
    if (!run?.done && original.stop) original.stop();
    run = {
      t0: performance.now(), moved: performance.now(), done: false, lines: [], log: [], events: [], problems: [], metrics: {}, note: '',
      state: { ready: true, status: 'running', progress: 0, scene: 'lab' },
    };
    const me = run;
    event('start', 'lab'); scene('lab'); show();
    try {
      if (untilReady) await untilReady(until);
      const room = typeof main === 'function' ? main() : main;
      if (!room) throw new Error('demo room is not ready');
      await labChecks({
        check, until, wait,
        metric: (k, v) => { me.metrics[k] = v; },
        event, scene, main: room, openPeer, openInRoom, roomName, myPos, setPos, keyHold, stickDrag, phone, canvas,
      });
      me.state.progress = 1;
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
    return {
      scenario: 'lab',
      outcome: run.done ? run.state.status : 'stuck',
      seconds: r1(run.seconds ?? now()),
      metrics: { ...run.metrics },
      events: run.events.slice(),
      problems: run.problems.slice(),
      log: [...run.lines.map((l) => `${l.ok ? 'PASS' : l.ok === false ? 'FAIL' : '...'} ${l.text}${l.why ? ` (${l.why})` : ''}`), ...run.log],
    };
  };
  api.stop = () => { if (mine()) finish('done'); return original.stop(); };
  return api;
}
