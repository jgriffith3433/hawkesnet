// The rooms one relay process holds (docs/net.md "Transport relay"). A room lives in exactly one process; the node's
// primary routes every socket for a room to it. Each room is in one of two modes:
//   p2p    the players' data goes peer to peer (WebRTC, host-star). Every player keeps one socket here for the
//          signal route: SDP/ICE forwarding, who is in the room and who hosts, and a slow carrier of data for a player
//          whose direct link failed. Nearly free: no bundles flow.
//   relay  this process runs the room (the core in sdk/js/hawkes-net-core.mjs) and every player's data goes
//          through it, by interest and within a byte budget.
// A p2p room moves to the relay on the same sockets (nobody reconnects): when it grows past its p2p size, when its
// host leaves, when players can't link, or when the game asks. The host's copy of the world seeds the relay. A room
// never moves back: it stays on the relay until it empties.
import crypto from 'node:crypto';
import * as core from '../sdk/js/hawkes-net-core.mjs';
import { accept, refuse, type Socket, type Headers, type WsMessage } from './ws.ts';
import { verifyToken, SeenIds, resumeToken, checkResume, TICKET_PREFIX, PUBLISH_PREFIX, type PublicKeys } from './tickets.ts';
import type { Duplex } from 'node:stream';

const COLORS = ['#4a9eff', '#a855f7', '#34d399', '#fbbf24', '#ef4444', '#f97316', '#22d3ee', '#ec4899'];
/** How long a dropped player keeps their place (a phone locking, a network blink) before the room lets them go. */
export const GRACE_MS = 15_000;
const IDLE_MS = 20_000;
const PER_IP = 256; // sockets from one address in one process (a school or a phone carrier's shared address still plays)
const RESUME_S = 600; // a resume token lives 10 minutes (the grace is 15 s; a page tries a few times)
const SEED_WAIT_MS = 3000;
const SIG_PER_SEC = 60;
const SIG_BYTES_PER_SEC = 24 * 1024;
const SIG_DATA_BYTES_PER_SEC = 48 * 1024; // the slow carrier: 4 bundles a second of up to 6 KB, base64

export type Payload = {
  v: 1; kid: string; prj: string; room: string; peer: string; ord: number; sub: string; nm: string | null; role: string;
  tr: ('p2p' | 'relay')[]; node?: string; epoch?: number; lim: Record<string, number>; cfg: { topology: string; profile: string; maxPlayers: number; p2pMax: number; interest: any; quant?: any; sendHz?: number };
  iat: number; exp: number; jti: string; want?: 'auto' | 'p2p' | 'relay';
};

type Peer = {
  id: string; ord: number; name: string | null; role: string; sub: string; color: string;
  ws: Socket | null; v: 2 | 3; conn: any | null; away: ReturnType<typeof setTimeout> | null;
  sig: { at: number; n: number; bytes: number; dBytes: number }; linksFailed: number; bytesIn: number; bytesOut: number; joined: number;
};
export type Room = {
  key: string; project: string; name: string; mode: 'p2p' | 'relay'; want: 'auto' | 'p2p' | 'relay'; allowRelay: boolean;
  cfg: Payload['cfg']; lim: Record<string, number>; dirEpoch: number; epoch: number;
  peers: Map<string, Peer>; core: any | null; host: string | null; test: boolean;
  migrating: { epoch: number; why: string; until: number } | null; failed: Map<string, number>;
  opened: number; peak: number; usage: Map<string, UsageAcc>; nextFlush: number; reported: number;
};
type UsageAcc = { project: string; transport: 'p2p' | 'relay'; test: boolean; playerSeconds: number; bytesOut: number; bytesIn: number; peakRooms: number; peakPlayers: number; skipped: number; slowDrops: number; refused: { full: number; limit: number; ticket: number } };

export type RoomEvent = { project: string; room: string; epoch: number; event: 'opened' | 'closed' | 'moved' | 'count'; transport: 'p2p' | 'relay'; players: number; at: number };

