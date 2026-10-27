/**
 * WebSocket Server — Chat Demo
 * @description A simple broadcast WebSocket chat server with heartbeat,
 *              client limits, and graceful shutdown.
 * @module server/app
 */

'use strict';

const WebSocket = require('ws');

/** @type {number} Server port */
const PORT = process.env.PORT || 8080;

/** @type {string} Server bind address */
const HOST = process.env.HOST || '0.0.0.0';

/** @type {number} Maximum number of simultaneous clients */
const MAX_CLIENTS = process.env.MAX_CLIENTS ? parseInt(process.env.MAX_CLIENTS, 10) : 50;

/** @type {number} Heartbeat interval in milliseconds (ping sent to each client) */
const HEARTBEAT_INTERVAL = 30000;

/** @type {number} Time in ms after which an unresponsive client is considered dead */
const HEARTBEAT_TIMEOUT = 35000;

/** @type {WebSocket.Server} */
const wss = new WebSocket.Server({ host: HOST, port: PORT });

/** @type {Set<import('ws').WebSocket>} Active client sockets */
const clients = new Set();

/** @type {Map<import('ws').WebSocket, NodeJS.Timeout>} Heartbeat timers keyed by socket */
const heartbeatTimers = new Map();

/**
 * Starts a ping timer for a given socket.
 * If the client doesn't respond (pong) within HEARTBEAT_TIMEOUT,
 * its connection is terminated.
 * @param {import('ws').WebSocket} socket
 */
function startHeartbeat(socket) {
  // Stop any existing timer for this socket before starting a new one.
  const existing = heartbeatTimers.get(socket);
  if (existing) clearInterval(existing);

  const timer = setInterval(() => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.ping();
    } else {
      clearInterval(timer);
      heartbeatTimers.delete(socket);
    }
  }, HEARTBEAT_INTERVAL);

  heartbeatTimers.set(socket, timer);

  // Reset the same timer on each pong — no recreation needed.
  socket.on('pong', () => {
    // Client is alive; the existing interval continues.
  });
}

/**
 * Stops and clears all heartbeat timers.
 */
function clearAllHeartbeats() {
  for (const timer of heartbeatTimers.values()) {
    clearInterval(timer);
  }
  heartbeatTimers.clear();
}

/**
 * Removes a socket from tracking and cleans up its heartbeat.
 * @param {import('ws').WebSocket} socket
 */
function removeClient(socket) {
  clients.delete(socket);
  const timer = heartbeatTimers.get(socket);
  if (timer) {
    clearInterval(timer);
    heartbeatTimers.delete(socket);
  }
  console.log(`[Server] Client disconnected. Active clients: ${clients.size}`);
}

/**
 * Broadcasts a message to all connected clients with OPEN state.
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

wss.on('connection', (socket, req) => {
  if (clients.size >= MAX_CLIENTS) {
    console.warn(`[Server] Connection rejected — max clients (${MAX_CLIENTS}) reached.`);
    socket.send(JSON.stringify({ type: 'error', message: 'Server is at full capacity. Try again later.' }));
    socket.close();
    return;
  }

  const clientIp = req.socket.remoteAddress || 'unknown';
  clients.add(socket);
  console.log(`[Server] Client connected from ${clientIp}. Active clients: ${clients.size}`);

  // Start heartbeat for this client
  startHeartbeat(socket);

  socket.on('message', (raw) => {
    /** @type {string} */
    let messageStr;
    try {
      messageStr = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
    } catch (err) {
      console.error('[Server] Failed to decode message:', err);
      socket.send(JSON.stringify({ type: 'error', message: 'Failed to decode message.' }));
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(messageStr);
    } catch {
      console.error('[Server] Invalid JSON received:', messageStr);
      socket.send(JSON.stringify({ type: 'error', message: 'Invalid JSON format.' }));
      return;
    }

    const { ip, uid, message, type } = parsed;

    // Handle join messages
    if (type === 'join') {
      console.log(`[Server] User joined: ${ip} (${uid})`);
      broadcast({ type: 'system', message: `User ${ip} joined the chat.`, timestamp: Date.now() }, socket);
      return;
    }

    // Handle regular chat messages
    if (!message || typeof message !== 'string') {
      socket.send(JSON.stringify({ type: 'error', message: 'Message field is required.' }));
      return;
    }

    console.log(`[Server] Broadcast from ${ip} (${uid}): ${message}`);
    broadcast({
      type: 'chat',
      ip,
      uid,
      message: message.trim(),
      timestamp: Date.now(),
    }, socket);
  });

  socket.on('error', (err) => {
    console.error(`[Server] Socket error for ${clientIp}:`, err.message);
  });

  socket.on('close', () => {
    removeClient(socket);
  });

  socket.on('pong', () => {
    // Heartbeat response received — handled in startHeartbeat
  });
});

wss.on('error', (err) => {
  console.error('[Server] WebSocket server error:', err);
});

/**
 * Gracefully shuts down the server.
 * Closes all client connections and stops accepting new ones.
 * @param {string} signal
 */
function gracefulShutdown(signal) {
  console.log(`\n[Server] Received ${signal}. Starting graceful shutdown...`);
  clearAllHeartbeats();

  for (const client of clients) {
    try {
      client.send(JSON.stringify({ type: 'system', message: 'Server is shutting down.' }));
      client.close(1001, 'Server shutdown');
    } catch (err) {
      // Ignore errors during cleanup
    }
  }
  clients.clear();

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

console.log(`[Server] WebSocket server running on ws://${HOST}:${PORT}`);
console.log(`[Server] Max clients: ${MAX_CLIENTS} | Heartbeat: ${HEARTBEAT_INTERVAL}ms`);
