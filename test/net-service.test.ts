// The Hawkes Net service end to end (src/hub.ts in this process): tickets from POST /v1/net/ticket, the service's own
// relay node (ws://<service>/v1/net/ws), and the client SDK (sdk/js/hawkes-net.mjs) in Node: a relay room (messages,
// avatars, things, ownership, synced states, actions), an 'auto' room that starts peer to peer on the signal route and
// moves to the relay when it grows (with no reliable message lost or repeated), the public ticket door, publish, kicks,
// and usage handed on (the box sends it to Gen).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

const { startTestHub, addKey } = await import('./helper.ts');
// @ts-ignore: plain JS SDK
const { join, lobby } = await import('../sdk/js/hawkes-net.mjs');
const hub = await startTestHub();
const { endpoint, svc } = hub;
test.after(async () => { await hub.stop(); });

const wait = async (pred: () => any, ms = 4000, what = 'condition') => {
  const until = Date.now() + ms;
  for (;;) { const v = pred(); if (v) return v; if (Date.now() > until) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 20)); }
};
const opts = (o: any = {}) => ({ project: 'netdemo', endpoint, leaveOnHide: false, log: false, ...o });

test('the service is up with its own relay node, and hands out tickets for it', async () => {
  const st = svc.status();
  assert.ok(st.up, 'a node is up');
  const r = await fetch(`${endpoint}/v1/net/ticket`, { method: 'POST', body: JSON.stringify({ project: 'netdemo', room: 'tk', sub: 'x', client: { sdk: '1', protocols: [3] } }) }).then((x) => x.json());
  assert.match(r.ticket, /^hn1\./);
  assert.equal(r.peer, 'p1');
  assert.match(r.relayUrl, /\/v1\/net\/ws$/);
  const r2 = await fetch(`${endpoint}/v1/net/ticket`, { method: 'POST', body: JSON.stringify({ project: 'netdemo', room: 'tk', sub: 'y', client: { sdk: '1', protocols: [3] } }) }).then((x) => x.json());
  assert.equal(r2.peer, 'p2', 'join order counts up per room');
});

test('the public door: a page on one of the project\'s sites gets a player ticket; other sites do not', async () => {
  const ask = (origin: string, body: any = {}) => fetch(`${endpoint}/v1/net/ticket`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ project: 'netdemo', room: 'door', sub: 's', client: { protocols: [3] }, ...body }) });
  assert.equal((await ask('https://hawkesgen.ai')).status, 200);
  assert.equal((await ask('http://localhost:5173')).status, 200);
  assert.equal((await ask('https://evil.example')).status, 403);
  assert.equal((await ask('https://hawkesgen.ai', { role: 'bot' })).status, 403, 'bots need a key');
  assert.equal((await ask('https://hawkesgen.ai', { project: 'doseofdestruction', room: 'x' })).status, 403, 'only the project\'s own sites');
});

test('a relay room: messages once and in order, avatars, things only from their simulator, ownership, states, actions', async () => {
  const a = await join('relay1', opts({ name: 'Ada', transport: 'relay' }));
  const b = await join('relay1', opts({ name: 'Bo', transport: 'relay' }));
  try {
    assert.equal(a.transport, 'relay');
    assert.equal(a.host, a.id, 'the first in is the host');
    await wait(() => a.peers.has(b.id), 4000, 'A sees B');
    const got: number[] = [];
    b.on('n', (d: number) => got.push(d));
    for (let i = 0; i < 50; i++) a.send('n', i);
    await wait(() => got.length === 50, 4000, '50 messages');
    assert.deepEqual(got, [...Array(50).keys()]);
    // Avatars.
    let pose: any = null;
    b.onPose((id: string, s: any) => { if (id === a.id) pose = s; });
    a.pose([1, 2, 3], 1.5, { f: 1 });
    await wait(() => pose, 3000, 'a pose');
    assert.deepEqual(pose.p, [1, 2, 3]); assert.equal(pose.f, 1);
    // Things: the host simulates what nobody owns; B's pushes of a thing it doesn't own are dropped by its own SDK.
    const seen = new Map<string, number[]>();
    b.sync.onThing((id: string, _at: number, v: number[]) => seen.set(id, v.slice()));
    a.sync.push('ball', [4, 5, 6, 0, 0, 0, 1, 0, 0]);
    await wait(() => seen.get('ball'), 3000, 'the ball');
    assert.deepEqual(seen.get('ball')!.slice(0, 3), [4, 5, 6]);
    assert.equal(b.sync.mine('ball'), false);
    assert.equal(b.sync.claim('car', { hold: true }), true);
    await wait(() => a.sync.holder('car') === b.id, 3000, 'B holds the car');
    assert.equal(a.sync.claim('car'), false, "A can't take a held car");
    // A synced state from the host, and an action decided by the host.
    let weather: any = null;
    const sky = { rain: true, wind: 3 };
    a.sync.state('weather', { get: () => sky, set: () => {} });
    b.sync.state('weather', { get: () => ({}), set: (s: any) => { weather = s; } });
    await wait(() => weather, 4000, 'the weather');
    assert.deepEqual(weather, { rain: true, wind: 3 });
    const booms: any[] = [];
    const boomA = a.sync.action('boom', (d: any, c: any) => booms.push(['a', d, c.authoritative]));
    const boomB = b.sync.action('boom', (d: any, c: any) => booms.push(['b', d, c.authoritative]));
    boomB({ at: 1 });
    await wait(() => booms.length >= 2, 3000, 'the boom on both');
    assert.deepEqual(booms.find((x) => x[0] === 'a'), ['a', { at: 1 }, true], 'the host decides');
    assert.ok(a.stats().downBytes > 0 && b.stats().rttMs !== null, 'stats and a round trip');
    void boomA;
  } finally { await a.leave(); await b.leave(); }
});