export class Rooms {
  rooms = new Map<string, Room>();
  keys: PublicKeys = new Map();
  private seen = new SeenIds();
  private byIp = new Map<string, number>();
  private usage = new Map<string, UsageAcc>();
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  draining = false;
  stats = { refusedTicket: 0, refusedFull: 0, slowDrops: 0, migrations: 0, joins: 0 };

  o: { node: string; secret: Buffer; onRoom?: (e: RoomEvent) => void; testPrefix?: string; log?: (s: string) => void };
  constructor(o: Rooms['o']) { this.o = o; }

  private log(s: string) { (this.o.log ?? ((x) => console.log(`[net] ${x}`)))(s); }
  get players() { let n = 0; for (const r of this.rooms.values()) for (const p of r.peers.values()) if (p.ws) n++; return n; }

  start() {
    if (this.flushTimer) return;
    // A fine timer that flushes each room when its turn comes: rooms send at their own rate (cfg.sendHz) and each starts
    // at its own phase, so the work is spread over time instead of every room at once.
    this.flushTimer = setInterval(() => this.flushAll(), 10);
    this.tickTimer = setInterval(() => this.tick(), 1000);
    this.flushTimer.unref?.(); this.tickTimer.unref?.();
  }
  stop() { if (this.flushTimer) clearInterval(this.flushTimer); if (this.tickTimer) clearInterval(this.tickTimer); this.flushTimer = this.tickTimer = null; }

