// The Hawkes Net service as its own process (node src/hub.ts, as on the box) against a stand-in for Gen that answers
// the two things the service asks it: who a key is (GET /v1/net/whoami, narrowed by X-Hawkesgen-Project) and usage
// (POST /v1/net/usage with the service's own key). Tickets, a real room and usage on its way to Gen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// @ts-ignore: plain JS SDK
const { join } = await import('../sdk/js/hawkes-net.mjs');

// The stand-in Gen: three keys, and the usage it was sent.
const KEYS: Record<string, { id: string; name: string; role: string; projects: string[] }> = {
  'hg_box': { id: 'c_box', name: 'box', role: 'user', projects: ['hawkesnet'] },
  'hg_portal': { id: 'c_portal', name: 'portal', role: 'user', projects: ['usr_*'] },
  'hg_other': { id: 'c_other', name: 'other', role: 'user', projects: ['games-x'] },
};
const usage: any[] = [];
let whoamiCalls = 0;
const gen = http.createServer(async (req, res) => {
  const key = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
  const c = KEYS[key];
  const json = (s: number, b: unknown) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(b)); };
  if (req.url === '/v1/net/whoami') {
    whoamiCalls++;
    if (!c) return json(401, { error: 'Unknown or disabled API key' });
    const only = String(req.headers['x-hawkesgen-project'] ?? '');
    const ok = !only || c.projects.some((p) => p === only || (p.endsWith('*') && only.startsWith(p.slice(0, -1))));
    return ok ? json(200, { client: { ...c, projects: only ? [only] : c.projects } }) : json(401, { error: 'not that project' });
  }
  if (req.url === '/v1/net/usage' && req.method === 'POST') {
    if (key !== 'hg_box') return json(403, { error: 'not a hawkesnet key' });
    const chunks: Buffer[] = [];
    for await (const ch of req) chunks.push(ch as Buffer);
    usage.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    return json(200, { ok: true });
  }
  json(404, { error: 'not in the stand-in' });
});
await new Promise<void>((r) => gen.listen(0, '127.0.0.1', () => r()));
const genUrl = `http://127.0.0.1:${(gen.address() as any).port}`;
const freePort = () => new Promise<number>((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => r(p)); }); });

