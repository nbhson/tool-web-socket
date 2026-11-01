# WebSocket Chat Demo

A minimal real-time chat demo using raw WebSocket (`ws` library) on Node.js, with a plain HTML/CSS/JS frontend. Designed as a learning reference, not a production system.

---

## Features

- **Broadcast** — messages are relayed to all connected clients.
- **Heartbeat / ping-pong** — server detects and terminates dead clients.
- **Client limit** — configurable maximum simultaneous connections (default: 50).
- **Per-IP limit** — caps simultaneous connections from a single IP (default: 10), enforced at the HTTP upgrade level.
- **Origin check** — optional allow-list for the WebSocket `Origin` header, enforced at the HTTP handshake level (403).
- **Rate limiting** — sliding window per client (20 messages / 10 s by default).
- **Message size limit** — frames larger than 4 KB are rejected (close 1009).
- **Stats endpoint** — `GET /stats` returns aggregate metrics (client count, limits, uptime).
- **Ping/pong message type** — clients can send `{"type":"ping"}` and receive `{"type":"pong"}` as an application-layer liveness check.
- **Graceful shutdown** — responds to `SIGTERM`/`SIGINT` cleanly.
- **Dark mode** — toggle between light and dark themes.
- **Connection status indicator** — live feedback on WebSocket state.
- **Auto-reconnect** — client retries with exponential backoff (±jitter) and a visible attempt counter; reconnects after server restarts as well (close 1001 included).
- **Rate-limit & rejection banners** — close codes 1008/1013 and rate-limit errors surface as clear, dismissible banners.
- **Responsive UI** — works on mobile and desktop.

---

## Quick Start (Local)

### Frontend

```bash
cd ui
# Serve index.html with any static server, e.g.:
npx serve .
# or use the Live Server extension in VS Code / WebStorm
```

Then open `http://localhost:3000` (or the port your server uses).

### Backend

```bash
cd server
npm install
npm start          # production
# or
npm run dev        # with auto-reload (Node >= 18 required)
```

The WebSocket server listens on `ws://localhost:8080`.

---

## Docker

### Build

```bash
docker-compose build --no-cache
```

### Run

```bash
docker-compose up --build
```

- Chat UI: http://localhost:80
- WebSocket server: `ws://localhost:8080`

Both services run unprivileged (server as the `node` user, UI on
`nginx-unprivileged` listening internally on 8080) and include healthchecks and
CPU/memory limits — see `docker-compose.yml`.

### Environment variables (server)

| Variable               | Default  | Description                                             |
|------------------------|----------|---------------------------------------------------------|
| `PORT`                 | `8080`   | WebSocket server port                                   |
| `HOST`                 | `0.0.0.0`| Address to bind                                         |
| `MAX_CLIENTS`          | `50`     | Maximum simultaneous client connections                 |
| `MAX_CLIENTS_PER_IP`   | `10`     | Maximum simultaneous connections from one IP            |
| `ALLOWED_ORIGIN`       | _(off)_  | If set, only this `Origin` is accepted (e.g. `https://chat.example.com`) |
| `HEARTBEAT_INTERVAL`   | `30000`  | Heartbeat ping interval (ms)                            |
| `MAX_MESSAGE_SIZE`     | `4096`   | Maximum incoming frame size in bytes                    |
| `RATE_LIMIT_MAX`       | `20`     | Messages allowed per rate-limit window                  |
| `RATE_LIMIT_WINDOW_MS` | `10000`  | Rate-limit window length (ms)                           |

When a client exceeds the rate limit the server sends an error message and closes
the connection with close code `1008`. Oversized frames are rejected by `ws` at
the protocol level with close code `1009`.

### Handshake rejection codes

Rejections that used to be WS close codes are now enforced at the HTTP upgrade
level (standard `ws` v9 pattern — handshakes are rejected before any WebSocket
resources are allocated):

| Situation                    | Before (close code) | Now (HTTP status) |
|------------------------------|---------------------|-------------------|
| `ALLOWED_ORIGIN` mismatch    | 1008                | 403 Forbidden     |
| Per-IP limit exceeded        | 1013                | 429 Too Many Requests |
| Server at `MAX_CLIENTS`      | 1013                | 1013 (unchanged — checked after handshake, so an explanatory error message can be sent) |

A handshake without an `Origin` header is still accepted when `ALLOWED_ORIGIN` is set.

### Stats endpoint

```bash
curl http://localhost:8080/stats
# {"clients":1,"maxClients":50,"maxClientsPerIp":10,
#  "rateLimit":{"max":20,"windowMs":10000},"uptimeSeconds":42}
```

Aggregate metrics only — no per-IP or per-client data is exposed.

### Message types

| `type`    | Direction        | Meaning                                        |
|-----------|------------------|------------------------------------------------|
| `ping`    | client → server  | Application-layer liveness probe               |
| `pong`    | server → client  | Response to `ping`                             |
| `data`    | —                | Reserved generic data type (enum constant)     |
| `join`    | client → server  | Announce presence (legacy, still supported)    |
| `chat`    | both             | Chat message broadcast (legacy, still supported) |
| `system`  | server → client  | Server-generated informational message         |
| `error`   | server → client  | Server-generated error message                 |

### Note on WebSocket URL

Inside the Docker network the UI cannot reach `localhost` from the container. The default `window.WS_URL` is `ws://localhost:8080`. Override it by setting `window.WS_URL` before the script loads or by using an ingress / reverse proxy.

---

## Testing

```bash
cd server
npm install
npm test        # run once
# or
npm run test:watch  # watch mode
```

## Linting

```bash
cd server
npm run lint        # check
npm run lint:fix    # auto-fix
```

---

## Project Structure

```
.
├── server/                  # WebSocket server (Node.js)
│   ├── app.js               # Server entry point
│   ├── protocol.js          # Message type enum (ping/pong/data/…)
│   ├── app.test.js          # Unit tests (vitest)
│   ├── hardening.test.js    # Heartbeat / rate-limit / maxPayload tests
│   ├── security.test.js     # Origin check / per-IP cap tests
│   ├── stats.test.js        # Ping/pong + /stats endpoint tests
│   ├── reconnect.test.js    # Client reconnect after server restart
│   ├── eslint.config.mjs    # ESLint flat config
│   ├── package.json
│   ├── Dockerfile
│   └── vitest.config.mjs
├── ui/                      # Frontend (plain HTML/CSS/JS)
│   ├── index.html
│   ├── styles.css
│   ├── app.js
│   └── Dockerfile
├── docker-compose.yml
└── README.md
```

---

## Deploy with Heroku

See [Heroku CLI docs](https://devcenter.heroku.com/articles/heroku-cli) for setup. For a Dockerfile-based deploy:

```bash
heroku container:push web
heroku container:release web
```
