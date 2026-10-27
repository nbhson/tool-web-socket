/**
 * WebSocket Server — Chat Demo
 * @description A simple broadcast WebSocket chat server with heartbeat,
 *              client limits, rate limiting, and graceful shutdown.
 * @module server/app
 */

'use strict';

const WebSocket = require('ws');

// ── Configuration (all overridable via environment) ───────────────────────────

/** @type {number} Server port */
const PORT = process.env.PORT || 8080;

/** @type {string} Server bind address */
const HOST = process.env.HOST || '0.0.0.0';

/** @type {number} Maximum number of simultaneous clients */
const MAX_CLIENTS = process.env.MAX_CLIENTS ? parseInt(process.env.MAX_CLIENTS, 10) : 50;

/**
 * Heartbeat interval in milliseconds (ping sent to each client).
 * Configure via HEARTBEAT_INTERVAL env var.
 * @type {number}
 */
const HEARTBEAT_INTERVAL =
  process.env.HEARTBEAT_INTERVAL
    ? parseInt(process.env.HEARTBEAT_INTERVAL, 10)
    : 30_000;

/** @type {number} Maximum incoming message size in bytes (default 4 KB). */
const MAX_MESSAGE_SIZE =
  process.env.MAX_MESSAGE_SIZE
    ? parseInt(process.env.MAX_MESSAGE_SIZE, 10)
    : 4 * 1024;

/** @type {number} Maximum messages per client per rate-limit window. */
const RATE_LIMIT_MAX =
  process.env.RATE_LIMIT_MAX ? parseInt(process.env.RATE_LIMIT_MAX, 10) : 20;

/** @type {number} Rate-limit window in milliseconds (default 10 s). */
const RATE_LIMIT_WINDOW_MS =
  process.env.RATE_LIMIT_WINDOW_MS
    ? parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10)
    : 10_000;

// ── WebSocket server ───────────────────────────────────────────────────────────

/**
 * @type {WebSocket.Server}
 * @description
 *   maxPayload: closes connections that send frames larger than MAX_MESSAGE_SIZE
 *               (close code 1009 — Message Too Big).
 *               Protocol-level enforcement; application can add a tighter limit
 *               on the message string length.
 */
const wss = new WebSocket.Server({
  host: HOST,
  port: PORT,
  maxPayload: MAX_MESSAGE_SIZE,
});

// ── State ─────────────────────────────────────────────────────────────────────

/** @type {Set<import('ws').WebSocket>} Active client sockets */
const clients = new Set();

/** @type {Map<import('ws').WebSocket, Array<number>>} Per-socket message timestamps for rate limiting */
const messageTimestamps = new Map();

/**
 * Heartbeat: pings each client and terminates those that miss a pong.
 * Uses isAlive flag — set true on connection and on each pong response,
 * set false before each ping. Clients that don't respond get terminated.
 */
