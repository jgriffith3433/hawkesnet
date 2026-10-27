// A Hawkes Net relay node over real sockets (src/node.ts, rooms.ts, ws.ts, tickets.ts): tickets checked and
// refused, a relay room carrying protocol 3, coming back with a resume token, a p2p room's signal route, the move from
// p2p to the relay when a room grows, Gen's publish, and the same with worker processes holding the rooms.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import * as core from '../sdk/js/hawkes-net-core.mjs';
import { NetNode, type GenLink } from '../src/node.ts';
import { newKeyPair, exportPublic, signToken, TICKET_PREFIX, PUBLISH_PREFIX } from '../src/tickets.ts';
import { refuse } from '../src/ws.ts';

const K = newKeyPair('ktest');
const events: any[] = [];
const usage: any[] = [];
const link: GenLink = { keys: async () => [{ kid: K.kid, pub: exportPublic(K.publicKey) }], heartbeat: async () => {}, room: async (e) => { events.push(e); }, usage: async (r) => { usage.push(r); } };

async function startNode(workers = 0) {
  const node = new NetNode({ id: 'n1', url: 'ws://x', link, workers, log: () => {} });
  await node.start();
  const server = http.createServer((req, res) => void node.http(req, res, new URL(req.url ?? '/', 'http://x').pathname));
  server.on('upgrade', (req, socket, head) => (new URL(req.url ?? '/', 'http://x').pathname === '/v3' ? node.upgrade(req, socket, head) : refuse(socket, 404, 'no')));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return { node, server, port, stop: async () => { node.stop(); server.closeAllConnections(); await new Promise((r) => server.close(() => r(null))); } };
}
let ordN = 0;
function ticket(room: string, o: any = {}) {
  const now = Math.floor(Date.now() / 1000);
  const ord = o.ord ?? ++ordN;
  return signToken(TICKET_PREFIX, {
    v: 1, kid: K.kid, prj: 'test', room, peer: o.peer ?? `p${ord}`, ord, sub: 's', nm: o.name ?? `P${ord}`, role: o.role ?? 'player', tr: o.tr ?? ['p2p', 'relay'], want: o.want ?? 'relay', node: 'n1', epoch: 1,
    lim: { ...core.DEFAULT_LIMITS, playersPerRoom: 64 }, cfg: { topology: 'star', profile: 'medium', maxPlayers: o.max ?? 64, p2pMax: o.p2pMax ?? 8, interest: null }, iat: now, exp: now + (o.exp ?? 90), jti: crypto.randomBytes(6).toString('hex'),
  }, K.privateKey);
}

