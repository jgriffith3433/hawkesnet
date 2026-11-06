// The Hawkes Net service's HTTP routes (docs/net.md, docs/api.md "Hawkes Net"), served by src/hub.ts:
//   POST /v1/net/ticket            a join ticket (a Gen key, or no key from the project's own sites: the public door)
//   GET  /v1/net/counts            players in named rooms of a project with its own sites (public numbers)
//   GET  /v1/net/keys              the public keys nodes check tickets with
//   GET  /v1/net/status            nodes and rooms
//   POST /v1/net/publish           a server's world edits or event into a room, or every room under "<prefix>/*" (a Gen key)
//   POST /v1/net/room              is a room open, how many are in it (a Gen key)
//   POST /v1/net/nodes/heartbeat   a relay node says it's there (a node's Gen key)
//   POST /v1/net/nodes/room        a relay node's room opened, moved or closed
//   POST /v1/net/usage             a relay node's usage for the last minute
//   POST /v1/net/keys/rotate       a new signing key (owner)
//   GET|POST /v1/net/projects      an account's projects (list, make); /projects/<id> (GET, POST settings, DELETE),
//                                  /<id>/claim (an admin takes a Hawkes game), /<id>/rooms/<room> (who is in it), /kick
//   GET  /sdk/hawkes-net.mjs, /sdk/hawkes-net-core.mjs (and @1): the client SDK, for pages that load it from here
//   GET  /sdk/com.hawkes.net.tgz   the Unity package (Package Manager > Add package from tarball)
//   GET|POST /v1/net/records       a game's public store: signed records by tag (a leaderboard's results)
// Keys are Gen API keys; how one is checked is set by the server (useKeyCheck: the box asks Gen's /v1/net/whoami).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { canProject, NetError, type Client } from './store.ts';
import { netProject, originAllowed } from './registry.ts';
import * as svc from './service.ts';
import * as projects from './projects.ts';
import { packageTarball } from './tarball.ts';
import * as records from './records.ts';
import { ERROR_CODES, ERRORS, errorBody, errorStatus, type ErrorCode } from './errors.ts';

const SDK_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'sdk', 'js');
const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};
/** An error answer: { code, message, docs, error } with the code's status (src/errors.ts, docs/errors.md). */
export const fail = (res: ServerResponse, code: ErrorCode, message?: string) => send(res, errorStatus(code), errorBody(code, message));
async function readJson(req: IncomingMessage, limit = 256 * 1024) {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) { n += c.length; if (n > limit) throw new NetError('Request body too large', { code: 'body_too_large' }); chunks.push(c); }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  try { return JSON.parse(text); } catch { throw new NetError('Body is not valid JSON', { code: 'bad_json' }); }
}
/** How a request's key is checked (the box asks Gen: src/hub.ts). Unset, no key is accepted. */
type KeyCheck = (req: IncomingMessage) => Client | null | Promise<Client | null>;
let checkKey: KeyCheck = () => null;
/** What the server adds to the operator view (hub.ts: uptime, usage waiting for Gen, key checks). */
let opsExtra: () => Record<string, unknown> = () => ({});
export function useOpsExtra(fn: () => Record<string, unknown>) { opsExtra = fn; }
export function useKeyCheck(fn: KeyCheck) { checkKey = fn; }

/** Nodes report with a key that may act for "hawkesnet" (or an admin key). */
async function nodeClient(req: IncomingMessage): Promise<Client> {
  const c = await checkKey(req);
  if (!c) throw new NetError('A node key is needed', { code: 'key_required' });
  if (!(c.role === 'owner' || c.role === 'admin' || canProject(c, 'hawkesnet'))) throw new NetError('This key is not a Hawkes Net node key', { code: 'node_key_forbidden' });
  return c;
}

const sdkCache = new Map<string, { mtime: number; body: Buffer; etag: string }>();
function sdkFile(name: string) {
  const file = path.join(SDK_DIR, name);
  const mtime = fs.statSync(file).mtimeMs;
  let c = sdkCache.get(name);
  if (!c || c.mtime !== mtime) {
    const body = fs.readFileSync(file);
    c = { mtime, body, etag: `"${crypto.createHash('sha256').update(body).digest('base64url').slice(0, 20)}"` };
    sdkCache.set(name, c);
  }
  return c;
}

