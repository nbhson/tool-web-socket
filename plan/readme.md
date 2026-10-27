# Plan — tool-web-socket

WebSocket server (Node) + UI, docker-compose, vitest.

## Baseline audit (00:44, 28-10-2026)
- Tests: ✅ **6 pass** (1 file)
- Cấu trúc: `server/` (app.js + test) + `ui/` (app.js, index.html, styles.css) + docker-compose.yml

## P1 #2 (28-10-2026) — Hardening
### Issues fixed
- **[Bug]** Heartbeat: `HEARTBEAT_TIMEOUT` was declared but never used — dead code.
  Replaced with working `isAlive` pattern (matches hub.js): server pings each client,
  terminates those that miss a pong (unresponsive after 1 missed heartbeat).
- **[Bug]** No message size limit: added `maxPayload: MAX_MESSAGE_SIZE` (4 KB) to
  `WebSocket.Server`. Protocol-level enforcement with close code 1009.
  Application-level length guard as defence-in-depth.
- **[Bug]** No rate limiting: added per-socket sliding window (20 msgs / 10 s, configurable).
  On breach: server sends error JSON and closes with 1008.
- ✅ Disconnect handling: already correct (`removeClient` on `close` event).
- ✅ XSS sanitization: UI (`ui/app.js`) uses `textContent` everywhere — safe.

### Tests added (hardening.test.js — 7 tests, all pass)
- Message size limit: 10 KB frame → close 1009.
- Rate limiting: 25-burst → error message + close 1008.
- Disconnect: stdout includes "Client disconnected" after close.
- Heartbeat ping-pong: client receives ping events from server.
- Dead-client termination: raw TCP client that never pongs → TCP RST within ~600 ms.

### Final test count: **13/13** ✅

## Roadmap
### P0
- [x] Review app.js server: rate limit, message size limit, error handling khi client disconnect
- [x] Review UI: reconnect logic, XSS khi render message

### P1 (chất lượng)
- [x] Bổ sung tests: heartbeat/ping-pong, nhiều client, malformed message
- [ ] Hardening docker-compose (non-root user, healthcheck)

### P2
- [ ] CI workflow
- [ ] README sync

## Self-review log
- _0:44_ Audit lần 1: 6/6 pass.
- _1:16_ P1 #2 hardened: isAlive heartbeat, rate limiting, maxPayload, XSS confirmed safe.
  13/13 pass.
