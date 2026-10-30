// Hawkes Net: the types every later piece builds against (docs/net.md is the design; this file is its exact shapes).
// Types only: nothing here runs, and nothing imports it yet. The service's routes (src/), the relay service, the page SDK
// (sdk/js/hawkes-net.mjs) and the Unity bridge (com.hawkes.net) each take what they need from here, so a field
// is named once. When a shape changes, change it here and in docs/net.md together.

// ------------------------------------------------------------------ names

/** A project that may use Hawkes Net: the id in projects.json (same ids as analytics/products.json). */
export type ProjectId = string;
/** The room's name inside its project, 1 to 64 of [a-z0-9/_-] ("level-1/n3", "pair-ab12"). With the project it is the room's key. */
export type RoomName = string;
/** A player's id in a room. Gen assigns it with the ticket ("p1", "p2", ...), never the client, and it stays the same on any transport. */
export type PeerId = string;
/** The transports a game can ask for. 'auto' starts as 'p2p' and may move the room to 'relay' without the game noticing. */
export type TransportChoice = 'auto' | 'p2p' | 'relay';
/** The transport a room is on right now. */
export type Transport = 'p2p' | 'relay';
/** Which protocol a connection speaks: 1 = the portal's old per-message JSON, 2 = JSON bundles, 3 = binary (docs/net.md "Protocol v3"). */
export type ProtocolVersion = 1 | 2 | 3;

// ------------------------------------------------------------------ rooms and limits

/** How much a game sends, which decides how many players a host can serve (p2p) and what the byte budget starts at. */
export type Profile = 'light' | 'medium' | 'heavy';

/** The shape of a room's network, fixed when its first ticket is made. */
export interface RoomConfig {
  /** 'star': one host forwards for everyone (p2p) or the relay does. 'pair': two peers, a direct link only (a fighting game). */
  topology: 'star' | 'pair';
  profile: Profile;
  /** Most players at once. The relay enforces it; p2p rooms past `p2pMax` move to the relay or are refused when the project is serverless. */
  maxPlayers: number;
  /** Most players a p2p room holds before 'auto' moves it to the relay. Default 8; a 'light' profile may go to 24. */
  p2pMax: number;
  /** How the quantized values of this room are scaled (a room that keeps to the defaults omits it). */
  quant?: Partial<Quantization>;
  /** What a player is sent depends on where they are (portal tiers); null sends everyone everything. */
  interest: InterestConfig | null;
}

/** Scale of every quantized number on the wire (docs/net.md "Quantization"). */
export interface Quantization {
  /** Metres per unit of a position (default 1/128). */
  posStep: number;
  /** Metres per second per unit of a velocity (default 0.05). */
  velStep: number;
  /** Degrees per second per unit of a spin (default 1). */
  spinStep: number;
  /** Positions are sent as deltas against the last acknowledged copy, and in full at least this often (ms, default 2500). */
  keyframeMs: number;
}

/** Interest by distance, as the portal's tierMs: a thing at d metres waits at most `waitMs` between updates. */
export interface InterestConfig {
  /** [maxDistanceMetres, waitMs for ordinary things, waitMs for important things], nearest first; the last row's distance is Infinity (null in JSON). */
  tiers: [number | null, number, number][];
  /** Players farther than this get a pose five times a second (portal: 120 m). */
  farAvatarM: number;
}

/** What a project may use, from projects.json. A ticket carries the effective values (the lower of the project's and the room's). */
export interface ProjectLimits {
  /** Rooms open at once across the project. */
  rooms: number;
  /** Players in one room (relay). */
  playersPerRoom: number;
  /** Players connected at once across the project. */
  players: number;
  /** Bytes a second sent to one connection, moving things and states (reliable messages always go). Portal: 96 KB. */
  downBytesPerSec: number;
  /** Bytes a second one connection may send. */
  upBytesPerSec: number;
  /** Messages (bundles) a connection may send each second; messages inside bundles. Portal: 90 and 900. */
  msgsPerSec: number;
  innerPerSec: number;
  /** Largest one message (bytes). */
  messageBytes: number;
  /** Moving things and synced states a room remembers. Portal: 4096 and 2048. */
  ents: number;
  states: number;
  /** All the project's relay traffic out, bytes a second (the project's share of a node). */
  egressBytesPerSec: number;
  /** A calendar month's traffic out, bytes. At 80% Gen warns; at 100% new rooms are refused, rooms open keep going. */
  monthlyBytes: number;
}

