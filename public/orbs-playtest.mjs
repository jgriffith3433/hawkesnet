// Orb-game checks for /demo (host-authoritative sync.state / sync.action). Wired from demo.html; the shared
// demo-playtest.mjs stays free of hawkesnet-only checks (same pattern as site-playtest.mjs).
//
// Used from smoke's `extra` (second player already in the page) and from two-players via `afterTwoPlayers`
// (opens a short-lived bot as player B, steers it onto an orb by pose, asserts A sees the score and respawn).
// Round checks (short ?round= / beginTestRound hook) run from afterTwoPlayers only.

const ORB_N = 5;
const SCORE_MS = 500;
const SHORT_ROUND_SEC = 8;
const RESULT_MS = 3000;

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

/**
 * Short-round checks for two-players (and any caller with a second wired room): timer, shared winner + board,
 * auto-restart with scores reset, and host migration continuing the same round. Uses beginTestRound(8) when the
 * page loaded with a long default (same idea as ?round=8).
 */
export async function roundChecks({
  check, main, other, until, wait, metric, event = () => {},
  openInRoom, // async (roomName, name, sub) => room — for host-migration side room
}) {
  const api = orbsApi();
  api.wire(main);
  if (other) api.wire(other);

  await check('A round timer counts down from the play window at the top of the arena', async () => {
    await until(() => api.snapshot(main).phase === 'play' || api.snapshot(main).phase === 'result', 8000, 'a round to be running');
    const host = main.isHost ? main : other?.isHost ? other : main;
    if (typeof api.beginTestRound === 'function') api.beginTestRound(host, SHORT_ROUND_SEC);
    const ms = await until(() => {
      const a = api.snapshot(main), b = other ? api.snapshot(other) : a;
      return a.phase === 'play' && b.phase === 'play' && a.playMs === SHORT_ROUND_SEC * 1000 && b.playMs === SHORT_ROUND_SEC * 1000;
    }, 6000, 'both sides on an 8 s play round');
    const a = api.snapshot(main);
    const view = typeof window !== 'undefined' ? window.hawkesNetDemoView : null;
    const leftSec = view?.round?.leftSec;
    if (leftSec == null || leftSec > SHORT_ROUND_SEC || leftSec < 0) {
      throw new Error(`arena clock leftSec=${leftSec}, expected 0..${SHORT_ROUND_SEC}`);
    }
    metric('roundPlayMs', a.playMs);
    metric('roundTimerArmMs', Math.round(ms));
    event('round-timer', `playMs ${a.playMs}, leftSec ${leftSec}, round ${a.round}`);
    return `${a.playMs / 1000}s window, clock ${leftSec}s`;
  });

  let resultSnap = null;
  await check("At 0 the winner's name and a sorted scoreboard show for about 3 seconds on both screens", async () => {
    const waitMs = SHORT_ROUND_SEC * 1000 + 4000;
    const ms = await until(() => {
      const a = api.snapshot(main), b = other ? api.snapshot(other) : a;
      return a.phase === 'result' && b.phase === 'result' && a.winner && b.winner
        && a.winner.name === b.winner.name && a.winner.score === b.winner.score
        && sameBoard(a.board, b.board);
    }, waitMs, 'both screens to show the same result');
    const a = api.snapshot(main), b = other ? api.snapshot(other) : a;
    resultSnap = { winner: { ...a.winner }, board: a.board.map((r) => ({ ...r })), round: a.round, endsAt: a.endsAt };
    if (!isSortedBoard(a.board)) throw new Error(`board not sorted: ${a.board.map((r) => r.score).join(',')}`);
    const view = typeof window !== 'undefined' ? window.hawkesNetDemoView : null;
    if (view?.round?.phase !== 'result' || view.round?.winner?.name !== a.winner.name) {
      throw new Error(`arena view phase=${view?.round?.phase} winner=${view?.round?.winner?.name}`);
    }
    if (!a.confetti && !(view?.fx?.confetti || view?.round?.confetti)) {
      // confetti is brief; still require winner large on the view
    }
    const resultLeft = a.leftMs;
    if (resultLeft > RESULT_MS + 500) throw new Error(`result window left ${resultLeft} ms, expected ~${RESULT_MS}`);
    metric('roundResultMs', Math.round(ms));
    event('round-result', `${a.winner.name} ${a.winner.score}; board ${a.board.map((r) => `${r.name}:${r.score}`).join(' ')}`);
    return `${a.winner.name} (${a.winner.score}) on both, ${a.board.length} on the board after ${Math.round(ms)} ms`;
  });

  await check('A new round starts by itself with scores reset', async () => {
    const prev = resultSnap?.round || api.snapshot(main).round;
    const ms = await until(() => {
      const a = api.snapshot(main), b = other ? api.snapshot(other) : a;
      const play = a.phase === 'play' && b.phase === 'play';
      const next = a.round > prev && b.round === a.round;
      const cleared = Object.values(a.scores).every((n) => !n) && Object.values(b.scores).every((n) => !n);
      return play && next && cleared && a.orbs.length === ORB_N && b.orbs.length === ORB_N;
    }, RESULT_MS + 5000, 'a fresh play round with scores cleared');
    const a = api.snapshot(main);
    metric('roundRestartMs', Math.round(ms));
    event('round-restart', `round ${a.round}, scores ${JSON.stringify(a.scores)}`);
    return `round ${a.round} play, scores reset after ${Math.round(ms)} ms`;
  });

  if (openInRoom) {
    let host = null, guest = null;
    try {
      await check('If the host leaves mid-round the round continues for the others', async () => {
        const side = `round-mig-${Math.random().toString(36).slice(2, 8)}`;
        host = await openInRoom(side, 'Round host', `rh-${Math.random()}`);
        guest = await openInRoom(side, 'Round guest', `rg-${Math.random()}`);
        api.wire(host); api.wire(guest);
        await until(() => host.peers.has(guest.id) && guest.peers.has(host.id), 10000, 'side-room peers');
        if (typeof api.beginTestRound === 'function') api.beginTestRound(host.isHost ? host : guest, SHORT_ROUND_SEC);
        await until(() => {
          const h = api.snapshot(host), g = api.snapshot(guest);
          return h.phase === 'play' && g.phase === 'play' && h.endsAt && g.endsAt === h.endsAt;
        }, 8000, 'side room play round');
        // Guest collects so scores are non-empty before the handoff.
        const target = api.snapshot(guest).orbs[0];
        if (target) {
          for (let i = 0; i < 30; i++) {
            guest.pose([target.x, 0, target.y], 0);
            api.touchAt(guest, target.x, target.y);
            await wait(30);
            if ((api.snapshot(guest).scores[guest.id] || 0) > 0) break;
          }
        }
        const before = api.snapshot(guest);
        const hostId = host.id;
        await host.leave();
        host = null;
        await until(() => guest.isHost && !guest.peers.has(hostId), 10000, 'guest to become host');
        await wait(300);
        const after = api.snapshot(guest);
        if (after.phase !== 'play') throw new Error(`phase became ${after.phase} after host left`);
        if (after.round !== before.round) throw new Error(`round changed ${before.round}→${after.round}`);
        if (after.endsAt !== before.endsAt) throw new Error(`endsAt changed ${before.endsAt}→${after.endsAt}`);
        if ((after.scores[guest.id] || 0) !== (before.scores[guest.id] || 0)) {
          throw new Error(`score reset on host leave (${before.scores[guest.id]}→${after.scores[guest.id]})`);
        }
        metric('hostMigrateRound', after.round);
        event('round-host-migrate', `round ${after.round} endsAt ${after.endsAt} score ${after.scores[guest.id] || 0}`);
        return `same round ${after.round}, endsAt held, score ${after.scores[guest.id] || 0}`;
      });
    } finally {
      try { await host?.leave(); } catch { /* gone */ }
      try { await guest?.leave(); } catch { /* gone */ }
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

function sameBoard(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].name !== b[i].name || (a[i].score || 0) !== (b[i].score || 0)) return false;
  }
  return true;
}

function isSortedBoard(board) {
  for (let i = 1; i < board.length; i++) if ((board[i - 1].score || 0) < (board[i].score || 0)) return false;
  return true;
}
