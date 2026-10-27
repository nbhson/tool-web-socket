# WebSocket Chat Demo

A minimal real-time chat demo using raw WebSocket (`ws` library) on Node.js, with a plain HTML/CSS/JS frontend. Designed as a learning reference, not a production system.

---

## Features

- **Broadcast** — messages are relayed to all connected clients.
- **Heartbeat / ping-pong** — server detects and cleans up stale connections.
- **Client limit** — configurable maximum simultaneous connections (default: 50).
- **Graceful shutdown** — responds to `SIGTERM`/`SIGINT` cleanly.
- **Dark mode** — toggle between light and dark themes.
- **Connection status indicator** — live feedback on WebSocket state.
- **Auto-reconnect** — client retries with exponential backoff on disconnect.
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

### Environment variables (server)

| Variable       | Default | Description                                |
|----------------|---------|--------------------------------------------|
| `PORT`         | `8080`  | WebSocket server port                      |
| `HOST`         | `0.0.0.0` | Address to bind                          |
| `MAX_CLIENTS`  | `50`    | Maximum simultaneous client connections    |

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

---

## Project Structure

```
.
├── server/          # WebSocket server (Node.js)
│   ├── app.js       # Server entry point
│   ├── app.test.js  # Unit tests (vitest)
│   ├── package.json
│   ├── Dockerfile
│   └── vitest.config.js
├── ui/              # Frontend (plain HTML/CSS/JS)
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
