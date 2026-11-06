// The relay's refusals, answered as HTTP before a websocket opens, and the node's own /publish: each code (src/errors.ts)
// arrives as JSON with { code, message, docs, error }. test/errors.test.ts checks that every code here has a case.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import * as core from '../sdk/js/hawkes-net-core.mjs';
import { NetNode, type GenLink } from '../src/node.ts';
import { newKeyPair, exportPublic, signToken, TICKET_PREFIX } from '../src/tickets.ts';
import { ERRORS, type ErrorCode } from '../src/errors.ts';

const K = newKeyPair('kerr');
const link: GenLink = { keys: async () => [{ kid: K.kid, pub: exportPublic(K.publicKey) }], heartbeat: async () => {}, room: async () => {}, usage: async () => {} };

async function startNode(workers = 0) {
  const node = new NetNode({ id: 'n1', url: 'ws://x', link, workers, log: () => {} });
  await node.start();
  const server = http.createServer((req, res) => void node.http(req, res, new URL(req.url ?? '/', 'http://x').pathname));
  server.on('upgrade', (req, socket, head) => node.upgrade(req, socket, head));
  const socks = new Set<import('node:net').Socket>();
  server.on('connection', (c) => { socks.add(c); c.on('close', () => socks.delete(c)); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return { node, port, stop: async () => { node.stop(); server.closeAllConnections(); for (const c of socks) c.destroy(); await new Promise((r) => server.close(() => r(null))); } };
}
function ticket(room: string, o: any = {}) {
  const now = Math.floor(Date.now() / 1000);
  return signToken(TICKET_PREFIX, {
    v: 1, kid: K.kid, prj: 'test', room, peer: o.peer ?? 'p1', ord: 1, sub: 's', nm: 'P', role: 'player', tr: ['relay'], want: 'relay', node: o.node ?? 'n1', epoch: o.epoch ?? 5,
    lim: { ...core.DEFAULT_LIMITS, playersPerRoom: 64 }, cfg: { topology: 'star', profile: 'medium', maxPlayers: 64, p2pMax: 8, interest: null }, iat: now, exp: now + 90, jti: crypto.randomBytes(6).toString('hex'),
  }, K.privateKey);
}
type Got = { status: number; body: any };
/** A websocket upgrade request, and the refusal that comes back instead of a 101. */
const upgrade = (port: number, query: string, headers: Record<string, string> = {}, key = true) => new Promise<Got>((resolve, reject) => {
  const req = http.request({ port, host: '127.0.0.1', path: `/v3?${query}`, headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', ...(key ? { 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64') } : {}), 'Sec-WebSocket-Protocol': 'hawkes-net.v3', ...headers } });
  req.on('response', (res) => { const chunks: Buffer[] = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })); });
  req.on('upgrade', (_res, socket) => { socket.destroy(); reject(new Error('the relay accepted it')); });
  req.on('error', reject);
  req.end();
});
const post = (port: number, route: string, raw: string, token = 'x') => fetch(`http://127.0.0.1:${port}${route}`, { method: 'POST', body: raw, headers: { Authorization: `Bearer ${token}` } }).then(async (r) => ({ status: r.status, body: await r.json() }));

const one = await startNode(0);
const pool = await startNode(1);
test.after(async () => { await one.stop(); await pool.stop(); });

const relay: Partial<Record<ErrorCode, () => Promise<Got>>> = {
  ws_handshake_invalid: () => upgrade(one.port, `t=${ticket('hs')}`, {}, false),
  ws_ticket_required: () => upgrade(pool.port, ''),
  node_draining: async () => {
    const n = await startNode(0);
    (n.node as any).draining = true;
    (n.node as any).rooms.draining = true;
    try { return await upgrade(n.port, `t=${ticket('dr')}`); } finally { await n.stop(); }
  },
  node_restarting: async () => {
    const w = pool.node.workers[0];
    w.alive = false;
    try { return await upgrade(pool.port, `t=${ticket('rs')}`); } finally { w.alive = true; }
  },
  connections_limit: async () => {
    (one.node as any).rooms.byIp.set('9.9.9.9', 100_000);
    try { return await upgrade(one.port, `t=${ticket('cl')}`, { 'X-Forwarded-For': '9.9.9.9' }); } finally { (one.node as any).rooms.byIp.delete('9.9.9.9'); }
  },
  resume_gone: () => upgrade(one.port, 'r=not-a-resume-token'),
  ticket_refused: () => upgrade(one.port, 't=hn1.garbage'),
  ticket_wrong_node: () => upgrade(one.port, `t=${ticket('wn', { node: 'elsewhere' })}`),
  ticket_used: async () => {
    const t = ticket('tu');
    await upgrade(one.port, `t=${t}`).catch(() => {}); // the first use (accepted: the helper rejects the 101)
    return upgrade(one.port, `t=${t}`);
  },
  ticket_stale: async () => {
    // A room opened at epoch 5 stays open while its first player is connected; an older ticket is stale.
    const ws = new WebSocket(`ws://127.0.0.1:${one.port}/v3?t=${ticket('st', { epoch: 5, peer: 'p1' })}`, ['hawkes-net.v3']);
    await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error('first join refused')); });
    try { return await upgrade(one.port, `t=${ticket('st', { epoch: 1, peer: 'p2' })}`); } finally { ws.close(); }
  },
  publish_token_bad: () => post(pool.port, '/publish', '{}', 'not-a-token'),
};

for (const [code, run] of Object.entries(relay) as [ErrorCode, () => Promise<Got>][]) {
  test(`relay error ${code}: ${ERRORS[code].status}, with code, message and docs link`, async () => {
    const r = await run();
    assert.equal(r.status, ERRORS[code].status, JSON.stringify(r.body));
    assert.equal(r.body.code, code);
    assert.ok(r.body.message.length > 3);
    assert.equal(r.body.docs, `https://net.hawkesgen.ai/docs/errors#${code}`);
    assert.equal(r.body.error, r.body.message);
  });
}

test('the node\'s own HTTP answers errors the same way: unknown route, bad JSON, a refused publish token', async () => {
  const nf = await fetch(`http://127.0.0.1:${one.port}/nothing`).then(async (r) => ({ status: r.status, body: await r.json() }));
  assert.deepEqual([nf.status, nf.body.code], [404, 'not_found']);
  const bj = await post(one.port, '/publish', '{nope');
  assert.deepEqual([bj.status, bj.body.code], [400, 'bad_json']);
  const big = await post(one.port, '/publish', JSON.stringify({ pad: 'x'.repeat(1024 * 1024 + 10) }));
  assert.deepEqual([big.status, big.body.code], [413, 'body_too_large']);
  const refused = await post(one.port, '/publish', '{}', 'not-a-token');
  assert.deepEqual([refused.status, refused.body.code], [401, 'publish_refused']);
  const lost = await post(one.port, '/publish', '{}', `hp1.${Buffer.from('{}').toString('base64url')}.x`);
  assert.equal(lost.body.docs.endsWith(`#${lost.body.code}`), true);
  const w = await fetch(`http://127.0.0.1:${pool.port}/publish`, { method: 'POST', body: '{}', headers: { Authorization: 'Bearer nope' } }).then((r) => r.json());
  assert.equal(w.code, 'publish_token_bad');
});
