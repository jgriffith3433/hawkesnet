// Orb-game checks for /demo (host-authoritative sync.state / sync.action). Wired from demo.html; the shared
// demo-playtest.mjs stays free of hawkesnet-only checks (same pattern as site-playtest.mjs).
//
// Used from smoke's `extra` (second player already in the page) and from two-players via `afterTwoPlayers`
// (opens a short-lived bot as player B, steers it onto an orb by pose, asserts A sees the score and respawn).

const ORB_N = 5;
const SCORE_MS = 500;

/** Reads what the demo exposes on window.hawkesNetOrbs. */
function orbsApi() {
  const a = typeof window !== 'undefined' ? window.hawkesNetOrbs : null;
  if (!a || typeof a.snapshot !== 'function' || typeof a.wire !== 'function' || typeof a.touchAt !== 'function') {
    throw new Error('the demo has no hawkesNetOrbs API');
  }
  return a;
}

/**
 * Criterion checks: same 5 orbs, B collects → A sees score within 500 ms and the orb moves, a late joiner sees
 * scores and orbs. `collector` is the room that will be steered onto an orb (the smoke bot, or a bot opened here).
 * `main` is player A's room (this page). `openLate` joins a fresh room in the same ?room= for the late-join check.
 */
export async function orbChecks({ check, main, collector, until, wait, metric, openLate, event = () => {} }) {
  const api = orbsApi();
  api.wire(collector);

  await check('Both players see the same 5 orbs at the same spots', async () => {
    const ms = await until(() => {
      const a = api.snapshot(main), b = api.snapshot(collector);
      return a.orbs.length === ORB_N && b.orbs.length === ORB_N && sameOrbs(a.orbs, b.orbs);
    }, 8000, 'both sides to hold the same 5 orbs');
    const a = api.snapshot(main);
    metric('orbCount', a.orbs.length);
    metric('orbsSyncMs', Math.round(ms));
    event('orbs', a.orbs.map((o) => `${o.id}@${Math.round(o.x)},${Math.round(o.y)}`).join(' '));
    return `${a.orbs.length} orbs match after ${Math.round(ms)} ms`;
  });

  await check("Collecting an orb raises that player's score on both screens within half a second, and the orb respawns", async () => {
    const before = api.snapshot(main);
    const target = before.orbs[0] && { ...before.orbs[0] };
    if (!target) throw new Error('no orb to collect');
    const bid = collector.id;
    const scoreBefore = before.scores[bid] || 0;
    let touchedAt = null;
    // Steer B onto the orb by pose (real path the room already uses), then the demo's touch check sends collect.
    for (let i = 0; i < 40; i++) {
      const u = (i + 1) / 40;
      const x = target.x - 80 + 80 * u, y = target.y;
      collector.pose([x, 0, y], 0);
      if (Math.hypot(x - target.x, y - target.y) <= 22) {
        if (touchedAt == null) touchedAt = performance.now();
        api.touchAt(collector, x, y);
      }
      await wait(25);
      if ((api.snapshot(main).scores[bid] || 0) > scoreBefore) break;
    }
    if (touchedAt == null) throw new Error('player B never reached the orb');
    await until(() => {
      const a = api.snapshot(main), b = api.snapshot(collector);
      const rose = (a.scores[bid] || 0) > scoreBefore && (b.scores[bid] || 0) > scoreBefore;
      const moved = (side) => {
        const o = side.orbs.find((x) => x.id === target.id);
        return o && (Math.abs(o.x - target.x) > 1 || Math.abs(o.y - target.y) > 1 || o.gen !== target.gen);
      };
      return rose && moved(a) && moved(b);
    }, SCORE_MS + 2000, () => {
      const a = api.snapshot(main);
      return `A to see B's score rise and the orb move (score ${a.scores[bid] || 0}, was ${scoreBefore})`;
    });
    const ms = Math.round(performance.now() - touchedAt);
    metric('orbCollectMs', ms);
    if (ms > SCORE_MS) throw new Error(`score and respawn took ${ms} ms from touch, limit is ${SCORE_MS} ms`);
    const after = api.snapshot(main);
    event('collect', `B ${bid} score ${scoreBefore}→${after.scores[bid]} orb ${target.id} moved in ${ms} ms`);
    return `B's score ${scoreBefore}→${after.scores[bid]} on both screens, orb respawned in ${ms} ms`;
  });

  if (openLate) {
    let late = null;
    try {
      await check('A player who joins mid-round sees the current scores and orbs', async () => {
        const expect = api.snapshot(main);
        late = await openLate();
        api.wire(late);
        const ms = await until(() => {
          const s = api.snapshot(late);
          return s.orbs.length === ORB_N && sameOrbs(s.orbs, expect.orbs) && sameScores(s.scores, expect.scores);
        }, 10000, 'the late joiner to receive orbs and scores');
        metric('lateJoinOrbsMs', Math.round(ms));
        const s = api.snapshot(late);
        event('late-join', `${s.orbs.length} orbs, scores ${JSON.stringify(s.scores)}`);
        return `${s.orbs.length} orbs and ${Object.keys(s.scores).length} score(s) in ${Math.round(ms)} ms`;
      });
    } finally {
      try { await late?.leave(); } catch { /* gone */ }
    }
  }
}

function sameOrbs(a, b) {
  if (a.length !== b.length) return false;
  const key = (o) => `${o.id}:${Math.round(o.x)}:${Math.round(o.y)}:${o.gen || 0}`;
  const A = a.map(key).sort().join('|'), B = b.map(key).sort().join('|');
  return A === B;
}

function sameScores(a, b) {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of keys) if ((a[k] || 0) !== (b[k] || 0)) return false;
  return true;
}
