// Deploy-drain reconnect for /demo: Reconnecting banner, same room, back with a peer within 3 s.
// Wired from demo.html; shared demo-playtest.mjs stays free of hawkesnet-only checks.
//
// The playtest cannot SIGTERM beta's box. It injects the same `draining` control the node pushes on
// restart (SDK _onDrain), so the page skips resume, shows the banner, and rejoins with a fresh ticket.

/**
 * Acceptance: short Reconnecting banner, back in the same room with the other two players within 3 s.
 */
export async function drainChecks({
  check, until, wait, metric, event = () => {}, scene = () => {},
  main, openPeer, roomName,
}) {
  const banner = () => (typeof window !== 'undefined' && window.hawkesNetBanner ? window.hawkesNetBanner() : { state: '', text: '', log: [] });

  // Three players, as in npm test's "a 3-player room surviving a simulated node restart" (test/drain-restart.test.ts).
  const everyone = () => [main, ...(drainChecks._bots || [])];
  const seesAll = (list) => list.every((p) => p.status === 'online' && list.every((q) => q === p || p.peers.has(q.id)));

  await check('Three players are online in one room before the drain', async () => {
    const a = main;
    if (!a || a.status !== 'online') throw new Error('main player is not online');
    const name = roomName || a.room;
    const bots = [await openPeer('Drain peer 1'), await openPeer('Drain peer 2')];
    drainChecks._bots = bots;
    const all = [a, ...bots];
    await until(() => seesAll(all), 15000, 'all three players to see each other');
    event('room-ready', name);
    scene('drain-ready');
    metric('peersBefore', all.length);
    drainChecks._room = name;
    drainChecks._names = all.map((p) => p.name);
    return `room ${name}, ${drainChecks._names.join(' + ')}`;
  });

  await check('A draining notice shows the Reconnecting banner (no resume)', async () => {
    const before = banner().log.length;
    const t0 = performance.now();
    // Same control frame the node pushes on SIGTERM / deploy drain, to every client at once.
    for (const p of everyone()) p._controlIn({ c: 'draining', why: 'node restart' });
    await until(() => main.status === 'reconnecting' || banner().state === 'reconnecting', 3000, 'reconnecting status or banner');
    await until(() => banner().state === 'reconnecting' || banner().log.slice(before).some((e) => e.state === 'reconnecting'), 3000, 'the banner to say Reconnecting');
    event('reconnecting', banner().text);
    scene('drain-reconnecting');
    metric('bannerMs', Math.round(performance.now() - t0));
    drainChecks._t0 = t0;
    return banner().text || 'reconnecting';
  });

  await check('All three players are back in the same room within 3 s with their names', async () => {
    const all = everyone();
    const room = drainChecks._room;
    const t0 = drainChecks._t0 || performance.now();
    await until(() => seesAll(all), 3000, 'all three online and seeing each other again');
    const ms = Math.round(performance.now() - t0);
    metric('reconnectMs', ms);
    metric('peersAfter', all.length);
    if (ms > 3000) throw new Error(`back in ${ms} ms, wanted under 3000`);
    const drifted = all.filter((p) => p.room !== room);
    if (drifted.length) throw new Error(`room drifted: ${all.map((p) => p.room).join(' / ')}, wanted ${room}`);
    const names = all.map((p) => p.name).sort();
    const expect = [...drainChecks._names].sort();
    if (names.join('|') !== expect.join('|')) throw new Error(`names ${names.join(', ')}, wanted ${expect.join(', ')}`);
    await until(() => banner().state === 'online' || banner().state === '', 2000, 'the banner to clear');
    event('back', `${ms} ms in ${room}`);
    scene('drain-back');
    return `back in ${ms} ms, room ${room}, names ${names.join(' + ')}`;
  });

  for (const b of drainChecks._bots || []) { try { await b.leave(); } catch { /* gone */ } }
  drainChecks._bots = null;
}

/**
 * Adds the `drain` scenario to hawkesPlaytest without changing shared demo-playtest.mjs.
 */
export function addDrainScenario(api, {
  where = typeof location !== 'undefined' ? location.host : 'Hawkes Net',
  main,
  openPeer,
  roomName,
  untilReady,
} = {}) {
  const scenario = {
    id: 'drain',
    title: 'Deploy drain: 3-player room, Reconnecting banner, same room back within 3 s',
    seconds: 40,
    tags: ['full', 'multiplayer', 'drain'],
    description: 'Three players in one room; injects the node\'s draining notice (as on SIGTERM / deploy), checks the Reconnecting banner, then that all three are back in the same room with their names within 3 s.',
  };
  const original = { scenarios: api.scenarios, start: api.start, state: api.state, report: api.report, stop: api.stop };
  let run = null;
  const r1 = (n) => Math.round(n * 10) / 10;
  const now = () => (run ? (performance.now() - run.t0) / 1000 : 0);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const panel = typeof document === 'undefined' ? null : document.createElement('div');
  if (panel) {
    panel.id = 'hawkes-net-drain-playtest';
    panel.style.cssText = 'position:fixed;right:12px;top:12px;z-index:99999;max-width:420px;background:rgba(10,12,16,.86);color:#e8eaed;font:12px/1.5 ui-monospace,Menlo,monospace;padding:8px 12px;border-radius:8px;display:none;pointer-events:none';
  }
  const show = () => {
    if (!run || !panel) return;
    if (!panel.isConnected) document.body.appendChild(panel);
    panel.style.display = 'block';
    const head = run.done ? (run.state.status === 'won' ? '<b style="color:#9fe870">PASS</b>' : `<b style="color:#ff7b72">${run.state.status === 'lost' ? 'FAIL' : run.state.status.toUpperCase()}</b>`) : '<b style="color:#ffd84d">running</b>';
    panel.innerHTML = `Playtest drain on ${esc(where)} · ${head}<br>` + run.lines.map((l) => `${l.ok === true ? '<span style="color:#9fe870">✓</span>' : l.ok === false ? '<span style="color:#ff7b72">✗</span>' : '…'} ${esc(l.text)}${l.why ? ` <span style="color:#9aa1ad">(${esc(l.why)})</span>` : ''}`).join('<br>');
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
    if (id !== 'drain') { run = null; panel?.remove(); return original.start(id, options); }
    if (!run?.done && original.stop) original.stop();
    run = { t0: performance.now(), moved: performance.now(), done: false, lines: [], log: [], events: [], problems: [], metrics: {}, note: '',
      state: { ready: true, status: 'running', progress: 0, scene: 'drain-ready' } };
    const me = run;
    event('start', 'drain'); scene('drain-ready'); show();
    try {
      if (untilReady) await untilReady(until);
      const room = typeof main === 'function' ? main() : main;
      if (!room) throw new Error('demo room is not ready');
      await drainChecks({
        check, until, wait,
        metric: (k, v) => { me.metrics[k] = v; },
        event, scene, main: room, openPeer, roomName: typeof roomName === 'function' ? roomName() : roomName,
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
    return { scenario: 'drain', outcome: run.done ? run.state.status : 'stuck', seconds: r1(run.seconds ?? now()), metrics: { ...run.metrics },
      events: run.events.slice(), problems: run.problems.slice(), log: [...run.lines.map((l) => `${l.ok ? 'PASS' : l.ok === false ? 'FAIL' : '...'} ${l.text}${l.why ? ` (${l.why})` : ''}`), ...run.log] };
  };
  api.stop = () => { if (mine()) finish('done'); return original.stop(); };
  return api;
}
