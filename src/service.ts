// The Hawkes Net service (docs/net.md): the signing keys, tickets, the directory (which node holds which room), node
// heartbeats, usage (handed to a sink: the box sends it to Gen), server-side publishes, and the relay node this process
// runs itself (more relay boxes run src/node.ts and report here).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';
import { ERRORS } from './errors.ts';
import { db, DATA_DIR, env, canProject, NetError, type Client } from './store.ts';
import { netProject, originAllowed, roomConfig, type NetProject } from './registry.ts';
import { logTicket, addUsage, readable, type Actor } from './projects.ts';
import { newKeyPair, exportPrivate, exportPublic, importPrivate, importPublic, signToken, TICKET_PREFIX, PUBLISH_PREFIX, type KeyPair } from './tickets.ts';
import { NetNode, type GenLink, type NodeRecord } from './node.ts';
import { VERSION as NET_VERSION, PROTOCOL } from '../sdk/js/hawkes-net-core.mjs';

db.exec(`
CREATE TABLE IF NOT EXISTS net_nodes (
  id TEXT PRIMARY KEY, url TEXT NOT NULL, admin_url TEXT, region TEXT, status TEXT NOT NULL, players INTEGER NOT NULL DEFAULT 0,
  capacity INTEGER NOT NULL DEFAULT 1000, load REAL NOT NULL DEFAULT 0, rooms INTEGER NOT NULL DEFAULT 0, version TEXT, workers INTEGER NOT NULL DEFAULT 0,
  embedded INTEGER NOT NULL DEFAULT 0, client TEXT, beat_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS net_rooms (
  project TEXT NOT NULL, room TEXT NOT NULL, node TEXT, epoch INTEGER NOT NULL DEFAULT 1, next_ord INTEGER NOT NULL DEFAULT 1,
  transport TEXT NOT NULL DEFAULT 'p2p', config TEXT NOT NULL, players INTEGER NOT NULL DEFAULT 0, opened_at INTEGER NOT NULL, seen_at INTEGER NOT NULL,
  PRIMARY KEY (project, room)
);
CREATE INDEX IF NOT EXISTS net_rooms_node ON net_rooms (node);
`);