/** One entry of projects.json. */
export interface ProjectConfig {
  name: string;
  /** Sites that may ask for tickets with no API key (the public door), like analytics/products.json. http://localhost is always allowed. */
  origins: string[];
  /** Transports the project may use. A serverless project lists only 'p2p' and signals through Nostr/trackers (mode 'serverless'). */
  transports: Transport[];
  /** 'hawkes': signalling and the fallback route go through Hawkes Net (needs tickets). 'serverless': public Nostr relays and trackers, no tickets, no relay, no limits. 'hawkes+nostr': Hawkes first, serverless if Gen or a node can't be reached. */
  signal: 'hawkes' | 'serverless' | 'hawkes+nostr';
  defaults: RoomConfig;
  limits: Partial<ProjectLimits>;
  /** Rooms named with this prefix (playtests: "t-<job>") are test rooms: free, never counted in presence or usage totals. */
  testPrefix: string;
}

// ------------------------------------------------------------------ tickets

/** Who is joining. 'bot' and 'test' are playtest peers (docs/net.md "Bots and playtests"); 'spectator' receives and never sends. */
export type TicketRole = 'player' | 'spectator' | 'bot' | 'test';

/** What Gen signs (Ed25519) into a join ticket. The relay holds only the project's public key and checks this offline. */
export interface TicketPayload {
  /** Ticket format version. */
  v: 1;
  /** Key id: which of the project's keys signed it (keys rotate; two are valid at once). */
  kid: string;
  prj: ProjectId;
  room: RoomName;
  /** The peer id assigned to this join. */
  peer: PeerId;
  /** The join order in this room (Gen counts up per room, across transports and nodes): the lowest present `ord` is the host. */
  ord: number;
  /** The player's stable id in the project (a profile key, a random per-tab id), for blocking and usage. Never shown to other players. */
  sub: string;
  /** Display name, already cleaned by the game; null lets the room name them. */
  nm: string | null;
  role: TicketRole;
  /** Transports this ticket may use. */
  tr: Transport[];
  /** The relay node that holds this room (the directory's answer) and its epoch; absent in a p2p-only room. */
  node?: string;
  epoch?: number;
  /** Effective limits. */
  lim: ProjectLimits;
  cfg: RoomConfig;
  /** Issued at and expires at, seconds. A ticket is for connecting (about 90 s); a connected player reconnects with a resume token. */
  iat: number;
  exp: number;
  /** A unique id: a ticket works once per connection, and Gen can deny a jti before it expires. */
  jti: string;
}

/** The ticket on the wire: `hn1.<base64url JSON of TicketPayload>.<base64url Ed25519 signature of "hn1." + that payload>`. */
export type Ticket = string;

// ------------------------------------------------------------------ The service's routes (src/api.ts)

/** POST /v1/net/ticket. With a Gen API key (servers, agents, playtests) or from an allowed origin (a static game's page). */
export interface TicketRequest {
  project: ProjectId;
  room: RoomName;
  /** Default 'player'. 'bot' and 'test' need an API key. */
  role?: TicketRole;
  name?: string;
  /** A stable id for this player; the page makes and keeps one. */
  sub: string;
  transport?: TransportChoice;
  /** The room's shape if this ticket creates the room; otherwise ignored. Missing values come from the project's defaults. */
  config?: Partial<RoomConfig>;
  /** The SDK's version and the protocols it speaks, so Gen can say "reload" or choose v2 for an old page. */
  client: { sdk: string; protocols: ProtocolVersion[] };
}

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface TicketResponse {
  ticket: Ticket;
  peer: PeerId;
  config: RoomConfig;
  /** wss URLs; null where the room has no node (a p2p room starts without one until it is needed, then Gen allocates). */
  relayUrl: string | null;
  /** The signal route: the same node's /v3/signal, or a shared signal node for rooms not on the relay. */
  signalUrl: string | null;
  /** STUN always (Cloudflare, Google); TURN with short-lived credentials only when Gen hands them out (a project that pays for it, a ticket that asked after a link failed). */
  ice: IceServer[];
  expiresAt: number;
  /** Set when the SDK is too old to use this room ('reload'), or the project is over its monthly cap ('capped'). */
  notice?: 'reload' | 'capped';
}

/** The directory: which node holds which room. Gen's table `net_rooms`; nodes learn of a room by a ticket naming them. */
export interface RoomRecord {
  project: ProjectId;
  room: RoomName;
  config: RoomConfig;
  transport: Transport;
  node: string | null;
  /** Raised each time the room moves (p2p to relay, node to node): a ticket or message with an older epoch is refused. */
  epoch: number;
  /** The next `ord` to hand out. */
  nextOrd: number;
  openedAt: number;
  lastSeenAt: number;
}