test("'auto': peer to peer on the signal route, then the relay when a third joins; nothing reliable lost or repeated", async () => {
  const cfg = { config: { p2pMax: 2, maxPlayers: 8 } };
  // (Peer to peer is asked for: the relay is the default, and netdemo is a project that allows it.)
  const a = await join('auto1', opts({ name: 'Host', transport: 'auto', ...cfg }));
  const b = await join('auto1', opts({ name: 'Two', transport: 'auto', ...cfg }));
  const got: number[] = [];
  b.on('n', (d: number) => got.push(d));
  const moved: any[] = [];
  a.when('transport', (e: any) => moved.push(e));
  try {
    assert.equal(a.transport, 'p2p');
    assert.equal(b.transport, 'p2p');
    assert.equal(a.isHost, true);
    await wait(() => b.host === a.id, 3000, 'B knows the host');
    for (let i = 0; i < 20; i++) a.send('n', i);
    await wait(() => got.length === 20, 4000, '20 messages over p2p (signal route: Node has no WebRTC)');
    let seenBall: any = null;
    b.sync.onThing((id: string, _at: number, v: number[]) => { if (id === 'ball') seenBall = v.slice(); });
    a.sync.push('ball', [7, 8, 9]);
    await wait(() => seenBall, 3000, 'the ball over p2p');
    // A third player: past p2pMax 2, so the room moves to the relay, seeded by the host's copy of the world.
    const c = await join('auto1', opts({ name: 'Three', ...cfg }));
    try {
      await wait(() => a.transport === 'relay' && b.transport === 'relay' && c.transport === 'relay', 6000, 'everyone on the relay');
      assert.equal(moved.length, 1, 'one move');
      assert.equal(a.host, a.id, 'the host is still the host');
      for (let i = 20; i < 40; i++) a.send('n', i);
      await wait(() => got.length >= 40, 4000, '20 more messages over the relay');
      assert.deepEqual(got, [...Array(40).keys()], 'every message once, in order, across the move');
      const cBall = await wait(() => c.sync.thing('ball'), 4000, 'the newcomer gets the world the host had');
      assert.deepEqual(cBall.slice(0, 3), [7, 8, 9]);
    } finally { await c.leave(); }
  } finally { await a.leave(); await b.leave(); }
});

test("publish puts a server's world edit into the room", async () => {
  const a = await join('pub1', opts({ transport: 'relay' }));
  try {
    let ops: any = null;
    a.sync.onOps((o: any, meta: any) => { ops = { o, meta }; });
    const r = await fetch(`${endpoint}/v1/net/publish`, { method: 'POST', body: JSON.stringify({ project: 'netdemo', room: 'pub1', ops: [{ op: 'create', entity: { id: 'tree' } }], by: 'Assistant' }) }).then((x) => x.json());
    assert.equal(r.delivered, 1);
    await wait(() => ops, 3000, 'the ops');
    assert.equal(ops.o[0].entity.id, 'tree');
    assert.equal(ops.meta.by, 'Assistant');
  } finally { await a.leave(); }
});

test("usage is handed on: player-seconds and bytes per project and transport (the box sends it to Gen)", async () => {
  const a = await join('use1', opts({ transport: 'relay' }));
  const b = await join('use1', opts({ transport: 'relay' }));
  for (let i = 0; i < 30; i++) { a.pose([i, 0, 0], 0); await new Promise((r) => setTimeout(r, 40)); }
  await new Promise((r) => setTimeout(r, 1100));
  await (svc.ownNode() as any).reportUsage();
  await a.leave(); await b.leave();
  const rows = hub.usage.flatMap((u) => u.rows).filter((r: any) => r.project === 'netdemo' && r.transport === 'relay');
  assert.ok(rows.some((r: any) => r.playerSeconds > 0), JSON.stringify(rows));
  assert.ok(rows.some((r: any) => r.bytesOut > 0));
});

test('a full room: the next join is refused with a reason', async () => {
  const a = await join('full1', opts({ transport: 'relay', config: { maxPlayers: 1 } }));
  try {
    await assert.rejects(join('full1', opts({ transport: 'relay' })), /full/);
  } finally { await a.leave(); }
});

test("an engine on raw messages (the portal's play/net.js): its own shapes both ways, and a hello to start from", async () => {
  const gotA: any[] = [];
  const gotB: any[] = [];
  const a = await join('raw1', opts({ transport: 'relay', name: 'A', onRaw: (m: any) => gotA.push(m) }));
  const b = await join('raw1', opts({ transport: 'relay', name: 'B', onRaw: (m: any) => gotB.push(m) }));
  try {
    assert.equal(gotA[0].t, 'hello');
    assert.equal(gotA[0].you, a.id);
    await wait(() => gotA.some((m) => m.t === 'join' && m.c === b.id), 3000, "A's raw join of B");
    a.raw.send({ t: 'xf', at: a.now(), x: [['crate', 0b111, 1, 2, 3]] });
    a.raw.send({ t: 'me', at: a.now(), s: { p: [4, 5, 6], y: 1, f: 1 } });
    a.raw.send({ t: 'ev', name: 'boom', data: { r: 2 } });
    a.raw.send({ t: 'own', id: 'car', on: true, lock: 1 });
    await wait(() => gotB.some((m) => m.t === 'xf') && gotB.some((m) => m.t === 'me') && gotB.some((m) => m.t === 'ev' && m.name === 'boom') && gotB.some((m) => m.t === 'own'), 3000, 'all four on B');
    assert.deepEqual(gotB.find((m) => m.t === 'xf').x[0], ['crate', 7, 1, 2, 3]);
    assert.equal(gotB.find((m) => m.t === 'me').s.f, 1);
    assert.equal(gotB.find((m) => m.t === 'own').c, a.id);
  } finally { await a.leave(); await b.leave(); }
});

