# Hawkes Net: the design

**Status: built (2026-10-25).** The sections after "What is built" are the design it follows; where the build differs, this
section says so and wins. Exact shapes: `src/types.ts` (the design's types) and the code.

## What is built (read this first)

| Piece | Where | What |
|---|---|---|
| Room core + protocol v3 | `sdk/js/hawkes-net-core.mjs` | The room (from the portal's `relay.ts`, same rules), the binary codec (varints, quantized values, deltas, per-stream dictionaries), protocol 2 (JSON) kept, `Track`, snapshot/seed for moving a room. One file: runs in relay nodes and in a p2p host's page. Hot paths use integer slots and keys, not string maps. |
| Relay node | `src/node.ts` (+ `rooms.ts`, `worker.ts`, `ws.ts`, `tickets.ts`, `lag.ts`) | WebSocket server (binary, subprotocol `hawkes-net.v3`), tickets checked offline (Ed25519), rooms pinned to worker processes by a hash of the room key (the primary hands the socket over: `child_process` sendHandle), p2p signal mode, the move to relay on the same sockets, resume tokens (15 s grace), the service's publish, usage, heartbeat, drain. Runs inside the service (`src/hub.ts`) or standalone on another box (`node src/node.ts`). |
| Errors | `src/errors.ts`, `docs/errors.md`, `/docs/errors`, `GET /v1/net/errors` | Every error the service answers with (HTTP routes, the relay's refusals before a socket opens, the node's `/publish`) is `{ code, message, docs, error }` (`error` repeats `message` for older SDKs). `code` is a stable snake_case name from the one catalog in `src/errors.ts`, which also gives its HTTP status, what it means and what to do; `docs` links to its row on `/docs/errors`. `throw new NetError(message, { code })` is how a route refuses; `docs/errors.md` is made from the catalog (`node tools/errors-md.mjs`) and `test/errors.test.ts` fails if a code has no test or the file is stale. Never rename or reuse a code. `NET_DOCS_BASE` changes the host in the links (default `https://net.hawkesgen.ai`). |
| **The Hawkes Net box** | `src/hub.ts`, `deploy/` (setup, units, Caddy, self-deploy), `hawkesstudio/deploy/provision-net.mjs` | **Where it runs (J, 2026-10-25: off the control server).** `https://net.hawkesgen.ai`: one EC2 instance (c7g.large, Graviton, us-east-1, ~$59/month with disk and IPv4, plus $0.09/GB the relay sends) running everything multiplayer in one service: tickets (the public door and keyed), the directory and signing keys in its own data folder (`/srv/hawkes/net-data`), publish, room info, heartbeats, status, the SDK files at `/sdk/hawkes-net@1.mjs`, and the relay with one worker process per vCPU. Gen does two things for it: checks API keys (`GET /v1/net/whoami`, the box keeps an answer a minute) and takes usage once a minute (`POST /v1/net/usage` with the box's `hawkesnet` key). Caddy in front holds the certificate; no CloudFront. The box deploys itself from main (`deploy/pull.mjs`: Hawkes Net's tests (`net/test`, no packages) on a clean copy, restart with drain, health check, back on failure). More relay boxes: run `node src/node.ts` with `NET_GEN_URL=https://net.hawkesgen.ai` and a `hawkesnet` key; the directory prefers them for new rooms. Bigger box: `NET_TYPE` in provision-net.mjs (a stop and start). |
| Gen's part | Gen's `src/netbridge.ts` (the hawkesgen repo) | Three things: `GET /v1/net/whoami` (who an API key is, narrowed by `X-Hawkesgen-Project`: the box checks keys with it), `POST /v1/net/usage` (the box's usage into Gen's usage table, provider `hawkesnet`, relay GB at $0.09, peer to peer and test rooms free), and a 308 to the box for everything else under `/v1/net/` and the SDK files. Gen runs no relay and takes no WebSocket upgrades. |
| The service | `src/service.ts`, `api.ts`, `registry.ts`, `store.ts`, `projects.json` | Tickets (`POST /v1/net/ticket`: a Gen key, or the public door by origin), the directory (`net_nodes`, `net_rooms` in the service's own `net.db`), node heartbeats, room events, usage handed to Gen, publish to a room or every room under `prefix/*` (and kicks), room info, status, the SDK files at `/sdk/hawkes-net@1.mjs`. Settings are `NET_*` environment variables (`store.ts`). |
| Client SDK | `sdk/js/hawkes-net.mjs` (types: `hawkes-net.d.ts`, served at `/sdk/hawkes-net@1.d.ts`) | `lobby({ project, liveHosts, ... })`: the standard layer for web and Babylon games (below), the same as Unity's `HawkesNetLobby`. `join(room, { project, transport, ticket, ... })`: relay (WebSocket), p2p (WebRTC host-star: the host runs the core in its page; players start on the signal route and move onto their link; one stream, one carrier), `auto` (p2p, then the relay without the game noticing), reconnect with resume, exactly-once reliable messages across reconnects and moves, the shared clock (eased, never jumps), `send/on`, `pose/onPose`, `sync.*` (the portal's H.sync: state, action, track, push, onThing, thing, claim, hold, release, mine, holder, clear, onHost), `raw` (an engine with its own logic: hawkesgen.ai's `play/net.js`), stats, sleep handling, `pagehide` leave. |
| Unity WebGL | `sdk/unity/com.hawkes.net` (0.4.0) | The standard Unity layer (below, "Unity: the standard layer"): `HawkesNetLobby` (shared rooms by area, live/beta/playtest names, shards, rejoining, one status), `HawkesNetAvatars` (drop-in avatars), and the room itself, `HawkesNet.Join(room, options)`: `OnReady`, `On(kind, (data, from))` / `On<T>`, `Send` (JSON) and `SendText` (the game's own text, arriving as sent), `Pose(position, yawDegrees, extra)` and `OnPose`/`Poses` (changed poses read once a frame, with their extra values and time), `Peers`, `PeerOrder`, `Order`, `Host`, `Transport`, `OnStatus`, `OnProblem`, `Migrate`, `Leave`, and `HawkesNet.Count(project, rooms, done)` (public counts). The web SDK runs in the page (`HawkesNet.jslib` imports it from `/sdk/hawkes-net@1.mjs`); in the Editor `Join` reports `webgl-only`. Test `test/net-unity.test.ts` runs the jslib against the real SDK and service. Adopted by Sick Of It (its ghosts, on `HawkesNetLobby`) and Yooba Land (its whole MMO). 0.2.1 adds the Avatars sample, a changelog and the outside developer's readme (Asset Store shape); 0.4.0 the background: `Away`, `OnPeerAway`, `HostReason`, `SetAway`, `HawkesNet.RunInBackground`. |
| **Projects and accounts** | `src/projects.ts` (`net_projects`, `net_tickets`, `net_days`, `net_online`), `registry.ts` (`useProjectRows`), `GET/POST/DELETE /v1/net/projects[/<id>[/claim|/rooms/<room>[/kick]]]`; the portal's `/v1/net/projects` (hawkesgenwebsite `src/hnet.ts`); the dashboard `public/dashboard.html` | Every project belongs to a hawkesgen.ai account (below, "Projects and accounts"). Nothing is anonymous: no project, no ticket. Each project's page: players online now and over the day, rooms and who is in them (put a player out), the ticket log (made and refused, and why), 30 days of usage. The Unity package downloads from `/sdk/com.hawkes.net.tgz` (`src/tarball.ts`). |
| **Express frames** | `FRAME.express` in `hawkes-net-core.mjs`; `room.express(bytes, { to })`, `room.onExpress(fn)` in the SDK (and on `lobby()`) | For what can't wait (a fighting game's inputs): binary, unreliable, sent at once and forwarded at once, past the 33 ms bundling on both ends. On a p2p link, a second data channel (`hx`, unordered, no retransmits). Below, "Express". |
| **In the background** | `hawkes-net.mjs` (the background clock, `background()`, `inBackground()`), `setAway` and host choice in `hawkes-net-core.mjs`; Unity `HawkesNet.RunInBackground`, `Peer.Away` | A page in the background keeps its room at full speed, games can keep their step running there, and an away host hands the room to a present player. Below, "In the background". |
| **Records** | `src/records.ts`, `GET/POST /v1/net/records` | A small store of signed events per project (a leaderboard's results): the newest per publisher and key kept, read by anyone. Below, "Records". |
| Demo page | `public/demo.html` (`https://net.hawkesgen.ai/demo`; the root `/` is the developer dashboard, `public/dashboard.html`: docs, and with a hawkesgen.ai sign-in your key, rooms and usage, read from the portal, which allows that origin on `/v1/net/me` and `/v1/users/api-key`) | Dots in a room plus a host-authoritative orb game on `sync.state` / `sync.action` (five glowing orbs, scores by peer id, host migration keeps them): invite link, bots in the same page, "move to the relay", live transport, host, routes, round trip and bandwidth. |
| Tools | `tools/net-load.mjs`, `tools/net-dev.mjs` | The load test (below; `--url` tests a real service from outside) and the service on this PC with a scratch data folder. |
| Tests | `test/` (`npm test`): `net-core`, `net-node`, `net-service`, `net-hub`, `net-unity`; Gen's bridge is tested in Gen (`test/netbridge.test.ts`) | Rules from the portal's relay on both protocols, codec bounds, the measured scene's bytes, flush time, a relay room over real sockets (and with worker processes), refused tickets, resume, p2p signalling and the move to the relay with nothing reliable lost, publish, full rooms, raw mode, usage rows. |

**Where the build differs from the design below:**

- **Hosting (J, 2026-10-25): relay nodes take players directly, no CloudFront.** WebSocket messages aren't HTTP requests,
  so CloudFront's request allowances don't apply to them, and a node on its own address is how game servers are run on
  AWS. The cost is EC2 data transfer (~$0.09/GB) per byte sent, which protocol v3 cuts ~5x and p2p rooms avoid entirely.
  A node behind CloudFront's flat-rate plan (WebSockets included) is still possible later: it only changes the node's URL.
- **One service key, not one per project.** Gen signs every ticket and publish token with one Ed25519 key (rotated with
  `POST /v1/net/keys/rotate`; the previous stays valid a day). Nodes fetch the public keys every minute.
- **Hawkes Net is its own repo** (`jgriffith3433/hawkesnet`, private; J, 2026-10-26: moved out of Gen's `net/` folder with the SDK and the Unity package), importing nothing from Gen. Gen keeps only its bridge (`src/netbridge.ts`). Gen's whole part is `src/netbridge.ts`.
- **p2p links carry one ordered, reliable data channel** per player for the room's stream, plus an unordered,
  no-retransmit one (`hx`) for express frames only (2026-10-26). The explicit-ack baselines that would put the stream
  itself on an unreliable channel are still to do.
- **Signalling is Hawkes's own** (the node's signal mode). The serverless Nostr/tracker driver is not in the SDK, and
  no game uses one any more: Yooba Land's was deleted when it moved to Hawkes Net, Dose Of Destruction's on 2026-10-26.
- **Hardening (2026-10-25, after a review of the public paths):** numbers are always safe to encode (the varint
  writer clamps NaN, Infinity and anything past 2^53; peers' clock stamps are kept within ten minutes of the room's), a
  value nested past 32 levels goes as null instead of throwing mid-flush, a stream keeps at most 8192 baselines and
  256 K characters of dictionary (both ends count the same), a synced state at most 512 keys, ownership at most `ents`
  entries, `upBytesPerSec` is enforced per connection, control frames are 125 bytes at most and ping echoes respect the
  slow-client cap, 64 sockets per address per process, a client's own close code never skips the grace (no ghosts), a
  ticket for an id already in the room is refused, resume tokens live 10 minutes and only for the same instance of the
  room, a closed room keeps its directory row (join order never restarts) until a sweep six hours later, rooms count
  toward `limits.rooms` only with people in them (rooms asked for but not joined have a cap of five times that), the
  mode is the ticket's (not the URL's), only the host (or players whose links failed) can move a room to the relay,
  spectators are capped at the room's size, a key narrowed to one customer can't act for a whole project, the public
  status has totals only, and Gen's publish can put people out (`kick: { sub }`: the portal's closed worlds and removed
  members). **The door:** an Origin header is only a browser's word, so the door gives only player tickets, limited per
  address; localhost is a door only where Gen is open to its own machine (`settings.localOpen`, never the server); the
  portal's project lists no origins (its rooms include editors' rooms, so every ticket comes from the portal's key after
  its own checks).
- **Not built yet:** TURN credentials (`/v1/net/turn`), a grid index for rooms
  of 1000 (avatars are compared per pair: fine at 32-64), per-project egress caps enforced at the node.

**Measured (2026-10-25, J's laptop: Intel Core Ultra 7 155U, Windows 11, Node 24; the load generator on the same machine):**

- Protocol 3 vs 2, the portal's cows scene (100 cows, 3 vehicles, 20 crates, 4 players): **11.4 KB/s vs 55.3 KB/s per player
  (4.9x smaller)** (`test/net-core.test.ts`).
- A 32-player room's flush with 120 things: 0.42 ms mean.
- The relay node alone (no workers): 256 players in rooms of 32 with 60 moving things each and avatars at 15 Hz: **0.32
  CPU cores**; 512: 0.54.
- `tools/net-load.mjs --players 1000 --room 32 --workers 4`: **all connected, none dropped, delivery p50 39 ms / p99 81 ms**
  (including the generators' own queueing), each worker at 250 players: 0.67 CPU, timers late by 27 ms at p99,
  **8.3 KB/s per player**. At 2000 players (500 per worker) on the same laptop the workers saturate (p99 136 ms): plan
  ~250-400 players per worker process on this class of machine; a Linux box with real cores does better. Rerun on the
  real box before sizing it.
- Real browsers (Chrome): 7 players p2p each on a WebRTC link to the host, then 12: the room moved to the relay on the same
  sockets, one move, host kept.

### Using it

```js
import { join } from 'https://net.hawkesgen.ai/sdk/hawkes-net@1.mjs'; // or npm install @hawkesgen/net
const net = await join('lobby-1', { project: 'mygame', name: 'Ada' });   // public door: the page's origin must be the project's
net.on('chat', (text, from) => console.log(from.name, text));
net.send('chat', 'hi');                       // reliable: once, in order, also across reconnects and the move to the relay
net.pose([x, y, z], yaw);                     // my avatar; others get it through net.onPose((id, s, at) => ...)
const t = net.sync.track({ pos: [0, 1, 2] }); // smooth playback of others' snapshots
```

- **Tickets.** (Projects and accounts: below.) A page on one of the project's sites gets player tickets with no key (the public
  door; per-address limits). A game server, a bot or a test gets them with a Gen key (`Authorization: Bearer hg_...`),
  any role. A game with its own server can mint tickets there and pass `ticket` to `join` (a string, or a function that
  returns Gen's answer, called again on reconnects).
- **Server sends.** `POST /v1/net/publish { project, room | 'prefix/*', ops | event, by, except }` with a Gen key.
- **An engine with its own multiplayer logic** passes `onRaw` and sends with `net.raw.send(m)` in the core's message
  shapes (hawkesgen.ai's `public/play/net.js` does).
- **Status.** `GET /v1/net/status` (nodes, rooms per project and transport), `GET /v1/net/nodes`, the demo at `https://net.hawkesgen.ai/demo`.
- **Public counts.** `GET /v1/net/counts?project=<id>&rooms=a,b` (no key, CORS open): `{ project, rooms: { a: 12, b: 0 } }`,
  players in each named room, for a project with its own sites (`origins`): a page showing "12 in Level 1" before joining it.
  Up to 24 rooms a call, 120 calls a minute per address. Numbers only.
- **Avatars in a big room.** The relay sends an avatar to a player every bundle within the room's `farAvatarM`, 5 times a
  second within four times that, and once a second past it (`flushOne` in the core): a room of a few hundred spread over a
  map costs little. Avatars are still compared per pair (no grid index yet), which is why Yooba Land's rooms stop at 250.

### Express: frames for what can't wait (J, 2026-10-26)

J, moving Dose Of Destruction: "fighting games need to have low latency and "feel fair" … if this changes things for
Hawkes Net then that's okay because we want it to be a solution for all types of game modes." The room's stream is
built for many players and many things: a client flushes every 33 ms and the relay bundles every 33 ms, which is up to
~66 ms of waiting on top of the network. A rollback fight sends one tiny packet a frame and wants it there now.

- **`room.express(bytes, { to })`** sends a `Uint8Array` (at most 1,200 bytes) as frame type 3: at once, not queued for
  the flush. **`room.onExpress((bytes, fromId) => ...)`** gets them. `to` is one peer id (or none: everyone in the room).
- **Unreliable.** Nothing is acked or resent: a lost frame is gone, and the game's own packets must cover it (a rollback
  packet carries every input the other side hasn't acked). Not part of the stream, the reliable messages or resume.
- **Relay:** the node forwards an express frame the moment it arrives (`express()` in the core), to `to` or everyone
  else, with the sender's id, and never bundles it. **p2p:** each player's link gets a second data channel `hx`
  (`ordered: false, maxRetransmits: 0`), so a lost packet never holds up the next; the host forwards a frame for
  someone else at once the same way. Before a link is up, or on the signal route, they go through the node.
- **Limits:** `limits.expressPerSec` per connection (default 240; DoD 300), counted apart from `msgsPerSec`. Over it, frames
  are dropped, not the connection. Stats: `expressUp`, `expressDown`.
- **Measured** (DoD's `tools/online-live.test.ts`, two players in one machine, a 60 fps fight): ~2,580 express frames each
  way in a match, ~13 bytes of inputs each (binary, varints and run lengths, against 85 as JSON), direct and on the relay.
- **A pair room that moves to the relay** (p2p fails between the two): the new peer list can arrive before the other
  player's own connection does. The SDK now waits up to 5 s (`MOVE_GRACE_MS`) for a peer missing after a move before
  calling them gone, so a fight doesn't end as a forfeit on the move.

### In the background: hidden tabs, minimised and covered windows (J, 2026-10-26)

J: "People background their games ALL the time." A hidden tab, a minimised window or a window covered by another gets
no animation frames (the game stops), and its timers slow to once a second, once a minute after five minutes. Found when
Dose Of Destruction's online fight froze between two windows on one machine. Three things in the SDK (1.2.0):

- **The background clock.** The SDK's upkeep, its sends (every 33 ms) and a p2p host's bundling run on a worker's timer
  (8 ms ticks; browsers don't slow a worker), so a page in the background keeps its room exactly as in front: its
  messages on time, and a p2p host's whole room on time. One clock per page, stopped when nothing uses it; ordinary
  timers where there is no Worker (Node, a strict content policy). The relay pings every socket every 10 s and browsers
  answer those even in hidden tabs, so nobody is dropped for being in the background.
- **`background(fn, { hz = 60, afterMs = 100 })`** keeps a game going: fn() about 60 times a second, only while the page
  has had no animation frame for 100 ms. Run the game's step there (inputs, simulation, sends), not its drawing.
  `inBackground(ms)` says whether the page is in the background now. For rollback and lockstep games (Dose Of
  Destruction), turn timers, and a host's simulation that others wait on. A presence game usually doesn't need it:
  away (next) is the better behaviour there.
- **Away.** A page in the background for 2 s tells the room (`{ t: 'away', on }`, a bundle item: older pages and
  servers skip it); back the moment it's seen again. Everyone gets `peer:away` ({ peer, away }) and `peer.away`;
  joiners get it in the hello's peer list; `room.awayPeers`; the page itself gets `away`. **An away host hands the room
  to the first present player** (`host` with reason `host away`), so what nobody owns keeps moving (the portal's
  animals and physics, Yooba Land's host duties); it doesn't take it back when it returns; with everyone away the host
  stays, and the first back takes it. `setAway(on)` for bots, tests and games that know better (paused in their own
  menu); `away: false` in the join options turns it off. Tests: `test/net-service.test.ts` "away" (relay and peer
  to peer) and "background()".
- **Unity:** the package gets all of it through the web SDK, plus `Peer.Away`, the `PeerAway` event and
  `HawkesNet.RunInBackground` (below, "Unity: the standard layer").

### Records: a small store of signed events (2026-10-26)

For a static game that keeps something all its players read (Dose Of Destruction's leaderboard: results signed by both
players, every page building the same Elo table from them). Hawkes Net only stores and serves; checking what a record
means is the game's job.

- **`POST /v1/net/records { project, test?, event }`**: `event` is a signed event in Nostr's shape (`id`, `pubkey`,
  `created_at`, `kind`, `tags`, `content`, `sig`; the id and Schnorr signature are checked), at most 8 KB. One record is
  kept per project, test flag, tag `t`, tag `d` and publisher: a newer one replaces it. From a page on the project's
  sites (its origin, no key; 30 writes a minute per address) or with a key that may act for the project. localhost
  (and any test page) writes only test records. 20,000 writes a project a day.
- **`GET /v1/net/records?project=&tag=&since=&limit=&test=1`**: the tag's records since a time, newest first (up to
  3,000), CORS open, 120 reads a minute per address.
- **Test and live apart:** `test: true` records are a separate set, so the beta site never touches the live table.

### Unity: the standard layer

How a Unity game uses Hawkes Net (J, 2026-10-26: "a standard implementation of hawkes net into unity projects"). Web and
Babylon games get the same shape from the JS SDK: `lobby({ project, liveHosts, prefix })` with `join(area)`, `on`, `onPose`,
`when('status')`, `send`, `pose` (the same room names, shards and rejoining; `test/net-service.test.ts` "the lobby").
Package `sdk/unity/com.hawkes.net` (its README has the code):

1. **`HawkesNetLobby`: shared rooms.** One room per area for everyone, kept joined. Room names by where the page runs: the
   game's live hosts get `<prefix><area>`, anywhere else `t-<prefix><area>` (the test prefix: beta is free and apart from
   live), a playtest page with `?room=<id>` `t-<id>/<prefix><area>`. A full room (the SDK's 4009) moves to the next shard
   (`<area>.2`...). A lost or refused room joins again by itself (2 s doubling to 60 s; a refused ticket 30 s to 5 minutes:
   the door's limits). Events (`Joined`, `PeerJoined`, `PeerLeft`, `HostChanged`, `Message`, `PoseChanged`,
   `StatusChanged`) stay subscribed across rejoins. Status: off, connecting, online, reconnecting, offline, full.
2. **Avatars are poses, everything else messages.** A player's place goes through `Pose(position, yaw, extra)` (the
   relay's interest by distance applies to it, never to messages), with the game's other per-frame values in `extra`.
   Events (an emote, a chat line, a gift) are messages; the game's own text goes with `SendText` and arrives as sent.
3. **`HawkesNetAvatars`** for a game with no avatars of its own: a prefab per player, played back a little behind.
4. **A game with its own network layer** keeps it and puts Hawkes Net under it: Yooba Land's `YoobaHawkesNet` is its
   `YoobaNet.ITransport` on `HawkesNetLobby` (its hundreds of online features unchanged; its bot peers stay in-page
   simulations merged into the room's view; presence keys and tags travel in the room as `~p` messages; other levels'
   numbers from the public counts). Sick Of It's ghosts (`GhostLobby`) are on `HawkesNetLobby`: area `lobby`, the floor in
   the pose's z.
5. **Ship a copy.** A game built on the cloud build server embeds the package in its own `Packages/` (the server has no Gen
   checkout of its own branch): copy it again when this one changes.

### Projects and accounts (J, 2026-10-26)

J: "You create the account at hawkesgen.ai and you get access to the Hawkes Net portal too and you can create your own
projects and get an api key, download the sdk and plug it into your unity project or babylon project. hawkesgen.ai game is
just the 1st project under my account." And: "make it so peer to peer isn't defaulted and API key and account at hawkesgen
is required."

- **net.hawkesgen.ai is the product** (J, 2026-10-26: hawkesgen.ai/net advertises it, `/net/docs` is gone): signed out it is a
  sign-in page (Google with `next=/net/back`, or email and password posted to the portal's own login, signup and forgot routes,
  which allow this origin), and every way in comes back to it; signed in: Projects (a getting-started guide and the engines
  when there are none), Docs, Account (the API key, downloads), and a page per project.
- **Accounts are hawkesgen.ai's.** net.hawkesgen.ai (the dashboard) reads and changes everything through the portal with
  the hawkesgen.ai session; the portal asks the service with its key and names the account (`owner`: its Gen project,
  `usr_...`), whether it is an admin and its tier (`paid` or `free`). The service trusts a key for a pattern of accounts
  (the portal's `usr_*`) to name one of them, a key for one account to act for that account, and owner/admin Gen keys for
  anyone (`projects.ts actor`).
- **Projects** (`net_projects`: id, owner, name, sites, peer to peer on or off, room size, tier). An account makes up to 20;
  the id (3 to 40 of `a-z0-9-`, from the name) is what the game passes as `project`. Settings: the sites whose pages join
  with no key (up to 20 https sites; paid accounts), peer to peer (off by default), players in a room (up to the plan's).
- **Hawkes's own games** (`projects.json`: Hawkes Gen Portal `hawkesgenwebsite`, Sick Of It `sickofit`, Yooba Land
  `yoobaland`, Dose Of Destruction, the demo) keep their room shapes and limits in the file; an admin takes one into their
  account from the dashboard ("Hawkes games nobody has taken"), and the row then sits over the file (its sites and peer to
  peer can be changed there; let go, it is nobody's again).
- **Tiers:** a free account's projects build and test: localhost in test rooms, 3 rooms, 16 players, 8 a room
  (`FREE_LIMITS`). A paid account (credits or a plan) gets its sites, server tickets and the defaults (64 a room, 200 rooms,
  2,000 players). Hawkes's games keep their file limits. The portal tells the service the tier on every call.
- **Tickets:** a page on a project's sites (no key), localhost for a project's test rooms (`t-...`), or a key that may act
  for the project (the account's servers through `POST https://hawkesgen.ai/v1/net/rooms/ticket` with `project`; the portal
  narrows its key to the account and the service checks the project is the account's). Every ticket, made or refused, is in
  the project's log for 7 days and counted in its day.
- **The relay by default.** Projects allow only the relay unless the account turns peer to peer on; the SDK (`join`,
  `lobby`) and the Unity package ask for `relay` unless the game asks for `auto`. The portal's own games and the demo are on
  the relay. Every room then shows on its project's page with its players.
- **Numbers** (`projects.ts`): players online a minute per project (`net_online`, the box samples it, 8 days), a row per
  project and UTC day (`net_days`: tickets, refused, player-seconds, test-room player-seconds, relay and p2p bytes, peak
  players; fed by the nodes' usage and the tickets). Gen's usage table still gets every node report (billing later sums a
  project's rows by its owner).
- **Toward the Unity Asset Store:** the package has a sample, a changelog and an outside developer's readme, and downloads as a
  tarball. Still open: the license and price (J's call), an Editor/standalone transport (a C# client of protocol 3 over a
  WebSocket: buyers will want Play mode), the listing's art and a demo build.

### Running a relay box

`node src/node.ts` with `NET_GEN_KEY` (a Gen key whose projects include `hawkesnet`), `NET_NODE_ID`,
`NET_PUBLIC_URL` (`wss://<host>/v3`, what tickets name), `NET_ADMIN_URL` (where Gen sends publishes), `NET_PORT`,
`NET_WORKERS` (default: the cores). TLS in front (Caddy) or a load balancer. It heartbeats to Gen, which then places new
rooms there (relay boxes before the node inside Gen). SIGTERM drains: players are told to move and Gen places their rooms
elsewhere. On the control server, Caddy must let `/v1/net/ws` and the public door through without the Studio login
(hawkesstudio `deploy/caddyfile.mjs`, `@net`).

## The design

Hawkes Net is how Hawkes games play together: one client SDK, two ways to carry it (peer to peer, or a relay we run),
and a service in Gen that hands out tickets, knows where rooms live and counts usage. A game says *what* it wants
("join this room, keep these things in sync"); Hawkes Net decides *how* (WebRTC or relay), and may change its mind while
people are playing.

## Why this exists

Three games each built their own network layer, and each is good at one thing:

| Where | What it is | What it taught us |
|---|---|---|
| `hawkesgenwebsite` (the portal) `src/relay.ts`, `rooms.ts`, `ws.ts`, `public/play/net.js` | A WebSocket relay. Rooms with no sockets in the logic (`relay.ts` is pure, so tests drive it with a simulated network). The host is the oldest connection, every moving thing has an owner, the relay keeps the newest pose and state copies so joiners and new hosts start from the world as it is. Each connection gets one bundle per 33 ms: reliable things first, then moving things by interest (full rate near, 4/s, 1/s, every 3 s far) in priority order inside a byte budget (96 KB/s), delta-encoded per connection. Clients replay buffered, stamped snapshots a little in the past (`Track`). | Measured (`docs/engine-modules.md` §7): 100 cows, 3 vehicles, crates and 4 players: the host sends ~27 KB/s in ~21 messages/s, **each player gets 26-33 KB/s**. JSON is the cost. The pure core is the thing worth keeping. |
| `YoobaLand/Docs/Online.md`, `Tools/Web/net/src` | WebRTC peer to peer, no servers: signalling over Nostr relays and WebTorrent trackers, neighborhoods of 24, a reliable and an unreliable channel per link, the "signal route" (messages ride the signalling relays when a direct link fails), bot peers in one page, iOS suspend handling. | Public relays refuse and rate-limit (damus bans, offchain.pub's web of trust, 3.5 events/s per player got three relays swapped out in 80 s; 1 batch/s did not). Without TURN a phone behind a carrier NAT never links, so a fallback route is not optional. Full mesh does not scale: 24 is the cap. A suspended iOS page looks like every peer being lost. Trystero keeps one peer id per page, so it cannot run bot peers. |
| `doseofdestructionwebsite` `docs/online.md`, `src/game/net/` | (Before 2026-10-26; now on Hawkes Net: a relay lobby room, pair rooms p2p first with relay fallback, inputs as express frames, the leaderboard as records.) Pair rooms (two players, one WebRTC link), rollback netcode over an unreliable channel, lobby as Nostr presence beats only. | A fight needs the shortest path (a direct link) and an unreliable channel. A lobby is presence, not a room. Same-device tabs need 127.0.0.1 ICE copies. |

Shared lessons (shared memory): `link-failed is not a bug` (only report a peer lost with no route at all, wait 20 s,
skip hidden pages and bots); a closed tab sends no bye unless `pagehide` leaves the room; `bot peers cannot share a
module-wide singleton`; vet every Nostr relay by publishing and reading back before listing it.

J's decisions that bind this design: Yooba Land and Dose Of Destruction run **without servers of ours** (m_8a95e7a2a215,
m_3d09268fce1b: peer to peer, GitHub Pages, no codes, always online). Hawkes Net must therefore keep a *serverless
mode* working. The portal's JSON protocol (v2) must keep working for pages already out.

## The pieces

```
 game page / Unity WebGL / Node bot
   └─ hawkes-net.mjs  (join, send/on, sync, clock, reconnect)
        ├─ transport p2p ── WebRTC host-star ── signal: Hawkes signal route  (or Nostr + trackers: serverless)
        ├─ transport relay ─ wss ── CloudFront ── relay node (Graviton, our process)
        └─ 'auto': p2p while small and healthy, then the relay, same room, same peer ids

 Hawkes Gen (hawkesgen.ai)                      Relay nodes (n1, n2, ...)
   POST /v1/net/ticket  (signs tickets)                 hold rooms (a room lives on ONE node)
   directory: which node holds which room               verify tickets offline (public key only)
   per-project limits, usage -> /v1/usage               report usage and room events to Gen
   ICE servers (STUN; TURN only when handed out)        also serve the signal route
```

- **Gen decides and records; it is never in the data path.** If Gen is down, rooms already running keep running;
  only new joins wait (and a project that allows it falls back to serverless signalling).
- **The relay core is shared code.** `relay.ts` keeps rooms with no sockets in it. That module (call it
  `net-core`) becomes a package used in two places: by the relay service, and *inside the host's page* in a p2p room.
  The host's page runs the same room logic (owners, locks, newest copies, interest, budgets) and forwards to its
  peers. This is why moving a room between transports is cheap: only *where the core runs* changes (see "Moving a room").
- **Peer ids, join order, the host and the clock belong to the room, not to a connection or a transport.**

## 1. The client SDK

`sdk/js/hawkes-net.mjs` (plus `.d.ts` from `src/types.ts`; synced into products with `bin/hawkesgen-sdk.mjs sync`
like the other client files, and bumped through a `NET_VERSION`). Later `com.hawkes.net` for Unity WebGL: a jslib
bridge the C# side polls, like Yooba Land's `YoobaNet.jslib` and `com.hawkes.analytics`. The C# API mirrors the JS one
(`HawkesNet.Join`, `Send`, `On`, `State`...). The page SDK is the only implementation of the protocol on the client.

```js
import { join } from './hawkes-net.mjs';

const net = await join('level-1/n3', {
  project: 'yoobaland',
  transport: 'auto',              // 'auto' | 'p2p' | 'relay'
  ticket,                         // optional: from your own server. Otherwise the SDK asks Gen (public door by origin)
  name: 'Gooey Pumpkin 42',
});

net.id; net.peers; net.host; net.isHost; net.transport;     // 'p2p' | 'relay' (informational)
net.send('emote', { e: 'wave' });                           // reliable: once, in order
net.send('pose', pose, { reliable: false, key: 'pose' });   // newest wins; may be dropped
net.on('emote', (data, from, meta) => { /* ... */ });
net.when('peer:join', (p) => {}); net.when('host', ({ host, previous }) => {});
net.now();                                                  // the shared clock (ms); never jumps
const car = net.sync.track({ pos: [0, 1, 2], vel: [6, 7, 8], euler: [3, 4, 5] });   // snapshot buffer (portal Track)
net.sync.push('car-3', values, { important: true });        // things I simulate (delta-encoded for me)
net.sync.onThing((id, at, values, from) => car.push(at, values, from));
net.sync.state('weather', { get, set, rate: 2 });           // module state: only changed keys (portal H.sync.state)
const boom = net.sync.action('boom', (d, { authoritative }) => { /* ... */ });   // decided once by the host
await net.leave();
```

What the SDK promises, on every transport:

1. **send / on, reliable and unreliable.** Reliable = exactly once, in order per sender, across reconnects and
   across a transport change (a per-sender sequence number and a short replay buffer on both ends; see "Moving a
   room"). Unreliable = newest wins. On a relay (a WebSocket is reliable and ordered) "unreliable" is coalescing by
   `key` (a newer value replaces an older one still queued) and dropping when the socket's `bufferedAmount` grows;
   on WebRTC it is an unordered, `maxRetransmits: 0` data channel.
2. **State sync, the portal's model.** `track / push / sample` is `H.sync` lifted out of the Babylon engine
   (`net.sync.*` mirrors `H.sync.state / action / track / claim / release / mine / holder / onHost`, `docs/engine-modules.md` §7). One authority per
   moving thing (its owner, else the host), `held` things cannot be bumped away, remote things are replayed ~one send
   interval behind with adaptive delay, a change of authority is blended by the game, not snapped. The engine's
   `public/play/net.js` becomes a thin adapter over this SDK; the wire is not its concern any more.
3. **A shared clock.** Pings to the room's centre (the relay, or the host in p2p), the quickest of the last ten
   round trips (the portal's rule). It is *the room's* clock: when the room moves from the host to the relay, the
   relay adopts the host's clock reading, so the clock does not jump.
4. **Reconnect.** A dropped socket or link retries with back-off (0.3 s doubling to a steady 1.2 s for the 15 s grace, then 2 s doubling to 15 s); `Hello.resume` (a token,
   valid 30 s) gives the connection its place back with ownership, and only reliable messages newer than
   `lastSeq` are resent. After 30 s it is a fresh join (new ticket, same `sub`, same peer id when still free).
5. **Leave properly.** `pagehide` sends a `bye` on every route (data channels, signal route, socket) and closes. A tab
   that vanishes is dropped by the room after 20 s of nothing (the portal's `idleMs`), 12 s on p2p.
6. **Sleep.** The SDK's 1 s upkeep timer notices being late by more than 4 s (iOS freezes timers and WebRTC) and
   enters a 15 s grace in which no peer is judged lost (Yooba Land's `resumed()`), then re-announces itself.
   `visibilitychange`, `pageshow` and `online` also trigger a check.
7. **No singleton.** `join()` returns an object; a page may hold several (bot peers in one page, a lobby plus a
   level). Ids are per join. Node works: the relay transport uses the global `WebSocket` (Node 24); p2p in Node takes
   `rtc` (a `node-datachannel` shim) as an option.
8. **Reports, not noise.** The SDK emits `problem` events with the convention from the earlier agents: `relay-lost`
   only when a peer is gone with no route at all, after 20 s, not for bots or hidden pages; direct-link failures just
   retry. The page sends them to its error capture and to analytics (`net_join`, `net_transport`, `net_fail`).

## 2. Transport `p2p`: WebRTC host-star

A room of up to **8** (a project may raise it to 24 for a *light* profile, see the table below) is a *star*: every
player has one WebRTC link, to the **host**. The host is the oldest player (lowest `ord`, which Gen assigns with the
ticket). It runs `net-core` in its page and forwards: a message from a player goes to the host, which applies the
room rules and sends each player their bundle (interest and budgets as on the relay, with a smaller budget).

Why a star and not a mesh: Yooba Land's full mesh capped at 24 and costs every player N-1 uplinks. In a star only
the host pays N-1; the others pay one. The host's uplink is `(N-1) x downrate`:

| Profile (per-player downstream) | 8 players | 24 players | Verdict |
|---|---|---|---|
| light, 4 KB/s (avatars, a few events: Yooba Land) | 28 KB/s | 92 KB/s | p2p up to 24 |
| medium, 12 KB/s (a world with a few dozen moving things, v3) | 84 KB/s | 276 KB/s | p2p up to 8 |
| heavy, 30 KB/s (the portal's measured 100 cows, v2) | 210 KB/s | 690 KB/s | p2p up to 4; the relay is the normal home |

The SDK measures the host's real uplink (bytes it forwards, `bufferedAmount` of its channels, the budget skipping
rate) and asks to move ("host overloaded") before players notice. A phone host is allowed only for `light` rooms:
`canHost` is false for a phone in a medium or heavy room, and the host is then the oldest player that can
(`ord` still orders everyone else; only the host choice skips them).

- **Channels.** Per link: `reliable` (ordered, reliable) and `fast` (`ordered: false, maxRetransmits: 0`). Bundles go on
  `fast` when they only carry unreliable items, otherwise `reliable`. v3 frames; `ack` is explicit here (see Protocol).
- **`pair` topology** (Dose Of Destruction): two peers, one link, no host logic beyond "who started". Input packets
  go on `fast`, the rollback code stays the game's. Latency is the point, so a pair room never moves to the relay
  (`auto` on a `pair` room means p2p, falling back to the signal route only for the lobby handshake).
- **Signalling: Hawkes signal route first.** The SDK opens `wss://.../v3/signal?t=<ticket>` (served by the relay
  nodes, "signal mode": opaque `sig` messages `{to, kind: offer|answer|ice|data|bye, body}`, 4 KB, rate limited, a
  few KB/s per connection). It carries SDP and ICE, `bye`, the migration control messages, and a *low-rate carrier of
  data* for a player whose direct link failed (Yooba Land's signal route: 1 batch a second with the newest few poses).
  One connection serves a whole p2p session at about nothing (no bundles flow), and it is what makes 'auto' possible
  without the game noticing.
- **Signalling fallback: Nostr and trackers.** For a static site that wants no server of ours (Yooba Land, Dose Of
  Destruction): `signal: 'serverless'` in the project (or `'hawkes+nostr'`, used when Gen or a node cannot be reached).
  Same approach as Yooba's `Tools/Web/net/src` (`nostr.js`, `tracker.js`, `presence.js`): Nostr kind 21791 ephemeral
  events and a 30078 presence beat, WebTorrent trackers as a second bus, sealed messages, a relay pool that swaps out
  a relay that refuses twice, 1 batch/s under the relays' limits. That code moves into the SDK as the `nostr` signal
  driver; Dose Of Destruction's copy in `src/game/net/` is retired in favour of it. In serverless mode there are no
  tickets, no limits, no relay and no 'auto' migration: a room past `p2pMax` is the game's to shard (Yooba's
  neighborhoods).
- **ICE.** STUN always: `stun:stun.cloudflare.com:3478`, `stun:stun.l.google.com:19302`, `stun:stun1.l.google.com:19302`
  (Yooba also lists Twilio's; drop it, three is enough). Wait up to 5 s for a server-reflexive candidate (slow mobile
  STUN was cut off at 2.5 s). Add the 127.0.0.1 copy of mDNS host candidates (same-device tabs; Yooba `sdpFor`).
  **TURN only when Gen hands out credentials** in `TicketResponse.ice` (short-lived, per ticket): a project must have
  `turn: true`, and the SDK asks for credentials with a second ticket after a link failed twice, so only players who
  need TURN cost anything. Without credentials, a player who cannot link to the host rides the signal route and the
  room's next step is the relay (below).
- **Host leaves.** The star has no links between players, so when the host goes the room cannot just elect the next
  oldest. Order of preference: (1) a relay is allowed for the project: **move to the relay** (the players still have
  their copies of the world; the next oldest seeds it, see "Moving a room"). (2) No relay: the next oldest that
  `canHost` becomes host, everyone links to it over the signal route (the data is already in their pages, as every
  player runs the whole game), taking about two seconds of hand-over; things keep their last values meanwhile.
- **Trust.** The host is trusted with the room, as in the portal (the one simulating a thing says where it is). A
  malicious host can lie; that is the price of p2p and is stated in the game's design, not hidden.
  Content that must be safe (Yooba Land) is quick-chat only.

## 3. Transport `relay`: the Hawkes Net relay service

A new process, `hawkesnet` (its own repo/folder `hawkesnet/` when built; the shared `net-core` and the codec are
packages used by it, by the SDK and by Gen's tests). It is the portal's `rooms.ts` + `relay.ts` + `ws.ts` made into a
standalone service and generalised:

- **Rooms with no sockets in the logic** (`net-core`, from `relay.ts`): `newRoom / join / leave / receive / flush`,
  same rules (host = oldest `ord`, owners and locks, newest `ents` and `states` kept, `clear`, `ops`), same tests
  (`test/relay.test.ts`, the netsim in `test/engine/netsim.ts` that runs 2-4 engines with latency, jitter and loss).
  The socket layer (`ws.ts`, an RFC 6455 server with no dependencies, text frames only today) gains binary frames and
  per-message-deflate off (binary is already small). The codec for each protocol version sits at the edge; the core
  never sees bytes.
- **Sharded by room.** A room lives on exactly one node and one worker thread (a node runs one worker per vCPU;
  rooms are pinned by a hash of the room key). No cross-node traffic at all. The **directory is in Gen**
  (`net_rooms`: project, room, node, epoch, nextOrd; `net_nodes`: path, status, players, capacity, load, beat). Gen picks
  the node when a room first needs one (the least loaded `up` node in the project's region with room for
  `maxPlayers`), puts it in the ticket (`node`, `epoch`, `relayUrl`), and every later ticket for that room goes to the
  same node. A node refuses a ticket that names another node or an old epoch, so a stale directory shows up as a
  refusal and the SDK asks Gen again.
- **Interest management and byte budgets move from the portal unchanged in intent.** Per connection: reliable
  items first, avatars (near every bundle, far five a second), moving things in priority order inside the
  connection's token bucket (`downBytesPerSec`), tiers by distance (`InterestConfig`, the portal's 45/130/320 m
  defaults), states that say where they are (`where`) thinned the same way, `important` first. What changes:
  tiers and budgets come from the room's config (not constants), and a connection's budget can be lowered by Gen
  (a project's `egressBytesPerSec` shared across its connections).
- **Rooms of 1000.** Interest by distance is what lets a Yooba Land *level* be one relay room instead of a
  neighborhood: with a grid index (cell = the far-tier distance) a connection scans its own and adjacent cells
  instead of every thing. Not needed for 32; required past about 100. The portal's `LIMITS.people` of 32 becomes the
  project's `playersPerRoom`.
- **The signal route** is the same endpoint in `signal` mode: no world state, only `sig` forwarding. A p2p room is
  not a "room" on the node, only a set of signal connections, so a node can hold tens of thousands.
- **Slow clients** are dropped, not buffered (the portal: close with 1013 above 4 MB buffered). Pings every 25 s keep
  proxies from closing quiet sockets; 20 s of nothing ends a connection.
- **Process.** One Node 24 TypeScript process per vCPU (workers), `systemd`, no database; state is in memory by
  design (a restart drops a node's rooms: the SDK reconnects, asks Gen, and the new room is seeded by the players'
  copies of the world, "Moving a room" case C). A node drains before a deploy: `status: draining`, Gen stops
  placing rooms there, rooms move or end.
- **Observability.** `GET /healthz`, `GET /stats` (rooms, players, bytes, skipped, slow drops, loop lag) for Gen's
  Machines monitor (the same dashboard that shows GPU servers), and the heartbeat to Gen every 10 s.

## 4. `auto`: starting small and moving up without the game noticing

`transport: 'auto'` is the default and what games should use. The room starts as `p2p` (cheapest, no node). The game
sees the same `NetRoom`; `transport` is information, never needed.

**When the room moves from p2p to the relay** (any one is enough; `'game asked'` is `net.migrate()` for a game that knows):

| Trigger | Where it is noticed |
|---|---|
| The room is about to pass `p2pMax` (the next join would make it too big) | the signal route (it counts) |
| The host leaves and the project allows a relay | the signal route |
| Two or more players are on the signal fallback only (no link to the host after 8 s) | the host and the players |
| The host's uplink is overloaded (budget skipping above 10% for 5 s, or `bufferedAmount` high) | the host |
| The game asked | the game |

A relay is chosen only if the project's `transports` include it, the ticket carried `relay`, and the project is not
capped. Otherwise the room stays p2p and the next join is refused with `full` (or the game shards it).

**Moving a room (make before break).** The room is a set of peers plus a `RoomSnapshot` (`types.ts`): host, peers
with `ord`, owners and locks, the newest value of every thing and state, the epoch, the clock, and the recent
reliable sequence numbers. The snapshot is the whole of what moves.

```
 host or signal room             Gen                       relay node n1                every player
 1 propose  ──── POST /v1/net/rooms/move ───▶ pick n1, epoch+1, ord kept
 2 prepare  ◀── ticket' for each peer (node n1, epoch+1) ───────────────────────────▶ (over the signal route)
 3 seed     host sends its snapshot to n1 over its new socket (a relay `seed` frame: <= 1 MB)
 4 ready    each player opens a socket to n1 with its ticket' and says ready; n1 holds it, does not send yet
 5 switch   host sends `switch{epoch}` on every route; at it, each player sends and receives on the socket
            (reliable sequence continues; the first bundle from n1 carries a full keyframe for every thing)
 6 done     p2p links close after 2 s; Gen records transport=relay, node=n1, epoch
```

- **Nothing resets.** `PeerId`s, `ord`, host, owners, locks, `net.now()` and every reliable sequence number are the
  snapshot's, so the game's `peer:join`, `host` and clock logic see no event. The only visible signal is a
  `transport` event and, if `fast` data was in flight, one bundle's worth of gap (typically under 150 ms) that the
  Track buffers already smooth (they replay ~100 ms in the past).
- **Messages across the switch.** Reliable items carry `(sender, seq)`. During steps 4-5 a player sends on both
  routes; the receiver (relay or host core) drops any `(sender, seq)` it has seen (the snapshot's `recent` list
  seeds this). Unreliable items are not duplicated: they follow the route in force at their tick.
- **If the relay fails to come up** (no node, ticket refused, n1 slow): `abort`; the room stays p2p, back-off 60 s,
  then retry; Gen logs it and the project's usage shows `refused`. If the host vanishes *during* the move, the next
  oldest finishes it with its own copy of the world (every player runs the game, so they all have the snapshot's
  contents already; only the host's "newest data" is lost, which is ~100 ms).
- **Case C, node loss** (a relay node restarts): players reconnect, Gen sees the room's node is `down`, allocates
  a new node and epoch, the oldest reconnecting player seeds it from its copy (the same `seed` step), and the room
  continues. Rooms lose their kept `ents` for a moment and rebuild from the owners' next sends (10/s).
- **Back to p2p?** No. Hysteresis: a room that went to the relay stays there until it empties; flapping costs more
  than it saves. (A later option: for a room under `p2pMax / 2` for 5 minutes with a healthy host.)
- **Games that need to know** (a loading bar, a quick-chat that the relay may delay) read `net.transport`; the
  guidance is that nothing about gameplay may depend on it.

## 5. Protocol v3

Binary, versioned, and the old protocols keep working: the same room core serves **v1** (the portal's per-message
JSON), **v2** (JSON bundles, `?v=2`) and **v3** (binary) connections in one room, each with its own encoder
(`Conn.v`, as relay.ts already does for 1 and 2). A page already out in the world keeps its v2 URL
(`/v1/ws?play=<slug>&room=<code>&v=2`), which the portal keeps serving; when the portal's rooms move to the relay
service, `/v1/ws` is forwarded to it with the same rules. New SDKs ask for v3 (WebSocket subprotocol
`hawkes-net.v3`); the SDK offers `[3, 2]` and the ticket response says which the room speaks. Everything below
describes v3.

**Frames.** One frame per WebSocket binary message or data-channel message. Byte 0: high nibble = kind (0 bundle, 1
hello, 2 control, 3 seed), low nibble = flags (1 = compressed with `deflate-raw` for big hellos/seeds only, 2 = full
keyframe). Integers are LEB128 varints; signed values are zig-zag varints; strings are `varint length + UTF-8`; ids
(peers and things) are a per-connection dictionary: a string is sent once (`define id string`), then as a varint.

**Bundle** (what v2 calls `{t:'b', m:[...]}`), at most every 33 ms:

```
 [0x0|flags] [tick varint] [ack varint] [count varint] item*
 item = [tag u8] [length varint] payload
 tag: 1 me   2 xf   3 st   4 ev   5 own   6 join   7 leave   8 host   9 ops   10 clear   11 pong   12 define
```

- **`xf` (moving things)** replaces `[id, mask, ...values]` JSON. Per thing: `id` (varint from the dictionary), `mask`
  (varint; bits 0-11 as the portal: x y z, rx ry rz, vx vy vz, spin x y z; bit 12 important), then one **zig-zag varint
  delta** per set bit against the baseline. A full (keyframe) update is the same shape with the baseline 0.
- **Quantization** (`Quantization`; defaults, tuned per room): positions in 1/128 m (7.8 mm; the portal sends 1 mm
  but only when a thing moved more than 4 mm), velocities 0.05 m/s, spins 1 degree/s, rotations as a `uint16` fraction of
  a turn per Euler axis (0.0055 degrees) or, for things the game marks `quat`, smallest-three in 32 bits. Avatars
  (`me`): position as three zig-zag deltas, yaw as one byte (1.4 degrees; clients smooth), extra game flags as a
  length-prefixed blob the core forwards without reading.
- **Baselines are acknowledged, not assumed.** The sender keeps, per connection, the values of its last
  `K = 32` bundles; the receiver's `ack` (the highest `tick` it applied, carried in its own next bundle) promotes that
  bundle's values to the baseline. Deltas are always against the baseline, and a keyframe is forced if no ack arrives
  in `keyframeMs` (default 2500 ms, the portal's `full` rule). On a reliable ordered carrier (WebSocket) `ack` is
  implicit and not sent; on a lossy one (the p2p `fast` channel) it is explicit. This is the difference from the
  portal's v2, which diffs against the last *sent* copy and relies on TCP, and what makes unreliable delivery safe.
- **`st` (synced state)**: a tagged value codec instead of JSON: null/bool/varint/zig-zag/f32/f64/string
  (dictionary)/array/map/bytes. Keys use the connection's dictionary. Only changed keys, `full` flag, `where`, `important`
  as in v2.
- **`ev` (events)**: `kind` (dictionary), a body that is bytes (opaque) or the tagged codec, and `seq` per sender for
  exactly-once. Reliable items are never dropped by the budget.
- **Budget**: the same token bucket per connection, counted in real bytes now (the portal estimated JSON sizes).

**Expected size.** One moving thing at 10 Hz in v2 JSON costs about 70-100 bytes (`["c12",63,1.234,0.5,...]` with
every changed value as text); in v3 it is id 1-2 + mask 2 + roughly 10-14 bytes of deltas, about **15-20 bytes**:
4-6 times smaller. The portal's measured 26-33 KB/s per player in the cows scene should become **about 8-12 KB/s
(the "medium" profile)**. This is a target to prove with the netsim (`test/engine/net.multi.ts` scene on both codecs),
not a measurement: the first v3 task must produce the real number and update the cost table below.

**Compatibility rules.** A new optional item tag or field is not a version bump (old receivers skip unknown tags by
length, the way Yooba Land's `PROTOCOL` is only bumped for a change the page before cannot read). A bump of `v` is
announced in a ticket (`client.protocols` is how the SDK says what it speaks) and an SDK too old for a room gets
`notice: 'reload'` (the "A new Yooba Land is out: reload" card).

## 6. Tickets

Gen signs a **join ticket** for a project's key; the relay (and a host's page, for signal-room checks) holds **only the
public key**, so a relay node cannot mint tickets and a leaked node costs one project's rooms, not the keys.

- **Format**: `hn1.<base64url JSON TicketPayload>.<base64url Ed25519 signature over "hn1." + payload>` (fields: project,
  room, peer, `ord`, `sub`, name, role, allowed transports, node and epoch, effective limits, room config, `iat`, `exp`,
  `jti`; exact shape in `types.ts`). Gen signs with Node's `crypto.sign(null, ...)`; nodes verify with `crypto.verify` or
  WebCrypto (`Ed25519`), a few hundred microseconds.
- **Keys**: one Ed25519 key pair per project, id `kid`; the private half stays in Gen (`.data/net/keys.json`, same
  rules as other secrets), the public halves are served to nodes at `GET /v1/net/keys` (and pushed on rotation). Two keys per
  project are valid at once for rotation. Gen's own signing is separate from `src/auth.ts` and the portal's `sign.ts`
  (HMAC for editor tokens): unchanged.
- **`POST /v1/net/ticket`** (`TicketRequest` / `TicketResponse`):
  - *With a Gen API key* (a game's server, agents, playtests, bots): any role; counted to the key's client.
  - *From an allowed origin, no key* (the public door for static games, like the analytics collect door): role `player`
    only; the Origin must be in the project's `origins`; per-IP and per-project rate limits; no IP is stored. This is
    how a GitHub Pages game gets a ticket without holding a secret.
  - It creates the room if needed (config from the request, clamped to the project's), assigns `peer` and `ord`
    (Gen's `nextOrd` per room), chooses the node when the room needs one, adds the ICE servers, and refuses with
    `capped` when the project is out of its monthly allowance.
- **Lifetime and use**: `exp` is 90 s (a ticket is for connecting); `jti` is single use per node (an LRU of recent
  `jti`s); a connected player comes back with `Hello.resume` (30 s) rather than a new ticket. Gen can push a `jti` or
  `sub` deny list to nodes (a kicked player), so a ticket is revocable before it expires.
- **Nodes** authenticate to Gen with ordinary Gen API keys (a client per node, project `hawkesnet`), so `src/auth.ts`
  does not change.

## 7. Limits and usage

**Limits** (`ProjectLimits`, in `projects.json` next to `analytics/products.json`; the ticket carries the effective values and the
node enforces them; Gen also checks the aggregate ones when it issues a ticket). Starting defaults, to tune with
load tests:

| Limit | Default | Source |
|---|---|---|
| Rooms open at once (project) | 200 | new |
| Players per room (relay) | 64 (up to 1000 with interest tiers) | portal `people: 32` |
| Players at once (project) | 2000 | new |
| Down bytes/s per connection | 48 KB (v2 rooms keep 96 KB) | portal `budget: 96 KB` |
| Up bytes/s per connection | 32 KB | new |
| Messages/s, inner messages/s | 90, 900 | portal |
| One message | 64 KB (v2: 200 KB) | portal 200 KB |
| Moving things, states per room | 4096, 2048 | portal |
| Project egress (relay) | 5 MB/s | new |
| Month's traffic out (project) | 5 TB; warn at 80%, refuse new rooms at 100% | new |

The relay applies the byte budgets as token buckets; a connection over its up limits has messages dropped (the portal's
`perSecond` and `innerPerSecond` rules) and a repeat offender is closed with 1008. Exceeding rooms/players is a refused
ticket (`full`/`capped`), not a dropped connection.

**Usage** reports back to Gen so it appears in the existing usage and cost views (`src/usage.ts`, `/v1/usage`,
Settings, the dashboard's Usage tab):

- Each relay node sends `UsageReport` every 60 s (`POST /v1/net/usage`): per project and transport, player-seconds,
  bytes out and in, peak rooms and players, updates skipped by budget, slow drops, refusals. `test: true` rows
  (rooms starting with the project's `testPrefix`) are filed with cost 0.
- p2p pages send one report when they leave and every 5 minutes (`POST /v1/net/report`, ticket-authenticated):
  player-seconds and the bytes their own links carried. These are self-reported and used for counting, never for billing.
- Gen files them as `recordUsage({ client, project, provider: 'hawkesnet', unit: 'player-minute' | 'gb', amount, cost, detail })`.
  **Cost attribution**: a node's hourly price (EC2) is split by each project's share of that node's player-seconds
  in the hour; the flat CloudFront plan is split by share of GB; both prices are in Gen's settings
  (`settings.net.rates`), so changing the box changes the numbers. TURN traffic (if handed out) is `unit: 'gb'`, `provider: 'hawkesnet-turn'`.
- Alerts (Machines monitor and the Studio inbox): a node's load above 0.8 for 5 minutes, a project at 80% of its monthly allowance, a node `down`.

## 8. Hosting the relay

> **Decided 2026-10-25 (J): nodes take players directly, no CloudFront** (see "What is built"). The CloudFront text below is
> the option kept for later, not the plan.

**One small Graviton box, its own process, behind CloudFront, on a flat-rate plan.**

- **Box**: an EC2 `c7g.large` (2 vCPU Graviton3, 4 GB; about **$0.0725/h**, ~$53/month on demand; a `t4g.medium` at ~$0.0336/h is
  enough for beta), its own security group, `systemd`, one worker per vCPU. Control stays in Gen: the box has no
  database. Node `n1` first; more are added by launching the same image (like the fleet image: `hawkesgen net node launch`, later).
  Planning capacity **600 players per `c7g.large` on the medium profile** (one core ≈ 300 players at 30 bundles/s each with
  interest filtering: an assumption from the portal's design, to be replaced by a load test before launch; the first relay task measures it).
- **In front: CloudFront with WebSockets** (the viewer connection is `wss://net.hawkesgen.ai/n1/v3?...`; a behavior per node path `/n1/*`
  to that node's origin; the distribution allows 25 behaviors by default, enough for ~20 nodes, then a second
  distribution). Reasons: TLS and DDoS absorption without a load balancer, the browser sees one hostname, and **AWS
  origin to CloudFront transfer is free**, so the box's own egress bill (EC2 internet transfer is ~$0.09/GB) disappears:
  the traffic that costs is CloudFront to the viewer.
- **CloudFront flat-rate plan (J's research, 2026-10-25)**: the **Pro plan, $15/month**, includes **50 TB** of data transfer to viewers and
  WebSocket support, **with no overage charges**. (Free tier $0; there are larger plans above Pro.) Source: AWS CloudFront pricing page,
  https://aws.amazon.com/cloudfront/pricing/ and the flat-rate plans announcement. **Not re-checked when this was written** (no web access in the
  builder's sandbox): the first provisioning task must re-read the page for the current price, the allowance, what "no overage" means at the
  limit (throttle? plan upgrade?), WebSocket idle and duration limits (CloudFront closes idle viewer
  connections; our 25 s pings keep them alive), and whether bytes *from* the viewer count toward the allowance (upstream is ~25% of the volume).
- **Without CloudFront** the same box would pay ~$0.09/GB out to the internet (first 10 TB, us-east-1); at the "medium" profile that is
  ~$3.9 an hour per 1,000 players, ~$2,800 a month at 24/7. The flat plan is what makes the relay viable at all.
- **Where**: Gen's region first (us-east-1 for Gen and the fleet). A relay room near its players matters less than
  for a shooter because small rooms are p2p; per-region nodes (`NodeRecord.region`) are in the types for later.
- **Failure**: a node dies, its rooms are re-seeded on another from the players' copies (see "Moving a room", case C). Run at least two
  nodes once there is traffic that matters; place new rooms on the less loaded.
- **Later option: Cloudflare Durable Objects.** A room is a Durable Object (naturally one room, one place, sharded for free,
  global edge, no boxes). The `net-core` is plain TypeScript with no sockets, so it drops in. As researched: **outgoing WebSocket
  messages are free; incoming ones are billed at 20:1** (20 messages count as one request), requests are $0.15 per million after
  1 million included on the $5/month plan, duration is GB-seconds ($12.50 per million after 400,000 included) while an object is active, and a busy
  game room never sleeps. Source: https://developers.cloudflare.com/durable-objects/platform/pricing/ (not re-checked here). It costs
  more than our own box at steady load (table below) but nothing to operate and reaches players worldwide at low latency, so it is the
  answer if players spread across continents or traffic is spiky. Because `ticket` + `TicketResponse.relayUrl` already hide where a room lives,
  moving a project to Durable Objects is a directory change, not an SDK change.

## 9. What it costs: per 1,000 concurrent players

> **With the decision and the measurements (2026-10-25):** the relay sends **~8 KB/s per player** in a world of 60 moving
> things and 31 avatars (measured, protocol 3), so **1,000 players on the relay = ~29 GB an hour = ~$2.60 an hour in EC2
> data transfer** ($0.09/GB), plus the boxes (a c7g.large is ~$0.07 an hour and holds several hundred players: measure on
> it). That is **~0.26 cents per player-hour**. Rooms of friends that stay peer to peer cost nothing. The table below was
> written before the measurements and with CloudFront in mind; keep it for the comparison.

Assumptions (all of them are numbers someone can change; formulas below):

- Profiles (per-player **downstream**, with a smaller upstream): **light 4 KB/s** (avatars at 10 Hz in v3, a few events: Yooba
  Land; down 4, up 1), **medium 12 KB/s** (v3 target for a world of dozens of moving things; up 3), **heavy 30 KB/s** (the portal's
  *measured* 26-33 KB/s in v2 JSON; up 8). Per 1,000 players: light 14.4 GB/hour, medium 43.2 GB/hour, heavy 108 GB/hour
  (`KB/s x 3,600 x 1,000 / 1,000,000`). Per month at 24/7 (730 h): 10.5 TB, 31.5 TB, 78.8 TB.
- Prices (US, on demand; from AWS and Cloudflare's public pages as I know them, **to be re-checked when provisioning**; the
  CloudFront flat-rate plan is J's research above): EC2 `c7g.large` $0.0725/h; EC2 data transfer to the internet $0.09/GB;
  CloudFront Pro $15/month for 50 TB; Cloudflare Durable Objects $5/month + $0.15 per million requests + $12.50 per million GB-s, incoming
  WebSocket messages 20:1, outgoing free; TURN, if run by us on EC2, $0.09/GB, or on Cloudflare's TURN service ~$0.05/GB after 1 TB a month free
  (Cloudflare Realtime pricing, to verify).
- Players send one bundle every 33 ms at most; DO rows assume a client batches to 15 per second (30 per second doubles the request line).
- 15% of players cannot link directly and need TURN (commonly quoted for consumer networks; Yooba Land's phone on carrier NAT is
  the case). It matters only for p2p; the relay has no such players.

| Transport (1,000 concurrent) | Per hour | Per month at 24/7 | Notes |
|---|---|---|---|
| **p2p, no TURN** (serverless Nostr/trackers, or Hawkes signal) | **$0** (Gen signalling ~ nothing) | **$0** | Players pay their own bandwidth; the host's uplink is the limit (table in section 2). The 15% who cannot link do not play together. |
| **p2p + TURN handed out to the 15%** | light $0.14 / medium $0.41 / heavy $1.03 (TURN at $0.05/GB) | light ~$50, medium ~$250, heavy ~$700 after the free 1 TB | Same at $0.09/GB: $0.24 / $0.73 / $1.85 an hour. Only players who needed it count. |
| **relay, 2x c7g.large behind CloudFront Pro** | **$0.17** (2 x $0.0725 + $15/730 h) for light and medium | **~$124** (2 boxes ~$106 + 2 x 20 GB disk ~$3 + $15) | Light 10.5 TB and medium 31.5 TB sit under 50 TB. Heavy (78.8 TB) is **over** the plan's allowance: the relay speaking v3 should turn heavy into medium; otherwise needs a second plan or pay-as-you-go. |
| relay with no CloudFront (direct EC2 egress, for comparison) | light $1.30 / medium $3.89 / heavy $9.72 (+ boxes) | ~$950 / ~$2,840 / ~$7,100 | Why the flat plan is the design. |
| relay on CloudFront pay-as-you-go (~$0.085/GB first 10 TB, for comparison) | light $1.22 / medium $3.67 / heavy $9.18 | ~$890 / ~$2,680 / ~$6,700 | Not recommended; shown because overage on the flat plan may end up here. |
| **relay on Cloudflare Durable Objects (later)** | medium ~$0.59 (requests 15/s: $0.41, duration 32 rooms: $0.18) | ~$430 + $5 | 30 msgs/s up: $0.99/h. Heavy and light differ only in bytes, which are free outgoing; requests are what scale. |

Formulas, so they can be redone: `GB/h = players x KB/s x 3.6 / 1000`; EC2 egress `GB/h x 0.09`; TURN `0.15 x (down + up GB/h) x rate`;
relay `nodes x 0.0725 + 15 / 730`, `nodes = ceil(players / 600)`; DO requests `players x msgs/s / 20 x 3600 / 1e6 x 0.15`; DO duration
`ceil(players / 32) x 0.125 GB x 3600 s x 12.50 / 1e6`. The TURN cost depends on how many players need it, which is why credentials are handed out only after
a failed link. The relay's per-1,000 cost is dominated by the two boxes (about $106 of $124 a month); the per-player-hour cost is **$0.00017**.

**Reading it:** p2p is free but limited to small rooms and to players who can link; the relay is ~$125 a month per 1,000 concurrent players
(flat, up to the plan's 50 TB), which is under two cents per 100 players an hour; Durable Objects is 3 to 4 times that at steady load, in exchange for zero operations.
Do not run heavy worlds on p2p and do not run light ones on the relay unless they need big rooms: **auto** exists to make that choice by the room's size.

## 10. How a game picks transports; bots and playtests

**Picking** (a game states needs, not mechanisms; the project's registry entry holds the defaults):

| Game | Config | Why |
|---|---|---|
| Yooba Land | **On Hawkes Net (J, 2026-10-26: "it's an MMO, everyone is in the same lobby" and "Always connect to servers")**: `transport: 'relay'` (the project allows only the relay), one room per area for everyone (`p1/lobby`, `p1/level-1`), profile `light`, rooms of 250 then shards (`.2` = neighborhood n2 in the game), `farAvatarM` 60. Its old serverless network (Nostr signalling, WebRTC mesh) is deleted. | J's word replaces m_8a95e7a2a215 for Yooba Land. |
| Dose Of Destruction | `topology: 'pair'`, `transport: 'p2p'`, `signal: 'serverless'` | Rollback needs the direct link and an unreliable channel; the lobby stays presence beats. DoD's `src/game/net/` becomes thin over the SDK's `nostr` signal driver. |
| Portal games (`hawkesgenwebsite`) | `transport: 'auto'`, profile `heavy` becoming `medium` on v3, `p2pMax: 4` | Worlds with many moving things; they start p2p for a couple of friends and live on the relay. Their v2 pages keep working through the old URL. |
| New casual / co-op games | `transport: 'auto'`, profile as measured | The default. |

A project that is **serverless** has no Gen involvement: no tickets, no limits, no usage, no relay. A project that is not
gets everything. Both use the same SDK API, so a game can change its mind in one line of config.

**Bots (in a page)**: `join()` returns independent rooms with their own `PeerId`, so Yooba Land's `?botpeers=N` becomes N calls with
`role: 'bot'` and the game's scripted route. Bots join over the real network (the relay, or p2p with their own links). A bot in
the same page links over 127.0.0.1 candidates only (Yooba's rule). **Bots in Node** (tests, soak runs) use the relay transport with the global `WebSocket`
(no WebRTC needed) or p2p with `rtc` from `node-datachannel` (what `Tools/Web/net/test` already does).

**Playtests (Gen `playtest.run` with `peers: 2..4`)**: each browser context opens the page at `?room=<id>&peer=<i>`; the page's SDK reads `room`
and asks for a ticket. Because `playtest.run` runs inside Gen with an API key, it mints tickets itself (`POST /v1/net/ticket` with `role: 'test'`)
for the project and passes them as `?nt=<ticket>` (so it needs no Origin and sees no rate limit), and names the room `t-<job id>` so it
matches the project's `testPrefix`: not counted in presence, not billed, closed when the job ends. The scenario log records the room, transport,
peers, round-trip times and host (the contract Yooba Land's `YoobaPlaytestTwoPlayers` already logs). A scenario can force a transport
(`?net=p2p|relay|auto`) and, to test 'auto', ask the SDK to move the room (`window.hawkesPlaytest.net.migrate()`), then check that peer ids, host and the clock held and that the
reliable message count matches. `playtest.run`'s lanes (browser tabs) do not change: a room of 4 is 4 tabs, as now.

## 11. Security and privacy

- Peers never choose their own id or `ord`; Gen does. The relay checks a thing's owner before accepting its transform
  (`may()` in the portal) and drops `ops` from clients (only Gen's world-save route may send them).
- Origin checks are for the public ticket door only; the socket is authorized by the ticket alone, so tickets are
  short, single use and revocable. Rooms are not secret unless the game makes the name unguessable.
- Nothing typed by a player is relayed unless the game sends it; the SDK adds nothing. Yooba Land's rule (quick chat, generated names)
  stays the game's.
- No IP addresses are stored by Gen or the node (analytics' rule); per-IP rate limits live in memory. Counts only.
- p2p exposes players' IPs to each other (WebRTC does); a game that cannot accept that picks `relay`. Say it in the game's privacy text.

## 12. Tests

- `net-core`: the portal's `test/relay.test.ts` moves with it; plus codec round-trips (random values, quantization error
  bounds, baselines with dropped acks, keyframes), a v1/v2/v3 mixed room, and migration (a simulated host leaving mid-move).
- A **transport contract suite** that runs the same scenario against `p2p` (in-process loopback), `relay` (a real node in
  the test) and `auto` (migrating mid-scenario): joins, host order, ownership, reliable ordering and exactly-once, unreliable
  coalescing, the clock after a move, reconnect with `resume`.
- The netsim (latency, jitter, loss) from the portal's `test/engine/netsim.ts`, and the measured scene (100 cows, 3 vehicles, 4 players) as the byte-budget
  regression: v2 about 30 KB/s per player, v3 under the target.
- Live checks as Yooba Land does (`node test/twopages.mjs soak 120`, relays vetted by publish-and-read-back) for the serverless driver.

## 13. Build order (the roadmap tasks that follow this design)

Each is one change; none is started.

1. **net-core and the codec package**: extract `relay.ts` unchanged in behaviour (tests move with it), add the v3 codec with the byte
   targets and a v1/v2/v3 mixed-room test. Measures the real per-player rate and replaces the "medium" number here.
2. **Registry, keys, tickets** (`src/`, `projects.json`, `POST /v1/net/ticket`, `GET /v1/net/keys`, the public-door rules, tests).
3. **Gen: directory and usage** (`net_rooms`, `net_nodes`, heartbeat, room events, `POST /v1/net/usage` into `usage`, `settings.net.rates`, a dashboard Net tab, `hawkesgen net status`).
4. **The relay service** (`hawkesnet/`, the portal's `ws.ts` + `rooms.ts` generalised, signal mode, health, drain) and a load test that sets the
   real capacity per node. Then provisioning: the box, CloudFront Pro, the DNS (needs J's OK: it costs money).
5. **SDK, relay transport** (`sdk/js/hawkes-net.mjs`: join, send/on, sync, clock, reconnect, pagehide, sleep), with the portal's `net.js` rebuilt over it.
6. **SDK, p2p transport and signalling** (host-star, `nostr` driver moved from Yooba Land, Hawkes signal route, ICE, bots in Node).
7. **`auto` and moving a room** (the migration, the contract suite, abort and node-loss cases).
8. **Unity WebGL `com.hawkes.net`** (jslib bridge, Yooba Land adopts it in place of `YoobaNet.jslib`).
9. **Adopters**: portal games (v2 keeps working), Dose Of Destruction's net layer over the SDK, Yooba Land's, Gen `playtest.run` minting test tickets.

## Open questions for J

1. ~~May Yooba Land's levels ever use a relay room?~~ Yes (J, 2026-10-26): one room per area for everyone, on Hawkes Net.
2. TURN: hand it out at all (Cloudflare's service or ours), and for which projects? It is the only p2p cost.
3. Does the relay get a second region, or is one (us-east-1, with p2p for small rooms) enough to start?
4. The flat CloudFront plan's limits (what happens past 50 TB, WebSocket duration) must be re-read on the day we provision it.
