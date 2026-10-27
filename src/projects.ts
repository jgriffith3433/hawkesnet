// Projects and accounts (docs/net.md "Projects and accounts"): every Hawkes Net project belongs to a hawkesgen.com
// account (its Gen project, usr_...). The account makes its projects on net.hawkesgen.com (through the portal, which
// checks who is signed in and passes the account here with its key), sets each one's sites, peer to peer and room size,
// and reads its numbers: players online now and over the last day, rooms, the ticket log (made and refused, and why) and
// daily usage. Hawkes's own games (projects.json) are projects too, taken by an admin's account.
//
// Tables (the service's own net.db): net_projects (the projects), net_tickets (7 days of tickets), net_days (a row per
// project and UTC day: tickets, refused, player-seconds, bytes, peak players), net_online (players and rooms a minute,
// 8 days).
import { db, NetError, type Client } from './store.ts';
import { netProject, listedProjects, useProjectRows, type NetProject, type ProjectRow, type Tier } from './registry.ts';

db.exec(`
CREATE TABLE IF NOT EXISTS net_projects (
  id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL, origins TEXT, p2p INTEGER NOT NULL DEFAULT 0, max_players INTEGER,
  tier TEXT NOT NULL DEFAULT 'free', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS net_projects_owner ON net_projects (owner);
CREATE TABLE IF NOT EXISTS net_tickets (
  project TEXT NOT NULL, at INTEGER NOT NULL, room TEXT, role TEXT, via TEXT, origin TEXT, ok INTEGER NOT NULL, peer TEXT, why TEXT, status INTEGER
);
CREATE INDEX IF NOT EXISTS net_tickets_project ON net_tickets (project, at);
CREATE TABLE IF NOT EXISTS net_days (
  project TEXT NOT NULL, day TEXT NOT NULL, tickets INTEGER NOT NULL DEFAULT 0, refused INTEGER NOT NULL DEFAULT 0,
  player_seconds REAL NOT NULL DEFAULT 0, test_player_seconds REAL NOT NULL DEFAULT 0, relay_bytes REAL NOT NULL DEFAULT 0,
  p2p_bytes REAL NOT NULL DEFAULT 0, peak_players INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (project, day)
);
CREATE TABLE IF NOT EXISTS net_online (project TEXT NOT NULL, at INTEGER NOT NULL, players INTEGER NOT NULL, rooms INTEGER NOT NULL, PRIMARY KEY (project, at));
`);

// The first version kept one list of sites per account (net_sites, a day old): each becomes a project of that account.
if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'net_sites'").get()) {
  const now = Date.now();
  for (const r of db.prepare('SELECT project, name, origins FROM net_sites').all() as { project: string; name: string; origins: string }[]) {
    db.prepare("INSERT OR IGNORE INTO net_projects (id, owner, name, origins, p2p, tier, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 'paid', ?, ?)").run(r.project, r.project, r.name, r.origins, now, now);
  }
  db.exec('DROP TABLE net_sites');
}

// ------------------------------------------------------------------ rows
type Raw = { id: string; owner: string; name: string; origins: string | null; p2p: number; max_players: number | null; tier: string; created_at: number; updated_at: number };
const toRow = (r: Raw): ProjectRow => ({ id: r.id, owner: r.owner, name: r.name, origins: r.origins ? JSON.parse(r.origins) : null, p2p: Boolean(r.p2p), maxPlayers: r.max_players, tier: (r.tier === 'paid' ? 'paid' : 'free') as Tier, createdAt: r.created_at, updatedAt: r.updated_at });
const rowCache = new Map<string, { at: number; v: ProjectRow | null }>();
function row(id: string): ProjectRow | null {
  const c = rowCache.get(id);
  if (c && Date.now() - c.at < 10_000) return c.v;
  const r = db.prepare('SELECT * FROM net_projects WHERE id = ?').get(id) as Raw | undefined;
  const v = r ? toRow(r) : null;
  if (rowCache.size > 20_000) rowCache.clear();
  rowCache.set(id, { at: Date.now(), v });
  return v;
}
useProjectRows(row);
const forget = (id: string) => rowCache.delete(id);

// ------------------------------------------------------------------ who is asking
/** Who a request acts for: an account (its Gen project) and whether it is a Hawkes admin. */
export type Actor = { owner: string | null; admin: boolean };
const OWNER_RE = /^[a-z0-9_]{1,64}$/i;
/**
 * The portal's key (a pattern of accounts, usr_*) acts for the account it names (`owner`), and says whether that account
 * is an admin: the portal checked the session. A key for one project (a key narrowed to an account) acts for it. An owner
 * or admin Gen key acts for anyone, as an admin.
 */
