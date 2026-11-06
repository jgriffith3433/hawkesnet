// Every error code (src/errors.ts, docs/errors.md): each one is made to happen over HTTP and must answer with its status,
// { code, message, docs, error }. `cases` is a Record over every code, so a code with no case here fails the typecheck.
// (The relay's own refusals, answered before a socket opens, are in test/errors-relay.test.ts.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ERRORS, ERROR_CODES, errorBody, errorsMarkdown, type ErrorCode } from '../src/errors.ts';

// A project file with one project that has no way to connect (project_disabled), beside the real ones.
const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hn-err-')), 'projects.json');
const real = JSON.parse(fs.readFileSync(new URL('../projects.json', import.meta.url), 'utf8'));
real.projects.noroute = { name: 'No route', transports: [], origins: [] };
fs.writeFileSync(file, JSON.stringify(real));
process.env.NET_PROJECTS_FILE = file;

const { startTestHub, addKey } = await import('./helper.ts');
const { db } = await import('../src/store.ts');
const api = await import('../src/api.ts');
const hub = await startTestHub();
const { endpoint } = hub;
test.after(async () => { await hub.stop(); });

type Got = { status: number; body: any };
async function call(method: string, route: string, o: { body?: unknown; raw?: string; key?: string; origin?: string; headers?: Record<string, string> } = {}): Promise<Got> {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (o.key) headers.Authorization = `Bearer ${o.key}`;
  if (o.origin) headers.Origin = o.origin;
  let body: string | undefined = o.raw;
  if (o.body !== undefined) { body = JSON.stringify(o.body); headers['Content-Type'] = 'application/json'; }
  const r = await fetch(`${endpoint}${route}`, { method, headers, body });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const ticket = (body: any, o: Parameters<typeof call>[2] = {}) => call('POST', '/v1/net/ticket', { body: { room: 'er', client: { protocols: [3] }, ...body }, ...o });
const SITE = 'https://hawkesgen.ai'; // one of netdemo's sites (projects.json)

// Accounts: the portal's key (usr_*) acts for the account it is told, as that account (never as an admin).
const portal = addKey('portal-errors', ['usr_*']);
const acct = (n: number) => `usr_00000000000e${String(n).padStart(4, '0')}`;
const as = (n: number, extra: any = {}) => ({ owner: acct(n), tier: 'paid', ...extra });
const project = (n: number, extra: any = {}) => call('POST', '/v1/net/projects', { key: portal, body: as(n, extra) });
const rowFor = (projectId: string, room: string, o: { node?: string | null; players?: number } = {}) =>
  db.prepare("INSERT OR REPLACE INTO net_rooms (project, room, node, epoch, next_ord, transport, config, players, opened_at, seen_at) VALUES (?, ?, ?, 1, 1, 'relay', '{\"maxPlayers\":8}', ?, ?, ?)")
    .run(projectId, room, o.node === undefined ? 'e-node' : o.node, o.players ?? 1, Date.now(), Date.now());
const hex = (n: number, c: string) => c.repeat(n);
const ev = (o: any = {}) => ({ id: hex(64, 'a'), pubkey: hex(64, 'b'), sig: hex(128, 'c'), created_at: Math.floor(Date.now() / 1000), kind: 30078, tags: [['d', 'k'], ['t', 'errors/tag']], content: '{}', ...o });
const putRec = (event: any, o: Parameters<typeof call>[2] = {}) => call('POST', '/v1/net/records', { body: { project: 'doseofdestruction', event }, origin: 'https://doseofdestruction.com', ...o });

const cases: Record<ErrorCode, () => Promise<Got>> = {
  not_found: () => call('GET', '/v1/net/nothing-here'),
  method_not_allowed: () => call('GET', '/v1/net/ticket'),
  bad_json: () => call('POST', '/v1/net/room', { raw: '{nope', headers: { 'Content-Type': 'application/json' } }),
  body_too_large: () => call('POST', '/v1/net/room', { raw: JSON.stringify({ pad: 'x'.repeat(300_000) }) }),
  internal: async () => {
    const was = console.error; console.error = () => {};
    try { return await call('POST', '/v1/net/nodes/heartbeat', { raw: 'null' }); } finally { console.error = was; }
  },

  key_required: () => call('POST', '/v1/net/room', { origin: SITE, body: {} }),
  key_invalid: () => ticket({ project: 'netdemo' }, { key: 'k-nobody' }),
  key_or_site_required: async () => { api.useKeyCheck(() => null); return ticket({ project: 'netdemo' }); }, // last: no key check after
  key_project_forbidden: () => ticket({ project: 'netdemo' }, { key: addKey('other-project', ['elsewhere']) }),
  owner_key_required: () => call('POST', '/v1/net/keys/rotate', { key: addKey('plain-user', ['x']), body: {} }),
  admin_key_required: () => call('GET', '/v1/net/ops', { key: addKey('plain-user2', ['x']) }),
  node_key_forbidden: () => call('POST', '/v1/net/nodes/heartbeat', { key: addKey('plain-user3', ['x']), body: { id: 'n', url: 'ws://x' } }),

  ticket_rate_limited: async () => {
    let last: Got = { status: 0, body: null };
    for (let i = 0; i < 125 && last.status !== 429; i++) last = await call('GET', '/v1/net/records?project=netdemo&tag=errors/rate');
    return last;
  },
  project_invalid: () => ticket({ project: 'no spaces!' }),
  project_not_found: () => ticket({ project: 'nobodys-game' }, { origin: SITE }),
  room_invalid: () => ticket({ project: 'netdemo', room: 'bad room!' }),
  room_prefix_invalid: () => call('POST', '/v1/net/publish', { body: { project: 'netdemo', room: '!/*' } }),
  site_not_allowed: () => ticket({ project: 'netdemo' }, { origin: 'https://evil.example' }),
  role_needs_key: () => ticket({ project: 'netdemo', role: 'bot' }, { origin: SITE }),
  project_disabled: () => ticket({ project: 'noroute' }, { key: undefined }),
  sdk_too_old: () => ticket({ project: 'netdemo', client: { protocols: [1] } }),
  rooms_limit: async () => {
    const id = (await project(1, { name: 'Rooms Limit', tier: 'free' })).body.id;
    for (let i = 0; i < 3; i++) rowFor(id, `open-${i}`);
    return ticket({ project: id, room: 'one-more' });
  },
  rooms_waiting_limit: async () => {
    const id = (await project(2, { name: 'Rooms Waiting', tier: 'free' })).body.id;
    for (let i = 0; i < 15; i++) rowFor(id, `wait-${i}`, { players: 0 });
    return ticket({ project: id, room: 'one-more' });
  },
  players_limit: async () => {
    const id = (await project(3, { name: 'Players Limit', tier: 'free' })).body.id;
    rowFor(id, 'crowd', { players: 16 });
    return ticket({ project: id, room: 'one-more' });
  },
  no_node: async () => {
    db.prepare("UPDATE net_nodes SET status = 'draining'").run();
    try { return await ticket({ project: 'netdemo', room: 'nowhere-to-go' }); }
    finally { db.prepare("UPDATE net_nodes SET status = 'up', beat_at = ?").run(Date.now()); }
  },

  kick_target_required: async () => {
    const id = (await project(4, { name: 'Kick Target' })).body.id;
    return call('POST', `/v1/net/projects/${id}/rooms/r/kick`, { key: portal, body: as(4, {}) });
  },
  counts_not_public: async () => {
    const id = (await project(5, { name: 'Counts Private' })).body.id;
    return call('GET', `/v1/net/counts?project=${id}&rooms=a`);
  },
  counts_rooms_invalid: () => call('GET', '/v1/net/counts?project=netdemo&rooms='),
  node_not_taking_requests: async () => {
    db.prepare("INSERT OR REPLACE INTO net_nodes (id, url, admin_url, region, status, beat_at) VALUES ('e-node', 'ws://x', NULL, 'r', 'up', ?)").run(Date.now());
    rowFor('netdemo', 'ghost');
    try { return await call('POST', '/v1/net/publish', { body: { project: 'netdemo', room: 'ghost', event: { name: 'x' } } }); }
    finally { db.prepare("DELETE FROM net_rooms WHERE room = 'ghost'").run(); db.prepare("DELETE FROM net_nodes WHERE id = 'e-node'").run(); }
  },
  node_not_answering: async () => {
    db.prepare("INSERT OR REPLACE INTO net_nodes (id, url, admin_url, region, status, beat_at) VALUES ('e-node', 'ws://x', 'http://127.0.0.1:1', 'r', 'up', ?)").run(Date.now());
    rowFor('netdemo', 'ghost');
    try { return await call('POST', '/v1/net/publish', { body: { project: 'netdemo', room: 'ghost', event: { name: 'x' } } }); }
    finally { db.prepare("DELETE FROM net_rooms WHERE room = 'ghost'").run(); db.prepare("DELETE FROM net_nodes WHERE id = 'e-node'").run(); }
  },
  publish_refused: async () => { // the embedded node, asked with a token it did not sign (a real node answers the same way over its /publish)
    const r: any = await hub.node.publish('not-a-token', {});
    return { status: r.status, body: errorBody(r.code, r.error) };
  },

  account_required: () => call('POST', '/v1/net/projects', { key: portal, body: { name: 'Nobody' } }),
  key_no_account: () => call('GET', '/v1/net/projects', { key: addKey('two-accounts', ['a-one', 'a-two']) }),
  project_name_required: () => project(6, { name: '' }),
  project_limit: async () => {
    let last: Got = { status: 0, body: null };
    for (let i = 0; i < 21; i++) last = await project(7, { name: `Many ${i}` });
    return last;
  },
  project_id_invalid: () => project(8, { name: 'Bad Id', id: 'A!' }),
  project_id_taken: () => project(8, { name: 'Taken', id: 'sickofit' }),
  sites_invalid: async () => {
    const id = (await project(9, { name: 'Sites Invalid' })).body.id;
    return call('POST', `/v1/net/projects/${id}`, { key: portal, body: as(9, { sites: ['https://acme.games/page'] }) });
  },
  project_unclaimed: () => call('POST', '/v1/net/projects/sickofit', { body: { owner: acct(10), name: 'Mine' } }),
  project_not_in_account: () => call('DELETE', '/v1/net/projects/sickofit', { body: { owner: acct(10) } }),
  room_size_invalid: async () => {
    const id = (await project(11, { name: 'Room Size' })).body.id;
    return call('POST', `/v1/net/projects/${id}`, { key: portal, body: as(11, { maxPlayers: 9999 }) });
  },
  admin_required: () => call('POST', '/v1/net/projects/sickofit/claim', { key: portal, body: as(12) }),
  not_hawkes_game: () => call('POST', '/v1/net/projects/not-one-of-ours/claim', { body: { owner: acct(13) } }),
  project_in_other_account: async () => {
    await call('POST', '/v1/net/projects/sickofit/claim', { body: { owner: acct(14) } });
    return call('POST', '/v1/net/projects/sickofit/claim', { body: { owner: acct(15) } });
  },

  record_invalid: () => putRec(ev({ sig: 'nope' })),
  record_tag_invalid: () => putRec(ev({ tags: [['d', 'x']] })),
  record_site_not_allowed: () => putRec(ev(), { origin: 'https://evil.example' }),
  record_too_large: () => putRec(ev({ content: 'x'.repeat(9000) })),
  records_daily_limit: async () => {
    const ins = db.prepare("INSERT INTO net_records (project, test, tag, d, pubkey, created_at, at, event) VALUES ('doseofdestruction', 0, 'errors/fill', ?, 'p', 1, ?, '{}')");
    db.exec('BEGIN');
    try { for (let i = 0; i < 20_000; i++) ins.run(`d${i}`, Date.now()); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
    try { return await putRec(ev()); } finally { db.prepare("DELETE FROM net_records WHERE tag = 'errors/fill'").run(); }
  },

  node_invalid: () => call('POST', '/v1/net/nodes/heartbeat', { body: { id: '!!', url: 'ws://x' } }),

  // the relay's websocket and node HTTP: test/errors-relay.test.ts (it checks these codes by name)
  ws_handshake_invalid: async () => relayCovered('ws_handshake_invalid'),
  ws_ticket_required: async () => relayCovered('ws_ticket_required'),
  node_draining: async () => relayCovered('node_draining'),
  node_restarting: async () => relayCovered('node_restarting'),
  connections_limit: async () => relayCovered('connections_limit'),
  resume_gone: async () => relayCovered('resume_gone'),
  ticket_refused: async () => relayCovered('ticket_refused'),
  ticket_wrong_node: async () => relayCovered('ticket_wrong_node'),
  ticket_used: async () => relayCovered('ticket_used'),
  ticket_stale: async () => relayCovered('ticket_stale'),
  publish_token_bad: async () => relayCovered('publish_token_bad'),
};
// A code only the relay answers: its test file lists the codes it makes happen; this one checks the lists agree.
const RELAY_CODES = fs.readFileSync(new URL('./errors-relay.test.ts', import.meta.url), 'utf8');
const relayCovered = async (code: ErrorCode): Promise<Got> => {
  assert.match(RELAY_CODES, new RegExp(`\\b${code}: (\\(\\)|async)`), `${code} has a case in errors-relay.test.ts`);
  return { status: ERRORS[code].status, body: errorBody(code) };
};

const LAST: ErrorCode[] = ['key_or_site_required']; // after it no key is accepted
for (const code of [...ERROR_CODES.filter((c) => !LAST.includes(c)), ...LAST]) {
  test(`error ${code}: ${ERRORS[code].status}, with code, message and docs link`, async () => {
    const r = await cases[code]();
    assert.equal(r.status, ERRORS[code].status, `${code}: status (${JSON.stringify(r.body)})`);
    assert.equal(r.body?.code, code, `the code (${JSON.stringify(r.body)})`);
    assert.equal(typeof r.body.message, 'string');
    assert.ok(r.body.message.length > 3, 'a message that says something');
    assert.equal(r.body.docs, `https://net.hawkesgen.ai/docs/errors#${code}`);
    assert.equal(r.body.error, r.body.message, '`error` repeats `message` for older SDKs');
  });
}

test('the docs page lists every code, docs/errors.md is made from the catalog, and the JSON list agrees', async () => {
  const page = await fetch(`${endpoint}/docs/errors`);
  assert.equal(page.status, 200);
  const html = await page.text();
  for (const code of ERROR_CODES) assert.ok(html.includes(`id="${code}"`), `${code} on the docs page`);
  const md = fs.readFileSync(new URL('../docs/errors.md', import.meta.url), 'utf8');
  assert.equal(md, errorsMarkdown(), 'docs/errors.md is out of date: run node tools/errors-md.mjs');
  for (const code of ERROR_CODES) assert.ok(md.includes(`\`${code}\``), `${code} in docs/errors.md`);
  const list = await call('GET', '/v1/net/errors');
  assert.deepEqual(list.body.errors.map((e: any) => e.code), ERROR_CODES);
});

test('every error site in the service names a catalog code, and every catalog code is used', () => {
  const src = ['api', 'projects', 'records', 'service', 'rooms', 'node', 'ws', 'hub'].map((f) => fs.readFileSync(new URL(`../src/${f}.ts`, import.meta.url), 'utf8')).join('\n');
  const used = new Set([...src.matchAll(/code: '(\w+)'|fail\(res, '(\w+)'|fail\('(\w+)'|refuse\(\w+, '(\w+)'|errorBody\('(\w+)'/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5]));
  for (const c of used) assert.ok(c in ERRORS, `${c} is in the catalog`);
  for (const c of ERROR_CODES) assert.ok(used.has(c), `${c} is answered somewhere`);
  assert.equal(new Set(ERROR_CODES).size, ERROR_CODES.length);
  for (const c of ERROR_CODES) assert.match(c, /^[a-z][a-z_]+$/);
});