const BEAT_STALE_MS = 35_000;
export const ICE = [{ urls: ['stun:stun.cloudflare.com:3478'] }, { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];

// ------------------------------------------------------------------ keys
// One Ed25519 key pair signs every ticket and publish token; the previous one stays valid for a day after a rotation.
const KEY_FILE = path.join(DATA_DIR, 'keys.json');
// (Where they were while the service ran inside Gen's data folder: picked up once, so tickets already out stay valid.)
const OLD_KEY_FILE = path.join(DATA_DIR, 'net', 'keys.json');
if (!fs.existsSync(KEY_FILE) && fs.existsSync(OLD_KEY_FILE)) fs.copyFileSync(OLD_KEY_FILE, KEY_FILE);
type KeyFile = { current: { kid: string; priv: string; pub: string; at: number }; previous?: { kid: string; priv: string; pub: string; at: number } | null };
let keyCache: { pair: KeyPair; file: KeyFile } | null = null;
function keys() {
  if (keyCache) return keyCache;
  let file: KeyFile | null = null;
  try { file = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8')); } catch {}
  if (!file?.current?.priv) {
    const k = newKeyPair();
    file = { current: { kid: k.kid, priv: exportPrivate(k.privateKey), pub: exportPublic(k.publicKey), at: Date.now() }, previous: null };
    fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
    fs.writeFileSync(KEY_FILE, JSON.stringify(file, null, 2), { mode: 0o600 });
  }
  const c = file.current;
  keyCache = { file, pair: { kid: c.kid, privateKey: importPrivate(c.priv), publicKey: importPublic(c.pub) } };
  return keyCache;
}
/** The public keys nodes check tickets with (GET /v1/net/keys: public, nothing secret in it). */
export function publicKeys() {
  const f = keys().file;
  const out = [{ kid: f.current.kid, pub: f.current.pub }];
  if (f.previous && Date.now() - f.current.at < 24 * 3600_000) out.push({ kid: f.previous.kid, pub: f.previous.pub });
  return out;
}
/** A new signing key; the old one keeps working for a day (nodes fetch keys every minute). */
export function rotateKeys() {
  const k = newKeyPair();
  const f = keys().file;
  const next: KeyFile = { current: { kid: k.kid, priv: exportPrivate(k.privateKey), pub: exportPublic(k.publicKey), at: Date.now() }, previous: f.current };
  fs.writeFileSync(KEY_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  keyCache = null;
  return publicKeys();
}

// ------------------------------------------------------------------ the directory
type NodeRow = { id: string; url: string; admin_url: string | null; region: string; status: string; players: number; capacity: number; load: number; rooms: number; version: string; workers: number; embedded: number; client: string | null; beat_at: number };
type RoomRow = { project: string; room: string; node: string | null; epoch: number; next_ord: number; transport: string; config: string; players: number; opened_at: number; seen_at: number };

const live = (n: NodeRow | undefined | null, now = Date.now()) => Boolean(n && n.status === 'up' && now - n.beat_at < BEAT_STALE_MS);
export function nodes(): NodeRow[] { return db.prepare('SELECT * FROM net_nodes ORDER BY id').all() as NodeRow[]; }
const nodeById = (id: string | null) => (id ? (db.prepare('SELECT * FROM net_nodes WHERE id = ?').get(id) as NodeRow | undefined) : undefined);
/** The least loaded live node with room for more players (the service's own node last: other relay boxes first). */
function pickNode(): NodeRow | null {
  const now = Date.now();
  const list = nodes().filter((n) => live(n, now) && n.players < n.capacity);
  list.sort((a, b) => (a.embedded - b.embedded) || (a.players / a.capacity + a.load) - (b.players / b.capacity + b.load));
  return list[0] ?? null;
}

export function heartbeat(rec: NodeRecord, client: Client | null) {
  if (!/^[a-z0-9][a-z0-9._-]{0,40}$/i.test(String(rec.id))) throw new NetError('Bad node id', { code: 'node_invalid' });
  if (!/^wss?:\/\//.test(String(rec.url))) throw new NetError('A node url is ws:// or wss://', { code: 'node_invalid' });
  db.prepare(`INSERT INTO net_nodes (id, url, admin_url, region, status, players, capacity, load, rooms, version, workers, embedded, client, beat_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET url = excluded.url, admin_url = excluded.admin_url, region = excluded.region, status = excluded.status, players = excluded.players,
                capacity = excluded.capacity, load = excluded.load, rooms = excluded.rooms, version = excluded.version, workers = excluded.workers, embedded = excluded.embedded,
                client = excluded.client, beat_at = excluded.beat_at`)
    .run(rec.id, rec.url, rec.adminUrl ?? null, rec.region ?? 'us-east-1', rec.status === 'draining' ? 'draining' : 'up', Math.max(0, rec.players | 0), Math.max(1, rec.capacity | 0), Number(rec.load) || 0, Math.max(0, rec.rooms | 0), String(rec.version ?? ''), rec.workers | 0, rec.embedded ? 1 : 0, client?.id ?? null, Date.now());
  return { ok: true };
}
export function roomEvent(e: { node: string; project: string; room: string; event: string; transport: string; players: number }) {
  const now = Date.now();
  // A closed room keeps its row (and its join order, so peer ids never repeat) until the sweep, hours later.
  if (e.event === 'closed') { db.prepare('UPDATE net_rooms SET players = 0, seen_at = ? WHERE project = ? AND room = ? AND node = ?').run(now, e.project, e.room, e.node); return { ok: true }; }
  db.prepare('UPDATE net_rooms SET transport = ?, seen_at = ?, players = ? WHERE project = ? AND room = ?').run(e.transport === 'relay' ? 'relay' : 'p2p', now, Math.max(0, e.players | 0), e.project, e.room);
  return { ok: true };
}

/** Where usage goes: the box sends it to Gen's usage table (src/hub.ts); tests keep it. Unset, it is dropped. */
let usageSink: ((rep: { node: string; rows: any[] }) => void) | null = null;
export function sendUsageTo(fn: ((rep: { node: string; rows: any[] }) => void) | null) { usageSink = fn; }

/** A node's usage report (player-seconds and bytes per project and transport, the last minute). */
export function recordNetUsage(rep: { node: string; rows: any[] }) {
  const rows = Array.isArray(rep?.rows) ? rep.rows.slice(0, 500) : [];
  if (rows.length) { try { addUsage(rows); } catch (e: any) { console.error('[net] usage days:', e.message); } }
  if (usageSink && rows.length) usageSink({ node: String(rep.node ?? ''), rows });
  return { ok: true, rows: rows.length };
}

// Rows of rooms empty for six hours go (a ticket lives 90 s and a resume token 10 minutes, so their peer ids are long
// dead); at most once a minute.
let sweptAt = 0;
function sweepRooms(now: number) {
  if (now - sweptAt < 60_000) return;
  sweptAt = now;
  db.prepare('DELETE FROM net_rooms WHERE players = 0 AND seen_at < ?').run(now - 6 * 3600_000);
}

// ------------------------------------------------------------------ tickets
const ROOM_RE = /^[a-z0-9][a-z0-9/_.-]{0,63}$/i;
/** May this key make tickets for this Hawkes Net project? Its own project, or a key-project pattern the entry lists. */
export function keyMayIssue(c: Client, p: NetProject) {
  if (c.role === 'owner' || c.projects.includes('*') || canProject(c, p.id)) return true;
  // The account that owns it: the portal's key narrowed to that account (a customer's server asking through hawkesgen.ai).
  if (p.owner && c.projects.includes(p.owner)) return true;
  // A key whose own projects entry is the pattern (the portal's key: usr_*) may; the same key narrowed to one customer
  // (X-Hawkesgen-Project: usr_x) may not act for the whole project.
  return c.projects.some((cp) => p.keyProjects.includes(cp));
}

// The public door (no key, by Origin): per address and per project, in memory.
const doorHits = new Map<string, number[]>();
export function doorLimit(key: string, max: number, ms = 60_000) {
  const now = Date.now();
  const recent = (doorHits.get(key) ?? []).filter((t) => now - t < ms);
  if (recent.length >= max) throw new NetError('Too many tickets; wait a moment', { code: 'ticket_rate_limited' });
  recent.push(now);
  doorHits.set(key, recent);
  if (doorHits.size > 50_000) for (const [k, v] of doorHits) if (!v.length || now - v[v.length - 1] > ms) doorHits.delete(k);
}

export type TicketAuth = { client: Client | null; origin: string; ip: string | null; host: string | null; proto: string };

/** A join ticket, and a line in the project's ticket log (made or refused, and why: the dashboard's Tickets). */
export function issueTicket(body: any, auth: TicketAuth) {
  const line = { project: String(body?.project ?? '').slice(0, 64), room: String(body?.room ?? '').slice(0, 64), role: String(body?.role ?? 'player').slice(0, 12), via: auth.client ? 'key' : 'site', origin: auth.origin.slice(0, 120), ip: auth.ip };
  try {
    const t = makeTicket(body, auth);
    logTicket({ ...line, ok: true, peer: t.peer });
    return t;
  } catch (e: any) {
    if (e instanceof NetError) logTicket({ ...line, ok: false, why: e.message.slice(0, 200), status: e.status });
    throw e;
  }
}

function makeTicket(body: any, auth: TicketAuth) {
  const project = String(body?.project ?? '');
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(project)) throw new NetError('project is the Hawkes Net project id', { code: 'project_invalid' });
  const p = netProject(project);
  // No anonymous projects: one made on net.hawkesgen.ai (or one of Hawkes's games). An owner key (tests, bots) may.
  const root = auth.client && (auth.client.role === 'owner' || auth.client.projects.includes('*'));
  if (!p.listed && !root) throw new NetError(`No Hawkes Net project "${project}": make one on net.hawkesgen.ai`, { code: 'project_not_found' });
  const room = String(body?.room ?? '');
  if (!ROOM_RE.test(room)) throw new NetError('room is 1 to 64 of letters, digits and / _ . -', { code: 'room_invalid' });
  let role = ['player', 'spectator', 'bot', 'test'].includes(body?.role) ? body.role : 'player';
  if (auth.client) {
    if (!keyMayIssue(auth.client, p)) throw new NetError(`This key can't make tickets for ${project}`, { code: 'key_project_forbidden' });
  } else {
    if (!p.listed || !originAllowed(p, auth.origin, room)) throw new NetError('Tickets without a key only for the project\'s own sites', { code: 'site_not_allowed' });
    if (role === 'bot' || role === 'test') throw new NetError('bot and test tickets need an API key', { code: 'role_needs_key' });
    doorLimit(`ip:${auth.ip ?? '?'}`, 30);
    doorLimit(`prj:${project}`, 3000);
  }
  const choice = ['auto', 'p2p', 'relay'].includes(body?.transport) ? body.transport : 'auto';
  let tr = p.transports.filter((t) => choice === 'auto' || t === choice);
  if (!tr.length) tr = p.transports.slice(0, 1);
  if (!tr.length) throw new NetError(`${project} may not use Hawkes Net`, { code: 'project_disabled' });
  const protocols: number[] = Array.isArray(body?.client?.protocols) ? body.client.protocols.map(Number) : [PROTOCOL];
  if (!protocols.includes(3) && !protocols.includes(2)) throw new NetError('This SDK is too old for Hawkes Net; reload', { code: 'sdk_too_old' });
  const now = Date.now();

  // The room: where it lives (one node), its config (fixed by its first ticket) and the next join order.
  const tx = db.prepare('BEGIN IMMEDIATE');
  tx.run();
  let row: RoomRow;
  let node: NodeRow | null;
  try {
    row = db.prepare('SELECT * FROM net_rooms WHERE project = ? AND room = ?').get(project, room) as RoomRow;
    node = row ? nodeById(row.node) ?? null : null;
    if (!row || !live(node, now)) {
      // A new room, or its node went away: the least loaded live node takes it (a new epoch, so old tickets fail).
      sweepRooms(now);
      // Rooms with people in them count toward the limit; rooms asked for but not joined yet have their own, larger cap
      // (so tickets for rooms nobody enters can't lock a project out of new rooms).
      const open = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(players), 0) AS players FROM net_rooms WHERE project = ? AND players > 0 AND seen_at > ?").get(project, now - 10 * 60_000) as { n: number; players: number };
      if (!row && open.n >= p.limits.rooms) throw new NetError(`${project} has ${open.n} rooms open, its limit`, { code: 'rooms_limit' });
      const waiting = (db.prepare('SELECT COUNT(*) AS n FROM net_rooms WHERE project = ? AND players = 0 AND seen_at > ?').get(project, now - 5 * 60_000) as { n: number }).n;
      if (!row && waiting >= p.limits.rooms * 5) throw new NetError(`${project} has too many rooms waiting for players`, { code: 'rooms_waiting_limit' });
      if (open.players >= p.limits.players) throw new NetError(`${project} has ${open.players} players online, its limit`, { code: 'players_limit' });
      node = pickNode();
      if (!node) throw new NetError('No Hawkes Net node is up right now; try again in a minute', { code: 'no_node' });
      const cfg = roomConfig(p, body?.config);
      if (!row) {
        db.prepare('INSERT INTO net_rooms (project, room, node, epoch, next_ord, transport, config, players, opened_at, seen_at) VALUES (?, ?, ?, 1, 1, ?, ?, 0, ?, ?)').run(project, room, node.id, choice === 'relay' || !tr.includes('p2p') ? 'relay' : 'p2p', JSON.stringify(cfg), now, now);
      } else db.prepare('UPDATE net_rooms SET node = ?, epoch = epoch + 1, seen_at = ? WHERE project = ? AND room = ?').run(node.id, now, project, room);
      row = db.prepare('SELECT * FROM net_rooms WHERE project = ? AND room = ?').get(project, room) as RoomRow;
    }
    db.prepare('UPDATE net_rooms SET next_ord = next_ord + 1, seen_at = ? WHERE project = ? AND room = ?').run(now, project, room);
    db.prepare('COMMIT').run();
  } catch (e) {
    db.prepare('ROLLBACK').run();
    throw e;
  }
  const cfg = JSON.parse(row.config);
  const ord = row.next_ord;
  const peer = `p${ord}`;
  const name = typeof body?.name === 'string' ? body.name.replace(/[\u0000-\u001f\u007f<>]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) || null : null;
  const sub = typeof body?.sub === 'string' && body.sub ? body.sub.slice(0, 64) : crypto.randomBytes(8).toString('hex');
  const k = keys().pair;
  const iat = Math.floor(now / 1000);
  const payload = {
    v: 1, kid: k.kid, prj: project, room, peer, ord, sub, nm: name, role, tr, want: choice, node: node!.id, epoch: row.epoch,
    lim: p.limits, cfg, iat, exp: iat + 90, jti: crypto.randomBytes(9).toString('base64url'),
  };
  const ticket = signToken(TICKET_PREFIX, payload, k.privateKey);
  const url = node!.embedded ? embeddedUrl(auth) : node!.url;
  return { ticket, peer, ord, config: cfg, relayUrl: url, signalUrl: url, transports: tr, ice: ICE, expiresAt: (iat + 90) * 1000, node: node!.id, epoch: row.epoch, protocol: protocols.includes(3) ? 3 : 2, sdk: NET_VERSION };
}
/** This process's own relay node is reached at NET_PUBLIC_URL (the box: wss://net.hawkesgen.ai/v1/net/ws), else where
 *  the caller reached this service. */
function embeddedUrl(a: TicketAuth) {
  const fixed = env('NET_PUBLIC_URL');
  if (fixed) return fixed;
  if (!a.host) return `ws://127.0.0.1:${env('NET_PORT') ?? 8800}/v1/net/ws`;
  return `${a.proto === 'https' ? 'wss' : 'ws'}://${a.host}/v1/net/ws`;
}

// ------------------------------------------------------------------ server-side publish (world edits, server events)
/** Sends world edits or an event into a room from a server (the portal saving a scene). Nothing happens when the room
 *  isn't open. Signed with Gen's key, so the node takes it from no one else. */
export async function publish(client: Client, body: any) {
  const project = String(body?.project ?? '');
  const room = String(body?.room ?? '');
  const p = netProject(project);
  if (!keyMayIssue(client, p)) throw new NetError(`This key can't publish to ${project}`, { code: 'key_project_forbidden' });
  // "<prefix>/*": every open room under it (a game's edit room and all its play rooms hear one world edit).
  if (room.endsWith('/*')) {
    const prefix = room.slice(0, -1);
    if (!ROOM_RE.test(prefix.slice(0, -1)) || prefix.length < 3) throw new NetError('Bad room prefix', { code: 'room_prefix_invalid' });
    const names = (db.prepare("SELECT room FROM net_rooms WHERE project = ? AND players > 0 AND substr(room, 1, ?) = ? LIMIT 200").all(project, prefix.length, prefix) as { room: string }[]).map((r) => r.room);
    let delivered = 0;
    for (const name of names) delivered += Number((await publish(client, { ...body, room: name })).delivered) || 0;
    return { delivered, rooms: names.length, open: names.length > 0 };
  }
  if (!ROOM_RE.test(room)) throw new NetError('Bad room', { code: 'room_invalid' });
  const row = db.prepare('SELECT node FROM net_rooms WHERE project = ? AND room = ?').get(project, room) as { node: string | null } | undefined;
  const node = row ? nodeById(row.node) : null;
  if (!row || !node || !live(node)) return { delivered: 0, open: false };
  const k = keys().pair;
  const iat = Math.floor(Date.now() / 1000);
  const token = signToken(PUBLISH_PREFIX, { v: 1, kid: k.kid, prj: project, room, iat, exp: iat + 30, jti: crypto.randomBytes(9).toString('base64url') }, k.privateKey);
  const msg = { ops: Array.isArray(body.ops) ? body.ops : undefined, by: typeof body.by === 'string' ? body.by.slice(0, 60) : 'server', fx: typeof body.fx === 'string' ? body.fx.slice(0, 20) : null, event: body.event && typeof body.event.name === 'string' ? { name: body.event.name, data: body.event.data ?? null } : undefined, except: typeof body.except === 'string' ? body.except : null, kick: body.kick && typeof body.kick === 'object' ? { sub: typeof body.kick.sub === 'string' && body.kick.sub ? body.kick.sub.slice(0, 64) : null } : undefined };
  if (node.embedded && embedded) return { open: true, ...nodeAnswer(await embedded.publish(token, msg)) };
  if (!node.admin_url) throw new NetError('This node takes no publishes', { code: 'node_not_taking_requests' });
  const r = await fetch(`${node.admin_url.replace(/\/+$/, '')}/publish`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(msg), signal: AbortSignal.timeout(5000) }).catch(() => null);
  if (!r) throw new NetError('Node not answering', { code: 'node_not_answering' });
  return { open: true, ...nodeAnswer(await r.json().catch(() => ({}))) };
}

/** What a node answered: a refusal (ok: false) becomes the service's own error, with the node's code. */
function nodeAnswer(r: any) {
  if (r && r.ok === false) throw new NetError(String(r.error ?? 'The node refused'), { code: r.code in ERRORS ? r.code : 'publish_refused' });
  return r;
}

/** Who is in a room now (a project's own dashboard): each player's id, name, join order, role, your game's id for them
 *  (sub), when they joined, connected or within their grace, and bytes each way. Asked of the room's node with a signed token. */
export async function roomPlayers(a: Actor, project: string, room: string) {
  readable(a, project);
  if (!ROOM_RE.test(room)) throw new NetError('Bad room', { code: 'room_invalid' });
  const r: any = await toRoomNode(project, room, { peek: true });
  return { project, room, open: Boolean(r.open), transport: r.transport ?? null, host: r.host ?? null, players: Array.isArray(r.players) ? r.players : [] };
}
/** Puts a player out of a room (by your game's id for them, `sub`, or the peer id); they can come back with a new ticket
 *  unless your game stops giving them one. */
export async function kickPlayer(a: Actor, project: string, room: string, body: any) {
  readable(a, project);
  if (!ROOM_RE.test(room)) throw new NetError('Bad room', { code: 'room_invalid' });
  const sub = typeof body?.sub === 'string' && body.sub ? body.sub.slice(0, 64) : null;
  const peer = typeof body?.peer === 'string' && /^p\d{1,9}$/.test(body.peer) ? body.peer : null;
  if (!sub && !peer) throw new NetError('sub or peer: who to put out', { code: 'kick_target_required' });
  const r: any = await toRoomNode(project, room, { kick: { sub, peer } });
  return { project, room, kicked: Number(r.kicked) || 0 };
}
async function toRoomNode(project: string, room: string, msg: any) {
  const row = db.prepare('SELECT node FROM net_rooms WHERE project = ? AND room = ?').get(project, room) as { node: string | null } | undefined;
  const node = row ? nodeById(row.node) : null;
  if (!row || !node || !live(node)) return { open: false, players: [], kicked: 0 };
  const k = keys().pair;
  const iat = Math.floor(Date.now() / 1000);
  const token = signToken(PUBLISH_PREFIX, { v: 1, kid: k.kid, prj: project, room, iat, exp: iat + 30, jti: crypto.randomBytes(9).toString('base64url') }, k.privateKey);
  if (node.embedded && embedded) return { open: true, ...nodeAnswer(await embedded.publish(token, msg)) };
  if (!node.admin_url) throw new NetError('This node takes no requests', { code: 'node_not_taking_requests' });
  const r = await fetch(`${node.admin_url.replace(/\/+$/, '')}/publish`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(msg), signal: AbortSignal.timeout(5000) }).catch(() => null);
  if (!r) throw new NetError('Node not answering', { code: 'node_not_answering' });
  return { open: true, ...nodeAnswer(await r.json().catch(() => ({}))) };
}