/** Gen's table `net_nodes`: relay nodes report in every 10 s (POST /v1/net/nodes/heartbeat, with a Gen API key of their own). */
export interface NodeRecord {
  id: string;
  /** The path the CloudFront distribution sends to this node ("/n1"). */
  path: string;
  region: string;
  status: 'up' | 'draining' | 'down';
  /** Players now, the most it will take, and its load 0..1 (the busiest worker's CPU). */
  players: number;
  capacity: number;
  load: number;
  rooms: number;
  version: string;
  beatAt: number;
}

/** POST /v1/net/nodes/room: a node tells Gen a room it holds opened, moved or closed. */
export interface RoomEvent {
  node: string;
  project: ProjectId;
  room: RoomName;
  epoch: number;
  event: 'opened' | 'closed' | 'draining';
  at: number;
}

/** POST /v1/net/usage every 60 s from each node (and POST /v1/net/report from a p2p page when it leaves). Gen files it in `usage`. */
export interface UsageReport {
  node: string | null;
  from: number;
  to: number;
  rows: UsageRow[];
}
export interface UsageRow {
  project: ProjectId;
  transport: Transport;
  test: boolean;
  /** Player-seconds connected in the period. */
  playerSeconds: number;
  /** Bytes sent to players and received from them (relay: counted at the node; p2p: reported by the page, so unverified). */
  bytesOut: number;
  bytesIn: number;
  peakRooms: number;
  peakPlayers: number;
  /** Updates held back by the byte budget, and connections dropped for being too slow, over the period. */
  skipped: number;
  slowDrops: number;
  refused: { full: number; limit: number; ticket: number };
}

// ------------------------------------------------------------------ the client SDK (sdk/js/hawkes-net.mjs)

export type NetStatus = 'connecting' | 'online' | 'reconnecting' | 'offline' | 'refused' | 'closed';

export interface JoinOptions {
  project: ProjectId;
  /** Default 'auto'. */
  transport?: TransportChoice;
  /** A ticket from the game's own server; otherwise the SDK asks Gen (POST /v1/net/ticket). Not needed when the project is serverless. */
  ticket?: Ticket | (() => Promise<TicketResponse>);
  /** Where Gen is (default https://hawkesgen.ai). */
  endpoint?: string;
  name?: string;
  /** A stable id for this player. Default: a random one kept in localStorage. */
  sub?: string;
  role?: TicketRole;
  /** The shape of the room if this join creates it. */
  config?: Partial<RoomConfig>;
  /** Leave the room when the page is hidden for good (pagehide). Default true. */
  leaveOnHide?: boolean;
  /** Give a node/browser WebRTC implementation (bots in Node). Default: the page's RTCPeerConnection. */
  rtc?: unknown;
}

export interface PeerInfo {
  id: PeerId;
  name: string | null;
  role: TicketRole;
  /** Join order in the room (the lowest present is the host). */
  ord: number;
  /** How this peer's data reaches me: through the relay, a direct link (p2p), forwarded by the host, or only over the signal route. */
  route: 'relay' | 'direct' | 'host' | 'signal';
  /** Round trip time to the room's centre (the relay or the host), ms. */
  rttMs: number | null;
  /** The last time anything from them arrived (shared clock, ms). */
  seenAt: number;
}

export interface SendOptions {
  /** Default true: arrives, once, in order. false: the newest wins, older may be dropped (poses). */
  reliable?: boolean;
  /** One peer only; default everyone. */
  to?: PeerId;
  /** Also deliver it to me, in order with the rest (script events that happen for everyone). */
  self?: boolean;
  /** For unreliable sends: a newer one with the same key replaces an older one still waiting (default: the kind). */
  key?: string;
}

export interface MessageMeta {
  /** The sender's stamp on the shared clock, ms. */
  at: number;
  reliable: boolean;
}

/** A buffer of stamped snapshots played back smoothly in the past: the portal's Track (public/play/net.js). */
export interface TrackOptions {
  /** Indexes in a snapshot's values that are x, y, z (extrapolated across short gaps). */
  pos?: [number, number, number];
  /** Indexes of velocity of `pos` (else worked out from the last two snapshots). */
  vel?: [number, number, number] | null;
  /** Turns in radians, slerped. */
  euler?: [number, number, number] | null;
  /** Single angles, lerped the short way round. */
  yaw?: number[];
  /** A quaternion x y z w, slerped. */
  quat?: [number, number, number, number] | null;
  /** The most it carries on past the newest snapshot, ms. */
  maxAhead?: number;
}
export interface Track {
  push(at: number, values: number[], from?: PeerId): void;
  sample(now?: number): number[] | null;
  /** The newest snapshot carried on to `now` by its velocity: where a new authority starts from. */
  latest(now?: number, capMs?: number): number[] | null;
  clear(): void;
  readonly size: number;
}

