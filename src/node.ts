import { errorBody, errorStatus, type ErrorCode } from './errors.ts';
// A Hawkes Net relay node (docs/net.md "Hosting"): one process that takes WebSocket connections for rooms and, on a
// machine with more than one core, hands each socket to the worker process that owns its room (rooms are pinned to a
// worker by a hash of the room key, so a room is always in one place and workers never talk to each other).
//
// It reports to the Hawkes Net service (src/hub.ts): a heartbeat every 10 s (players, rooms, load), rooms opening and closing (the directory), and usage
// every 60 s (player-seconds and bytes per project). The service is never in the data path: if it is unreachable, rooms keep
// running and only new tickets wait.
//
// Two ways to run it:
//   standalone   node src/node.ts   (another relay box: NET_PORT, NET_NODE_ID, NET_PUBLIC_URL, NET_GEN_URL = the Hawkes Net service, NET_GEN_KEY)
//   in the service   src/service.ts startNode: the service's own node, with the in-process link (src/hub.ts)
import crypto from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Duplex } from 'node:stream';
import { Rooms, type RoomEvent } from './rooms.ts';
import { importPublic, peekToken, peekResume, type PublicKeys } from './tickets.ts';
import { refuse } from './ws.ts';
import { Lag } from './lag.ts';
import { VERSION } from '../sdk/js/hawkes-net-core.mjs';

export type NodeRecord = { id: string; url: string; adminUrl: string | null; region: string; status: 'up' | 'draining'; players: number; capacity: number; load: number; rooms: number; version: string; workers: number; embedded: boolean };
export type UsageRow = { project: string; transport: 'p2p' | 'relay'; test: boolean; playerSeconds: number; bytesOut: number; bytesIn: number; peakRooms: number; peakPlayers: number; skipped: number; slowDrops: number; refused: { full: number; limit: number; ticket: number } };

/** How a node talks to the Hawkes Net service: over HTTP (another relay box) or directly (the service's own node). */
export type GenLink = {
  keys(): Promise<{ kid: string; pub: string }[]>;
  heartbeat(rec: NodeRecord): Promise<void>;
  room(ev: RoomEvent & { node: string }): Promise<void>;
  usage(report: { node: string; from: number; to: number; rows: UsageRow[] }): Promise<void>;
};