const heartbeatTimer = setInterval(() => {
  for (const socket of wss.clients) {
    if (socket.isAlive === false) {
      // Client failed to respond to the last ping — force close.
      console.log('[Server] Client missed pong — terminating.');
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    if (socket.readyState === WebSocket.OPEN) {
      socket.ping();
    }
  }
}, HEARTBEAT_INTERVAL);
if (heartbeatTimer.unref) heartbeatTimer.unref();

/**
 * Cleans up all client state.
 * Called on socket close; removes from tracking sets and clears rate-limit data.
 * @param {import('ws').WebSocket} socket
 */
function removeClient(socket) {
  clients.delete(socket);
  messageTimestamps.delete(socket);
  console.log(`[Server] Client disconnected. Active clients: ${clients.size}`);
}

/**
 * Checks whether a client has exceeded the rate limit.
 * Resets the window automatically on each call.
 * @param {import('ws').WebSocket} socket
 * @returns {boolean} true if the client is now rate-limited
 */
function isRateLimited(socket) {
  const now = Date.now();
  const window = RATE_LIMIT_WINDOW_MS;
  const timestamps = (messageTimestamps.get(socket) ?? []).filter(
    (t) => now - t < window
  );
  if (timestamps.length >= RATE_LIMIT_MAX) {
    messageTimestamps.set(socket, timestamps);
    return true;
  }
  timestamps.push(now);
  messageTimestamps.set(socket, timestamps);
  return false;
}

/**
 * Broadcasts a message to all connected clients with OPEN state,
 * excluding the optional sender socket.
 * @param {object} data - Serializable payload
 * @param {import('ws').WebSocket} [exclude] - Optional socket to skip
 */
function broadcast(data, exclude) {
  const payload = JSON.stringify(data);
  for (const client of clients) {
    if (client !== exclude && client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

// ── Connection handler ─────────────────────────────────────────────────────────

wss.on('connection', (socket, req) => {
  // ── Capacity check ──────────────────────────────────────────────────────────
  if (clients.size >= MAX_CLIENTS) {
    console.warn(
      `[Server] Connection rejected — max clients (${MAX_CLIENTS}) reached.`
    );
    socket.send(
      JSON.stringify({
        type: 'error',
        message: 'Server is at full capacity. Try again later.',
      })
    );
    socket.close(1013, 'Server full');
    return;
  }

  const clientIp = req.socket.remoteAddress || 'unknown';
  clients.add(socket);
  console.log(
    `[Server] Client connected from ${clientIp}. Active clients: ${clients.size}`
  );

  // Heartbeat: initialise isAlive flag
  socket.isAlive = true;

  socket.on('pong', () => {
    // Client responded to ping — mark alive for the next heartbeat round.
    socket.isAlive = true;
  });

  // ── Message handler ─────────────────────────────────────────────────────────
  socket.on('message', (raw) => {
    // Rate-limit check before any decoding to reject floods early.
    if (isRateLimited(socket)) {
      console.warn(`[Server] Rate limit exceeded for ${clientIp}.`);
      socket.send(
        JSON.stringify({
          type: 'error',
          message: 'Rate limit exceeded. Please slow down.',
        })
      );
      socket.close(1008, 'Rate limit exceeded');
      return;
    }

    /** @type {string} */
    let messageStr;
    try {
      // Handle Buffer (Node ws) or string raw payloads.
      messageStr = Buffer.isBuffer(raw)
        ? raw.toString('utf8')
        : String(raw);
    } catch (err) {
      console.error('[Server] Failed to decode message:', err);
      socket.send(
        JSON.stringify({
          type: 'error',
          message: 'Failed to decode message.',
        })
      );
      return;
    }

    // Protocol-level maxPayload already closes oversized frames at the ws layer
    // (close 1009). Application-level length check as a secondary defence.
    if (messageStr.length > MAX_MESSAGE_SIZE) {
      socket.send(
        JSON.stringify({
          type: 'error',
          message: `Message exceeds maximum length of ${MAX_MESSAGE_SIZE} bytes.`,
        })
      );
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(messageStr);
    } catch {
      console.error('[Server] Invalid JSON received:', messageStr);
      socket.send(
        JSON.stringify({
          type: 'error',
          message: 'Invalid JSON format.',
        })
      );
      return;
    }

    const { ip, uid, message, type } = parsed;

    // Handle join messages
    if (type === 'join') {
      console.log(`[Server] User joined: ${ip} (${uid})`);
      broadcast(
        {
          type: 'system',
          message: `User ${ip} joined the chat.`,
          timestamp: Date.now(),
        },
        socket
      );
      return;
    }

    // Handle regular chat messages
    // Validate that message is a non-empty string.
    if (typeof message !== 'string' || message.trim().length === 0) {
      socket.send(
        JSON.stringify({
          type: 'error',
          message: 'Message field is required.',
        })
      );
      return;
    }

    console.log(`[Server] Broadcast from ${ip} (${uid}): ${message.trim()}`);
    broadcast(
      {
        type: 'chat',
        ip,
        uid,
        message: message.trim(),
        timestamp: Date.now(),
      },
      socket
    );
  });

  socket.on('error', (err) => {
    console.error(`[Server] Socket error for ${clientIp}:`, err.message);
    // Client is removed from tracking when 'close' fires (guaranteed by ws spec).
  });

  socket.on('close', () => {
    removeClient(socket);
  });
});

wss.on('error', (err) => {
  console.error('[Server] WebSocket server error:', err);
});

// ── Graceful shutdown ───────────────────────────────────────────────────────────

/**
 * Gracefully shuts down the server.
 * Stops the heartbeat loop, notifies all clients, and closes the server.
 * @param {string} signal
 */
function gracefulShutdown(signal) {
  console.log(
    `\n[Server] Received ${signal}. Starting graceful shutdown...`
  );
  clearInterval(heartbeatTimer);

  for (const client of clients) {
    try {
      client.send(
        JSON.stringify({
          type: 'system',
          message: 'Server is shutting down.',
        })
      );
      client.close(1001, 'Server shutdown');
    } catch {
      // Ignore errors during cleanup — client may already be gone.
    }
  }
  clients.clear();
  messageTimestamps.clear();

  wss.close((err) => {
    if (err) {
      console.error('[Server] Error during close:', err);
      process.exit(1);
    }
    console.log('[Server] WebSocket server closed.');
    process.exit(0);
  });
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ── Startup ────────────────────────────────────────────────────────────────────

console.log(`[Server] WebSocket server running on ws://${HOST}:${PORT}`);
console.log(
  `[Server] Max clients: ${MAX_CLIENTS} | Heartbeat: ${HEARTBEAT_INTERVAL}ms | Max message: ${MAX_MESSAGE_SIZE}B`
);