test("publish to every room under a prefix, and ask whether a room is open", async () => {
  const a = await join('g1/edit', opts({ transport: 'relay' }));
  const b = await join('g1/play/x1', opts({ transport: 'relay' }));
  try {
    const got: string[] = [];
    a.sync.onOps(() => got.push('a'));
    b.sync.onOps(() => got.push('b'));
    await new Promise((r) => setTimeout(r, 1200)); // a room count reaches the directory each second
    const r = await fetch(`${endpoint}/v1/net/publish`, { method: 'POST', body: JSON.stringify({ project: 'netdemo', room: 'g1/*', ops: [{ op: 'delete', id: 'x' }] }) }).then((x) => x.json());
    assert.equal(r.rooms, 2);
    await wait(() => got.length === 2, 3000, 'both rooms');
    const info = await fetch(`${endpoint}/v1/net/room`, { method: 'POST', body: JSON.stringify({ project: 'netdemo', room: 'g1/edit' }) }).then((x) => x.json());
    assert.equal(info.open, true);
    assert.equal(info.players, 1);
    const none = await fetch(`${endpoint}/v1/net/room`, { method: 'POST', body: JSON.stringify({ project: 'netdemo', room: 'nobody/here' }) }).then((x) => x.json());
    assert.equal(none.open, false);
  } finally { await a.leave(); await b.leave(); }
});

test("the portal's key, narrowed to one customer, issues tickets in that customer's projects and no other", async () => {
  const key = addKey('portal', ['usr_*']);
  const make = (owner: string, id: string) => fetch(`${endpoint}/v1/net/projects`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ owner, id, name: id, tier: 'paid' }) });
  assert.equal((await make('usr_00000000000000aa', 'aa-arena')).status, 200);
  assert.equal((await make('usr_00000000000000bb', 'bb-arena')).status, 200);
  const ask = (project: string, only?: string) => fetch(`${endpoint}/v1/net/ticket`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(only ? { 'X-Hawkesgen-Project': only } : {}) }, body: JSON.stringify({ project, room: 'lobby', sub: 's', client: { protocols: [3] } }) });
  const ok = await ask('aa-arena', 'usr_00000000000000aa');
  assert.equal(ok.status, 200);
  assert.match((await ok.json()).ticket, /^hn1\./);
  assert.equal((await ask('bb-arena', 'usr_00000000000000aa')).status, 403, "another customer's project");
  assert.equal((await ask('usr_00000000000000aa', 'usr_00000000000000aa')).status, 404, 'no anonymous projects');
  assert.equal((await ask('netdemo')).status, 403, 'a project the key has no part in');
});

test("publish can put people out of a room: everyone, or those who joined as one sub; they don't come back", async () => {
  const a = await join('kick1', opts({ name: 'Ada', transport: 'relay', sub: 'u-ada' }));
  const b = await join('kick1', opts({ name: 'Bo', transport: 'relay', sub: 'u-bo' }));
  try {
    await wait(() => a.peers.has(b.id), 4000, 'A sees B');
    const problems: string[] = [];
    b.when('problem', (p: any) => problems.push(p.code));
    const r = await svc.publish({ id: 'local', name: 't', role: 'owner', projects: ['*'] } as any, { project: 'netdemo', room: 'kick1', kick: { sub: 'u-bo' } });
    assert.equal(r.kicked, 1, 'only Bo');
    await wait(() => b.status === 'closed', 4000, 'Bo is out');
    assert.ok(problems.includes('refused'), 'told why');
    await wait(() => !a.peers.has(b.id), 4000, 'A sees Bo leave');
    await new Promise((res) => setTimeout(res, 1500));
    assert.equal(b.status, 'closed', 'and does not come back by itself');
    assert.equal(a.status, 'online', 'Ada stays');
  } finally { await a.leave(); await b.leave(); }
});

test("the portal's rooms have no keyless door, and localhost is a door only where NET_TRUST_LOCALHOST says so", async () => {
  const r = await fetch(`${endpoint}/v1/net/ticket`, { method: 'POST', headers: { Origin: 'https://hawkesgen.ai', 'Content-Type': 'application/json' }, body: JSON.stringify({ project: 'hawkesgenwebsite', room: 'g/g_x/edit', client: { protocols: [3] } }) });
  assert.equal(r.status, 403, 'an Origin header can be set by anyone: the portal asks with its key');
  const { originAllowed, netProject } = await import('../src/registry.ts');
  assert.equal(originAllowed(netProject('netdemo'), 'http://localhost:5173'), true, 'on a developer machine');
  process.env.NET_TRUST_LOCALHOST = '0';
  try {
    assert.equal(originAllowed(netProject('netdemo'), 'http://localhost:5173'), false, 'on the box: anyone can say localhost');
    assert.equal(originAllowed(netProject('netdemo'), 'http://localhost:9088', 't-lobby'), true, "a project's test rooms take localhost pages (Studio's playtests)");
    assert.equal(originAllowed(netProject('netdemo'), 'http://127.0.0.1:9088', 't-abc/p1/level-1'), true, 'a playtest room too');
    assert.equal(originAllowed(netProject('netdemo'), 'http://localhost:9088', 'lobby'), false, 'never its live rooms');
    assert.equal(originAllowed(netProject('hawkesgenwebsite'), 'http://localhost:9088', 't-lobby'), false, 'never a project without its own sites');
    // Studio's preview host is shared by every customer's builds: Yooba Land's cell copy may play its test rooms only.
    assert.equal(originAllowed(netProject('yoobaland'), 'https://sites.hawkesgen.ai', 't-p1/level-1'), true, 'the preview host, test rooms');
    assert.equal(originAllowed(netProject('yoobaland'), 'https://sites.hawkesgen.ai', 'p1/level-1'), false, 'never the live rooms');
    assert.equal(originAllowed(netProject('hawkesgenwebsite'), 'https://sites.hawkesgen.ai', 't-lobby'), false, 'only for the project that lists it');
    assert.equal(originAllowed(netProject('netdemo'), 'https://sites.hawkesgen.ai', 'lobby'), false, "the demo's beta pages: never its live rooms");
    assert.equal(originAllowed(netProject('yoobaland'), 'https://yoobalandgame.com', 'p1/lobby'), true, 'its own site, live rooms');
  }
  finally { process.env.NET_TRUST_LOCALHOST = '1'; }
});