export function httpLink(genUrl: string, key: string): GenLink {
  const base = genUrl.replace(/\/+$/, '');
  const call = async (route: string, body?: unknown) => {
    const r = await fetch(`${base}${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Hawkes-Client': `net-node/${VERSION}` }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`Gen ${route}: ${r.status} ${(await r.text()).slice(0, 200)}`);
    return r.json() as Promise<any>;
  };
  return {
    keys: async () => (await call('/v1/net/keys')).keys,
    heartbeat: async (rec) => { await call('/v1/net/nodes/heartbeat', rec); },
    room: async (ev) => { await call('/v1/net/nodes/room', ev); },
    usage: async (rep) => { await call('/v1/net/usage', rep); },
  };
}

const roomKeyOf = (url: URL) => {
  const t = url.searchParams.get('t');
  if (t) { const p = peekToken<{ prj: string; room: string }>(t); return p ? `${p.prj}/${p.room}` : null; }
  const r = url.searchParams.get('r');
  if (r) { const p = peekResume(r); return p ? `${p.prj}/${p.room}` : null; }
  return null;
};
const hash = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };

type Worker = { proc: ChildProcess; summary: any; pending: Map<string, (v: any) => void>; alive: boolean };

export class NetNode {
  rooms: Rooms | null = null;
  workers: Worker[] = [];
  private keys: PublicKeys = new Map();
  private rawKeys: { kid: string; pub: string }[] = [];
  private timers: ReturnType<typeof setInterval>[] = [];
  private lag = new Lag();
  private usageFrom = Date.now();
  private draining = false;
  private stopped = false;
  readonly secret = crypto.randomBytes(32);
  private cpu = process.cpuUsage();
  private cpuAt = Date.now();
  load = 0;

  o: { id: string; url: string; adminUrl?: string | null; region?: string; capacity?: number; workers?: number; link: GenLink; embedded?: boolean; usageMs?: number; log?: (s: string) => void };
  constructor(o: NetNode['o']) { this.o = o; }

  private log(s: string) { (this.o.log ?? ((x) => console.log(`[net] ${x}`)))(s); }

  async start() {
    this.lag.start();
    await this.refreshKeys().catch((e) => this.log(`keys: ${e.message} (retrying)`));
    const n = Math.max(0, this.o.workers ?? 0);
    if (n === 0) {
      this.rooms = new Rooms({ node: this.o.id, secret: this.secret, onRoom: (e) => this.onRoom(e), log: this.o.log });
      this.rooms.keys = this.keys;
      this.rooms.start();
    } else {
      for (let i = 0; i < n; i++) this.workers.push(this.spawn(i));
    }
    this.timers.push(setInterval(() => void this.refreshKeys().catch(() => {}), 60_000));
    this.timers.push(setInterval(() => void this.beat().catch((e) => this.log(`heartbeat: ${e.message}`)), 10_000));
    this.timers.push(setInterval(() => void this.reportUsage().catch((e) => this.log(`usage: ${e.message}`)), this.o.usageMs ?? 60_000));
    for (const t of this.timers) t.unref?.();
    void this.beat().catch(() => {});
    return this;
  }

  private spawn(i: number): Worker {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'worker.ts');
    const proc = fork(file, [], { execArgv: ['--disable-warning=ExperimentalWarning'], env: { ...process.env, NET_NODE_ID: this.o.id, NET_SECRET: this.secret.toString('base64'), NET_WORKER: String(i) }, serialization: 'json' });
    const w: Worker = { proc, summary: null, pending: new Map(), alive: true };
    proc.on('message', (m: any) => {
      if (m?.t === 'room') this.onRoom(m.e);
      else if (m?.t === 'reply') { const f = w.pending.get(m.id); if (f) { w.pending.delete(m.id); f(m.v); } }
      else if (m?.t === 'log') this.log(`w${i}: ${m.s}`);
    });
    proc.on('exit', (code) => {
      w.alive = false;
      this.log(`worker ${i} exited (${code}); its rooms' players reconnect`);
      if (!this.draining && !this.stopped) setTimeout(() => { if (!this.stopped) this.workers[i] = this.spawn(i); }, 1000).unref?.();
    });
    proc.send({ t: 'keys', keys: this.rawKeys });
    return w;
  }
  private ask(w: Worker, msg: any, ms = 2000): Promise<any> {
    return new Promise((resolve) => {
      if (!w.alive) return resolve(null);
      const id = crypto.randomBytes(6).toString('hex');
      const t = setTimeout(() => { w.pending.delete(id); resolve(null); }, ms);
      w.pending.set(id, (v) => { clearTimeout(t); resolve(v); });
      try { w.proc.send({ ...msg, id }); } catch { clearTimeout(t); resolve(null); }
    });
  }

  private async refreshKeys() {
    const list = await this.o.link.keys();
    this.rawKeys = list;
    this.keys.clear();
    for (const k of list) { try { this.keys.set(k.kid, importPublic(k.pub)); } catch {} }
    for (const w of this.workers) if (w.alive) w.proc.send({ t: 'keys', keys: list });
  }

  /** A WebSocket upgrade (the caller already matched the path). */
  upgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer) {
    const url = new URL(req.url ?? '/', 'http://node');
    if (this.draining) return refuse(socket, 'node_draining', 'This node is draining; ask for a new ticket');
    if (!this.workers.length) return this.rooms!.upgrade(req.headers, url, socket, head);
    const key = roomKeyOf(url);
    if (!key) return refuse(socket, 'ws_ticket_required', 'A ticket (t=) or resume token (r=) is needed');
    const w = this.workers[hash(key) % this.workers.length];
    if (!w.alive) return refuse(socket, 'node_restarting', 'Restarting; try again in a second');
    // The socket goes to the worker that owns the room; this process forgets it.
    (socket as any).pause?.();
    w.proc.send({ t: 'up', headers: req.headers, url: url.pathname + url.search, head: head.length ? head.toString('base64') : '' }, socket as any, { keepOpen: false } as any, (err) => { if (err) { try { socket.destroy(); } catch {} } });
  }

  /** Gen's publish for a room this node holds (world edits saved by a server, server events). */
  async publish(token: string, body: any) {
    if (!this.workers.length) return this.rooms!.publish(token, body);
    const p = peekToken<{ prj: string; room: string }>(token);
    if (!p) return { ok: false, status: 400, code: 'publish_token_bad', error: 'Bad token' };
    const w = this.workers[hash(`${p.prj}/${p.room}`) % this.workers.length];
    return (await this.ask(w, { t: 'publish', token, body })) ?? { ok: false, status: 503, code: 'node_not_answering', error: 'Worker not answering' };
  }

  async summary() {
    if (!this.workers.length) return this.rooms!.summary();
    const parts = await Promise.all(this.workers.map((w) => this.ask(w, { t: 'summary' })));
    const out: any = { rooms: 0, relayRooms: 0, p2pRooms: 0, players: 0, refusedTicket: 0, refusedFull: 0, slowDrops: 0, migrations: 0, joins: 0, workers: [] };
    for (const p of parts) { if (!p) continue; for (const k of Object.keys(out)) if (typeof out[k] === 'number') out[k] += p[k] ?? 0; out.workers.push({ rooms: p.rooms, players: p.players, lagP99: p.lagP99, lagMax: p.lagMax, cpu: p.cpu }); }
    return out;
  }
  async stats() {
    const s = await this.summary();
    const lag = this.lag.read();
    return { node: this.o.id, version: VERSION, status: this.draining ? 'draining' : 'up', url: this.o.url, workers: this.workers.length, load: this.load, lagMs: lag, mem: process.memoryUsage().rss, ...s };
  }

  private async beat() {
    const s = await this.summary();
    const now = Date.now();
    const cpu = process.cpuUsage(this.cpu);
    const busy = (cpu.user + cpu.system) / 1000 / Math.max(1, now - this.cpuAt);
    this.cpu = process.cpuUsage(); this.cpuAt = now;
    const workerCpu = (s.workers ?? []).reduce((m: number, w: any) => Math.max(m, w.cpu ?? 0), 0);
    this.load = Math.round(Math.max(busy, workerCpu) * 1000) / 1000;
    await this.o.link.heartbeat({
      id: this.o.id, url: this.o.url, adminUrl: this.o.adminUrl ?? null, region: this.o.region ?? 'us-east-1', status: this.draining ? 'draining' : 'up',
      players: s.players, capacity: this.o.capacity ?? 1000, load: this.load, rooms: s.rooms, version: VERSION, workers: this.workers.length, embedded: Boolean(this.o.embedded),
    });
  }
  private onRoom(e: RoomEvent) { void this.o.link.room({ ...e, node: this.o.id }).catch((err) => this.log(`room event: ${err.message}`)); }
  private async reportUsage() {
    const to = Date.now();
    let rows: UsageRow[] = [];
    if (!this.workers.length) rows = this.rooms!.takeUsage();
    else for (const w of this.workers) rows.push(...((await this.ask(w, { t: 'usage' })) ?? []));
    const from = this.usageFrom;
    this.usageFrom = to;
    if (rows.length) await this.o.link.usage({ node: this.o.id, from, to, rows });
  }

  /** Stops taking players and tells everyone to move; resolves when the rooms are empty or after `ms`. */
  async drain(ms = 10_000) {
    this.draining = true;
    if (this.rooms) this.rooms.drain();
    for (const w of this.workers) if (w.alive) w.proc.send({ t: 'drain' });
    await this.beat().catch(() => {});
    const until = Date.now() + ms;
    while (Date.now() < until && ((await this.summary()).players ?? 0) > 0) await new Promise((r) => setTimeout(r, 250));
    await this.reportUsage().catch(() => {});
  }
  stop() {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.rooms?.stop();
    for (const w of this.workers) { w.alive = false; try { w.proc.disconnect(); } catch {} try { w.proc.kill(); } catch {} w.proc.unref(); }
    this.lag.stop();
  }

  /** The node's own HTTP routes: /healthz, /stats, POST /publish (Gen's world edits and events, a signed token). */
  async http(req: http.IncomingMessage, res: http.ServerResponse, route: string) {
    const send = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
    const fail = (code: ErrorCode, message?: string) => send(errorStatus(code), errorBody(code, message));
    if (route.endsWith('/healthz')) return send(this.draining ? 503 : 200, { ok: !this.draining, node: this.o.id, version: VERSION });
    if (route.endsWith('/stats')) return send(200, await this.stats());
    if (route.endsWith('/publish') && req.method === 'POST') {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const c of req) { size += c.length; if (size > 1024 * 1024) return fail('body_too_large', 'Too big'); chunks.push(c); }
      let body: any = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return fail('bad_json', 'Not JSON'); }
      const token = String(req.headers.authorization ?? '').replace(/^Bearer\s+/, '');
      const r: any = await this.publish(token, body);
      return r.ok ? send(200, r) : fail(r.code ?? 'publish_refused', r.error);
    }
    return fail('not_found');
  }
}