  // ------------------------------------------------------------------ joining
  /**
   * A WebSocket upgrade for /v3 (or Gen's /v1/net/ws). Query: t=<ticket> (a new join) or r=<resume> (coming back),
   * want=auto|p2p|relay, v=3|2 (protocol). Refuses with an HTTP status before the socket exists when it can.
   */
  upgrade(headers: Headers, url: URL, raw: Duplex, head: Uint8Array | null) {
    const now = Date.now();
    if (this.draining) return refuse(raw, 'node_draining', 'This node is draining; ask for a new ticket');
    // Sockets per address in this process (behind a proxy on this machine, the address it forwarded for).
    const remote = String((raw as any).remoteAddress ?? '');
    const fwd = String(headers['x-forwarded-for'] ?? '').split(',').pop()!.trim();
    const local = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
    const ip = local && fwd ? fwd : remote || '?';
    const had = this.byIp.get(ip) ?? 0;
    // (This machine itself, not through the proxy, isn't capped: load tests and Gen's own bots.)
    if (!(local && !fwd) && had >= PER_IP) return refuse(raw, 'connections_limit', 'Too many connections from this address');
    this.byIp.set(ip, had + 1);
    raw.once('close', () => { const n = (this.byIp.get(ip) ?? 1) - 1; if (n > 0) this.byIp.set(ip, n); else this.byIp.delete(ip); });
    const v = url.searchParams.get('v') === '2' ? 2 : 3;
    const resume = url.searchParams.get('r');
    if (resume) {
      const r = checkResume(this.o.secret, resume);
      const room = r && this.rooms.get(`${r.prj}/${r.room}`);
      const peer = room && room.peers.get(r!.peer);
      // Only this instance of the room: one closed and opened again reuses peer ids, and an old token must not take one.
      if (!r || !room || !peer || r.inst !== room.opened) return refuse(raw, 'resume_gone', 'That place in the room is gone; join again');
      const ws = accept(headers, raw, head, { maxMessage: room.lim.messageBytes || 64 * 1024, idleMs: IDLE_MS, protocols: ['hawkes-net.v3', 'hawkes-net.v2'] });
      if (!ws) return;
      return this.attach(room, peer, ws, v, now, true);
    }
    const checked = verifyToken<Payload>(TICKET_PREFIX, url.searchParams.get('t') ?? '', this.keys);
    if (!checked.ok) { this.stats.refusedTicket++; return refuse(raw, 'ticket_refused', `Ticket refused: ${checked.why}`); }
    const t = checked.payload;
    if (t.node && t.node !== this.o.node) { this.stats.refusedTicket++; return refuse(raw, 'ticket_wrong_node', `This ticket is for node ${t.node}`); }
    if (!this.seen.first(t.jti, t.exp)) { this.stats.refusedTicket++; return refuse(raw, 'ticket_used', 'Ticket already used'); }
    const key = `${t.prj}/${t.room}`;
    let room = this.rooms.get(key);
    if (room && t.epoch && t.epoch < room.dirEpoch) return refuse(raw, 'ticket_stale', 'Old ticket for this room; ask for a new one');
    // The room's mode is the ticket's (Gen decided it from the request); a URL can't change it.
    const want = t.want || 'auto';
    if (!room) room = this.open(t, want, now);
    // A peer id is one person: a ticket for an id already here is stale (the directory forgot the room and counted again).
    if (room.peers.has(t.peer)) { if (!room.peers.size) this.close(room); return refuse(raw, 'ticket_stale', 'Old ticket for this room; ask for a new one'); }
    const max = Math.min(room.cfg.maxPlayers || 64, room.lim.playersPerRoom || 64);
    const present = [...room.peers.values()].filter((p) => p.role !== 'spectator').length;
    // A p2p-only room past its p2p size can't grow (the game shards it); 'auto' moves to the relay instead (below).
    const full = (t.role !== 'spectator' && present >= max) || room.peers.size >= max * 2 || (room.mode === 'p2p' && !room.allowRelay && present >= room.cfg.p2pMax);
    const ws = accept(headers, raw, head, { maxMessage: room.lim.messageBytes || 64 * 1024, idleMs: IDLE_MS, protocols: ['hawkes-net.v3', 'hawkes-net.v2'] });
    if (!ws) return;
    if (full) {
      // Accepted only to say why: a browser can't read an HTTP refusal, but it can read a close code.
      this.stats.refusedFull++; this.acc(room).refused.full++;
      if (!room.peers.size) this.close(room);
      return ws.close(4009, 'This room is full');
    }
    const peer: Peer = {
      id: t.peer, ord: t.ord, name: t.nm ? String(t.nm).slice(0, 40) : `Player ${t.ord}`, role: t.role, sub: t.sub,
      color: COLORS[(t.ord - 1) % COLORS.length], ws: null, v, conn: null, away: null, sig: { at: 0, n: 0, bytes: 0, dBytes: 0 }, linksFailed: 0, bytesIn: 0, bytesOut: 0, joined: now,
    };
    room.peers.set(peer.id, peer);
    this.stats.joins++;
    this.attach(room, peer, ws, v, now, false);
    // The directory hears about a newcomer now, not at the next tick: an invitation asked a moment later sees the room open.
    let n = 0;
    for (const p of room.peers.values()) if (p.ws) n++; // (counted as the tick counts)
    if (n !== room.reported) { room.reported = n; this.o.onRoom?.({ project: room.project, room: room.name, epoch: room.dirEpoch, event: 'count', transport: room.mode, players: n, at: now }); }
    // Grown past what one host's uplink should carry: everyone moves to the relay, on these same sockets.
    if (room.mode === 'p2p' && room.allowRelay && room.want === 'auto' && this.present(room) > room.cfg.p2pMax) this.migrate(room, 'room grew', now);
  }

