# Hawkes Net — agent guide

**Lanes, local dev and deploys:** `LANES.md` (branches dev -> beta -> main; `dev.bat`, `deploy-beta.bat`, `deploy-prod.bat`, `status.bat`, `links.bat`, `sync.bat`; beta and live links).

The multiplayer service for every Hawkes game and for outside developers (net.hawkesgen.ai). `README.md` has the layout,
`docs/net.md` the design and what is built (its first section wins over the rest). This repo was Hawkes Gen's `net/`
folder until 2026-10-26 (J: "I would like hawkesnet to be its own standalone repository"); its history before that is in
`jgriffith3433/hawkesgen`.

## Hard rules

- **Work goes to `beta`; `main` is live.** Hawkes Studio has hawkesnet as a product (products.json `hawkesnet`): it runs
  beta as an app (its own data folder and Gen key), playtests it, and going live is the Go live page's card (J's tap, or
  `DEPLOY hawkesnet`), which fast-forwards `main` to the playtested beta commit. The box then deploys `main` itself
  (`deploy/pull.mjs`, every 2 minutes: tests on a clean copy, restart with the relay draining, health check, back on
  failure). Never push `main` by hand. Run `npm run typecheck` and `npm test` first. Commit only your own files.
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