test('a room is open in the directory as soon as its first player is in (an invitation asked a moment later)', async () => {
  const a = await join('soon1', opts({ transport: 'auto' }));
  try {
    const info = await fetch(`${endpoint}/v1/net/room`, { method: 'POST', body: JSON.stringify({ project: 'netdemo', room: 'soon1' }) }).then((x) => x.json());
    assert.equal(info.open, true);
    assert.equal(info.players, 1);
  } finally { await a.leave(); }
});

test("a developer's own rooms, and the operator view for owner and admin keys only", async () => {
  const a = await join('mine-1', opts({ transport: 'relay' }));
  try {
    const dev = addKey('dev', ['usr_dev']);
    const listFor = (key: string, project: string) => fetch(`${endpoint}/v1/net/rooms`, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: JSON.stringify({ project }) });
    assert.equal((await listFor(dev, 'netdemo')).status, 403, "another project's rooms");
    const own = await (await fetch(`${endpoint}/v1/net/rooms`, { method: 'POST', body: JSON.stringify({ project: 'netdemo' }) })).json();
    assert.ok(own.rooms.some((r: any) => r.room === 'mine-1' && r.players === 1), JSON.stringify(own));
    assert.equal((await fetch(`${endpoint}/v1/net/ops`, { headers: { Authorization: `Bearer ${dev}` } })).status, 403);
    const ops = await (await fetch(`${endpoint}/v1/net/ops`)).json();
    assert.ok(ops.node && typeof ops.node.players === 'number', 'the node and its workers');
    assert.ok(ops.extra && typeof ops.extra.uptimeS === 'number', 'uptime and usage');
  } finally { await a.leave(); }
});

