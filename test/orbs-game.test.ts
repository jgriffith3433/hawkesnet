// Host-authoritative orbs over the real SDK: same 5 orbs, collect raises score on both within 500 ms, late joiner sees state.
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
const pad = 40, W = 960, H = 600;
const randOrb = () => ({ x: pad + Math.random() * (W - 2 * pad), y: pad + Math.random() * (H - 2 * pad) });

function wire(room: any) {
  const game: any = { orbs: [] as any[], scores: {} as Record<string, number>, seq: 0, applied: new Set<number>() };
  room.sync.state('orbs', {
    get: () => ({ orbs: game.orbs, scores: game.scores, seq: game.seq }),
    set: (s: any) => {
      if (!s) return;
      if (Array.isArray(s.orbs)) game.orbs = s.orbs.map((o: any) => ({ id: o.id, x: +o.x, y: +o.y, gen: +o.gen || 1 }));
      if (s.scores) game.scores = { ...s.scores };
      if (Number.isFinite(s.seq)) game.seq = s.seq;
    },
    rate: 8,
  });
  const award = room.sync.action('orb-award', (data: any) => {
    if (!data || data.n == null || game.applied.has(data.n)) return;
    game.applied.add(data.n);
    game.seq = Math.max(game.seq, data.n);
    const by = String(data.by || '');
    if (by) game.scores[by] = (game.scores[by] || 0) + 1;
    const orb = game.orbs.find((o: any) => o.id === data.orb);
    if (orb) { orb.x = +data.nx; orb.y = +data.ny; orb.gen = (orb.gen || 1) + 1; }
  });
  const touch = room.sync.action('orb-touch', (data: any, { authoritative }: any) => {
    if (!authoritative || !data) return;
    const orb = game.orbs.find((o: any) => o.id === data.orb);
    if (!orb || (data.gen != null && data.gen !== orb.gen)) return;
    const p = randOrb();
    award({ orb: orb.id, by: data.by, nx: Math.round(p.x), ny: Math.round(p.y), n: game.seq + 1 });
  });
  if (room.isHost && game.orbs.length !== ORB_N) {
    game.orbs = Array.from({ length: ORB_N }, (_, i) => { const p = randOrb(); return { id: `o${i}`, x: Math.round(p.x), y: Math.round(p.y), gen: 1 }; });
  }
  room.sync.onHost(() => {
    if (room.isHost && game.orbs.length !== ORB_N) {
      game.orbs = Array.from({ length: ORB_N }, (_, i) => { const p = randOrb(); return { id: `o${i}`, x: Math.round(p.x), y: Math.round(p.y), gen: 1 }; });
    }
  });
  return { game, touch };
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
