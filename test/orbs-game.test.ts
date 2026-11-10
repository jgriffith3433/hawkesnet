// Host-authoritative orbs over the real SDK: same 5 orbs, collect raises score on both within 500 ms, late joiner sees state,
// rounds end with a shared result then restart, and host migration keeps the same round clock and scores.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestHub } from './helper.ts';
import { join } from '../sdk/js/hawkes-net.mjs';

const wait = (test: () => unknown, ms: number, what: string) => new Promise<number>((res, rej) => {
  const t0 = Date.now();
  const tick = () => {
    try { if (test()) return res(Date.now() - t0); } catch { /* not yet */ }
    if (Date.now() - t0 > ms) return rej(new Error(`timed out waiting for ${what}`));
    setTimeout(tick, 20);
  };
  tick();
});

const ORB_N = 5;
const RESULT_MS = 3000;
const pad = 40, W = 960, H = 600;
const randOrb = () => ({ x: pad + Math.random() * (W - 2 * pad), y: pad + Math.random() * (H - 2 * pad) });

function wire(room: any, playMs = 60_000) {
  const game: any = {
    orbs: [] as any[], scores: {} as Record<string, number>, seq: 0, applied: new Set<number>(),
    round: 0, phase: '', endsAt: 0, playMs, winner: null as any, board: [] as any[],
  };
  room.sync.state('orbs', {
    get: () => ({
      orbs: game.orbs, scores: game.scores, seq: game.seq,
      round: game.round, phase: game.phase, endsAt: game.endsAt, playMs: game.playMs,
      winner: game.winner, board: game.board,
    }),
    set: (s: any) => {
      if (!s) return;
      if (Array.isArray(s.orbs)) game.orbs = s.orbs.map((o: any) => ({ id: o.id, x: +o.x, y: +o.y, gen: +o.gen || 1 }));
      if (s.scores) game.scores = { ...s.scores };
      if (Number.isFinite(s.seq)) game.seq = s.seq;
      if (Number.isFinite(s.round)) game.round = s.round;
      if (s.phase === 'play' || s.phase === 'result') game.phase = s.phase;
      if (Number.isFinite(s.endsAt)) game.endsAt = s.endsAt;
      if (Number.isFinite(s.playMs)) game.playMs = s.playMs;
      if (s.winner === null) game.winner = null;
      else if (s.winner) game.winner = { id: String(s.winner.id || ''), name: String(s.winner.name || ''), score: +s.winner.score || 0 };
      if (Array.isArray(s.board)) game.board = s.board.map((r: any) => ({ id: String(r.id || ''), name: String(r.name || ''), score: +r.score || 0 }));
    },
    rate: 8,
  });
  const award = room.sync.action('orb-award', (data: any) => {
    if (!data || data.n == null || game.applied.has(data.n)) return;
    game.applied.add(data.n);
    game.seq = Math.max(game.seq, data.n);
    if (game.phase === 'result') return;
    const by = String(data.by || '');
    if (by) game.scores[by] = (game.scores[by] || 0) + 1;
    const orb = game.orbs.find((o: any) => o.id === data.orb);
    if (orb) { orb.x = +data.nx; orb.y = +data.ny; orb.gen = (orb.gen || 1) + 1; }
  });
  const touch = room.sync.action('orb-touch', (data: any, { authoritative }: any) => {
    if (!authoritative || !data || game.phase !== 'play') return;
    const orb = game.orbs.find((o: any) => o.id === data.orb);
    if (!orb || (data.gen != null && data.gen !== orb.gen)) return;
    const p = randOrb();
    award({ orb: orb.id, by: data.by, nx: Math.round(p.x), ny: Math.round(p.y), n: game.seq + 1 });
  });
  const endRound = room.sync.action('orb-round-end', (data: any) => {
    if (!data || data.n == null || game.applied.has(data.n)) return;
    game.applied.add(data.n);
    game.seq = Math.max(game.seq, data.n);
    game.phase = 'result';
    game.endsAt = Number.isFinite(data.endsAt) ? data.endsAt : Date.now() + RESULT_MS;
    if (Number.isFinite(data.round)) game.round = data.round;
    game.winner = data.winner ? { id: String(data.winner.id || ''), name: String(data.winner.name || ''), score: +data.winner.score || 0 } : null;
    game.board = Array.isArray(data.board) ? data.board.map((r: any) => ({ id: String(r.id || ''), name: String(r.name || ''), score: +r.score || 0 })) : [];
  });
  const startRound = room.sync.action('orb-round-start', (data: any) => {
    if (!data || data.n == null || game.applied.has(data.n)) return;
    game.applied.add(data.n);
    game.seq = Math.max(game.seq, data.n);
    game.round = Number.isFinite(data.round) ? data.round : (game.round || 0) + 1;
    game.phase = 'play';
    game.playMs = Number.isFinite(data.playMs) ? data.playMs : playMs;
    game.endsAt = Number.isFinite(data.endsAt) ? data.endsAt : Date.now() + game.playMs;
    game.scores = {};
    game.winner = null;
    game.board = [];
    if (Array.isArray(data.orbs) && data.orbs.length === ORB_N) {
      game.orbs = data.orbs.map((o: any) => ({ id: o.id, x: +o.x, y: +o.y, gen: +o.gen || 1 }));
    } else {
      game.orbs = Array.from({ length: ORB_N }, (_, i) => { const p = randOrb(); return { id: `o${i}`, x: Math.round(p.x), y: Math.round(p.y), gen: 1 }; });
    }
  });
  const boot = () => {
    if (!room.isHost) return;
    if (game.phase === 'play' || game.phase === 'result') {
      if (game.phase === 'play' && game.orbs.length !== ORB_N) {
        game.orbs = Array.from({ length: ORB_N }, (_, i) => { const p = randOrb(); return { id: `o${i}`, x: Math.round(p.x), y: Math.round(p.y), gen: 1 }; });
      }
      return;
    }
    const ms = game.playMs || playMs;
    startRound({
      n: (game.seq || 0) + 1, round: 1, playMs: ms, endsAt: Date.now() + ms,
      orbs: Array.from({ length: ORB_N }, (_, i) => { const p = randOrb(); return { id: `o${i}`, x: Math.round(p.x), y: Math.round(p.y), gen: 1 }; }),
    });
  };
  boot();
  room.sync.onHost(() => { if (room.isHost) boot(); });
  const tick = () => {
    if (!room.isHost) return;
    const now = Date.now();
    if (game.phase === 'play' && game.endsAt && now >= game.endsAt) {
      const ids = new Set([...Object.keys(game.scores), room.id, ...room.peers.keys()]);
      const board = [...ids].map((id) => ({
        id, name: id === room.id ? room.name : (room.peers.get(id)?.name || id), score: game.scores[id] || 0,
      })).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
      endRound({ n: game.seq + 1, round: game.round, endsAt: now + RESULT_MS, winner: board[0] ? { ...board[0] } : null, board });
    } else if (game.phase === 'result' && game.endsAt && now >= game.endsAt) {
      const ms = game.playMs || playMs;
      startRound({
        n: game.seq + 1, round: (game.round || 0) + 1, playMs: ms, endsAt: now + ms,
        orbs: Array.from({ length: ORB_N }, (_, i) => { const p = randOrb(); return { id: `o${i}`, x: Math.round(p.x), y: Math.round(p.y), gen: 1 }; }),
      });
    }
  };
  return { game, touch, tick, startRound };
}