// ------------------------------------------------------------------ standalone: a relay box
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const env = (k: string, d = '') => process.env[k] ?? d;
  const port = Number(env('NET_PORT', '8443'));
  const id = env('NET_NODE_ID', `n-${os.hostname()}`);
  const genUrl = env('NET_GEN_URL', 'https://hawkesgen.ai');
  const key = env('NET_GEN_KEY');
  if (!key) { console.error('NET_GEN_KEY is required (a Gen API key with the project "hawkesnet")'); process.exit(1); }
  const node = new NetNode({
    id, url: env('NET_PUBLIC_URL', `ws://localhost:${port}/v3`), adminUrl: env('NET_ADMIN_URL') || null, region: env('NET_REGION', 'us-east-1'),
    capacity: Number(env('NET_CAPACITY', '2000')), workers: Number(env('NET_WORKERS', String(Math.max(1, os.availableParallelism() - 0)))), link: httpLink(genUrl, key),
  });
  await node.start();
  const server = http.createServer((req, res) => {
    const route = new URL(req.url ?? '/', 'http://x').pathname;
    node.http(req, res, route).catch((e) => { if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(errorBody('internal'))); });
  });
  server.on('upgrade', (req, socket, head) => {
    const route = new URL(req.url ?? '/', 'http://x').pathname;
    if (route !== '/v3' && route !== '/v1/net/ws') return refuse(socket, 'not_found');
    node.upgrade(req, socket, head);
  });
  server.keepAliveTimeout = 75_000;
  server.listen(port, env('NET_HOST', '0.0.0.0'), () => console.log(`[net] node ${id} on :${port} (${node.workers.length} workers)`));
  const leave = async () => { console.log('[net] draining'); await node.drain(8000); node.stop(); process.exit(0); };
  process.on('SIGTERM', () => void leave());
  process.on('SIGINT', () => void leave());
  process.on('uncaughtException', (e) => console.error('[net] uncaught:', e));
}
