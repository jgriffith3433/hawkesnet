// /demo Network lab (public/demo.html + public/demo-lab.mjs + public/lab-playtest.mjs): client-only latency/jitter/loss.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startTestHub } from './helper.ts';

const html = fs.readFileSync(new URL('../public/demo.html', import.meta.url), 'utf8');
const bot = fs.readFileSync(new URL('../public/demo-playtest.mjs', import.meta.url), 'utf8');
const labPt = fs.readFileSync(new URL('../public/lab-playtest.mjs', import.meta.url), 'utf8');
const labMod = fs.readFileSync(new URL('../public/demo-lab.mjs', import.meta.url), 'utf8');
const hub = await startTestHub();
after(async () => { await hub.stop(); });

test('the demo wires a Network lab panel, Lab on chip, and hawkesPlaytest.lab', () => {
  assert.match(html, /id="lab-panel"/);
  assert.match(html, /id="lab-toggle"/);
  assert.match(html, /id="lab-chip"/);
  assert.match(html, /Lab on/);
  assert.match(html, /Network lab/);
  assert.match(html, /data-lab="latency"/);
  assert.match(html, /data-lab="jitter"/);
  assert.match(html, /data-lab="loss"/);
  assert.match(html, /data-value="250"/);
  assert.match(html, /data-value="30"/);
  assert.match(html, /data-value="5"/);
  assert.match(html, /createLab|demo-lab\.mjs/);
  assert.match(html, /hawkesNetLab/);
  assert.match(html, /hawkesPlaytest\.lab/);
  assert.match(html, /lab\.attach/);
  assert.match(html, /addLabScenario/);
  assert.match(html, /import\('\/lab-playtest\.mjs'\)/);
  assert.doesNotMatch(html, /setInterval\([^)]*fetch/);
});

test('shared demo-playtest stays free of lab checks; they live in lab-playtest + demo-lab', () => {
  assert.doesNotMatch(bot, /hawkesNetLab|lab-playtest|demo-lab|Network lab|Lab on/);
  assert.match(labPt, /labChecks/);
  assert.match(labPt, /addLabScenario/);
  assert.match(labPt, /id: 'lab'/);
  assert.match(labPt, /hawkesPlaytest\.lab/);
  assert.match(labPt, /Lab on/);
  assert.match(labPt, /250/);
  assert.match(labPt, /bottom sheet/);
  assert.match(labPt, /different room|other room/);
  assert.match(labMod, /_sendRoom/);
  assert.match(labMod, /_fromSocket/);
  assert.match(labMod, /createLab/);
  assert.match(labMod, /LAB_LATENCY/);
});

test('the hub serves demo-lab.mjs and lab-playtest.mjs', async () => {
  const a = await fetch(`${hub.url}/demo-lab.mjs`);
  assert.equal(a.status, 200);
  assert.match(a.headers.get('content-type') ?? '', /javascript/);
  assert.match(await a.text(), /createLab/);
  const b = await fetch(`${hub.url}/lab-playtest.mjs`);
  assert.equal(b.status, 200);
  assert.match(b.headers.get('content-type') ?? '', /javascript/);
  assert.match(await b.text(), /addLabScenario/);
});

test('lab module only allows the brief\'s latency / jitter / loss steps', async () => {
  const { createLab, LAB_LATENCY, LAB_JITTER, LAB_LOSS } = await import('../public/demo-lab.mjs');
  assert.deepEqual(LAB_LATENCY, [0, 100, 250]);
  assert.deepEqual(LAB_JITTER, [0, 30]);
  assert.deepEqual(LAB_LOSS, [0, 5]);
  const lab = createLab();
  assert.equal(lab.get().active, false);
  lab.set({ latency: 250, jitter: 30, loss: 5 });
  assert.deepEqual(lab.get(), { latency: 250, jitter: 30, loss: 5, active: true, open: false });
  lab.set({ latency: 99, jitter: 12, loss: 3 });
  assert.equal(lab.get().latency, 0); // invalid steps fall back
  assert.equal(lab.get().jitter, 0);
  assert.equal(lab.get().loss, 0);
});

test('layout() extract markers stay so demo-layout.test can still cut the function out', () => {
  assert.ok(html.includes('const PAD = 4'));
  assert.ok(html.includes('let last = performance.now()'));
  const body = html.slice(html.indexOf('const PAD = 4'), html.indexOf('let last = performance.now()'));
  assert.match(body, /function layout\(/);
  assert.doesNotMatch(body, /hawkesNetLab|lab-panel|createLab/);
});

test('lab shim: 250 ms latency on A reaches B about 250±50 ms later; another room is unaffected', async () => {
  const { createLab } = await import('../public/demo-lab.mjs');
  const { join } = await import('../sdk/js/hawkes-net.mjs');
  const opts = { project: 'netdemo', endpoint: hub.endpoint, transport: 'relay' as const, log: false, leaveOnHide: false };
  const lab = createLab();
  const a = await join('lab-delay-a', { ...opts, name: 'LabA', sub: 'lab-a' });
  lab.attach(a);
  lab.set({ latency: 250, jitter: 0, loss: 0 });
  const b = await join('lab-delay-a', { ...opts, name: 'LabB', sub: 'lab-b' });
  await new Promise<void>((res) => { const t = setInterval(() => { if (b.peers.has(a.id) && a.peers.has(b.id)) { clearInterval(t); res(); } }, 20); });
  const recv: number[] = [];
  b.onPose((id: string) => { if (id === a.id) recv.push(performance.now()); });
  lab.clearStamps();
  recv.length = 0;
  for (let i = 0; i < 10; i++) {
    a.pose([100 + i * 20, 0, 200], 0);
    await new Promise((r) => setTimeout(r, 40));
  }
  await new Promise((r) => setTimeout(r, 350));
  const outs = lab.wireOut();
  assert.ok(outs.length >= 3 && recv.length >= 3, `outs ${outs.length} recv ${recv.length}`);
  const delays: number[] = [];
  let ri = 0;
  for (const ot of outs) {
    while (ri < recv.length && recv[ri]! < ot) ri++;
    if (ri >= recv.length) break;
    delays.push(recv[ri]! - ot);
    ri++;
  }
  const median = delays.slice().sort((x, y) => x - y)[Math.floor(delays.length / 2)]!;
  assert.ok(Math.abs(median - 250) <= 50, `one-way ${Math.round(median)} ms`);
  // Other room: no shim → first pose well under lab latency.
  const other = `lab-other-${Math.random().toString(36).slice(2, 6)}`;
  const c = await join(other, { ...opts, name: 'C', sub: 'lab-c' });
  const d = await join(other, { ...opts, name: 'D', sub: 'lab-d' });
  assert.ok(!c._hawkesLab && !d._hawkesLab);
  await new Promise<void>((res) => { const t = setInterval(() => { if (d.peers.has(c.id)) { clearInterval(t); res(); } }, 20); });
  const t0 = performance.now();
  let got = 0;
  d.onPose((id: string) => { if (id === c.id && !got) got = performance.now(); });
  c.pose([50, 0, 50], 0);
  await new Promise<void>((res, rej) => {
    const t = setInterval(() => { if (got) { clearInterval(t); res(); } }, 10);
    setTimeout(() => { clearInterval(t); rej(new Error('no pose in other room')); }, 3000);
  });
  assert.ok(got - t0 < 120, `other room ${Math.round(got - t0)} ms`);
  await a.leave(); await b.leave(); await c.leave(); await d.leave();
});
