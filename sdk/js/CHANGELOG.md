# Changelog

## 1.4.7

- **Faster return after a drop:** reconnect tries come every 0.3 s doubling to a steady 1.2 s (with a little jitter) for the 15 s grace, instead of 0.5 s doubling to 8 s, so a player whose network is cut for 5 s is back within ~1.5 s of it returning, with the same id, name, colour and place (resume), and others never see a leave and a join.

## 1.4.6

- **Draining notice:** when the service restarts it pushes a `draining` notice to every client before closing; the SDK skips the doomed resume and rejoins its room at once with a fresh ticket, under the same room name. No polling.

## 1.4.5

- **Migrate seed freshness:** before the host answers a migrate `seed` request it flushes live `sync.state` into the p2p room, and a new stream clears `st.t` with `st.sent` so the immediate post-migrate `_syncStates` is never rate-limited. Stops a stale relay seed (actions changed orbs/scores after the last `_s`) from leaving peers mismatched until the next 1 s upkeep tick.

## 1.4.4

- **sync.state after a late wire:** `_s` that arrives before `sync.state(name)` is registered is kept and applied when the handler is added (smoke bot wiring after a p2p→relay move). Host also pushes synced states immediately on the migrated hello, not only on the next 1 s upkeep tick.

## 1.4.3

- **Deploy drain:** on SIGTERM / a deploy restart the node pushes a `draining` control frame before sockets close. The SDK clears the resume token and rejoins the same room name with a fresh ticket at once (fast retries while the process is briefly down). Builds on the `_resuming` fallback from 1.4.1; no polling.

## 1.4.2

Previous release.
