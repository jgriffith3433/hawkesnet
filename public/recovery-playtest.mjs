// A 5 s network cut on one player of /demo: back in the same room within 2 s of the network returning, with the same
// name, colour, id and score, while the other player sees a ghost that holds its spot, then live again, and never a leave
// and a join. Wired from demo.html into the two-players scenario (desktop, and at 390x844 touch: the drive is the page's
// own input either way); reports `recoveryMs`, `recoveryViewport` and `recoveryTouch` as metrics.

export const CUT_MS = 5000;
export const RECOVER_MS = 2000;
const SPOT_TOL = 40; // arena units: the last pose the other side got before the cut may trail the player by a send or two

/**
 * main: the page's player (it is cut); watcher: a second player in the room (it watches);
 * drop(room, ms): refuse reconnects for ms; myPos(): [x, y, z] of main; score(room, id): that player's score on that page;
 * collect(): named setup shortcut that gives main a point when it has none.
 */
export async function recoveryChecks({ check, until, wait, metric, event = () => {}, main, watcher, drop, myPos, score, collect, view }) {
  const w = innerWidth, h = innerHeight;
  const touch = Math.abs(w - 390) <= 8 && Math.abs(h - 844) <= 20;
  metric('recoveryViewport', `${w}x${h}`); metric('recoveryTouch', touch ? 1 : 0);
  const id = main.id, name = main.name, color = main.color;
  const seen = { left: 0, joined: 0, last: null };
  const offLeave = watcher.when('peer:leave', (e) => { if (e.peer.id === id) seen.left++; });
  const offJoin = watcher.when('peer:join', (p) => { if (p.id === id) seen.joined++; });
  watcher.onPose((who, s) => { if (who === id) seen.last = [s.p[0], s.p[1], s.p[2]]; });
  let before = null, t0 = 0;
  try {
    await check(`A player has a name, colour and score before the cut (${touch ? '390x844 touch' : `${w}x${h} desktop`})`, async () => {
      if (!score(main, id) && collect) { collect(); await until(() => score(main, id) > 0 && score(watcher, id) > 0, 6000, 'a point for this player on both screens'); }
      before = { score: score(main, id), name, color };
      if (!name || !color) throw new Error(`no name or colour (${name}, ${color})`);
      await until(() => seen.last, 4000, 'the watcher to see this player move');
      return `${name} ${color} score ${before.score}`;
    });
    if (!before) return;
    let ghostAt = null;
    await check('The network is cut for 5 s: the other player sees a ghost at the spot, not a leave', async () => {
      t0 = performance.now();
      event('network-cut', `${CUT_MS} ms`);
      drop(main, CUT_MS);
      await until(() => watcher.peers.get(id)?.away, 4000, 'the other player to see this player away');
      await wait(300);
      ghostAt = seen.last.slice(); // frozen from here: nothing arrives while the player is gone
      await wait(CUT_MS - 1500);
      if (!watcher.peers.has(id)) throw new Error('the watcher dropped the player during the cut');
      if (seen.left) throw new Error(`the watcher got ${seen.left} leave event(s) during the cut`);
      const moved = Math.hypot(seen.last[0] - ghostAt[0], seen.last[2] - ghostAt[2]);
      if (moved > 1) throw new Error(`the ghost moved ${Math.round(moved)} during the cut`);
      return `ghost held at ${Math.round(ghostAt[0])},${Math.round(ghostAt[2])}`;
    });
    await check('After the cut the player is back within 2 s with the same name, colour and score', async () => {
      const cutEnd = t0 + CUT_MS;
      await until(() => main.status === 'online' && main.id === id, 20000, 'this player to be online again');
      const ms = Math.max(0, Math.round(performance.now() - cutEnd));
      metric('recoveryMs', ms); metric('recoveryTotalMs', Math.round(performance.now() - t0));
      event('recovered', `${ms} ms after the network returned`);
      if (ms > RECOVER_MS) throw new Error(`back ${ms} ms after the network returned (limit ${RECOVER_MS} ms)`);
      if (main.id !== id || main.name !== name || main.color !== color) throw new Error(`identity changed: ${main.id} ${main.name} ${main.color}`);
      const s = score(main, id);
      if (s < before.score) throw new Error(`score ${s}, was ${before.score}`);
      return `recovered ${ms} ms after the network returned; ${name} ${color} score ${s}`;
    });
    await check('The other player sees the returning player live at the spot it left, never a leave and a join', async () => {
      await until(() => !watcher.peers.get(id)?.away, 5000, 'the other player to see this player live again');
      const p = watcher.peers.get(id);
      if (!p || p.name !== name || p.color !== color) throw new Error(`the watcher sees ${p?.name} ${p?.color}`);
      if (seen.left || seen.joined) throw new Error(`the watcher got ${seen.left} leave and ${seen.joined} join events`);
      await until(() => seen.last && Math.hypot(seen.last[0] - ghostAt[0], seen.last[2] - ghostAt[2]) <= SPOT_TOL, 4000, 'the returning player to be shown at the spot it left');
      const me = myPos();
      if (Math.hypot(me[0] - ghostAt[0], me[2] - ghostAt[2]) > SPOT_TOL * 2) throw new Error('the returning player moved while it was cut off');
      await until(() => score(watcher, id) >= before.score, 4000, 'the other page to hold the same score');
      return `live at ${Math.round(seen.last[0])},${Math.round(seen.last[2])}, no leave or join`;
    });
  } finally { offLeave?.(); offJoin?.(); }
}