const port = await freePort();
const hubUrl = `http://127.0.0.1:${port}`;
let hub: ChildProcess;
const logs: string[] = [];
test.before(async () => {
  hub = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', fileURLToPath(new URL('../src/hub.ts', import.meta.url))], {
    env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', NET_PORT: String(port), NET_HOST: '127.0.0.1', NET_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'hn-hub-')), NET_GEN_URL: genUrl, NET_GEN_KEY: 'hg_box', NET_PUBLIC_URL: `ws://127.0.0.1:${port}/v1/net/ws`, NET_WORKERS: '1', NET_USAGE_MS: '500' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  hub.stdout!.on('data', (d) => logs.push(String(d)));
  hub.stderr!.on('data', (d) => logs.push(String(d)));
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${hubUrl}/healthz`).then((r) => r.ok).catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`the service did not start: ${logs.join('')}`);
});
test.after(async () => {
  if (hub && hub.exitCode === null) { hub.kill('SIGTERM'); await new Promise((r) => setTimeout(r, 500)); if (hub.exitCode === null) hub.kill('SIGKILL'); }
  gen.closeAllConnections(); gen.close();
});
const wait = async (pred: () => any, ms = 5000, what = 'condition') => {
  const until = Date.now() + ms;
  for (;;) { const v = await pred(); if (v) return v; if (Date.now() > until) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 50)); }
};
const post = (p: string, body: any, headers: Record<string, string> = {}) => fetch(`${hubUrl}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const asPortal = (project: string) => ({ Authorization: 'Bearer hg_portal', 'X-Hawkesgen-Project': project });
// Customers' projects, made the way the portal makes them (its key, the account it acts for).
const made = new Set<string>();
async function project(owner: string, id: string) {
  if (made.has(id)) return id;
  const r = await post('/v1/net/projects', { owner, name: id, id, tier: 'paid' }, { Authorization: 'Bearer hg_portal' });
  if (r.status !== 200) throw new Error(`making ${id}: ${r.status} ${await r.text()}`);
  made.add(id);
  return id;
}

test('keys are checked with Gen (and kept a minute): the portal narrowed to a customer gets tickets in its projects; other keys, other projects and no key do not', async () => {
  await project('usr_00000000000000aa', 'aa-game');
  await project('usr_00000000000000bb', 'bb-game');
  const ok = await post('/v1/net/ticket', { project: 'aa-game', room: 'lobby', client: { protocols: [3] } }, asPortal('usr_00000000000000aa'));
  assert.equal(ok.status, 200, await ok.clone().text());
  const t = await ok.json();
  assert.match(t.ticket, /^hn1\./);
  assert.equal(t.relayUrl, `ws://127.0.0.1:${port}/v1/net/ws`, 'the relay on this box');
  const before = whoamiCalls;
  assert.equal((await post('/v1/net/ticket', { project: 'aa-game', room: 'lobby', client: { protocols: [3] } }, asPortal('usr_00000000000000aa'))).status, 200);
  assert.equal(whoamiCalls, before, 'the second ticket asked Gen nothing');
  assert.equal((await post('/v1/net/ticket', { project: 'bb-game', room: 'lobby', client: { protocols: [3] } }, asPortal('usr_00000000000000aa'))).status, 403, "another account's project");
  assert.equal((await post('/v1/net/ticket', { project: 'usr_00000000000000aa', room: 'lobby', client: { protocols: [3] } }, asPortal('usr_00000000000000aa'))).status, 404, 'no project of that name: nothing anonymous');
  assert.equal((await post('/v1/net/ticket', { project: 'aa-game', room: 'lobby', client: { protocols: [3] } }, { Authorization: 'Bearer hg_other' })).status, 403);
  assert.equal((await post('/v1/net/ticket', { project: 'aa-game', room: 'lobby', client: { protocols: [3] } }, { Authorization: 'Bearer hg_nope' })).status, 401);
  assert.equal((await post('/v1/net/ticket', { project: 'netdemo', room: 'x', client: { protocols: [3] } })).status, 401, 'no key, no origin: nothing (no local owner on a box)');
  assert.equal((await post('/v1/net/ticket', { project: 'netdemo', room: 'x', client: { protocols: [3] } }, { Origin: 'http://localhost:5173' })).status, 403, 'localhost is no door on a box');
  assert.equal((await post('/v1/net/ticket', { project: 'netdemo', room: 'x', client: { protocols: [3] } }, { Origin: 'https://net.hawkesgen.ai' })).status, 200, 'the demo page on the box');
});

test('players play on the service, and their usage goes to Gen with the service\'s key', async () => {
  await project('usr_00000000000000aa', 'aa-game');
  const ticket = (name: string) => async () => (await post('/v1/net/ticket', { project: 'aa-game', room: 'match-1', name, transport: 'relay', client: { protocols: [3] } }, asPortal('usr_00000000000000aa'))).json();
  const a = await join('match-1', { ticket: ticket('Ada'), transport: 'relay', leaveOnHide: false, log: false });
  const b = await join('match-1', { ticket: ticket('Bo'), transport: 'relay', leaveOnHide: false, log: false });
  try {
    const got: any[] = [];
    b.on('hi', (d: any) => got.push(d));
    a.send('hi', { n: 1 });
    await wait(() => got.length, 5000, 'the message');
    assert.deepEqual(got[0], { n: 1 });
    // (The directory hears the count from the node within a few seconds.)
    const room = await wait(async () => { const j = await (await post('/v1/net/room', { project: 'aa-game', room: 'match-1' }, asPortal('usr_00000000000000aa'))).json(); return j.players === 2 ? j : null; }, 15_000, 'the directory to count both');
    assert.equal(room.open, true);
    await new Promise((r) => setTimeout(r, 1500)); // (usage counts player-seconds on the relay's one-second tick)
  } finally { await a.leave(); await b.leave(); }
  await wait(() => usage.some((u) => u.rows.some((r: any) => r.project === 'aa-game' && r.transport === 'relay' && r.playerSeconds > 0)), 15_000, `usage at Gen: ${JSON.stringify(usage).slice(0, 600)} (${logs.join('').slice(-300)})`);
});

test('the front door is the dashboard; the demo page and the SDK are served by the service', async () => {
  const home = await fetch(`${hubUrl}/`, { redirect: 'manual' });
  assert.equal(home.status, 200);
  const html = await home.text();
  assert.match(html, /Sign in to Hawkes Net/, 'signed out: the sign-in page');
  assert.match(html, /\/v1\/net\/me/, 'it reads your Net from the portal');
  const page = await fetch(`${hubUrl}/demo`);
  assert.equal(page.status, 200);
  const demoHtml = await page.text();
  assert.match(demoHtml, /hawkes-net/i);
  assert.match(demoHtml, /installNetPlaytest/, "the demo carries Studio's playtest bot");
  const bot = await fetch(`${hubUrl}/demo-playtest.mjs`);
  assert.equal(bot.status, 200, "the playtest bot the demo imports");
  assert.match(bot.headers.get('content-type') ?? '', /javascript/);
  assert.match(await bot.text(), /export function installNetPlaytest/);
  const sdk = await fetch(`${hubUrl}/sdk/hawkes-net@1.mjs`);
  assert.equal(sdk.status, 200);
  assert.equal(sdk.headers.get('access-control-allow-origin'), '*');
  const types = await fetch(`${hubUrl}/sdk/hawkes-net@1.d.ts`);
  assert.equal(types.status, 200, 'the types, for TypeScript games');
  assert.match(await types.text(), /export declare function lobby/);
  assert.equal((await fetch(`${hubUrl}/sdk/hawkes-net-core.d.ts`)).status, 404, 'only the SDK has types');
  assert.match(html, /Your game's sites/, 'a game with no server lists its sites here');
});
