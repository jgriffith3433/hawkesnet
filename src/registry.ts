// Which projects use Hawkes Net and how (docs/net.md "Projects and accounts"). A project is owned by a hawkesgen.com
// account (its Gen project, usr_...) and kept by the service (net_projects: name, sites, peer to peer on or off, room
// size, the account's tier), made and changed through the portal. Hawkes's own games also have an entry in
// projects.json (re-read when it changes: the room shapes, interest tiers and limits their code depends on), under
// the stored row. Nothing is anonymous: a ticket comes from a project's own sites or from a key that may act for it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_LIMITS, DEFAULT_INTEREST } from '../sdk/js/hawkes-net-core.mjs';
import { trustLocalhost } from './store.ts';

export type RoomConfig = { topology: 'star' | 'pair'; profile: 'light' | 'medium' | 'heavy'; maxPlayers: number; p2pMax: number; interest: any; quant?: Record<string, number>; sendHz?: number };
export type Limits = { rooms: number; playersPerRoom: number; players: number; downBytesPerSec: number; upBytesPerSec: number; msgsPerSec: number; innerPerSec: number; messageBytes: number; ents: number; states: number; egressBytesPerSec: number; monthlyBytes: number };
export type Tier = 'free' | 'paid' | 'hawkes';
export type NetProject = {
  id: string; name: string; origins: string[]; keyProjects: string[]; transports: ('p2p' | 'relay')[]; signal: string;
  defaults: RoomConfig; limits: Limits; testPrefix: string;
  /** Known: in the file or the service's own projects (an unknown id gets nothing). */
  listed: boolean;
  /** In projects.json: one of Hawkes's games (its file settings can't be changed from the dashboard). */
  hawkes: boolean;
  /** The account that owns it (its Gen project, usr_...), null for one of Hawkes's games nobody has taken yet. */
  owner: string | null;
  tier: Tier;
  /** The account turned peer to peer on (off by default: every room on the relay). */
  p2p: boolean;
};

/** A project as the service keeps it (net_projects). */
export type ProjectRow = { id: string; owner: string; name: string; origins: string[] | null; p2p: boolean; maxPlayers: number | null; tier: Tier; createdAt: number; updatedAt: number };
let rowOf: ((id: string) => ProjectRow | null) | null = null;
export function useProjectRows(fn: ((id: string) => ProjectRow | null) | null) { rowOf = fn; }

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'projects.json');
const BASE_LIMITS: Limits = { rooms: 200, players: 2000, egressBytesPerSec: 5 * 1024 * 1024, monthlyBytes: 5e12, ...DEFAULT_LIMITS } as Limits;
const BASE_CONFIG: RoomConfig = { topology: 'star', profile: 'medium', maxPlayers: 64, p2pMax: 8, interest: DEFAULT_INTEREST };
/** An account that hasn't paid: enough to build and test a game, not to run one (the relay's bytes cost us). */
export const FREE_LIMITS = { rooms: 3, players: 16, playersPerRoom: 8 };

let cache: { mtime: number; data: any } | null = null;
function read(file = FILE) {
  let mtime = 0;
  try { mtime = fs.statSync(file).mtimeMs; } catch { return { defaults: {}, projects: {} }; }
  if (cache && cache.mtime === mtime) return cache.data;
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  cache = { mtime, data };
  return data;
}

const clean = (o: string) => String(o).replace(/\/+$/, '').toLowerCase();
/** A project's settings: the service's row over its file entry over the file's defaults over the built-in ones. */
export function netProject(id: string): NetProject {
  const raw = read();
  const d = raw.defaults ?? {};
  const p = raw.projects?.[id];
  const r = rowOf?.(id) ?? null;
  const pick = (k: string) => (p && p[k] !== undefined ? p[k] : d[k]);
  const fileTransports: ('p2p' | 'relay')[] = (Array.isArray(pick('transports')) ? pick('transports') : ['relay']).filter((t: string) => t === 'p2p' || t === 'relay');
  // Peer to peer only where it was turned on: the account's switch, else the file (the demo).
  const p2p = r ? r.p2p : fileTransports.includes('p2p');
  const transports: ('p2p' | 'relay')[] = r ? (p2p ? ['p2p', 'relay'] : ['relay']) : fileTransports;
  const tier: Tier = p ? 'hawkes' : r?.tier ?? 'free';
  const limits: Limits = { ...BASE_LIMITS, ...(d.limits ?? {}), ...(p?.limits ?? {}), ...(tier === 'free' ? FREE_LIMITS : {}) };
  const defaults: RoomConfig = { ...BASE_CONFIG, ...(d.defaults ?? {}), ...(p?.defaults ?? {}) };
  if (r?.maxPlayers) defaults.maxPlayers = Math.max(1, Math.min(r.maxPlayers, limits.playersPerRoom));
  return {
    id,
    name: String(r?.name ?? p?.name ?? id),
    origins: [...(r && r.origins ? r.origins : Array.isArray(pick('origins')) ? pick('origins') : [])].map(clean),
    keyProjects: Array.isArray(pick('keyProjects')) ? pick('keyProjects').map(String) : [],
    transports,
    signal: String(pick('signal') ?? 'hawkes'),
    defaults,
    limits,
    testPrefix: String(pick('testPrefix') ?? 't-'),
    listed: Boolean(p) || Boolean(r),
    hawkes: Boolean(p),
    owner: r?.owner ?? null,
    tier,
    p2p,
  };
}
/** Hawkes's own games (projects.json). */
export const listedProjects = () => Object.keys(read().projects ?? {});

/** May this origin ask for player tickets with no key? The project's own sites; localhost for its test rooms (a
 *  developer at Build And Run, Studio's playtests), where NET_TRUST_LOCALHOST=1 (a developer's machine, never the box) any
 *  room. An Origin header is only a browser's word: anything outside a browser can send any, so the door gives only
 *  player tickets, limited per address, and a project whose rooms need more (the portal's editor rooms) lists no sites and
 *  asks with its key. */
export function originAllowed(p: NetProject, origin: string, room = '') {
  const o = clean(origin);
  if (!o || !p.listed) return false;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(o)) return trustLocalhost() || ((p.origins.length > 0 || p.owner !== null) && room.startsWith(p.testPrefix));
  return p.origins.includes(o);
}

const NUM = (v: unknown, lo: number, hi: number, d: number) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : d; };
/** A room's config from a request, clamped to the project's (a game can ask for less, never more). */
export function roomConfig(p: NetProject, asked: any = {}): RoomConfig {
  const d = p.defaults;
  const a = asked && typeof asked === 'object' ? asked : {};
  const maxPlayers = NUM(a.maxPlayers, 1, Math.min(p.limits.playersPerRoom, 1000), Math.min(d.maxPlayers, p.limits.playersPerRoom));
  const topology = a.topology === 'pair' || a.topology === 'star' ? a.topology : d.topology;
  return {
    topology,
    profile: ['light', 'medium', 'heavy'].includes(a.profile) ? a.profile : d.profile,
    maxPlayers: topology === 'pair' ? Math.min(2, maxPlayers) : maxPlayers,
    p2pMax: NUM(a.p2pMax, 1, Math.min(24, maxPlayers), Math.min(d.p2pMax, maxPlayers)),
    interest: a.interest === null ? null : d.interest,
    // How often the relay sends each player a bundle: 30 (every 33 ms, physics worlds) or less for lighter games.
    sendHz: NUM(a.sendHz, 10, 60, Number(d.sendHz) || 30),
    ...(d.quant ? { quant: d.quant } : {}),
  };
}