test('orb game: same orbs, collect within 500 ms on both, late joiner sees scores', async () => {
  const hub = await startTestHub();
  const opts = (name: string, sub: string) => ({
    project: 'netdemo', endpoint: hub.url, transport: 'relay' as const, name, log: false, leaveOnHide: false, sub,
  });
  const a = await join('orbs1', opts('Host', 'a'));
  const b = await join('orbs1', opts('Guest', 'b'));
  try {
    await wait(() => a.peers.has(b.id) && b.peers.has(a.id), 5000, 'peers');
    const wa = wire(a), wb = wire(b);
    await wait(() => wa.game.orbs.length === ORB_N && wb.game.orbs.length === ORB_N, 8000, 'both to see 5 orbs');
    assert.equal(wa.game.orbs.length, ORB_N);
    assert.deepEqual(
      wa.game.orbs.map((o: any) => `${o.id}:${o.x}:${o.y}:${o.gen}`).sort(),
      wb.game.orbs.map((o: any) => `${o.id}:${o.x}:${o.y}:${o.gen}`).sort(),
    );
    const target = { ...wa.game.orbs[0] }; // copy: the live orb is mutated in place on award
    const before = wa.game.scores[b.id] || 0;
    const t0 = Date.now();
    wb.touch({ orb: target.id, gen: target.gen, by: b.id });
    await wait(() => (wa.game.scores[b.id] || 0) > before && (wb.game.scores[b.id] || 0) > before, 3000, "B's score on both");
    const ms = Date.now() - t0;
    assert.ok(ms <= 500, `score sync took ${ms} ms`);
    const moved = wa.game.orbs.find((o: any) => o.id === target.id);
    assert.ok(moved && (moved.x !== target.x || moved.y !== target.y || moved.gen !== target.gen), 'orb respawned');
    const expectScores = { ...wa.game.scores };
    const expectOrbs = wa.game.orbs.map((o: any) => ({ ...o }));
    const c = await join('orbs1', opts('Late', 'c'));
    try {
      const wc = wire(c);
      await wait(() => {
        if (wc.game.orbs.length !== ORB_N) return false;
        for (const o of expectOrbs) {
          const g = wc.game.orbs.find((x: any) => x.id === o.id);
          if (!g || g.x !== o.x || g.y !== o.y || g.gen !== o.gen) return false;
        }
        for (const [id, n] of Object.entries(expectScores)) if ((wc.game.scores[id] || 0) !== n) return false;
        return true;
      }, 10000, 'late joiner orbs and scores');
    } finally { await c.leave(); }
  } finally {
    await b.leave(); await a.leave();
    await hub.stop();
  }
});

