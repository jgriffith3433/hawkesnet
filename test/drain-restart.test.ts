// A deploy restart: the node pushes a draining notice, then the process stops and a new one takes the same port.
// Three fake clients skip resume, ask for fresh tickets, and are back in the same room (same names) within 2 s.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { startTestHub } = await import('./helper.ts');
const { join } = await import('../sdk/js/hawkes-net.mjs');

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (testFn: () => boolean, ms: number, what: string) => {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    if (testFn()) return performance.now() - t0;
    await wait(40);
  }
  throw new Error(`timed out after ${ms} ms waiting for ${what}`);
};

test('drain restart: a 3-player room survives a simulated node restart within 2 s', async () => {
  const hub1 = await startTestHub();
  const port = hub1.port;
  const endpoint = hub1.endpoint;
  const room = 'drain-restart-3';
  const names = ['Ada', 'Bo', 'Cy'];
  const opts = (name: string) => ({
    project: 'netdemo', endpoint, transport: 'relay' as const, name, log: false, leaveOnHide: false, sub: `drain-${name}`,
  });

  const clients: Awaited<ReturnType<typeof join>>[] = [];
  for (const name of names) clients.push(await join(room, opts(name)));
  await until(() => clients.every((c) => c.status === 'online' && c.peers.size === 2), 5000, 'all three to see each other');
  for (const c of clients) {
    assert.equal(c.room, room);
    assert.ok(names.includes(c.name!), `name ${c.name}`);
  }

  const urls: string[] = [];
  const OrigWS = globalThis.WebSocket;
  // Track whether anyone tries a resume URL after the draining notice (they must not).
  class TrackWS extends OrigWS {
    constructor(url: string, protocols?: string | string[]) {
      urls.push(url);
      super(url, protocols);
    }
  }
  for (const c of clients) (c as any).o.WebSocket = TrackWS;

  const statuses: string[][] = clients.map(() => []);
  for (let i = 0; i < clients.length; i++) {
    clients[i].when('status', ({ status }: { status: string }) => { statuses[i].push(status); });
  }

  const t0 = performance.now();
  // Same path as SIGTERM on the box: drain notice first, then sockets and process go away.
  await hub1.stop();
  const hub2 = await startTestHub(port);
  try {
    await until(
      () => clients.every((c) => c.status === 'online' && c.peers.size === 2 && names.includes(c.name!)),
      2000,
      'all three back online in the same room',
    );
    const ms = performance.now() - t0;
    assert.ok(ms < 2000, `back in ${Math.round(ms)} ms (wanted under 2000)`);

    for (const c of clients) {
      assert.equal(c.room, room);
      assert.ok(names.includes(c.name!), `name ${c.name} after restart`);
      const peerNames = [...c.peers.values()].map((p: { name?: string }) => p.name).sort();
      const expect = names.filter((n) => n !== c.name).sort();
      assert.deepEqual(peerNames, expect, `${c.name} should see the others by name`);
    }
    assert.ok(statuses.every((s) => s.includes('reconnecting')), `each client saw reconnecting: ${JSON.stringify(statuses)}`);
    const resumeTries = urls.filter((u) => /[?&]r=/.test(u));
    assert.equal(resumeTries.length, 0, `no resume after draining, got ${resumeTries.length}: ${resumeTries.join(', ')}`);

    for (const c of clients) await c.leave();
  } finally {
    await hub2.stop();
  }
});