export function actor(c: Client, owner: unknown, admin: unknown): Actor {
  const o = typeof owner === 'string' ? owner.trim() : '';
  if (c.role === 'owner' || c.role === 'admin' || c.projects.includes('*')) return { owner: o || null, admin: true };
  const patterns = c.projects.filter((p) => p.endsWith('*'));
  if (patterns.length) {
    if (!OWNER_RE.test(o) || !patterns.some((p) => o.startsWith(p.slice(0, -1)))) throw new NetError('owner is the account to act for (its project)');
    return { owner: o, admin: admin === true || admin === 'true' || admin === '1' };
  }
  if (c.projects.length === 1 && OWNER_RE.test(c.projects[0])) return { owner: c.projects[0], admin: false };
  throw new NetError('This key does not act for an account', { status: 403 });
}
const mayRead = (a: Actor, p: NetProject) => a.admin || (p.owner !== null && p.owner === a.owner);
function mine(a: Actor, id: string) {
  const p = netProject(id);
  if (!p.listed || !mayRead(a, p)) throw new NetError(`No project "${id}" in this account`, { status: 404 });
  return p;
}

/** The account's tier as the portal sees it now (paid or not): kept on its projects, which set their limits. */
export function touchTier(owner: string | null, tier: unknown) {
  if (!owner || (tier !== 'paid' && tier !== 'free')) return;
  const changed = db.prepare('UPDATE net_projects SET tier = ? WHERE owner = ? AND tier != ?').run(tier, owner, tier).changes;
  if (changed) for (const r of db.prepare('SELECT id FROM net_projects WHERE owner = ?').all(owner) as { id: string }[]) forget(r.id);
}

// ------------------------------------------------------------------ numbers
const DAY = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const LIVE_MS = 35_000;

/** Players and rooms with people in them now (rooms on a node that is up). */
function nowOf(project: string) {
  const r = db.prepare(`SELECT COUNT(*) AS rooms, COALESCE(SUM(r.players), 0) AS players FROM net_rooms r JOIN net_nodes n ON n.id = r.node
                        WHERE r.project = ? AND r.players > 0 AND n.beat_at > ?`).get(project, Date.now() - LIVE_MS) as { rooms: number; players: number };
  return { players: Number(r.players), rooms: Number(r.rooms) };
}
function dayOf(project: string, day = DAY()) {
  const r = db.prepare('SELECT * FROM net_days WHERE project = ? AND day = ?').get(project, day) as any;
  return { tickets: r?.tickets ?? 0, refused: r?.refused ?? 0, playerMinutes: Math.round(((r?.player_seconds ?? 0) / 60) * 10) / 10, relayGb: (r?.relay_bytes ?? 0) / 1e9, peakPlayers: r?.peak_players ?? 0 };
}

/** One project as the list and the page show it. */
function view(p: NetProject, extra: Record<string, unknown> = {}) {
  const r = row(p.id);
  return {
    id: p.id, name: p.name, owner: p.owner, hawkes: p.hawkes, tier: p.tier, sites: p.origins, sitesFromFile: p.hawkes && !(r && r.origins),
    p2p: p.p2p, maxPlayers: p.defaults.maxPlayers, limits: { rooms: p.limits.rooms, players: p.limits.players, playersPerRoom: p.limits.playersPerRoom },
    createdAt: r?.createdAt ?? null, now: nowOf(p.id), today: dayOf(p.id), ...extra,
  };
}

/** The account's projects; an admin also sees Hawkes's games nobody has taken (to take), and with `all` every project. */
export function listProjects(a: Actor, all = false) {
  const ids = new Set<string>();
  const own = a.owner ? (db.prepare('SELECT id FROM net_projects WHERE owner = ? ORDER BY created_at').all(a.owner) as { id: string }[]).map((r) => r.id) : [];
  for (const id of own) ids.add(id);
  const projects = own.map((id) => view(netProject(id)));
  const unowned = a.admin ? listedProjects().filter((id) => !row(id)).map((id) => view(netProject(id), { claimable: true })) : [];
  const others = a.admin && all
    ? (db.prepare('SELECT id FROM net_projects ORDER BY created_at').all() as { id: string }[]).filter((r) => !ids.has(r.id)).map((r) => view(netProject(r.id)))
    : [];
  return { owner: a.owner, admin: a.admin, projects, unowned, others };
}