test('orb rounds: short play ends with the same winner on both, then scores reset', async () => {
  const hub = await startTestHub();
  const opts = (name: string, sub: string) => ({
    project: 'netdemo', endpoint: hub.url, transport: 'relay' as const, name, log: false, leaveOnHide: false, sub,
  });
  const a = await join('orbs-round', opts('Host', 'a'));
  const b = await join('orbs-round', opts('Guest', 'b'));
  const timers: ReturnType<typeof setInterval>[] = [];
  try {
    await wait(() => a.peers.has(b.id) && b.peers.has(a.id), 5000, 'peers');
    const wa = wire(a, 800), wb = wire(b, 800);
    timers.push(setInterval(() => { wa.tick(); wb.tick(); }, 40));
    await wait(() => wa.game.phase === 'play' && wb.game.phase === 'play', 5000, 'play phase');
    const target = { ...wa.game.orbs[0] };
    wb.touch({ orb: target.id, gen: target.gen, by: b.id });
    await wait(() => (wa.game.scores[b.id] || 0) > 0, 3000, 'B scored');
    await wait(() => wa.game.phase === 'result' && wb.game.phase === 'result', 5000, 'result phase');
    assert.equal(wa.game.winner?.id, wb.game.winner?.id);
    assert.equal(wa.game.winner?.name, wb.game.winner?.name);
    assert.ok(wa.game.board.length >= 2);
    const prev = wa.game.round;
    await wait(() => wa.game.phase === 'play' && wb.game.phase === 'play' && wa.game.round > prev, 6000, 'next play round');
    assert.deepEqual(wa.game.scores, {});
    assert.deepEqual(wb.game.scores, {});
    assert.equal(wa.game.orbs.length, ORB_N);
  } finally {
    for (const t of timers) clearInterval(t);
    await b.leave(); await a.leave();
    await hub.stop();
  }
});

test('orb game: after p2p→relay, a peer that wires late still gets orbs and collect syncs', async () => {
  // Smoke wires the bot after migrate; `_s` on the new stream must not be dropped before sync.state is registered.
  const hub = await startTestHub();
  const cfg = { config: { p2pMax: 8, maxPlayers: 64 } };
  const opts = (name: string, sub: string) => ({
    project: 'netdemo', endpoint: hub.url, transport: 'auto' as const, name, log: false, leaveOnHide: false, sub, ...cfg,
  });
  const a = await join('orbs-relay', opts('Host', 'ar'));
  const b = await join('orbs-relay', opts('Guest', 'br'));
  try {
    await wait(() => a.peers.has(b.id) && b.peers.has(a.id), 5000, 'peers');
    assert.equal(a.transport, 'p2p');
    const wa = wire(a);
    await wait(() => wa.game.orbs.length === ORB_N, 5000, 'host orbs');
    await new Promise((r) => setTimeout(r, 1100)); // host `_syncStates` while B is still unwired
    a.migrate('game asked');
    await wait(() => a.transport === 'relay' && b.transport === 'relay', 10000, 'relay');
    await new Promise((r) => setTimeout(r, 1100)); // post-migrate `_s` lands before B wires
    const wb = wire(b);
    await wait(() => {
      if (wa.game.orbs.length !== ORB_N || wb.game.orbs.length !== ORB_N) return false;
      const key = (o: any) => `${o.id}:${o.x}:${o.y}:${o.gen}`;
      return wa.game.orbs.map(key).sort().join('|') === wb.game.orbs.map(key).sort().join('|');
    }, 8000, 'same orbs after late wire');
    const target = { ...wa.game.orbs[0] };
    const before = wa.game.scores[b.id] || 0;
    wb.touch({ orb: target.id, gen: target.gen, by: b.id });
    await wait(() => (wa.game.scores[b.id] || 0) > before && (wb.game.scores[b.id] || 0) > before, 3000, "B's score on both after relay");
    const moved = wa.game.orbs.find((o: any) => o.id === target.id);
    assert.ok(moved && (moved.x !== target.x || moved.y !== target.y || moved.gen !== target.gen), 'orb respawned');
  } finally {
    await b.leave(); await a.leave();
    await hub.stop();
  }
});

