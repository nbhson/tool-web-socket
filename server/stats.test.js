/**
 * Tests for the light round-2 features:
 * - Message type enum: application-layer ping → pong
 * - HTTP /stats endpoint (aggregate stats only, no per-IP data)
 *
 * Uses its own server instance on port 8089.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import { spawn } from 'child_process';

const PORT = 8089;

/** @type {import('child_process').ChildProcess | null} */
let proc;

/**
 * Spawns `node app.js` with custom env and waits for readiness.
 * @returns {Promise<import('child_process').ChildProcess>}
 */
function startServer(port, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['app.js'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.resume();
    child.stderr.resume();

    const tryConnect = (attempts = 0) => {
      if (attempts >= 25) {
        reject(new Error(`Server not ready on ${port}.`));
        return;
      }
      const probe = new WebSocket(`ws://127.0.0.1:${port}`);
      probe.on('open', () => {
        probe.close();
        resolve(child);
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

describe('Protocol: application-layer ping/pong', () => {
  beforeAll(async () => {
    proc = await startServer(PORT);
  });

  afterAll(async () => {
    proc?.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 200));
  });

  it('answers a {type:"ping"} with {type:"pong"}', async () => {
    const socket = await connect(PORT);
    const pongPromise = nextMessage(socket);
    socket.send(JSON.stringify({ type: 'ping' }));
    const msg = await pongPromise;
    expect(msg.type).toBe('pong');
    expect(typeof msg.timestamp).toBe('number');
    socket.close();
  });
});

describe('HTTP /stats endpoint', () => {
  beforeAll(async () => {
    proc = await startServer(PORT);
  });

  afterAll(async () => {
    proc?.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 200));
  });

  it('returns aggregate stats and no per-IP data', async () => {
    const socket = await connect(PORT); // one active client
    const resp = await fetch(`http://127.0.0.1:${PORT}/stats`);
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.clients).toBe(1);
    expect(body.maxClients).toBeGreaterThan(0);
    expect(body.maxClientsPerIp).toBeGreaterThan(0);
    expect(body.rateLimit.max).toBeGreaterThan(0);
    expect(body.rateLimit.windowMs).toBeGreaterThan(0);
    expect(typeof body.uptimeSeconds).toBe('number');
    // No per-IP or per-client data must leak through /stats.
    expect(JSON.stringify(body)).not.toMatch(/127\.0\.0\.1/);
    expect(body.addresses).toBeUndefined();
    expect(body.ips).toBeUndefined();
    socket.close();
  });

  it('returns 404 for other HTTP paths', async () => {
    const resp = await fetch(`http://127.0.0.1:${PORT}/nope`);
    expect(resp.status).toBe(404);
  });
});