  private open(t: Payload, want: Room['want'], now: number): Room {
    const allowRelay = t.tr.includes('relay');
    // Starts peer to peer unless the game asked for the relay or may only use it.
    const mode: Room['mode'] = (want === 'relay' && allowRelay) || !t.tr.includes('p2p') ? 'relay' : 'p2p';
    const room: Room = {
      key: `${t.prj}/${t.room}`, project: t.prj, name: t.room, mode, want: allowRelay ? want : 'p2p', allowRelay, cfg: t.cfg, lim: t.lim,
      dirEpoch: t.epoch || 1, epoch: 1, peers: new Map(), core: null, host: null, test: Boolean(this.o.testPrefix && t.room.startsWith(this.o.testPrefix)) || t.room.startsWith('t-'),
      migrating: null, failed: new Map(), opened: now, peak: 0, usage: new Map(), nextFlush: now + Math.random() * core.FLUSH_MS, reported: 0,
    };
    if (room.mode === 'relay') room.core = this.newCore(room, now);
    this.rooms.set(room.key, room);
    this.o.onRoom?.({ project: room.project, room: room.name, epoch: room.dirEpoch, event: 'opened', transport: room.mode, players: 0, at: now });
    this.start();
    return room;
  }
  private newCore(room: Room, now: number) {
    const L = room.lim;
    return core.newRoom({
      key: room.key, project: room.project, epoch: room.epoch, now, interest: room.cfg.interest === null ? null : room.cfg.interest || undefined, quant: room.cfg.quant,
      limits: { playersPerRoom: L.playersPerRoom, downBytesPerSec: L.downBytesPerSec, upBytesPerSec: L.upBytesPerSec, msgsPerSec: L.msgsPerSec, innerPerSec: L.innerPerSec, messageBytes: L.messageBytes, ents: L.ents, states: L.states, ...(L.expressPerSec ? { expressPerSec: L.expressPerSec } : {}) },
    });
  }
  private present(room: Room) { let n = 0; for (const p of room.peers.values()) if (p.role !== 'spectator') n++; return n; }
  private lowest(room: Room) { let best: Peer | null = null; for (const p of room.peers.values()) if (p.role !== 'spectator' && p.ws && (!best || p.ord < best.ord)) best = p; return best; }

  /** A socket for a peer: new, or back within its grace (`resumed`). */
  private attach(room: Room, peer: Peer, ws: Socket, v: 2 | 3, now: number, resumed: boolean) {
    if (peer.away) { clearTimeout(peer.away); peer.away = null; }
    if (peer.ws && peer.ws !== ws) { const old = peer.ws; peer.ws = null; old.onClose = () => {}; old.close(4000, 'replaced'); }
    peer.ws = ws;
    peer.v = ws.protocol === 'hawkes-net.v2' ? 2 : v;
    const resume = resumeToken(this.o.secret, { prj: room.project, room: room.name, peer: peer.id, exp: Math.floor(now / 1000) + RESUME_S, epoch: room.epoch, inst: room.opened });
    ws.onMessage = (data) => this.message(room, peer, data);
    ws.onClose = (code) => this.dropped(room, peer, ws, code);
    if (room.mode === 'relay') this.joinCore(room, peer, now, resume, resumed);
    else {
      const was = room.host;
      const low = this.lowest(room);
      room.host = low ? low.id : peer.id;
      this.control(peer, { t: 'hello', mode: 'p2p', you: peer.id, name: peer.name, color: peer.color, host: room.host, peers: this.peerList(room), now, epoch: room.epoch, resume, resumed, cfg: room.cfg, project: room.project, room: room.name }, true);
      if (!resumed) this.toOthers(room, peer.id, { c: 'peer', ev: 'join', peer: this.info(peer) });
      if (room.host !== was) this.toAll(room, { c: 'host', host: room.host, previous: was });
    }
    room.peak = Math.max(room.peak, this.present(room));
  }
  private joinCore(room: Room, peer: Peer, now: number, resume: string, resumed: boolean, extra: Record<string, unknown> = {}) {
    const old = peer.conn;
    const ws = peer.ws!;
    const c = core.newConn(room.core, {
      id: peer.id, ord: peer.ord, name: peer.name, color: peer.color, user: null, role: peer.role, v: peer.v, now,
      send: (f: WsMessage) => { if (ws.open) { peer.bytesOut += typeof f === 'string' ? f.length : f.length; ws.send(f); if (ws.buffered > 2 * 1024 * 1024) { this.stats.slowDrops++; this.acc(room).slowDrops++; ws.close(1013, 'too slow'); } } },
      close: (code: number, why: string) => ws.close(code, why),
    });
    // Reliable messages that came while they were away are theirs still, after the new hello.
    if (old && old !== c) { c.out.rel.push(...old.out.rel.slice(-4000)); }
    peer.conn = c;
    core.join(room.core, c, now, { resume, hello: { mode: 'relay', resumed, cfg: room.cfg, project: room.project, room: room.name, ...extra } });
  }