test('orb game: both wired, collect then immediate p2p→relay keeps matching orbs and scores', async () => {
  // Smoke wires before migrate; a collect (action) can race the last `_s` into the p2p room — seed must not leave peers mismatched.
  const hub = await startTestHub();
  const cfg = { config: { p2pMax: 8, maxPlayers: 64 } };
  const opts = (name: string, sub: string) => ({
    project: 'netdemo', endpoint: hub.url, transport: 'auto' as const, name, log: false, leaveOnHide: false, sub, ...cfg,
  });
  const a = await join('orbs-wired', opts('Host', 'aw'));
  const b = await join('orbs-wired', opts('Guest', 'bw'));
  try {
    await wait(() => a.peers.has(b.id) && b.peers.has(a.id), 5000, 'peers');
    assert.equal(a.transport, 'p2p');
    const wa = wire(a), wb = wire(b);
    await wait(() => wa.game.orbs.length === ORB_N && wb.game.orbs.length === ORB_N, 8000, 'both orbs on p2p');
    await new Promise((r) => setTimeout(r, 300)); // one `_s` into the p2p room
    const target = { ...wa.game.orbs[0] };
    const before = wa.game.scores[b.id] || 0;
    wb.touch({ orb: target.id, gen: target.gen, by: b.id });
    await wait(() => (wa.game.scores[b.id] || 0) > before && (wb.game.scores[b.id] || 0) > before, 3000, 'score before migrate');
    a.migrate('game asked'); // immediate: seed must include the post-collect orbs/scores
    await wait(() => a.transport === 'relay' && b.transport === 'relay', 10000, 'relay');
    const key = (o: any) => `${o.id}:${o.x}:${o.y}:${o.gen}`;
    await wait(() => {
      if (wa.game.orbs.length !== ORB_N || wb.game.orbs.length !== ORB_N) return false;
      if (wa.game.orbs.map(key).sort().join('|') !== wb.game.orbs.map(key).sort().join('|')) return false;
      return (wa.game.scores[b.id] || 0) === (wb.game.scores[b.id] || 0) && (wa.game.scores[b.id] || 0) > before;
    }, 8000, 'same orbs and scores after migrate');
    const again = { ...wa.game.orbs[0] };
    const scoreWas = wa.game.scores[b.id] || 0;
    wb.touch({ orb: again.id, gen: again.gen, by: b.id });
    await wait(() => (wa.game.scores[b.id] || 0) > scoreWas && (wb.game.scores[b.id] || 0) > scoreWas, 3000, 'collect still syncs on relay');
  } finally {
    await b.leave(); await a.leave();
    await hub.stop();
  }
});

test('orb rounds: host leave mid-round keeps endsAt and scores for the new host', async () => {
  const hub = await startTestHub();
  const opts = (name: string, sub: string) => ({
    project: 'netdemo', endpoint: hub.url, transport: 'relay' as const, name, log: false, leaveOnHide: false, sub,
  });
  const a = await join('orbs-mig', opts('Host', 'a'));
  const b = await join('orbs-mig', opts('Guest', 'b'));
  const timers: ReturnType<typeof setInterval>[] = [];
  try {
    await wait(() => a.peers.has(b.id) && b.peers.has(a.id), 5000, 'peers');
    const wa = wire(a, 30_000), wb = wire(b, 30_000);
    timers.push(setInterval(() => { try { wa.tick(); } catch { /* left */ } try { wb.tick(); } catch { /* left */ } }, 40));
    await wait(() => wa.game.phase === 'play' && wb.game.phase === 'play' && wa.game.endsAt === wb.game.endsAt, 5000, 'shared play');
    const target = { ...wb.game.orbs[0] };
    wb.touch({ orb: target.id, gen: target.gen, by: b.id });
    await wait(() => (wb.game.scores[b.id] || 0) > 0 && (wa.game.scores[b.id] || 0) > 0, 3000, 'score');
    const before = { round: wb.game.round, endsAt: wb.game.endsAt, score: wb.game.scores[b.id] || 0, phase: wb.game.phase };
    await a.leave();
    await wait(() => b.isHost, 8000, 'B becomes host');
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(wb.game.phase, before.phase);
    assert.equal(wb.game.round, before.round);
    assert.equal(wb.game.endsAt, before.endsAt);
    assert.equal(wb.game.scores[b.id] || 0, before.score);
  } finally {
    for (const t of timers) clearInterval(t);
    try { await b.leave(); } catch { /* gone */ }
    await hub.stop();
  }
});
