/**
 * Hardening tests: heartbeat/ping-pong, dead-client termination,
 * message size limit, rate limiting, and disconnect cleanup.
 *
 * Uses its own server instances on ports 8083/8084 to avoid clashing
 * with app.test.js (port 8081).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'child_process';

const PORT = 8083;
const HB_PORT = 8084;

/**
 * Spawns `node app.js` with custom env and waits for readiness.
 * @param {number} port
 * @param {Record<string, string>} [extraEnv]
 * @returns {Promise<{ proc: import('child_process').ChildProcess, getOutput: () => string }>}
 */
function startServer(port, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', ['app.js'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    proc.stdout.on('data', (d) => { output += d.toString(); });
    proc.stderr.on('data', (d) => { output += d.toString(); });

    const tryConnect = (attempts = 0) => {
      if (attempts >= 25) {
        reject(new Error(`Server not ready on ${port}.\nOutput: ${output}`));
        return;
      }
      const probe = new WebSocket(`ws://127.0.0.1:${port}`);
      probe.on('open', () => {
        probe.close();
        resolve({ proc, getOutput: () => output });
      });
      probe.on('error', () => setTimeout(() => tryConnect(attempts + 1), 200));
    };

    tryConnect();
  });
}

/** Opens a WebSocket connection and resolves once ready. */
function connect(port) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    const timer = setTimeout(() => { socket.close(); reject(new Error('connect timeout')); }, 5000);
    socket.on('open', () => { clearTimeout(timer); resolve(socket); });
    socket.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

/** Resolves with the next JSON message on a socket. */
function nextMessage(socket) {
  return new Promise((resolve) => {
    const handler = (data) => {
      socket.removeListener('message', handler);
      resolve(JSON.parse(data.toString()));
    };
    socket.on('message', handler);
  });
}

/** Resolves with the close info of a socket. */
function waitClose(socket) {
  return new Promise((resolve) => {
    socket.on('close', (code) => resolve({ code }));
    socket.on('error', () => resolve({ code: null }));
  });
}

// ── Tests against the main instance (default env) ──────────────────────────────

describe('Hardening: message size & rate limiting', () => {
  /** @type {{ proc: import('child_process').ChildProcess, getOutput: () => string }|null} */
  let server;

  beforeAll(async () => {
    server = await startServer(PORT);
  });

  it('closes the connection when a message exceeds maxPayload (1009)', async () => {
    const socket = await connect(PORT);
    const closed = waitClose(socket);
    // 10 KB frame > 4 KB maxPayload
    socket.send(JSON.stringify({ type: 'chat', ip: 'x', uid: 'u', message: 'a'.repeat(10_000) }));
    const { code } = await closed;
    expect(code).toBe(1009);
  });

  it('rate-limits clients that flood messages (error + close 1008)', async () => {
    const socket = await connect(PORT);
    const closeInfo = waitClose(socket);

    // Default RATE_LIMIT_MAX = 20 per 10s — fire 25 in a burst.
    for (let i = 0; i < 25; i++) {
      socket.send(JSON.stringify({ type: 'chat', ip: 'x', uid: 'u', message: `spam ${i}` }));
    }

    // Error arrives before the close.
    const errorMsgPromise = nextMessage(socket).catch(() => null);
    const msg = await errorMsgPromise;
    expect(msg).not.toBeNull();
    expect(msg.type).toBe('error');
    expect(msg.message).toMatch(/rate limit/i);
    // Wait for the close (1008) after the error has been received.
    const { code } = await closeInfo;
    expect(code).toBe(1008);
  });

  it('logs disconnect when a client closes', async () => {
    const socket = await connect(PORT);
    socket.close();
    await waitClose(socket);
    // Allow the server to process the close and log it.
    await new Promise((r) => setTimeout(r, 500));
    expect(server.getOutput()).toMatch(/Client disconnected/);
  }, 10_000);

  it('terminates server instance after tests', async () => {
    if (server) {
      server.proc.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 300));
    }
    expect(true).toBe(true);
  });
});

// ── Tests against a fast-heartbeat instance ────────────────────────────────────

describe('Hardening: heartbeat / ping-pong', () => {
  /** @type {{ proc: import('child_process').ChildProcess, getOutput: () => string }|null} */
  let hbServer;

  beforeAll(async () => {
    hbServer = await startServer(HB_PORT, { HEARTBEAT_INTERVAL: '200' });
  });

  it('sends pings to connected clients and receives pongs (stays alive)', async () => {
    const socket = await connect(HB_PORT);

    const pingPromise = new Promise((resolve) => {
      // ws emits 'ping' for every ping frame received from the server.
      socket.on('ping', resolve);
    });
    const ping = await pingPromise;
    expect(ping).toBeDefined();

    // ws auto-responds pong → the client must remain OPEN after 2+ rounds.
    await new Promise((r) => setTimeout(r, 700));
    expect(socket.readyState).toBe(WebSocket.OPEN);
    socket.close();
  });

  it('terminates clients that never respond to pings', async () => {
    // Raw TCP client: completes the WS handshake, then never pongs.
    // Server should terminate it within ~2 heartbeat rounds (~400-600ms).
    const { socket } = await rawHandshake(HB_PORT);

    const closed = new Promise((resolve) => socket.on('close', resolve));
    const timeout = new Promise((resolve) => setTimeout(() => resolve('timeout'), 1500));

    const result = await Promise.race([closed.then(() => 'closed'), timeout]);
    expect(result).toBe('closed');
    socket.destroy();
  });

  it('terminates server instance after tests', async () => {
    if (hbServer) {
      hbServer.proc.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 300));
    }
    expect(true).toBe(true);
  });
});

/**
 * Performs a raw WebSocket handshake over TCP and returns the socket
 * without ever responding to pings (simulates a dead client).
 * @param {number} port
 * @returns {Promise<{ socket: import('net').Socket }>}
 */
function rawHandshake(port) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const socket = net.connect(port, '127.0.0.1');
    let buf = Buffer.alloc(0);

    socket.on('connect', () => {
      socket.write(
        `GET / HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${port}\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\n` +
        `Sec-WebSocket-Version: 13\r\n\r\n`
      );
    });

    socket.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.toString('latin1').includes('\r\n\r\n')) {
        const head = buf.toString('latin1').split('\r\n')[0];
        if (head.includes('101')) {
          resolve({ socket });
        } else {
          socket.destroy();
          reject(new Error(`Handshake failed: ${head}`));
        }
      }
    });

    socket.on('error', reject);
  });
}