  // ------------------------------------------------------------------ messages
  private message(room: Room, peer: Peer, data: WsMessage) {
    const now = Date.now();
    const size = typeof data === 'string' ? data.length : data.length;
    peer.bytesIn += size;
    if (room.mode === 'relay' && peer.conn) {
      const ctl = core.receive(room.core, peer.conn, data, now);
      if (ctl) this.controlIn(room, peer, ctl, now);
      return;
    }
    // p2p: only control frames (JSON) come here.
    let m: any = null;
    if (typeof data === 'string') { try { m = JSON.parse(data); } catch { return; } }
    else { const p = core.peek(data); if (p.kind === 'control' || p.kind === 'hello') m = p.value; else return; }
    if (now - peer.sig.at > 1000) { peer.sig.at = now; peer.sig.n = 0; peer.sig.bytes = 0; peer.sig.dBytes = 0; }
    // The slow data carrier has its own byte budget: it must never crowd out offers, answers and ICE (a dropped answer
    // leaves the player's WebRTC link at ice 'new' until the room gives up on peer to peer).
    if (m && m.c === 'sig' && m.kind === 'data') { if ((peer.sig.dBytes += size) > SIG_DATA_BYTES_PER_SEC) return; }
    else if (++peer.sig.n > SIG_PER_SEC || (peer.sig.bytes += size) > SIG_BYTES_PER_SEC) return;
    if (m && typeof m === 'object') this.controlIn(room, peer, m, now);
  }

  private controlIn(room: Room, peer: Peer, m: any, now: number) {
    switch (m.c) {
      case 'bye': return this.leave(room, peer, 'left');
      case 'ping': return this.control(peer, { c: 'pong', at: m.at, now });
      case 'sig': {
        // Signalling between two players of a p2p room (offer, answer, ice), and the slow data carrier ('data').
        if (room.mode !== 'p2p') return;
        const to = room.peers.get(String(m.to));
        if (!to || !to.ws) return;
        const body = typeof m.body === 'string' ? m.body.slice(0, 16 * 1024) : '';
        return this.control(to, { c: 'sig', from: peer.id, kind: String(m.kind).slice(0, 12), body });
      }
      case 'migrate': {
        if (m.step === 'propose') {
          const why = ['links failed', 'host overloaded', 'game asked'].includes(m.why) ? m.why : 'game asked';
          if (peer.role === 'spectator') return;
          // The game and an overloaded host decide through the host; a player can only say its links failed.
          if (why !== 'links failed' && room.host !== peer.id) return;
          if (why === 'links failed') {
            room.failed.set(peer.id, now);
            for (const [k, at] of room.failed) if (now - at > 10_000 || !room.peers.has(k)) room.failed.delete(k);
            const others = this.present(room) - 1;
            if (room.failed.size < Math.min(2, Math.max(1, others))) return;
          }
          return this.migrate(room, why, now);
        }
        return;
      }
      case 'seed': {
        // The host's copy of the world, for the relay that takes over.
        if (room.migrating && peer.id === room.host && m.epoch === room.migrating.epoch) this.finishMigration(room, m.snap, now);
        return;
      }
    }
  }