test("projects belong to accounts: made, listed, changed and read only by their account; the door opens for their sites; Hawkes's games are an admin's to take", async () => {
  const portal = addKey('portal-projects', ['usr_*']);
  const call = (method: string, path: string, body?: any) => fetch(`${endpoint}${path}`, { method, headers: { Authorization: `Bearer ${portal}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const as = (owner: string, extra: any = {}) => ({ owner, tier: 'paid', ...extra });
  const door = (origin: string, project: string, room = 'lobby') => fetch(`${endpoint}/v1/net/ticket`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ project, room, client: { protocols: [3] } }) });
  const acme = 'usr_00000000000000a1', other = 'usr_00000000000000a2', admin = 'usr_00000000000000ad';

  // Made by its account, its id from its name; nobody may make one without an account.
  const made = await (await call('POST', '/v1/net/projects', as(acme, { name: 'Acme Arena' }))).json();
  assert.equal(made.id, 'acme-arena');
  assert.equal(made.owner, acme);
  assert.equal(made.p2p, false, 'peer to peer is off until the account turns it on');
  assert.equal((await call('POST', '/v1/net/projects', as(acme, { name: 'Acme Arena' })).then((r) => r.json())).id, 'acme-arena-2', 'a name taken: the next id');
  assert.equal((await call('POST', '/v1/net/projects', as(acme, { name: 'X', id: 'sickofit' }))).status, 409, "a Hawkes game's id is taken");
  assert.equal((await call('POST', '/v1/net/projects', { name: 'Nobody' })).status, 400, 'no account, no project');
  const mineKey = addKey('acme-own', [acme]);
  assert.equal((await fetch(`${endpoint}/v1/net/projects`, { headers: { Authorization: `Bearer ${mineKey}` } }).then((r) => r.json())).projects.length, 2, "a key for one account sees that account's");

  // Listed for its account only.
  const list = await (await call('GET', `/v1/net/projects?owner=${acme}&tier=paid`)).json();
  assert.deepEqual(list.projects.map((p: any) => p.id), ['acme-arena', 'acme-arena-2']);
  assert.equal(list.unowned.length, 0, 'Hawkes games are shown to admins only');
  assert.equal((await (await call('GET', `/v1/net/projects?owner=${other}`)).json()).projects.length, 0);
  assert.equal((await call('GET', `/v1/net/projects/acme-arena?owner=${other}`)).status, 404, "another account can't read it");
  assert.equal((await call('POST', '/v1/net/projects/acme-arena', as(other, { name: 'Mine now' }))).status, 404, "nor change it");

  // Its sites open the door; localhost joins its test rooms only; peer to peer and the room's size are its settings.
  assert.equal((await door('https://acme.games', 'acme-arena')).status, 403, 'no sites yet');
  assert.equal((await call('POST', '/v1/net/projects/acme-arena', as(acme, { sites: ['https://acme.games/x'] }))).status, 400, 'a site, not a page');
  const set = await (await call('POST', '/v1/net/projects/acme-arena', as(acme, { sites: ['acme.games', 'https://WWW.acme.games/'], p2p: true, maxPlayers: 12 }))).json();
  assert.deepEqual(set.sites, ['https://acme.games', 'https://www.acme.games']);
  assert.equal(set.p2p, true);
  assert.equal(set.maxPlayers, 12);
  assert.equal((await door('https://acme.games', 'acme-arena')).status, 200);
  assert.equal((await door('https://evil.example', 'acme-arena')).status, 403);
  assert.equal((await door('https://acme.games', 'acme-arena-2')).status, 403, "only the project whose sites they are");
  const { originAllowed, netProject } = await import('../src/registry.ts');
  process.env.NET_TRUST_LOCALHOST = '0';
  try {
    assert.equal(originAllowed(netProject('acme-arena-2'), 'http://localhost:5173', 't-lobby'), true, 'a project with no sites yet still tests on localhost');
    assert.equal(originAllowed(netProject('acme-arena-2'), 'http://localhost:5173', 'lobby'), false, 'never its live rooms');
    assert.equal(originAllowed(netProject('nobodys-game'), 'http://localhost:5173', 't-lobby'), false, 'no project, no door');
  } finally { process.env.NET_TRUST_LOCALHOST = '1'; }

  // The tier sets the limits: a free account builds and tests, a paid one runs a game.
  assert.equal(netProject('acme-arena-2').limits.playersPerRoom, 64);
  await call('GET', `/v1/net/projects?owner=${acme}&tier=free`);
  assert.equal(netProject('acme-arena-2').limits.playersPerRoom, 8, 'free: small rooms');
  assert.equal((await call('POST', '/v1/net/projects/acme-arena-2', as(acme, { tier: 'free', maxPlayers: 20 }))).status, 400, "a room bigger than the plan's");
  await call('GET', `/v1/net/projects?owner=${acme}&tier=paid`);

  // A ticket shows in its log and its day; the page lists its rooms and who is in them, and can put someone out.
  const a = await join('arena-1', opts({ project: 'acme-arena', name: 'Ada', sub: 'u-ada' }));
  const b = await join('arena-1', opts({ project: 'acme-arena', name: 'Bo', sub: 'u-bo' }));
  try {
    const page = await wait(async () => { const j = await (await call('GET', `/v1/net/projects/acme-arena?owner=${acme}`)).json(); return j.now?.players === 2 ? j : null; }, 6000, 'two players on the page');
    assert.ok(page.tickets.filter((t: any) => t.ok && t.room === 'arena-1').length >= 2, 'the tickets are logged');
    assert.ok(page.tickets.some((t: any) => !t.ok && /own sites/.test(t.why ?? '')), 'and the refused ones, with why');
    assert.ok(page.today.tickets >= 3 && page.today.refused >= 1, "the day's counts");
    assert.equal(page.rooms[0].room, 'arena-1');
    assert.equal(page.rooms[0].transport, 'relay', 'the relay: no peer to peer asked for');
    const who = await (await call('GET', `/v1/net/projects/acme-arena/rooms/arena-1?owner=${acme}`)).json();
    assert.deepEqual(who.players.map((p: any) => [p.name, p.sub, p.connected]), [['Ada', 'u-ada', true], ['Bo', 'u-bo', true]]);
    assert.equal((await call('GET', `/v1/net/projects/acme-arena/rooms/arena-1?owner=${other}`)).status, 404);
    const out = await (await call('POST', '/v1/net/projects/acme-arena/rooms/arena-1/kick', as(acme, { sub: 'u-bo' }))).json();
    assert.equal(out.kicked, 1);
    await wait(() => b.status === 'closed', 3000, 'Bo put out');
    const { sampleOnline } = await import('../src/projects.ts');
    sampleOnline();
    const after = await (await call('GET', `/v1/net/projects/acme-arena?owner=${acme}`)).json();
    assert.ok(after.online.some((o: any) => o.players >= 1), 'the players-online line has the minute');
  } finally { await a.leave(); await b.leave(); }

  // Hawkes's games: shown to an admin to take, then theirs (their file settings under it); a customer can't take one.
  const adminList = await (await call('GET', `/v1/net/projects?owner=${admin}&admin=true`)).json();
  assert.ok(adminList.unowned.some((p: any) => p.id === 'sickofit' && p.claimable && p.hawkes));
  assert.equal((await call('POST', '/v1/net/projects/sickofit/claim', as(acme))).status, 403, 'only an admin');
  const took = await (await call('POST', '/v1/net/projects/sickofit/claim', as(admin, { admin: true }))).json();
  assert.equal(took.owner, admin);
  assert.ok(took.sites.includes('https://sickofitgame.com'), "its sites from the file");
  assert.equal(took.p2p, false);
  assert.equal(netProject('sickofit').limits.playersPerRoom, 1000, "the file's limits stay");
  const now = await (await call('GET', `/v1/net/projects?owner=${admin}&admin=true`)).json();
  assert.ok(now.projects.some((p: any) => p.id === 'sickofit') && !now.unowned.some((p: any) => p.id === 'sickofit'), 'now in the account');
  assert.equal((await door('https://sickofitgame.com', 'sickofit')).status, 200, 'its game still plays');

  // A project goes; a Hawkes game is let go (back to nobody's).
  assert.equal((await call('DELETE', `/v1/net/projects/acme-arena-2?owner=${acme}`)).status, 200);
  assert.equal(netProject('acme-arena-2').listed, false);
  assert.equal((await (await call('DELETE', `/v1/net/projects/sickofit?owner=${admin}&admin=true`)).json()).released, true);
  assert.equal(netProject('sickofit').owner, null);
});

test('the lobby (the standard layer for web games): room names by where the page runs, the next shard when full, handlers kept across rooms', async () => {
  const lo = (url: string, o: any = {}) => lobby({ ...opts({ transport: 'relay' }), liveHosts: ['mygame.com'], url, ...o });
  assert.equal(lo('https://mygame.com/play').nameFor('level-1'), 'level-1', 'live');
  assert.equal(lo('https://mygame.com/play').nameFor('level-1', 3), 'level-1.3', 'a shard');
  assert.equal(lo('https://beta.mygame.dev/').nameFor('level-1'), 't-level-1', 'anywhere else: the test rooms');
  assert.equal(lo('http://localhost:9088/?playtest=x&room=abc123').nameFor('level-1'), 't-abc123/level-1', "a playtest's own room");
  assert.equal(lo('https://mygame.com/?room=../x').nameFor('lobby'), 'lobby', 'a bad room id is ignored');
  assert.equal(lo('https://mygame.com/', { prefix: 'p2/' }).nameFor('lobby'), 'p2/lobby', 'the prefix');

  const url = `http://localhost/?room=lob${Date.now() % 100000}`;
  const a = lo(url, { name: 'Ada', config: { maxPlayers: 1 } });
  const b = lo(url, { name: 'Bo', config: { maxPlayers: 1 } });
  const statuses: string[] = [];
  b.when('status', (x: any) => statuses.push(x.status));
  try {
    a.join('lobby');
    await wait(() => a.ready, 4000, 'a in the lobby');
    assert.match(a.roomName, /^t-lob\d+\/lobby$/);
    b.join('lobby');
    await wait(() => b.ready, 6000, 'b in a room');
    assert.equal(b.shard, 2, 'the first was full: the next shard');
    assert.equal(b.roomName, `${a.roomName}.2`);
    assert.ok(!statuses.includes('offline'), `a full room is not an error (${statuses.join(' ')})`);

  } finally { a.leave(); b.leave(); }

  // Handlers subscribed once keep working when the lobby moves rooms (another area, a rejoin).
  const u2 = `http://localhost/?room=msg${Date.now() % 100000}`;
  const l = lo(u2, { name: 'Lu' });
  const got: string[] = [];
  l.on('hi', (text: string) => got.push(text));
  try {
    for (const area of ['town', 'field']) {
      l.join(area);
      await wait(() => l.ready && l.area === area, 6000, `the lobby in ${area}`);
      const page = await join(l.roomName, opts({ transport: 'relay', name: 'Pa' }));
      try {
        await wait(() => l.peers.size >= 1, 3000, 'the page seen');
        page.send('hi', area);
        await wait(() => got.includes(area), 3000, `the message in ${area}`);
      } finally { await page.leave(); }
    }
    assert.deepEqual(got, ['town', 'field'], 'one handler, two rooms, each message once');
    l.send('ignored', 1); // in a room: goes; nothing to check but that it doesn't throw
    l.leave();
    l.send('dropped', 1);
    l.pose([0, 0, 0], 0);
    assert.equal(l.status, 'off', 'left: off, and sends are dropped quietly');
  } finally { l.leave(); }
});

test('express: the game\'s own bytes, forwarded at once on the relay (to everyone or one), not waiting for a bundle', async () => {
  const a = await join('x-relay', opts({ name: 'Ada', transport: 'relay' }));
  const b = await join('x-relay', opts({ name: 'Bo', transport: 'relay' }));
  const c = await join('x-relay', opts({ name: 'Cy', transport: 'relay' }));
  try {
    await wait(() => a.peers.size === 2 && b.peers.size === 2 && c.peers.size === 2, 4000, 'three in the room');
    const gotB: [number[], string][] = [], gotC: [number[], string][] = [];
    b.onExpress((bytes: Uint8Array, from: string) => gotB.push([[...bytes], from]));
    c.onExpress((bytes: Uint8Array, from: string) => gotC.push([[...bytes], from]));
    assert.equal(a.express(new Uint8Array([7, 1, 2, 3])), true);
    await wait(() => gotB.length && gotC.length, 2000, 'to everyone');
    assert.deepEqual(gotB[0], [[7, 1, 2, 3], a.id]);
    assert.deepEqual(gotC[0], [[7, 1, 2, 3], a.id], 'everyone else');
    a.express(new Uint8Array([9]), { to: b.id });
    await wait(() => gotB.length === 2, 2000, 'to one');
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(gotC.length, 1, 'only the one it was for');
    assert.throws(() => a.express(new Uint8Array(1300)), /at most/);
    // Timing: express against an ordinary unreliable message (which waits for the sender's and the relay's sends).
    const ex: number[] = [], ev: number[] = [];
    b.onExpress((bytes: Uint8Array) => { if (bytes[0] === 42) ex.push(performance.now() - t0); });
    b.on('tick', () => ev.push(performance.now() - t0));
    let t0 = 0;
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 17 + (i % 3) * 7));
      t0 = performance.now();
      a.express(new Uint8Array([42]));
      await wait(() => ex.length === i + 1, 1000, 'express');
      t0 = performance.now();
      a.send('tick', i, { reliable: false });
      await wait(() => ev.length === i + 1, 1000, 'event');
    }
    const med = (v: number[]) => [...v].sort((x, y) => x - y)[v.length >> 1];
    assert.ok(med(ex) < med(ev), `express ${med(ex).toFixed(1)} ms vs bundled ${med(ev).toFixed(1)} ms (median)`);
    assert.ok(med(ex) < 15, `express on this machine within 15 ms (median ${med(ex).toFixed(1)} ms)`);
    assert.ok(a.stats().expressUp >= 14 && b.stats().expressDown >= 14);
  } finally { await a.leave(); await b.leave(); await c.leave(); }
});