/** Is a room open (someone in it, on a live node), how many are in it, and on what? (Invitations ask before loading.) */
export function roomInfo(client: Client, body: any) {
  const project = String(body?.project ?? '');
  const room = String(body?.room ?? '');
  const p = netProject(project);
  if (!keyMayIssue(client, p)) throw new NetError(`This key can't read ${project}`, { code: 'key_project_forbidden' });
  if (!ROOM_RE.test(room)) throw new NetError('Bad room', { code: 'room_invalid' });
  const row = db.prepare('SELECT * FROM net_rooms WHERE project = ? AND room = ?').get(project, room) as RoomRow | undefined;
  const node = row ? nodeById(row.node) : null;
  const open = Boolean(row && live(node) && row.players > 0);
  return { open, players: open ? row!.players : 0, transport: row?.transport ?? null, limit: row ? JSON.parse(row.config).maxPlayers : netProject(project).defaults.maxPlayers };
}

/**
 * The public counts of a project that has its own sites (the public door): how many players are in each named room, for
 * a page that shows "12 in Level 1" before joining it. Only numbers, only for projects whose rooms any page on their
 * sites could join anyway; per-address limits like the door's.
 */
export function publicCounts(project: string, rooms: string[], ip: string | null) {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(project)) throw new NetError('project is the Hawkes Net project id', { code: 'project_invalid' });
  const p = netProject(project);
  if (!p.listed || !p.origins.length) throw new NetError(`${project} has no public counts`, { code: 'counts_not_public' });
  const names = [...new Set(rooms.map((r) => r.trim()).filter(Boolean))];
  if (!names.length || names.length > 24 || names.some((r) => !ROOM_RE.test(r))) throw new NetError('rooms is 1 to 24 room names, comma separated', { code: 'counts_rooms_invalid' });
  doorLimit(`cnt:${ip ?? '?'}`, 120);
  const out: Record<string, number> = {};
  const get = db.prepare('SELECT * FROM net_rooms WHERE project = ? AND room = ?');
  for (const room of names) {
    const row = get.get(project, room) as RoomRow | undefined;
    out[room] = row && live(nodeById(row.node)) && row.players > 0 ? row.players : 0;
  }
  return { project, rooms: out };
}