  // ------------------------------------------------------------------ moving to the relay
  migrate(room: Room, why: string, now: number) {
    if (room.mode !== 'p2p' || room.migrating || !room.allowRelay) return;
    const host = room.host ? room.peers.get(room.host) : null;
    room.migrating = { epoch: room.epoch + 1, why, until: now + SEED_WAIT_MS };
    this.stats.migrations++;
    this.log(`${room.key}: moving to the relay (${why})`);
    if (host && host.ws) this.control(host, { c: 'migrate', step: 'seed', epoch: room.migrating.epoch, why });
    else this.finishMigration(room, null, now);
  }
  private finishMigration(room: Room, snap: any, now: number) {
    if (!room.migrating) return;
    const why = room.migrating.why;
    room.epoch = room.migrating.epoch;
    room.migrating = null;
    room.mode = 'relay';
    room.core = this.newCore(room, now);
    room.core.host = null;
    if (snap) core.seed(room.core, { ...snap, epoch: room.epoch });
    // Everyone's socket becomes a relay connection, oldest first so the host stays who it was.
    const order = [...room.peers.values()].filter((p) => p.ws).sort((a, b) => a.ord - b.ord);
    for (const p of order) this.joinCore(room, p, now, resumeToken(this.o.secret, { prj: room.project, room: room.name, peer: p.id, exp: Math.floor(now / 1000) + RESUME_S, epoch: room.epoch, inst: room.opened }), false, { migrated: true, why });
    this.o.onRoom?.({ project: room.project, room: room.name, epoch: room.dirEpoch, event: 'moved', transport: 'relay', players: this.present(room), at: now });
  }

  // ------------------------------------------------------------------ leaving
  private dropped(room: Room, peer: Peer, ws: Socket, code: number) {
    if (peer.ws !== ws) return;
    peer.ws = null;
    // Relay: their connection stops being flushed, so what is said meanwhile waits for them (joinCore hands it over).
    if (room.mode === 'relay' && peer.conn) peer.conn.slow = true;
    // Kept a moment: a phone that locked or a network that blinked comes back with its resume token.
    peer.away = setTimeout(() => this.leave(room, peer, 'timeout'), GRACE_MS);
    peer.away.unref?.();
    if (room.mode === 'p2p' && room.host === peer.id) {
      // The host's page is gone (or sleeping): a room of two or more moves to the relay, which keeps playing.
      const others = [...room.peers.values()].filter((p) => p !== peer && p.ws && p.role !== 'spectator');
      if (others.length >= 2 && room.allowRelay && room.want === 'auto') this.migrate(room, 'host left', Date.now());
    }
  }
  leave(room: Room, peer: Peer, why: 'left' | 'timeout' | 'kicked') {
    if (room.peers.get(peer.id) !== peer) return;
    if (peer.away) { clearTimeout(peer.away); peer.away = null; }
    room.peers.delete(peer.id);
    const ws = peer.ws;
    peer.ws = null;
    // 4003: put out of the room (the SDK leaves and does not come back on its own); 1000 otherwise.
    if (ws && ws.open) { ws.onClose = () => {}; ws.close(why === 'kicked' ? 4003 : 1000, why); }
    if (room.mode === 'relay' && peer.conn) core.leave(room.core, peer.conn, why);
    else {
      this.toAll(room, { c: 'peer', ev: 'leave', peer: this.info(peer), why });
      if (room.host === peer.id) {
        const next = this.lowest(room);
        const was = room.host;
        room.host = next?.id ?? null;
        if (next) {
          const others = [...room.peers.values()].filter((p) => p.ws && p.role !== 'spectator');
          if (others.length >= 2 && room.allowRelay && room.want === 'auto') this.migrate(room, 'host left', Date.now());
          else this.toAll(room, { c: 'host', host: room.host, previous: was });
        }
      }
    }
    if (!room.peers.size) this.close(room);
  }
  private close(room: Room) {
    if (this.rooms.get(room.key) !== room) return;
    this.rooms.delete(room.key);
    this.o.onRoom?.({ project: room.project, room: room.name, epoch: room.dirEpoch, event: 'closed', transport: room.mode, players: 0, at: Date.now() });
  }