test('express in a peer to peer room: through the host (the signal route here; an unordered channel between browsers)', async () => {
  const cfg = { config: { p2pMax: 4, maxPlayers: 4 } };
  const a = await join('x-p2p', opts({ name: 'Host', transport: 'auto', ...cfg }));
  const b = await join('x-p2p', opts({ name: 'Two', transport: 'auto', ...cfg }));
  const c = await join('x-p2p', opts({ name: 'Three', transport: 'auto', ...cfg }));
  try {
    await wait(() => a.peers.size === 2 && b.peers.size === 2 && c.peers.size === 2, 6000, 'three in the room');
    assert.equal(a.transport, 'p2p');
    const got: Record<string, [number[], string][]> = { a: [], b: [], c: [] };
    a.onExpress((x: Uint8Array, f: string) => got.a.push([[...x], f]));
    b.onExpress((x: Uint8Array, f: string) => got.b.push([[...x], f]));
    c.onExpress((x: Uint8Array, f: string) => got.c.push([[...x], f]));
    b.express(new Uint8Array([1]));                 // a player: to the host's page, which forwards it
    await wait(() => got.a.length && got.c.length, 3000, 'a player to everyone');
    assert.deepEqual(got.a[0], [[1], b.id]);
    assert.deepEqual(got.c[0], [[1], b.id]);
    a.express(new Uint8Array([2]), { to: c.id });   // the host: from its own page
    await wait(() => got.c.length === 2, 3000, 'the host to one');
    assert.deepEqual(got.c[1], [[2], a.id]);
    assert.equal(got.b.length, 0, 'nothing to the sender, nothing that was for someone else');
  } finally { await a.leave(); await b.leave(); await c.leave(); }
});