const ID_RE = /^[a-z][a-z0-9-]{2,39}$/;
const RESERVED = new Set(['admin', 'api', 'hawkes', 'hawkesnet', 'net', 'demo', 'test', 'sdk', 'www', 'portal', 'new', 'projects']);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/^[^a-z]+/, '').slice(0, 32);
const taken = (id: string) => RESERVED.has(id) || listedProjects().includes(id) || Boolean(db.prepare('SELECT 1 FROM net_projects WHERE id = ?').get(id));
const cleanName = (v: unknown) => String(v ?? '').replace(/[^\p{L}\p{N} _.'&:!-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 60);
export const MAX_PROJECTS = 20;
export const MAX_SITES = 20;

/** A new project for the account ({ name, id? }): its id is what the game passes (`project`). */
export function createProject(a: Actor, body: any) {
  if (!a.owner) throw new NetError('owner is the account the project is for');
  const name = cleanName(body?.name);
  if (!name) throw new NetError('Give the project a name');
  const n = (db.prepare('SELECT COUNT(*) AS n FROM net_projects WHERE owner = ?').get(a.owner) as { n: number }).n;
  if (n >= MAX_PROJECTS && !a.admin) throw new NetError(`An account has at most ${MAX_PROJECTS} projects`, { status: 409 });
  let id: string;
  if (body?.id) {
    id = String(body.id).trim().toLowerCase();
    if (!ID_RE.test(id)) throw new NetError('The id is 3 to 40 of lower-case letters, digits and -, starting with a letter');
    if (taken(id)) throw new NetError(`"${id}" is taken`, { status: 409 });
  } else {
    const base = slug(name).length >= 3 ? slug(name) : `game-${slug(name)}`.replace(/-$/, '') || 'game';
    id = base;
    for (let i = 2; taken(id); i++) id = `${base.slice(0, 36)}-${i}`;
  }
  const now = Date.now();
  db.prepare('INSERT INTO net_projects (id, owner, name, origins, p2p, max_players, tier, created_at, updated_at) VALUES (?, ?, ?, NULL, 0, NULL, ?, ?, ?)')
    .run(id, a.owner, name, body?.tier === 'paid' ? 'paid' : 'free', now, now);
  forget(id);
  return view(netProject(id));
}

const ORIGIN_RE = /^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d{1,5})?$/;
function cleanSites(list: unknown): string[] {
  const raw: unknown[] = Array.isArray(list) ? list : [];
  if (raw.length > MAX_SITES) throw new NetError(`At most ${MAX_SITES} sites`);
  const out: string[] = [];
  for (const v of raw) {
    let o = String(v ?? '').trim().toLowerCase().replace(/\/+$/, '');
    if (!o) continue;
    if (!/^[a-z]+:\/\//.test(o)) o = `https://${o}`;
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o)) throw new NetError('localhost needs no entry: it may always join the test rooms (t-...)');
    if (!ORIGIN_RE.test(o)) throw new NetError(`${String(v)} is not a site: https://your-game.com (no path)`);
    if (!out.includes(o)) out.push(o);
  }
  return out;
}

/** Changes a project's settings: name, sites (its pages join with no key), p2p (peer to peer for small rooms, off by
 *  default), maxPlayers (a room's size). Sites need a paid account (the portal checks; the free tier tests on localhost). */