  // ------------------------------------------------------------------ server-side sends (Gen's publish)
  /** A publish token from Gen (hp1, signed with Gen's service key) and what it carries: world edits or an event. */
  publish(token: string, body: { ops?: unknown[]; by?: string; fx?: string | null; event?: { name: string; data: unknown }; except?: string | null; kick?: { sub: string | null; peer?: string | null }; peek?: boolean }) {
    const checked = verifyToken<{ kid: string; exp: number; prj: string; room: string; jti: string }>(PUBLISH_PREFIX, token, this.keys);
    if (!checked.ok) return { ok: false, status: 401, code: 'publish_refused', error: `Publish refused: ${checked.why}` };
    const p = checked.payload;
    if (!this.seen.first(`pub:${p.jti}`, p.exp)) return { ok: false, status: 401, code: 'publish_refused', error: 'Publish token already used' };
    const room = this.rooms.get(`${p.prj}/${p.room}`);
    if (!room) return { ok: true, delivered: 0, players: [] };
    // Who is here (the project's dashboard): nothing is sent to the room.
    if (body.peek) {
      const players = [...room.peers.values()].sort((a, b) => a.ord - b.ord).map((x) => ({ peer: x.id, name: x.name, ord: x.ord, role: x.role, sub: x.sub, joined: x.joined, connected: Boolean(x.ws), bytesIn: x.bytesIn, bytesOut: x.bytesOut }));
      return { ok: true, delivered: 0, transport: room.mode, host: room.host ?? (players[0]?.peer ?? null), players };
    }
    // Put people out: everyone, everyone joined as one `sub` (the portal: a removed member, a world an admin closed), or one peer.
    if (body.kick) {
      let kicked = 0;
      for (const peer of [...room.peers.values()]) if ((body.kick.peer ? peer.id === body.kick.peer : !body.kick.sub || peer.sub === body.kick.sub)) { this.leave(room, peer, 'kicked'); kicked++; }
      return { ok: true, delivered: 0, kicked };
    }
    const n = [...room.peers.values()].filter((x) => x.ws).length;
    if (room.mode === 'relay') {
      if (Array.isArray(body.ops) && body.ops.length) core.ops(room.core, body.ops.slice(0, 500), String(body.by ?? 'server'), body.fx ?? null, body.except ?? undefined);
      if (body.event && typeof body.event.name === 'string') core.event(room.core, body.event.name.slice(0, 64), body.event.data ?? null);
    } else {
      // A p2p room: the host applies it to its room and forwards; everyone else hears it from the host. Sent to all
      // directly as well, so a player not linked yet still gets it (the SDK applies ops once, by id).
      const msg = { c: 'server', ops: Array.isArray(body.ops) ? body.ops.slice(0, 500) : null, by: body.by ?? 'server', fx: body.fx ?? null, event: body.event ?? null, except: body.except ?? null, id: crypto.randomBytes(6).toString('hex') };
      this.toAll(room, msg);
    }
    return { ok: true, delivered: n };
  }