/** A module's synced state (H.sync.state in the portal). The owner (the host unless `owner` says otherwise) sends the keys that changed. */
export interface StateDef<S extends Record<string, unknown> = Record<string, unknown>> {
  get(): S;
  set(state: S, changed: string[], from: PeerInfo | null, meta: { at: number; from: PeerId | null }): void;
  /** Times a second at most (default 10). */
  rate?: number;
  owner?: 'host' | 'everyone' | (() => boolean);
  /** Where it is, so far players get it less often. */
  where?: () => [number, number, number] | [number, number];
  important?: boolean;
}

export interface NetStats {
  transport: Transport;
  protocol: ProtocolVersion;
  seconds: number;
  upBytes: number;
  downBytes: number;
  upMsgs: number;
  downMsgs: number;
  rttMs: number | null;
  /** How far the shared clock is from this machine's, ms. */
  clockOffsetMs: number;
  /** Times the room changed transport, links that failed and were retried, reconnects. */
  migrations: number;
  linkRetries: number;
  reconnects: number;
}

export interface NetEvents {
  /** Everything about the connection, for a status chip. */
  status: { status: NetStatus; peers: number; transport: Transport };
  'peer:join': PeerInfo;
  'peer:leave': { peer: PeerInfo; reason: 'left' | 'timeout' | 'kicked' | 'lost' };
  /** The host changed. `previous` is null at the start. Same on every transport. */
  host: { host: PeerId; previous: PeerId | null; reason: 'first' | 'host left' | 'older peer' };
  /** Information only: the room moved. Games must not need this. */
  transport: { from: Transport; to: Transport; why: 'room grew' | 'host left' | 'links failed' | 'host overloaded' | 'game asked' };
  /** Joined or rejoined: the room's state as it is now has arrived. */
  ready: { peers: PeerInfo[]; host: PeerId; resumed: boolean };
  /** Something the SDK wants reported (the page sends it to its error capture): a lost room, no route, a refused join. */
  problem: { code: 'relay-lost' | 'no-route' | 'refused' | 'full' | 'ticket' | 'reload' | 'capped'; detail: string };
}

/** What `Net.join()` returns: one room, one connection. There is no module-wide singleton, so one page may join several rooms or run bot peers. */
export interface NetRoom {
  readonly project: ProjectId;
  readonly room: RoomName;
  readonly id: PeerId;
  readonly status: NetStatus;
  readonly transport: Transport;
  readonly peers: ReadonlyMap<PeerId, PeerInfo>;
  readonly host: PeerId | null;
  readonly isHost: boolean;
  readonly config: RoomConfig;

  /** Send a message; `kind` is the game's own name for it (<= 64 chars). `data` is JSON-able, or a Uint8Array for binary. */
  send(kind: string, data?: unknown, options?: SendOptions): void;
  /** Receive messages of a kind ('*' for all). Returns off(). */
  on(kind: string, handler: (data: unknown, from: PeerInfo | null, meta: MessageMeta) => void): () => void;
  /** Connection events (NetEvents). Returns off(). */
  when<K extends keyof NetEvents>(event: K, handler: (value: NetEvents[K]) => void): () => void;

  /** The shared clock in ms (the host's on p2p, the relay's on relay; it does not jump when the room moves). */
  now(): number;

  /** Synced state, snapshot buffers and ownership: the same API as the portal's H.sync. */
  readonly sync: {
    state<S extends Record<string, unknown>>(name: string, def: StateDef<S>): { remove(): void; resend(): void };
    /** Something that must happen once for everyone, decided by the host. */
    action<D>(name: string, run: (data: D, ctx: { authoritative: boolean; from: PeerInfo | null }) => void): (data: D) => void;
    track(options?: TrackOptions): Track;
    /** Say where a thing you simulate is (values as the Track's indexes). Unchanged values are not sent again. */
    push(id: string, values: number[], options?: { important?: boolean }): void;
    /** Things others simulate arrive here, as (id, at, values, from). Returns off(). */
    onThing(handler: (id: string, at: number, values: number[], from: PeerId) => void): () => void;
    claim(id: string, options?: { hold?: boolean; force?: boolean }): boolean;
    release(id: string): void;
    mine(id: string): boolean;
    holder(id: string): PeerId | null;
    /** The host put the world back (reset, rewind): the room forgets the poses it kept. */
    clear(): void;
    onHost(handler: (host: PeerId, previous: PeerId | null) => void): () => void;
  };

