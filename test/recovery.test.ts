// A player whose network is cut for 5 s is back within 2 s of it returning, same id, name and colour; the other player
// sees it go away and come back, never a leave and a join. (The demo's two-players playtest does the same in a browser.)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const { startTestHub } = await import('./helper.ts');
const { join } = await import('../sdk/js/hawkes-net.mjs');
const hub = await startTestHub();
after(async () => { await hub.stop(); });

test('a 5 s cut: back within 2 s, same identity, the other side sees away then live, no leave or join', async () => {
  const opts = { project: 'netdemo', endpoint: hub.endpoint, transport: 'relay', log: false, leaveOnHide: false };
  const a = await join('recovery-5s', { ...opts, name: 'Cut' });
  const b = await join('recovery-5s', { ...opts, name: 'Watch' });
  await new Promise<void>((res) => { const t = setInterval(() => { if (b.peers.has(a.id) && a.peers.has(b.id)) { clearInterval(t); res(); } }, 20); });
  const events: string[] = [];
  b.when('peer:leave', (e: any) => { if (e.peer.id === a.id) events.push('leave'); });
  b.when('peer:join', (p: any) => { if (p.id === a.id) events.push('join'); });
  let away = false;
  b.when('peer:away', (e: any) => { if (e.peer === a.id || e.peer?.id === a.id) away = e.away || away; });
  const id = a.id, name = a.name, color = a.color;
  // The cut: the socket closes and new connects are refused for 5 s (the demo's dropFor).
  const real = a._connect, until = performance.now() + 5000;
  a._connect = function (q: string) { if (performance.now() < until) return this._lost(1006, 'blocked'); a._connect = real; return real.call(this, q); };
  a.ws.close();
  await new Promise<void>((res) => { const t = setInterval(() => { if (b.peers.get(id)?.away) { clearInterval(t); res(); } }, 20); });
  await new Promise<void>((res) => { const t = setInterval(() => { if (a.status === 'online' && performance.now() > until) { clearInterval(t); res(); } }, 10); });
  const ms = performance.now() - until;
  assert.ok(ms < 2000, `back ${Math.round(ms)} ms after the network returned`);
  assert.equal(a.id, id); assert.equal(a.name, name); assert.equal(a.color, color);
  await new Promise<void>((res) => { const t = setInterval(() => { if (!b.peers.get(id)?.away) { clearInterval(t); res(); } }, 20); });
  assert.deepEqual(events, [], 'no leave or join seen by the other player');
  await a.leave(); await b.leave();
});

test('the demo wires the recovery checks into two-players', () => {
  const html = fs.readFileSync(new URL('../public/demo.html', import.meta.url), 'utf8');
  const rec = fs.readFileSync(new URL('../public/recovery-playtest.mjs', import.meta.url), 'utf8');
  assert.match(html, /recovery-playtest\.mjs/);
  assert.match(rec, /recoveryMs/);
});