// ------------------------------------------------------------------ status
/** A project's rooms with people in them (or just opened), newest first: a developer's own view of their game. */
export function projectRooms(client: Client, body: any) {
  const project = String(body?.project ?? '');
  const p = netProject(project);
  if (!keyMayIssue(client, p)) throw new NetError(`This key can't read ${project}`, { code: 'key_project_forbidden' });
  const now = Date.now();
  const rows = db.prepare('SELECT room, transport, players, opened_at, seen_at FROM net_rooms WHERE project = ? AND seen_at > ? AND (players > 0 OR opened_at > ?) ORDER BY players DESC, seen_at DESC LIMIT 200')
    .all(project, now - 10 * 60_000, now - 2 * 60_000) as { room: string; transport: string; players: number; opened_at: number; seen_at: number }[];
  return { project, rooms: rows.map((r) => ({ room: r.room, transport: r.transport, players: r.players, openedAt: r.opened_at, seenAt: r.seen_at })), players: rows.reduce((n, r) => n + r.players, 0) };
}

export function status() {
  const now = Date.now();
  const ns = nodes().map((n) => ({ id: n.id, url: n.url, region: n.region, status: live(n, now) ? n.status : 'down', players: n.players, capacity: n.capacity, load: n.load, rooms: n.rooms, version: n.version, workers: n.workers, embedded: Boolean(n.embedded), beatAgoMs: now - n.beat_at }));
  const rooms = db.prepare("SELECT project, transport, COUNT(*) AS rooms, COALESCE(SUM(players), 0) AS players FROM net_rooms WHERE seen_at > ? GROUP BY project, transport").all(now - 10 * 60_000);
  const upCount = ns.filter((n) => n.status === 'up').length;
  // ok: every node up; degraded: some up, some not (still serving); down: none up.
  const health = upCount === 0 ? 'down' : upCount === ns.length ? 'ok' : 'degraded';
  return { version: NET_VERSION, protocol: PROTOCOL, up: upCount > 0, health, nodes: ns, rooms };
}