  stats(): NetStats;
  /** Leave now (also on pagehide unless `leaveOnHide` is false). */
  leave(reason?: string): Promise<void>;
}

/** The module: sdk/js/hawkes-net.mjs exports `join`, and attaches itself as window.HawkesNet. */
export interface NetModule {
  join(room: RoomName, options: JoinOptions): Promise<NetRoom>;
  /** Version of this SDK and the protocols it speaks. */
  readonly version: string;
  readonly protocols: readonly ProtocolVersion[];
}

// ------------------------------------------------------------------ Protocol v3, decoded (docs/net.md "Protocol v3")

/** First byte of every v3 frame on a socket or data channel. */
export type FrameKind = 'bundle' | 'hello' | 'control';

/** The items inside a bundle. The wire gives each a one-byte tag (docs/net.md has the table); this is their decoded form. */
export type Item =
  | { t: 'me'; peer: PeerId; at: number; pos: [number, number, number]; yaw: number; extra?: Uint8Array }
  | { t: 'xf'; at: number; from: PeerId; things: ThingUpdate[] }
  | { t: 'st'; at: number; from: PeerId; name: string; full: boolean; keys: Record<string, unknown>; where?: [number, number]; important?: boolean }
  | { t: 'ev'; from: PeerId | null; kind: string; data: unknown; seq: number }
  | { t: 'own'; thing: string; owner: PeerId | null; lock: boolean }
  | { t: 'join'; peer: PeerInfo }
  | { t: 'leave'; peer: PeerId; reason: 'left' | 'timeout' | 'kicked' }
  | { t: 'host'; peer: PeerId }
  | { t: 'ops'; ops: unknown[]; by: string; fx: string | null }
  | { t: 'clear' };

/** One moving thing: values are in the order of the portal's mask bits 0..11 (x y z, rx ry rz, vx vy vz, spin x y z), only those whose bit is set. */
export interface ThingUpdate {
  id: string;
  mask: number;
  /** Bit 12 of the mask: driven or held, sent first and often. */
  important: boolean;
  /** Quantized units, already added to the baseline (the decoder does that). */
  values: (number | undefined)[];
}

/** The first message to a connection: what the portal's `hello` says, plus the room's epoch, protocol and clock. */
export interface Hello {
  you: PeerId;
  host: PeerId;
  peers: PeerInfo[];
  owners: Record<string, PeerId>;
  locks: Record<string, PeerId>;
  /** The relay's or host's clock at this moment, ms. */
  now: number;
  epoch: number;
  protocol: ProtocolVersion;
  config: RoomConfig;
  /** A token that lets this connection come back within 30 s with its place, ownership and unsent reliable messages (the page was suspended, the network blinked). */
  resume: string;
  /** Highest reliable sequence the room has seen from this peer: the SDK resends only what is newer. */
  lastSeq: number;
}

/** Control messages (signal route and migration). All opaque to the game. */
export type Control =
  | { c: 'sig'; to: PeerId; kind: 'offer' | 'answer' | 'ice' | 'bye' | 'data'; body: string }
  | { c: 'ack'; seq: number }
  | { c: 'ping'; at: number }
  | { c: 'pong'; at: number; now: number }
  | { c: 'migrate'; step: MigrateStep; epoch: number; to: Transport; node?: string; why: NetEvents['transport']['why'] };

/** The steps of a room moving between transports (docs/net.md "Moving a room"). */
export type MigrateStep = 'propose' | 'prepare' | 'seed' | 'ready' | 'switch' | 'done' | 'abort';

/** Everything a core (the relay's logic, in a node or in a host's page) keeps about a room. It is the whole of what moves in a migration. */
export interface RoomSnapshot {
  project: ProjectId;
  room: RoomName;
  epoch: number;
  config: RoomConfig;
  host: PeerId | null;
  peers: PeerInfo[];
  owners: Record<string, PeerId>;
  locks: Record<string, PeerId>;
  /** The newest values of every moving thing: [id, owner, at, important, ...12 values]. */
  things: [string, PeerId, number, boolean, ...(number | null)[]][];
  /** The newest copy of every synced state. */
  states: { name: string; from: PeerId; at: number; where: [number, number] | null; important: boolean; copy: Record<string, unknown> }[];
  /** Reliable messages sent in the last few seconds, per sender, for the new carrier to deduplicate against. */
  recent: { from: PeerId; seq: number }[];
  clock: { now: number; offsetFromHost: number };
}
