# Changelog

## 1.4.4

- **sync.state after a late wire:** `_s` that arrives before `sync.state(name)` is registered is kept and applied when the handler is added (smoke bot wiring after a p2p→relay move). Host also pushes synced states immediately on the migrated hello, not only on the next 1 s upkeep tick.

## 1.4.3

- **Deploy drain:** on SIGTERM / a deploy restart the node pushes a `draining` control frame before sockets close. The SDK clears the resume token and rejoins the same room name with a fresh ticket at once (fast retries while the process is briefly down). Builds on the `_resuming` fallback from 1.4.1; no polling.

## 1.4.2

Previous release.
