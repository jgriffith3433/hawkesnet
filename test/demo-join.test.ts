// The /demo page joins its room fast and says so while it does (public/demo.html): the join starts before anything else on the
// page loads, the arena says "Joining <room>…" until the room's first state, and "Add 5 bots" / "Move to the relay" start off
// and come on at the join event. The SDK side is timed against a real service in this process.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const page = fs.readFileSync(new URL('../public/demo.html', import.meta.url), 'utf8');
const { startTestHub } = await import('./helper.ts');
const { join } = await import('../sdk/js/hawkes-net.mjs');
const hub = await startTestHub();
after(async () => { await hub.stop(); });

test('the demo page: buttons start off, the arena says Joining, the join starts first and enables them', () => {
  assert.match(page, /<button id="bots" disabled>/);
  assert.match(page, /<button id="migrate" disabled>/);
  assert.match(page, /`Joining \$\{room\}…`/, 'the arena text names the room');
  const joinAt = page.indexOf('const joining = join(room');
  const playtestAt = page.indexOf("import('/demo-playtest.mjs')");
  assert.ok(joinAt > 0 && playtestAt > joinAt, 'the join is started before the playtest bot file is loaded');
  assert.ok(!/^ {2}(net = )?await (join|import)\(/m.test(page), 'the page body awaits no join or import before it draws');
  assert.match(page, /joining\.then\(\(joined\) => \{[\s\S]*?\$\('bots'\)\.disabled = false; \$\('migrate'\)\.disabled = false;/, 'the join event enables both buttons');
  assert.ok(!/setInterval\([^)]*join|setTimeout\([^)]*join/.test(page), 'no polling for the join');
});

for (const transport of ['auto', 'relay']) {
  test(`join (${transport}) completes in under 1 s: ticket, socket and first room state`, async () => {
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      const net = await join(`join-${transport}-${i}`, { project: 'netdemo', endpoint: hub.endpoint, transport, name: 'Timer', config: { p2pMax: 8, maxPlayers: 64, profile: 'light' }, log: false, leaveOnHide: false });
      const ms = performance.now() - t0;
      await net.leave();
      assert.ok(ms < 1000, `joined in ${Math.round(ms)} ms`);
    }
  });
}

// Pins the two-players criterion: Studio peers open two browsers on one ?room=demo-<id>; both must see each other.
// A playtest with an empty pages list means the second browser never opened (runner infra), not a join bug here.
test('two players in a demo-* room see each other (Studio two-players peers path)', async () => {
  assert.match(page, /`demo-\$\{Math\.random\(\)\.toString\(36\)\.slice\(2, 7\)\}`/, 'the demo mints demo-<id> rooms');
  const room = `demo-meet-${Math.random().toString(36).slice(2, 7)}`;
  const cfg = { p2pMax: 8, maxPlayers: 64, profile: 'light' };
  const o = (name: string, sub: string) => ({
    project: 'netdemo', endpoint: hub.endpoint, transport: 'auto', name, sub, config: cfg, log: false, leaveOnHide: false,
  });
  const a = await join(room, o('Guest A', 'p1'));
  const b = await join(room, o('Guest B', 'p2'));
  try {
    const until = Date.now() + 5000;
    for (;;) {
      if (a.peers.has(b.id) && b.peers.has(a.id)) break;
      if (Date.now() > until) throw new Error(`peers did not meet in ${room} (A sees ${a.peers.size}, B sees ${b.peers.size})`);
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(a.host, a.id, 'first joiner is host');
    assert.ok(a.transport === 'p2p' || a.transport === 'relay', `unexpected transport ${a.transport}`);
  } finally {
    try { await b.leave(); } catch { /* gone */ }
    try { await a.leave(); } catch { /* gone */ }
  }
});