export async function handleNet(req: IncomingMessage, res: ServerResponse, route: string): Promise<void> {
  const method = req.method ?? 'GET';
  try {
    // The SDK files, for pages that load them from here (games may also keep a copy, or install @hawkesgen/net).
    // (hawkes-net.mjs imports ./hawkes-net-core.mjs, so both are also served under their own names.)
    // (hawkes-net.d.ts is the SDK's types, for TypeScript games.)
    const sdk = /^\/sdk\/(net|net-core|hawkes-net|hawkes-net-core)(@1)?\.(mjs|d\.ts)$/.exec(route);
    if (sdk && (method === 'GET' || method === 'HEAD') && (sdk[3] === 'mjs' || sdk[1] === 'hawkes-net' || sdk[1] === 'net')) {
      const types = sdk[3] === 'd.ts';
      const f = sdkFile(types ? 'hawkes-net.d.ts' : sdk[1] === 'net' || sdk[1] === 'hawkes-net' ? 'hawkes-net.mjs' : 'hawkes-net-core.mjs');
      const headers = { 'Content-Type': types ? 'application/typescript; charset=utf-8' : 'text/javascript; charset=utf-8', 'Cache-Control': sdk[2] ? 'public, max-age=3600, stale-while-revalidate=86400' : 'public, max-age=300', ETag: f.etag, 'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff' };
      if (req.headers['if-none-match'] === f.etag) return void res.writeHead(304, headers).end();
      res.writeHead(200, { ...headers, 'Content-Length': f.body.length });
      return void res.end(method === 'HEAD' ? undefined : f.body);
    }

    // The Unity package (Package Manager > Add package from tarball), made from sdk/unity/com.hawkes.net.
    if ((route === '/sdk/com.hawkes.net.tgz' || /^\/sdk\/com\.hawkes\.net-[0-9.]+\.tgz$/.test(route)) && (method === 'GET' || method === 'HEAD')) {
      const t = packageTarball(path.join(SDK_DIR, '..', 'unity', 'com.hawkes.net'));
      const headers = { 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="com.hawkes.net-${t.version}.tgz"`, 'Cache-Control': 'public, max-age=300', ETag: t.etag, 'Access-Control-Allow-Origin': '*', 'X-Hawkes-Net-Unity': t.version };
      if (req.headers['if-none-match'] === t.etag) return void res.writeHead(304, headers).end();
      res.writeHead(200, { ...headers, 'Content-Length': t.body.length });
      return void res.end(method === 'HEAD' ? undefined : t.body);
    }
    if (route === '/v1/net/ticket') {
      // CORS for the public door: the project's own sites (checked again on the request, by project) and localhost.
      const origin = String(req.headers.origin ?? '');
      if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Hawkesgen-Key, X-Hawkes-Client');
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Max-Age', '600');
      }
      if (method === 'OPTIONS') return void res.writeHead(204).end();
      if (method !== 'POST') return fail(res, 'method_not_allowed', 'POST a ticket request');
      const body = await readJson(req);
      const hasKey = Boolean(req.headers.authorization || req.headers['x-hawkesgen-key']);
      const client = await checkKey(req);
      if (hasKey && !client) return fail(res, 'key_invalid', 'Unknown or disabled API key');
      // A browser page with no key goes through the public door (its origin); everything else needs a key.
      const viaDoor = !hasKey && Boolean(origin);
      const auth = svc.ticketAuth(req, viaDoor ? null : client);
      if (!viaDoor && !client) return fail(res, 'key_or_site_required', 'A Gen API key, or a page on the project\'s own site');
      return send(res, 200, svc.issueTicket(body, auth));
    }
    // Records (records.ts): a game's public store (a leaderboard's signed results). Reads are open to every page; a page
    // on the project's sites writes without a key (localhost: test records only), a key that may act for it writes too.
    if (route === '/v1/net/records') {
      const origin = String(req.headers.origin ?? '');
      res.setHeader('Access-Control-Allow-Origin', method === 'GET' ? '*' : origin || '*');
      if (method !== 'GET') { res.setHeader('Vary', 'Origin'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization'); res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS'); }
      if (method === 'OPTIONS') return void res.writeHead(204).end();
      const ip = svc.ticketAuth(req, null).ip ?? '?';
      if (method === 'GET') {
        svc.doorLimit(`rec-r:${ip}`, 120);
        const q = new URL(req.url ?? '/', 'http://x').searchParams;
        return send(res, 200, records.getRecords(String(q.get('project') ?? ''), String(q.get('tag') ?? ''), { since: Number(q.get('since')) || 0, limit: Number(q.get('limit')) || undefined, test: q.get('test') === '1' }));
      }
      if (method !== 'POST') return fail(res, 'method_not_allowed', 'GET or POST');
      const body = await readJson(req, 16 * 1024);
      const hasKey = Boolean(req.headers.authorization);
      // (As for tickets: a page with an Origin goes through the door; a key, or a developer's own machine, acts as itself.)
      const c = hasKey || !origin ? await checkKey(req) : null;
      if (hasKey && !c) return fail(res, 'key_invalid', 'Unknown or disabled API key');
      if (c && !svc.keyMayIssue(c, netProject(String(body?.project ?? '')))) return fail(res, 'key_project_forbidden', "This key can't write that project's records");
      if (!c) { if (!origin) return fail(res, 'key_or_site_required', "A key, or a page on the project's own sites"); svc.doorLimit(`rec-w:${ip}`, 30); }
      return send(res, 200, records.putRecord(body, c ? null : { origin }));
    }
    if (route === '/v1/net/counts' && (method === 'GET' || method === 'OPTIONS')) {
      // Public numbers (a project with its own sites): any page may read them, so CORS is open.
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (method === 'OPTIONS') return void res.writeHead(204).end();
      const q = new URL(req.url ?? '/', 'http://x').searchParams;
      return send(res, 200, svc.publicCounts(String(q.get('project') ?? ''), String(q.get('rooms') ?? '').split(','), svc.ticketAuth(req, null).ip));
    }
    if (route === '/v1/net/keys' && method === 'GET') { res.setHeader('Access-Control-Allow-Origin', '*'); return send(res, 200, { keys: svc.publicKeys() }); }
    if (route === '/v1/net/status' && method === 'GET') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      // Public (no login on the server): totals only. Rooms per project (customers' project ids) need a key.
      const st = svc.status();
      if (req.headers.authorization && (await checkKey(req))) return send(res, 200, st);
      const rooms = st.rooms as { rooms: number; players: number }[];
      return send(res, 200, { ...st, rooms: undefined, totals: { rooms: rooms.reduce((n, r) => n + Number(r.rooms), 0), players: rooms.reduce((n, r) => n + Number(r.players), 0) } });
    }
    if (route === '/v1/net/publish' && method === 'POST') {
      const c = await checkKey(req);
      if (!c) return fail(res, 'key_required', 'A Gen key is needed');
      return send(res, 200, await svc.publish(c, await readJson(req, 2 * 1024 * 1024)));
    }
    if (route === '/v1/net/room' && method === 'POST') {
      const c = await checkKey(req);
      if (!c) return fail(res, 'key_required', 'A Gen key is needed');
      return send(res, 200, svc.roomInfo(c, await readJson(req)));
    }
    if (route === '/v1/net/nodes/heartbeat' && method === 'POST') return send(res, 200, svc.heartbeat(await readJson(req), await nodeClient(req)));
    if (route === '/v1/net/nodes/room' && method === 'POST') { await nodeClient(req); return send(res, 200, svc.roomEvent(await readJson(req))); }
    if (route === '/v1/net/usage' && method === 'POST') { await nodeClient(req); return send(res, 200, svc.recordNetUsage(await readJson(req, 4 * 1024 * 1024))); }
    if (route === '/v1/net/keys/rotate' && method === 'POST') {
      const c = await checkKey(req);
      if (!c) return fail(res, 'key_required', 'A key is needed');
      if (c.role !== 'owner') throw new NetError('Only an owner key may rotate the signing keys', { code: 'owner_key_required' });
      return send(res, 200, { keys: svc.rotateKeys() });
    }
    // A developer's own rooms (their key, narrowed to their project like every Gen call).
    if (route === '/v1/net/rooms' && method === 'POST') {
      const c = await checkKey(req);
      if (!c) return fail(res, 'key_required', 'A Gen key is needed');
      return send(res, 200, svc.projectRooms(c, await readJson(req)));
    }
    // Projects (docs/net.md "Projects and accounts"): an account's own, through the portal's key (owner, admin and tier
    // name the signed-in account), or an owner/admin key. ?owner=&admin=&tier= on reads, the same fields in a body.
    const pm = /^\/v1\/net\/projects(?:\/([a-z0-9][a-z0-9._-]{0,63})(?:\/(claim|rooms)(?:\/(.+?)(?:\/(kick))?)?)?)?$/i.exec(route);
    if (pm) {
      const c = await checkKey(req);
      if (!c) return fail(res, 'key_required', 'A key is needed');
      const q = new URL(req.url ?? '/', 'http://x').searchParams;
      const body = method === 'POST' ? await readJson(req) : {};
      const pick = (k: string) => body?.[k] ?? q.get(k);
      const a = projects.actor(c, pick('owner'), pick('admin'));
      projects.touchTier(a.owner, pick('tier'));
      const [, id, part, roomRaw, kick] = pm;
      const room = roomRaw ? decodeURIComponent(roomRaw) : '';
      if (!id && method === 'GET') return send(res, 200, projects.listProjects(a, q.get('all') === '1'));
      if (!id && method === 'POST') return send(res, 200, projects.createProject(a, body));
      if (id && !part && method === 'GET') return send(res, 200, projects.projectDetail(a, id));
      if (id && !part && method === 'POST') return send(res, 200, projects.updateProject(a, id, body));
      if (id && !part && method === 'DELETE') return send(res, 200, projects.deleteProject(a, id));
      if (id && part === 'claim' && method === 'POST') return send(res, 200, projects.claimProject(a, id));
      if (id && part === 'rooms' && room && !kick && method === 'GET') return send(res, 200, await svc.roomPlayers(a, id, room));
      if (id && part === 'rooms' && room && kick && method === 'POST') return send(res, 200, await svc.kickPlayer(a, id, room, body));
      return fail(res, 'method_not_allowed', 'Not a projects route');
    }
    // The operator's view (an owner or admin key): every node and worker, rooms per project, what waits to reach Gen.
    if (route === '/v1/net/ops' && method === 'GET') {
      const c = await checkKey(req);
      if (!c) return fail(res, 'key_required', 'A key is needed');
      if (c.role !== 'owner' && c.role !== 'admin') return fail(res, 'admin_key_required', 'Only an owner or admin key sees the operator view');
      return send(res, 200, { ...svc.status(), node: await svc.ownNode()?.stats().catch(() => null), extra: opsExtra() });
    }
    // The error catalog (docs/errors.md): the same list as the docs page, as JSON.
    if (route === '/v1/net/errors' && method === 'GET') { res.setHeader('Access-Control-Allow-Origin', '*'); return send(res, 200, { errors: ERROR_CODES.map((code) => ({ code, ...ERRORS[code], docs: errorBody(code).docs })) }); }
    if (route === '/v1/net/nodes' && method === 'GET') { res.setHeader('Access-Control-Allow-Origin', '*'); return send(res, 200, { nodes: svc.status().nodes }); }
    return fail(res, 'not_found');
  } catch (e: any) {
    if (e instanceof NetError) return fail(res, e.code, e.message);
    console.error('[net]', e);
    return fail(res, 'internal', 'The service failed on its own; try again in a moment');
  }
}