/** A raw protocol-3 client: decodes bundles and JSON frames into `got`. */
function client(port: number, q: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v3?${q}`, ['hawkes-net.v3']);
  ws.binaryType = 'arraybuffer';
  const got: any[] = [];
  let dec = new core.Codec();
  const enc = new core.Codec();
  const c = {
    ws, got,
    open: new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error('refused')); }),
    closed: new Promise<number>((res) => { ws.onclose = (e) => res(e.code); }),
    send(msgs: any[]) { ws.send(enc.bundle(msgs, Date.now(), true)); },
    control(m: any) { ws.send(core.jsonFrame(core.FRAME.control, m)); },
    reset() { dec = new core.Codec(); /* a new stream after a migration hello */ },
    wait: async (pred: (m: any) => boolean, ms = 3000) => {
      const until = Date.now() + ms;
      for (;;) { const m = got.find(pred); if (m) return m; if (Date.now() > until) throw new Error(`timed out; got ${JSON.stringify(got.map((x) => x.t ?? x.c)).slice(0, 400)}`); await new Promise((r) => setTimeout(r, 20)); }
    },
  };
  ws.onmessage = (e) => {
    const u8 = new Uint8Array(e.data as ArrayBuffer);
    const p = core.peek(u8);
    if (p.kind === 'bundle') got.push(...dec.read(u8, true).msgs);
    else { if (p.value?.t === 'hello' && p.value.mode === 'relay' && p.value.migrated) { dec = new core.Codec(); } got.push(p.value); }
  };
  return c;
}

for (const workers of [0, 2]) {
  test(`node (${workers ? `${workers} worker processes` : 'one process'}): a relay room carries protocol 3; bad tickets are refused`, async () => {
    const n = await startNode(workers);
    try {
      const a = client(n.port, `t=${encodeURIComponent(ticket('r1'))}&want=relay`);
      await a.open;
      const hello = await a.wait((m) => m.t === 'hello');
      assert.equal(hello.mode, 'relay');
      const b = client(n.port, `t=${encodeURIComponent(ticket('r1'))}&want=relay`);
      await b.open;
      await b.wait((m) => m.t === 'hello');
      await a.wait((m) => m.t === 'join');
      a.send([{ t: 'xf', at: Date.now(), x: [['ball', 7, 1, 2, 3]] }, { t: 'ev', name: 'hi', data: { n: 1 }, seq: 1 }]);
      const xf = await b.wait((m) => m.t === 'xf');
      assert.deepEqual(xf.x[0], ['ball', 7, 1, 2, 3]);
      assert.deepEqual((await b.wait((m) => m.t === 'ev' && m.name === 'hi')).data, { n: 1 });
      // A ticket used twice, a forged one, an expired one: refused before any socket.
      const t = ticket('r1');
      const ok = client(n.port, `t=${encodeURIComponent(t)}`);
      await ok.open;
      const twice = client(n.port, `t=${encodeURIComponent(t)}`);
      await assert.rejects(twice.open);
      const forged = client(n.port, `t=${encodeURIComponent(t.slice(0, -4) + 'AAAA')}`);
      await assert.rejects(forged.open);
      const old = client(n.port, `t=${encodeURIComponent(ticket('r1', { exp: -120 }))}`);
      await assert.rejects(old.open);
      for (const x of [a, b, ok]) x.ws.close();
    } finally { await n.stop(); }
  });
}

test('node: a dropped player comes back with its resume token and keeps its place and its owned things', async () => {
  const n = await startNode(0);
  try {
    const a = client(n.port, `t=${encodeURIComponent(ticket('r2', { ord: 1 }))}&want=relay`);
    await a.open;
    const hello = await a.wait((m) => m.t === 'hello');
    const b = client(n.port, `t=${encodeURIComponent(ticket('r2', { ord: 2 }))}&want=relay`);
    await b.open;
    await b.wait((m) => m.t === 'hello');
    a.send([{ t: 'own', id: 'car', on: true, lock: 1 }]);
    await b.wait((m) => m.t === 'own' && m.id === 'car');
    a.ws.close(4100);
    await new Promise((r) => setTimeout(r, 200));
    b.send([{ t: 'ev', name: 'while-away', data: 1 }]);
    const a2 = client(n.port, `r=${encodeURIComponent(hello.resume)}`);
    await a2.open;
    const h2 = await a2.wait((m) => m.t === 'hello');
    assert.equal(h2.you, hello.you, 'the same peer id');
    assert.equal(h2.owners.car, hello.you, 'still owns the car');
    assert.ok(await a2.wait((m) => m.t === 'ev' && m.name === 'while-away'), 'got what was sent while away');
    assert.ok(!b.got.some((m) => m.t === 'leave'), 'nobody saw them leave');
    a2.ws.close(); b.ws.close();
  } finally { await n.stop(); }
});

test('node: a p2p room is signalling only, and moves to the relay on the same sockets when it grows past its p2p size', async () => {
  const n = await startNode(0);
  try {
    const mk = (ord: number) => client(n.port, `t=${encodeURIComponent(ticket('r3', { ord, want: 'auto', p2pMax: 2 }))}&want=auto`);
    const a = mk(1); await a.open;
    const ha = await a.wait((m) => m.t === 'hello');
    assert.equal(ha.mode, 'p2p');
    const b = mk(2); await b.open;
    await b.wait((m) => m.t === 'hello' && m.mode === 'p2p');
    await a.wait((m) => m.c === 'peer' && m.ev === 'join');
    // Signalling goes from one to the other, and nowhere else.
    a.control({ c: 'sig', to: 'p2', kind: 'offer', body: 'sdp...' });
    const sig = await b.wait((m) => m.c === 'sig');
    assert.deepEqual([sig.from, sig.kind, sig.body], ['p1', 'offer', 'sdp...']);
    // A third joins: past p2pMax 2, the room moves. The host (p1) is asked for its copy of the world.
    const c = mk(3); await c.open;
    const ask = await a.wait((m) => m.c === 'migrate' && m.step === 'seed');
    a.control({ c: 'seed', epoch: ask.epoch, snap: { owners: { car: 'p2' }, locks: {}, things: [['ball', 'p1', Date.now(), false, 5, 6, 7]], states: [], recent: [] } });
    for (const x of [a, b, c]) {
      const h = await x.wait((m) => m.t === 'hello' && m.mode === 'relay');
      assert.equal(h.migrated, true);
      assert.equal(h.host, 'p1', 'the host stays the host');
      assert.equal(h.owners.car, 'p2', "the world's ownership came with it");
    }
    const ball = await c.wait((m) => m.t === 'xf' && m.x.some((e: any) => e[0] === 'ball'));
    assert.deepEqual(ball.x.find((e: any) => e[0] === 'ball').slice(2, 5), [5, 6, 7]);
    // And now data goes through the relay.
    b.send([{ t: 'ev', name: 'now-relayed', data: 1 }]);
    assert.ok(await c.wait((m) => m.t === 'ev' && m.name === 'now-relayed'));
    assert.ok(events.some((e) => e.event === 'moved' && e.room === 'r3'));
    for (const x of [a, b, c]) x.ws.close();
  } finally { await n.stop(); }
});

test("node: Gen's publish reaches a room's players; a forged publish doesn't", async () => {
  const n = await startNode(0);
  try {
    const a = client(n.port, `t=${encodeURIComponent(ticket('r4'))}&want=relay`);
    await a.open;
    await a.wait((m) => m.t === 'hello');
    const now = Math.floor(Date.now() / 1000);
    const tok = signToken(PUBLISH_PREFIX, { v: 1, kid: K.kid, prj: 'test', room: 'r4', iat: now, exp: now + 30, jti: 'j1' }, K.privateKey);
    const r = await fetch(`http://127.0.0.1:${n.port}/publish`, { method: 'POST', headers: { Authorization: `Bearer ${tok}` }, body: JSON.stringify({ ops: [{ op: 'create', entity: { id: 'tree' } }], by: 'Assistant' }) }).then((x) => x.json());
    assert.equal(r.delivered, 1);
    const ops = await a.wait((m) => m.t === 'ops');
    assert.equal(ops.ops[0].entity.id, 'tree');
    const bad = await fetch(`http://127.0.0.1:${n.port}/publish`, { method: 'POST', headers: { Authorization: `Bearer ${tok}` }, body: '{}' });
    assert.equal(bad.status, 401, 'a publish token works once');
    a.ws.close();
  } finally { await n.stop(); }
});

