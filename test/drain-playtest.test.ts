// /demo drain reconnect (public/demo.html + public/drain-playtest.mjs): Reconnecting banner after a draining notice.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startTestHub } from './helper.ts';

const html = fs.readFileSync(new URL('../public/demo.html', import.meta.url), 'utf8');
const bot = fs.readFileSync(new URL('../public/demo-playtest.mjs', import.meta.url), 'utf8');
const drain = fs.readFileSync(new URL('../public/drain-playtest.mjs', import.meta.url), 'utf8');
const hub = await startTestHub();
after(async () => { await hub.stop(); });

test('the demo wires a Reconnecting banner and the drain playtest', () => {
  assert.match(html, /id="banner"|hawkesNetBanner/);
  assert.match(html, /Reconnecting/);
  assert.match(html, /addDrainScenario/);
  assert.match(html, /import\('\/drain-playtest\.mjs'\)/);
  assert.doesNotMatch(html, /setInterval\([^)]*fetch/);
});

test('shared demo-playtest stays free of drain checks; they live in drain-playtest', () => {
  assert.doesNotMatch(bot, /drain-playtest|addDrainScenario|hawkesNetBanner/);
  assert.match(drain, /drainChecks/);
  assert.match(drain, /addDrainScenario/);
  assert.match(drain, /id: 'drain'/);
  assert.match(drain, /draining/);
  assert.match(drain, /reconnectMs/);
});

test('the hub serves drain-playtest.mjs', async () => {
  const r = await fetch(`${hub.url}/drain-playtest.mjs`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') ?? '', /javascript/);
  assert.match(await r.text(), /addDrainScenario/);
});

test('the drain scenario plays a 3-player room: drainChecks runs against the real service and all three come back by name', async () => {
  assert.match(drain, /Three players are online/);
  assert.match(drain, /All three players are back/);
  assert.match(html, /openPeer: \(name = 'Drain peer'\)/);
  const { join } = await import('../sdk/js/hawkes-net.mjs');
  const { drainChecks } = await import('../public/drain-playtest.mjs');
  const room = `drain-scenario-${Math.random().toString(36).slice(2, 8)}`;
  const o = (name: string, sub: string) => ({ project: 'netdemo', endpoint: hub.endpoint, transport: 'relay', name, log: false, leaveOnHide: false, sub });
  const main = await join(room, o('Main', 'ds-main'));
  // The demo's banner, reduced to what the scenario reads: it says reconnecting while the main client is.
  const log: { state: string }[] = [];
  main.when('status', ({ status }: { status: string }) => log.push({ state: status === 'reconnecting' ? 'reconnecting' : status }));
  (globalThis as any).window = { hawkesNetBanner: () => ({ state: main.status === 'reconnecting' ? 'reconnecting' : 'online', text: 'Reconnecting…', log }) };
  const lines: { text: string; ok: boolean; why?: string }[] = [];
  const metrics: Record<string, number> = {};
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn: () => boolean, ms: number, what: string) => {
    const t0 = performance.now();
    while (performance.now() - t0 < ms) { if (fn()) return; await wait(30); }
    throw new Error(`timed out waiting for ${what}`);
  };
  try {
    await drainChecks({
      check: async (text: string, fn: () => Promise<string>) => {
        try { lines.push({ text, ok: true, why: await fn() }); } catch (e: any) { lines.push({ text, ok: false, why: e.message }); }
      },
      until, wait,
      metric: (k: string, v: number) => { metrics[k] = v; },
      main, roomName: room,
      openPeer: (name: string) => join(room, o(name, `ds-${name}`)),
    });
  } finally {
    delete (globalThis as any).window;
    await main.leave();
  }
  assert.equal(lines.length, 3);
  assert.ok(lines.every((l) => l.ok), JSON.stringify(lines));
  assert.equal(metrics.peersBefore, 3);
  assert.equal(metrics.peersAfter, 3);
  assert.ok(metrics.reconnectMs < 3000, `back in ${metrics.reconnectMs} ms`);
});
