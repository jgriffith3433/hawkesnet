# Hawkes Net

Multiplayer for web, Babylon and Unity WebGL games: **https://net.hawkesgen.com**. One service holds the accounts'
projects, hands out tickets, keeps the room directory and runs the relay; games join rooms through the SDK, on the relay
or peer to peer, and the same SDK runs a peer-to-peer host's room in its page.

| Path | What |
|---|---|
| `src/` | The service (`hub.ts`: tickets, directory, keys, publish, status, the SDK files, its relay node), the relay node (`node.ts`, `rooms.ts`, `worker.ts`, `ws.ts`), tickets (`tickets.ts`, Ed25519), projects and accounts (`projects.ts`, `registry.ts`), records (`records.ts`), the Unity package download (`tarball.ts`), settings (`store.ts`, `NET_*`) |
| `sdk/js/` | The client SDK, published as **`@hawkesgen/net`** (MIT): `hawkes-net.mjs` (join, lobby, background), `hawkes-net-core.mjs` (the room and the binary protocol: the relay runs the same file), `hawkes-net.d.ts` |
| `sdk/unity/com.hawkes.net/` | A copy of the Unity package from [hawkesnet-unity](https://github.com/jgriffith3433/hawkesnet-unity) (its home), for the download at `/sdk/com.hawkes.net.tgz` and the WebGL bridge's test |
| `public/` | net.hawkesgen.com's pages: the developer dashboard (`dashboard.html`) and the demo (`demo.html`) |
| `projects.json` | Hawkes's own games' room shapes and limits |
| `deploy/` | The box: `setup.mjs` (one-time, from J's PC), systemd units, Caddy, `pull.mjs` (it deploys itself from main) |
| `tools/` | `net-dev.mjs` (the service on this PC), `net-load.mjs` (the load test) |
| `docs/net.md` | The design and what is built |

```bash
npm install          # only TypeScript, for the typecheck: the service has no runtime dependencies
npm test             # the service, relay, SDK and Unity bridge, in this process
npm run dev          # http://127.0.0.1:8786 with a scratch data folder
```

Hawkes Gen (`jgriffith3433/hawkesgen`) is asked only to check API keys (`GET /v1/net/whoami`) and is sent usage once a
minute (`POST /v1/net/usage`); accounts are hawkesgen.com's. Pushing `main` deploys: the box tests the new commit on a
clean copy, restarts and checks health, and goes back on a failure.