// ------------------------------------------------------------------ this process's relay node
let embedded: NetNode | null = null;
const inProcess: GenLink = {
  keys: async () => publicKeys(),
  heartbeat: async (rec) => { heartbeat(rec, null); },
  room: async (e) => { roomEvent(e as any); },
  usage: async (rep) => { recordNetUsage(rep); },
};
/** Starts the relay node this process runs (NET_WORKERS worker processes, NET_CAPACITY players, NET_NODE_ID). */
export async function startNode() {
  if (embedded) return embedded;
  const workers = Number(env('NET_WORKERS') ?? 1);
  embedded = new NetNode({ id: env('NET_NODE_ID') ?? 'net-1', url: env('NET_PUBLIC_URL') ?? `ws://127.0.0.1:${env('NET_PORT') ?? 8800}/v1/net/ws`, adminUrl: null, embedded: true, capacity: Number(env('NET_CAPACITY') ?? 2000), workers, usageMs: Number(env('NET_USAGE_MS') ?? 60_000), link: inProcess });
  await embedded.start();
  return embedded;
}
export const ownNode = () => embedded;
export async function stopNode() { if (embedded) { await embedded.drain(3000).catch(() => {}); embedded.stop(); embedded = null; } }

/** Who a ticket request is from (the public door uses the origin and the address). */
export function ticketAuth(req: IncomingMessage, client: Client | null): TicketAuth {
  const sock = req.socket.remoteAddress ?? '';
  const loop = sock === '127.0.0.1' || sock === '::1' || sock === '::ffff:127.0.0.1';
  const xff = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const ip = (loop && xff.length ? xff[xff.length - 1] : sock) || null;
  const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() || ((req.socket as any).encrypted ? 'https' : 'http');
  return { client, origin: String(req.headers.origin ?? ''), ip, host: String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '') || null, proto };
}