test('node: a full room refuses the next player', async () => {
  const n = await startNode(0);
  try {
    const a = client(n.port, `t=${encodeURIComponent(ticket('r5', { max: 1 }))}&want=relay`);
    await a.open;
    const b = client(n.port, `t=${encodeURIComponent(ticket('r5', { max: 1 }))}&want=relay`);
    await b.open;
    assert.equal(await b.closed, 4009, 'closed with the reason a page can read');
    a.ws.close();
  } finally { await n.stop(); }
});

test('node: a client closing with 4000 leaves no ghost, a stale ticket for an id already here is refused, and Infinity does not hang the room', async () => {
  const n = await startNode(0);
  try {
    const a = client(n.port, `t=${encodeURIComponent(ticket('ghost', { max: 2, ord: 901 }))}`);
    await a.open; await a.wait((m) => m.t === 'hello');
    const b = client(n.port, `t=${encodeURIComponent(ticket('ghost', { max: 2, ord: 902 }))}`);
    await b.open; await b.wait((m) => m.t === 'hello');
    // The same id again (the directory forgot the room and counted again): refused, and b keeps its place.
    const dup = client(n.port, `t=${encodeURIComponent(ticket('ghost', { max: 2, ord: 902 }))}`);
    await assert.rejects(dup.open);
    // A text frame with absurd numbers used to spin the worker forever at the next flush.
    a.ws.send(JSON.stringify({ t: 'me', at: 1e308, s: { p: [1e308, 0, 0], y: 1e308 } }));
    a.ws.send(JSON.stringify({ t: 'ev', name: 'alive', data: 1 }));
    await b.wait((m) => m.t === 'ev' && m.name === 'alive');
    // b says goodbye with 4000 (the code the node uses for "replaced"): it must still leave after its grace.
    b.ws.close(4000, 'bye');
    await b.closed;
    await a.wait((m) => m.t === 'leave', 20_000);
    // The room has a free place again.
    const c = client(n.port, `t=${encodeURIComponent(ticket('ghost', { max: 2, ord: 903 }))}`);
    await c.open; await c.wait((m) => m.t === 'hello');
    c.ws.close(); a.ws.close();
  } finally { await n.stop(); }
});