export function updateProject(a: Actor, id: string, body: any) {
  const p = mine(a, id);
  const r = row(id);
  if (!r) throw new NetError(`"${id}" is one of Hawkes's games nobody has taken: take it first`, { status: 409 });
  const sets: string[] = [];
  const vals: any[] = [];
  if (body?.name !== undefined) { const name = cleanName(body.name); if (!name) throw new NetError('Give the project a name'); sets.push('name = ?'); vals.push(name); }
  if (body?.sites !== undefined) {
    // A Hawkes game with no sites of its own here uses its file's: null puts that back.
    const sites = body.sites === null && p.hawkes ? null : cleanSites(body.sites);
    sets.push('origins = ?'); vals.push(sites === null ? null : JSON.stringify(sites));
  }
  if (body?.p2p !== undefined) { sets.push('p2p = ?'); vals.push(body.p2p === true ? 1 : 0); }
  if (body?.maxPlayers !== undefined) {
    const m = body.maxPlayers === null ? null : Number(body.maxPlayers);
    if (m !== null && (!Number.isInteger(m) || m < 1 || m > p.limits.playersPerRoom)) throw new NetError(`A room holds 1 to ${p.limits.playersPerRoom} players on this project's plan`);
    sets.push('max_players = ?'); vals.push(m);
  }
  if (!sets.length) return view(p);
  sets.push('updated_at = ?'); vals.push(Date.now());
  db.prepare(`UPDATE net_projects SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  forget(id);
  return view(netProject(id));
}

/** A customer's project goes (its rooms close as their players leave; its numbers stay out of every list). A Hawkes
 *  game is let go: back to its file, nobody's. */
export function deleteProject(a: Actor, id: string) {
  const p = mine(a, id);
  if (!row(id)) throw new NetError(`"${id}" is not in an account`, { status: 409 });
  db.prepare('DELETE FROM net_projects WHERE id = ?').run(id);
  forget(id);
  return { ok: true, id, released: p.hawkes };
}

/** An admin takes one of Hawkes's games into their account (it shows with their projects; its settings from the file). */
export function claimProject(a: Actor, id: string) {
  if (!a.admin || !a.owner) throw new NetError('Only an admin takes Hawkes\'s games', { status: 403 });
  const p = netProject(id);
  if (!p.hawkes) throw new NetError(`"${id}" is not one of Hawkes's games`, { status: 404 });
  const r = row(id);
  if (r && r.owner !== a.owner) throw new NetError(`"${id}" is in another account`, { status: 409 });
  if (!r) {
    const now = Date.now();
    db.prepare("INSERT INTO net_projects (id, owner, name, origins, p2p, max_players, tier, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, NULL, 'paid', ?, ?)")
      .run(id, a.owner, p.name, p.p2p ? 1 : 0, now, now);
    forget(id);
  }
  return view(netProject(id));
}

// ------------------------------------------------------------------ the record
type TicketLine = { project: string; room: string; role: string; via: string; origin: string; ip: string | null; ok: boolean; peer?: string; why?: string; status?: number; transport?: string };
let prunedAt = 0;
/** Every ticket made or refused for a known project (the dashboard's Tickets, and the day's counts). */
export function logTicket(t: TicketLine) {
  if (!t.project || !netProject(t.project).listed) return;
  const now = Date.now();
  db.prepare('INSERT INTO net_tickets (project, at, room, role, via, origin, ok, peer, why, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(t.project, now, t.room || null, t.role || null, t.via, t.origin || null, t.ok ? 1 : 0, t.peer ?? null, t.why ?? null, t.status ?? null);
  db.prepare(`INSERT INTO net_days (project, day, tickets, refused) VALUES (?, ?, ?, ?)
              ON CONFLICT(project, day) DO UPDATE SET tickets = tickets + excluded.tickets, refused = refused + excluded.refused`).run(t.project, DAY(now), t.ok ? 1 : 0, t.ok ? 0 : 1);
  if (now - prunedAt > 10 * 60_000) prune(now);
}
function prune(now: number) {
  prunedAt = now;
  db.prepare('DELETE FROM net_tickets WHERE at < ?').run(now - 7 * 86_400_000);
  db.prepare('DELETE FROM net_online WHERE at < ?').run(now - 8 * 86_400_000);
}

/** A node's usage rows into the day's numbers (player-seconds, bytes by transport; test rooms apart). */
export function addUsage(rows: any[]) {
  const day = DAY();
  const up = db.prepare(`INSERT INTO net_days (project, day, player_seconds, test_player_seconds, relay_bytes, p2p_bytes, peak_players) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project, day) DO UPDATE SET player_seconds = player_seconds + excluded.player_seconds, test_player_seconds = test_player_seconds + excluded.test_player_seconds,
      relay_bytes = relay_bytes + excluded.relay_bytes, p2p_bytes = p2p_bytes + excluded.p2p_bytes, peak_players = MAX(peak_players, excluded.peak_players)`);
  for (const r of rows) {
    if (typeof r?.project !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(r.project)) continue;
    const secs = Math.max(0, Number(r.playerSeconds) || 0);
    const bytes = Math.max(0, Number(r.bytesOut) || 0);
    const relay = r.transport === 'relay';
    up.run(r.project, day, r.test ? 0 : secs, r.test ? secs : 0, relay ? bytes : 0, relay ? 0 : bytes, Math.max(0, r.peakPlayers | 0));
  }
}

/** Players and rooms per project this minute (the dashboard's players-online line); the box runs it every minute. */
export function sampleOnline(now = Date.now()) {
  const at = Math.floor(now / 60_000) * 60_000;
  const rows = db.prepare(`SELECT r.project AS project, COUNT(*) AS rooms, COALESCE(SUM(r.players), 0) AS players FROM net_rooms r JOIN net_nodes n ON n.id = r.node
                           WHERE r.players > 0 AND n.beat_at > ? GROUP BY r.project`).all(now - LIVE_MS) as { project: string; rooms: number; players: number }[];
  const put = db.prepare('INSERT OR REPLACE INTO net_online (project, at, players, rooms) VALUES (?, ?, ?, ?)');
  const peak = db.prepare(`INSERT INTO net_days (project, day, peak_players) VALUES (?, ?, ?)
                           ON CONFLICT(project, day) DO UPDATE SET peak_players = MAX(peak_players, excluded.peak_players)`);
  for (const r of rows) { put.run(r.project, at, r.players, r.rooms); peak.run(r.project, DAY(now), r.players); }
  return rows.length;
}
let sampler: ReturnType<typeof setInterval> | null = null;
export function startSampler() { if (!sampler) { sampler = setInterval(() => { try { sampleOnline(); } catch (e: any) { console.error('[net] sample:', e.message); } }, 60_000); sampler.unref?.(); } }
export function stopSampler() { if (sampler) clearInterval(sampler); sampler = null; }

/** A project's page: its settings and limits, now, the last day of players online (5-minute steps), rooms, the last
 *  30 days, and the newest tickets (refused ones first counted by reason). */
export function projectDetail(a: Actor, id: string) {
  const p = mine(a, id);
  const now = Date.now();
  const rooms = (db.prepare(`SELECT r.room, r.transport, r.players, r.opened_at, r.seen_at, r.config, (n.beat_at > ?) AS up FROM net_rooms r LEFT JOIN net_nodes n ON n.id = r.node
                             WHERE r.project = ? AND r.seen_at > ? AND (r.players > 0 OR r.opened_at > ?) ORDER BY r.players DESC, r.seen_at DESC LIMIT 300`)
    .all(now - LIVE_MS, id, now - 10 * 60_000, now - 2 * 60_000) as any[])
    .map((r) => ({ room: r.room, transport: r.transport, players: r.up ? r.players : 0, maxPlayers: JSON.parse(r.config).maxPlayers ?? null, openedAt: r.opened_at, seenAt: r.seen_at, test: r.room.startsWith(p.testPrefix) }));
  const online: { at: number; players: number; rooms: number }[] = [];
  const samples = db.prepare('SELECT at, players, rooms FROM net_online WHERE project = ? AND at > ? ORDER BY at').all(id, now - 86_400_000) as { at: number; players: number; rooms: number }[];
  const step = 5 * 60_000;
  for (let t = Math.floor((now - 86_400_000) / step) * step; t <= now; t += step) {
    const inStep = samples.filter((s) => s.at >= t && s.at < t + step);
    online.push({ at: t, players: inStep.reduce((m, s) => Math.max(m, s.players), 0), rooms: inStep.reduce((m, s) => Math.max(m, s.rooms), 0) });
  }
  const days = (db.prepare('SELECT * FROM net_days WHERE project = ? AND day >= ? ORDER BY day DESC').all(id, DAY(now - 30 * 86_400_000)) as any[])
    .map((d) => ({ day: d.day, tickets: d.tickets, refused: d.refused, playerMinutes: Math.round((d.player_seconds / 60) * 10) / 10, testPlayerMinutes: Math.round((d.test_player_seconds / 60) * 10) / 10, relayGb: d.relay_bytes / 1e9, p2pGb: d.p2p_bytes / 1e9, peakPlayers: d.peak_players }));
  const tickets = (db.prepare('SELECT at, room, role, via, origin, ok, peer, why, status FROM net_tickets WHERE project = ? ORDER BY at DESC LIMIT 100').all(id) as any[])
    .map((t) => ({ at: t.at, room: t.room, role: t.role, via: t.via, origin: t.origin, ok: Boolean(t.ok), peer: t.peer, why: t.why, status: t.status }));
  const refusedWhy = db.prepare('SELECT why, COUNT(*) AS n FROM net_tickets WHERE project = ? AND ok = 0 AND at > ? GROUP BY why ORDER BY n DESC LIMIT 10').all(id, now - 86_400_000) as { why: string; n: number }[];
  const peakDay = online.reduce((m, o) => Math.max(m, o.players), 0);
  return view(p, { testPrefix: p.testPrefix, transports: p.transports, rooms, online, peakDay, days, tickets, refusedWhy, room: { profile: p.defaults.profile, sendHz: p.defaults.sendHz ?? 30, p2pMax: p.defaults.p2pMax } });
}

/** May this actor see this project? (Room details and kicks check it before going to the node.) */
export function readable(a: Actor, id: string) { return mine(a, id); }