for (const transport of ['relay', 'auto'] as const) {
  test(`away (${transport === 'relay' ? 'the relay' : 'peer to peer'}): everyone sees it, an away host hands the room to the first present player and doesn't take it back; a joiner hears who is away`, async () => {
    const o = (name: string) => opts({ name, transport, config: { p2pMax: 4, maxPlayers: 8 } });
    const room = `away-${transport}`;
    const a = await join(room, o('Ada'));
    const b = await join(room, o('Bo'));
    const c = await join(room, o('Cy'));
    const raw: any[] = [];
    let d: any = null;
    try {
      await wait(() => a.peers.size === 2 && b.peers.size === 2 && c.peers.size === 2, 6000, 'three in the room');
      assert.equal(a.isHost, true, 'the first in hosts');
      const seen: any[] = [], hosts: any[] = [];
      b.when('peer:away', (e: any) => seen.push([e.peer.id, e.away]));
      c.when('host', (e: any) => hosts.push(e));
      a.setAway(true);
      await wait(() => seen.length === 1, 3000, 'B hears A is away');
      assert.deepEqual(seen[0], [a.id, true]);
      assert.equal(b.peers.get(a.id).away, true);
      await wait(() => b.isHost && c.host === b.id && a.host === b.id, 3000, 'the host role moves to B');
      assert.equal(hosts.at(-1).reason, 'host away');
      // A joiner hears who is away in its hello.
      d = await join(room, opts({ name: 'Di', transport, onRaw: (m: any) => raw.push(m), config: { p2pMax: 4, maxPlayers: 8 } }));
      await wait(() => d.peers.has(a.id), 4000, 'D sees A');
      assert.equal(d.peers.get(a.id).away, true, 'the joiner knows A is away');
      assert.equal(d.host, b.id);
      // Back: everyone sees it, and the host stays B.
      a.setAway(false);
      await wait(() => seen.length === 2, 3000, 'B hears A is back');
      assert.deepEqual(seen[1], [a.id, false]);
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(b.isHost, true, 'the host role is not taken back');
      // Everyone away: the role moves along while someone is still present, then stays; the first back takes it.
      for (const x of [a, b, d]) x.setAway(true);
      await wait(() => [a, b, c, d].every((x) => x.host === c.id), 3000, 'C, the only one present, hosts');
      c.setAway(true);
      await new Promise((r) => setTimeout(r, 400));
      assert.equal(a.host, c.id, 'nobody present to hand it to: C keeps it');
      a.setAway(false);
      await wait(() => [a, b, c, d].every((x) => x.host === a.id), 3000, 'the first back (A) hosts');
      assert.ok(raw.some((m) => m.t === 'host' && m.c === a.id), 'an engine on raw messages hears the host change');
      for (const x of [b, d]) x.setAway(false);
      c.setAway(false);
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(b.host, a.id, 'the others coming back change nothing');
    } finally { await a.leave(); await b.leave(); await c.leave(); await d?.leave(); }
  });
}

test('background(): the game step keeps going where there are no animation frames, at about the asked rate, until stopped', async () => {
  // @ts-ignore: plain JS SDK
  const { background } = await import('../sdk/js/hawkes-net.mjs');
  let n = 0;
  const stop = background(() => n++, { hz: 50 });
  await new Promise((r) => setTimeout(r, 500));
  stop();
  const ran = n;
  assert.ok(ran >= 15 && ran <= 30, `about 25 steps in 0.5 s at 50 Hz (ran ${ran})`);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(n, ran, 'stopped');
});

