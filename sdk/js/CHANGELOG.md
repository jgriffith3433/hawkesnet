# Changelog

## 1.4.3

- **Deploy drain:** on SIGTERM / a deploy restart the node pushes a `draining` control frame before sockets close. The SDK clears the resume token and rejoins the same room name with a fresh ticket at once (fast retries while the process is briefly down). Builds on the `_resuming` fallback from 1.4.1; no polling.

## 1.4.2

Previous release.