  // ------------------------------------------------------------------ timers
  private flushAll() {
    const now = Date.now();
    for (const room of this.rooms.values()) {
      if (room.mode !== 'relay' || !room.core || now < room.nextFlush) continue;
      core.flush(room.core, now);
      const every = 1000 / Math.max(10, Math.min(60, Number(room.cfg.sendHz) || 1000 / core.FLUSH_MS));
      room.nextFlush = room.nextFlush + every > now ? room.nextFlush + every : now + every;
    }
  }
  private tick() {
    const now = Date.now();
    for (const room of this.rooms.values()) {
      if (room.migrating && now > room.migrating.until) this.finishMigration(room, null, now); // the host never sent its copy
      const a = this.acc(room);
      let n = 0;
      for (const p of room.peers.values()) {
        if (!p.ws) continue;
        n++;
        a.bytesIn += p.bytesIn; a.bytesOut += p.bytesOut; p.bytesIn = 0; p.bytesOut = 0;
      }
      a.playerSeconds += n;
      a.peakPlayers = Math.max(a.peakPlayers, n);
      // Gen's directory knows how many are in each room (invitations ask whether a room is open and how full).
      if (n !== room.reported) { room.reported = n; this.o.onRoom?.({ project: room.project, room: room.name, epoch: room.dirEpoch, event: 'count', transport: room.mode, players: n, at: now }); }
      if (room.core) { a.skipped += room.core.stats.skipped; room.core.stats.skipped = 0; }
    }
    // Rooms open at once, per project and transport.
    const open = new Map<string, number>();
    for (const room of this.rooms.values()) { const k = `${room.project}|${room.mode}|${room.test ? 1 : 0}`; open.set(k, (open.get(k) ?? 0) + 1); }
    for (const [k, n] of open) { const u = this.usage.get(k); if (u) u.peakRooms = Math.max(u.peakRooms, n); }
  }
  private acc(room: Room): UsageAcc {
    const k = `${room.project}|${room.mode}|${room.test ? 1 : 0}`;
    let u = this.usage.get(k);
    if (!u) { u = { project: room.project, transport: room.mode, test: room.test, playerSeconds: 0, bytesOut: 0, bytesIn: 0, peakRooms: 0, peakPlayers: 0, skipped: 0, slowDrops: 0, refused: { full: 0, limit: 0, ticket: 0 } }; this.usage.set(k, u); }
    return u;
  }
  /** The usage since the last call (docs/net.md "Usage"), for the node's report to Gen. */
  takeUsage() {
    const rows = [...this.usage.values()].filter((u) => u.playerSeconds || u.bytesOut || u.refused.full);
    this.usage.clear();
    return rows;
  }

  /** Stops taking players: every room's players get a pushed draining notice so they skip resume and rejoin with a new ticket. */
  drain() {
    this.draining = true;
    for (const room of this.rooms.values()) {
      for (const p of room.peers.values()) {
        if (!p.ws) continue;
        // SDK 1.4.3+ handles `draining` (skip resume, rejoin at once). Older pages ignore the kind and fall through
        // to the socket close + `_resuming` fallback when the process exits.
        this.control(p, { c: 'draining', why: 'node restart' });
      }
    }
  }

  // ------------------------------------------------------------------ helpers
  private info(p: Peer) { return { c: p.id, name: p.name, color: p.color, ord: p.ord, role: p.role }; }
  private peerList(room: Room) { return [...room.peers.values()].filter((p) => p.ws || p.away).sort((a, b) => a.ord - b.ord).map((p) => this.info(p)); }
  private control(peer: Peer, m: any, hello = false) {
    const ws = peer.ws;
    if (!ws || !ws.open) return;
    const f = peer.v === 3 ? core.jsonFrame(hello ? core.FRAME.hello : core.FRAME.control, m) : JSON.stringify(m);
    peer.bytesOut += typeof f === 'string' ? f.length : f.length;
    ws.send(f);
  }
  private toAll(room: Room, m: any) { for (const p of room.peers.values()) this.control(p, m); }
  private toOthers(room: Room, except: string, m: any) { for (const p of room.peers.values()) if (p.id !== except) this.control(p, m); }

  /** What this process holds, for /stats and the heartbeat. */
  summary() {
    let players = 0, relay = 0, p2p = 0;
    for (const r of this.rooms.values()) { for (const p of r.peers.values()) if (p.ws) players++; if (r.mode === 'relay') relay++; else p2p++; }
    return { rooms: this.rooms.size, relayRooms: relay, p2pRooms: p2p, players, ...this.stats };
  }
}
