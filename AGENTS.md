# Hawkes Net — agent guide

**Lanes, local dev and deploys:** `LANES.md` (branches dev -> beta -> main; `dev.bat`, `deploy-beta.bat`, `deploy-prod.bat`, `status.bat`, `links.bat`, `sync.bat`; beta and live links).

The multiplayer service for every Hawkes game and for outside developers (net.hawkesgen.ai). `README.md` has the layout,
`docs/net.md` the design and what is built (its first section wins over the rest). This repo was Hawkes Gen's `net/`
folder until 2026-10-26 (J: "I would like hawkesnet to be its own standalone repository"); its history before that is in
`jgriffith3433/hawkesgen`.

**The dashboard's names** (2026-10-29, hawkesgenwebsite `docs/domain-move.md`): the portal moves to hawkesgames.com, so
the dashboard is **net.hawkesgames.com** (beta **net-beta.hawkesgames.com**): it reads the portal with its session cookie,
which only goes to the same site. The relay, tickets and SDKs stay on net.hawkesgen.ai / hawkesnet.hawkesgen.ai, and the
dashboard page there sends visitors to its new name. Caddy serves both (`deploy/Caddyfile`, `deploy/lane.mjs`
`dashboard`); a Caddy change reaches a box only through `node deploy/setup.mjs [--lane beta]`.

## Hard rules

- **Work goes to `beta`; `main` is live.** Hawkes Studio has hawkesnet as a product (products.json `hawkesnet`): it runs
  beta as an app (its own data folder and Gen key), playtests it, and going live is the Go live page's card (J's tap, or
  `DEPLOY hawkesnet`), which fast-forwards `main` to the playtested beta commit. Each box deploys its lane itself
  (`deploy/pull.mjs`, every 2 minutes: tests on a clean copy, restart with the relay draining, health check, back on
  failure). Never push `main` by hand. Run `npm run typecheck` and `npm test` first. Commit only your own files.
- **Two boxes, one per lane; beta never touches live** (J, 2026-10-29; `deploy/lane.mjs`, test `test/lanes.test.ts`):

  | | Beta | Live |
  |---|---|---|
  | Address | https://hawkesnet.hawkesgen.ai | https://net.hawkesgen.ai |
  | Box | VM `hawkes-net-beta` (hawkes-prod, us-east1-b, e2-micro, free tier), made by `deploy/provision-gce.mjs` | VM `hawkes-net` (hawkes-prod, us-east4-c, e2-small, 34.86.89.28) |
  | Follows (`NET_DEPLOY_BRANCH` in its net.env) | `beta` | `main` (also when the line is missing) |
  | Checks API keys with (`NET_GEN_URL`, `/v1/net/whoami`) | gen-beta.hawkesgen.ai, its own "hawkesnet" key there | gen.hawkesgen.ai |
  | Data, SSH key, state | its own disk; `net_beta_ed25519`, `net-beta.json` | `net_ed25519`, `net.json` |

  Set up either with `node deploy/setup.mjs [--lane beta]` (it refuses a box whose settings name the other lane's Gen or
  branch). The portal's beta (beta.hawkesgen.ai, keys `ustg_*`) plays on beta Net; the beta dashboard signs in there.
  Games' beta sites reach beta Net through `window.HAWKES_NET_ENDPOINT`.
- **No runtime dependencies.** Node 24 runs the TypeScript directly (type stripping): erasable syntax only (no enums, no
  namespaces, no parameter properties), imports end in `.ts`.
- **One core, two places.** `sdk/js/hawkes-net-core.mjs` runs in relay nodes and in a peer-to-peer host's page. A change
  to the protocol must keep older pages working (a bundle item a page doesn't know is skipped by its length; never reuse a
  `TAG` number). Bump `VERSION` in the core and `sdk/js/package.json` together when behaviour changes.
- **The SDK is public** (`@hawkesgen/net`, MIT); this repo is private. Never put a secret, a project's key or anything
  about the box in `sdk/`.
- **Consumers:** games keep a copy of `sdk/js` or install `@hawkesgen/net`; Unity games install `com.hawkes.net` from **hawkesnet-unity** (public, its home; `sdk/unity/` here is a copy for the download at `/sdk/com.hawkes.net.tgz` and the bridge's test: copy it again after a release there)
  (`Packages/com.hawkes.net`) and load the SDK from `https://net.hawkesgen.ai/sdk/hawkes-net@1.mjs`. After an SDK change,
  tell the products that keep a copy (Dose Of Destruction `src/game/net/hawkes/`, the portal `public/play/`, Yooba Land
  and Sick Of It's `Packages/com.hawkes.net`).
- Secrets live on the box in `/etc/hawkes/net.env` (a Gen key for the project `hawkesnet`); never commit, print or log them.
- Anything that costs money (a bigger box, more relay boxes) needs J's OK.

## Run and check

```bash
npm install && npm run typecheck && npm test
npm run dev                  # the service on this PC (tools/net-dev.mjs), scratch data
node tools/net-load.mjs      # the load test (--url tests a real service from outside)
```

`test/helper.ts` starts the whole service in a test process; other repos use it too (Dose Of Destruction's
`tools/online-live.test.ts` imports it from a hawkesnet checkout).