test("records: a game's public store (a leaderboard's signed results): its sites write, anyone reads, localhost only test records, the newest per key and author", async () => {
  const hex = (n: number, c: string) => c.repeat(n);
  const ev = (o: any = {}) => ({ id: hex(64, 'a'), pubkey: hex(64, 'b'), sig: hex(128, 'c'), created_at: Math.floor(Date.now() / 1000), kind: 30078, tags: [['d', 'hawkes-dod/result/m1'], ['t', 'hawkes-dod/results/global']], content: '{"v":1}', ...o });
  const put = (origin: string, body: any) => fetch(`${endpoint}/v1/net/records`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const get = (q: string) => fetch(`${endpoint}/v1/net/records?${q}`).then((r) => r.json());
  const site = 'https://doseofdestruction.com';
  process.env.NET_TRUST_LOCALHOST = '0';
  try {
    assert.equal((await put(site, { project: 'doseofdestruction', event: ev() })).status, 200, 'its site writes');
    assert.equal((await put('https://evil.example', { project: 'doseofdestruction', event: ev() })).status, 403, 'another site does not');
    assert.equal((await put('http://localhost:8089', { project: 'doseofdestruction', event: ev() })).status, 403, 'localhost: not live records');
    assert.equal((await put('http://localhost:8089', { project: 'doseofdestruction', test: true, event: ev({ pubkey: hex(64, 'e') }) })).status, 200, 'localhost: test records');
    assert.equal((await put(site, { project: 'nobodys-game', event: ev() })).status, 404);
    assert.equal((await put(site, { project: 'doseofdestruction', event: ev({ tags: [['d', 'x']] }) })).status, 400, 'a tag is needed');
    assert.equal((await put(site, { project: 'doseofdestruction', event: ev({ content: 'x'.repeat(9000) }) })).status, 413, 'at most 8 KB');
    assert.equal((await put(site, { project: 'doseofdestruction', event: ev({ sig: 'nope' }) })).status, 400);
  } finally { process.env.NET_TRUST_LOCALHOST = '1'; }
  const live = await get('project=doseofdestruction&tag=hawkes-dod/results/global');
  assert.equal(live.events.length, 1, 'the live record');
  assert.equal((await get('project=doseofdestruction&tag=hawkes-dod/results/global&test=1')).events.length, 1, 'the test one apart');
  // The same key and author: a newer one replaces it, an older one doesn't.
  const t = Math.floor(Date.now() / 1000);
  await put(site, { project: 'doseofdestruction', event: ev({ created_at: t + 5, content: '{"v":2}' }) });
  await put(site, { project: 'doseofdestruction', event: ev({ created_at: t - 100, content: '{"v":0}' }) });
  const after = await get('project=doseofdestruction&tag=hawkes-dod/results/global');
  assert.deepEqual(after.events.map((e: any) => e.content), ['{"v":2}']);
  await put(site, { project: 'doseofdestruction', event: ev({ pubkey: hex(64, 'f'), created_at: t + 1 }) });
  assert.equal((await get('project=doseofdestruction&tag=hawkes-dod/results/global')).events.length, 2, 'another author: another record');
  assert.equal((await get(`project=doseofdestruction&tag=hawkes-dod/results/global&since=${t + 3}`)).events.length, 1, 'since');
  const r = await fetch(`${endpoint}/v1/net/records?project=doseofdestruction&tag=hawkes-dod/results/global`);
  assert.equal(r.headers.get('access-control-allow-origin'), '*', 'any page reads');
});

test('an option given as undefined keeps its default: endpoint: undefined goes to the page-named Net', async () => {
  (globalThis as any).HAWKES_NET_ENDPOINT = endpoint;
  try {
    const a = await join('undef1', opts({ name: 'Ada', transport: 'relay', endpoint: undefined, role: undefined }));
    try { assert.equal(a.transport, 'relay'); } finally { await a.leave(); }
  } finally { delete (globalThis as any).HAWKES_NET_ENDPOINT; }
});

test('the quickstart: linked from the landing page, and its first-room script really puts two clients in one room', async () => {
  const root = await fetch(`${endpoint}/`).then((r) => r.text());
  const hrefs = [...root.matchAll(/href="(\/quickstart)"/g)];
  assert.ok(hrefs.length >= 3, 'the landing page links to the quickstart (nav, button, footer)');
  const res = await fetch(`${endpoint}/quickstart`);
  assert.equal(res.status, 200);
  const page = await res.text();
  assert.doesNotMatch(page, /setInterval/, 'no polling');
  // every in-page link resolves, and every service path it links to answers
  const ids = new Set([...page.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  for (const m of page.matchAll(/href="#([^"]+)"/g)) assert.ok(ids.has(m[1]), `#${m[1]} exists`);
  for (const p of new Set([...page.matchAll(/href="(\/[^"#]*)/g)].map((m) => m[1]))) assert.equal((await fetch(`${endpoint}${p}`)).status, 200, p);
  // run the doc's own script, against this service, and check it prints what the doc says it prints
  const code = /<pre id="script-node"><code>([\s\S]*?)<\/code><\/pre>/.exec(page)![1].replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
  const doc = /<b>You should see<\/b> \(the last three[\s\S]*?<pre><code>([\s\S]*?)<\/code><\/pre>/.exec(page)![1].trim().split('\n');
  const key = addKey('quickstart', ['*']);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hn-qs-'));
  const file = path.join(dir, 'first-room.mjs');
  const sdk = new URL('../sdk/js/hawkes-net.mjs', import.meta.url).href;
  fs.writeFileSync(file, code.replace("'@hawkesgen/net'", `'${sdk}'`).replace('key: process.env.HAWKESGEN_KEY', `endpoint: '${endpoint}', key: process.env.HAWKESGEN_KEY`));
  const out = await new Promise<string>((ok, no) => execFile(process.execPath, [file], { env: { ...process.env, HAWKESGEN_KEY: key }, timeout: 20_000 }, (e, so, se) => (e ? no(new Error(se)) : ok(so))));
  const got = out.trim().split('\n');
  assert.deepEqual(got.slice(0, 2), doc.slice(0, 2));
  assert.deepEqual(got.slice(2).sort(), doc.slice(2).sort());
});

test('the root is a public landing page with status and the three SDKs; the dashboard keeps its own names and /dashboard', async () => {
  const root = await fetch(`${endpoint}/`).then((r) => r.text());
  assert.match(root, /Put your game online/);
  assert.match(root, /hawkesnet-js/); assert.match(root, /hawkesnet-babylon/); assert.match(root, /hawkesnet-unity/);
  assert.doesNotMatch(root, /setInterval|setTimeout/, 'the landing page never polls');
  const dash = await fetch(`${endpoint}/dashboard`).then((r) => r.text());
  assert.match(dash, /The dashboard of Hawkes Net/);
  const onDashName = await new Promise<string>((ok, no) => {
    const u = new URL(endpoint);
    import('node:http').then(({ default: http }) => http.get({ host: u.hostname, port: u.port, path: '/', headers: { Host: 'net.hawkesgames.com' } }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => ok(b)); }).on('error', no));
  });
  assert.match(onDashName, /The dashboard of Hawkes Net/);
  const st = await fetch(`${endpoint}/v1/net/status`).then((r) => r.json());
  assert.equal(st.health, 'ok');
  for (const p of ['/sdk/hawkes-net@1.mjs', '/sdk/com.hawkes.net.tgz']) assert.equal((await fetch(`${endpoint}${p}`)).status, 200, p);
});
