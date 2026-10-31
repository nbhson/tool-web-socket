/**
 * Tests for the second hardening round:
 * - Origin check (ALLOWED_ORIGIN)
 * - Per-IP connection cap (MAX_CLIENTS_PER_IP)
 * - Metadata type validation (non-string ip/uid must not crash / leak objects)
 *
 * Uses its own server instances on ports 8085/8086/8087.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import { spawn } from 'child_process';

const ORIGIN_PORT = 8085;
const PERIP_PORT = 8086;

/**
 * Spawns `node app.js` with custom env and waits for readiness.
 * @param {number} port
 * @param {Record<string, string>} [extraEnv]
 * @returns {Promise<import('child_process').ChildProcess>}
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
    proc.stdout.resume();
    proc.stderr.resume();

    const tryConnect = (attempts = 0) => {
      if (attempts >= 25) {
        reject(new Error(`Server not ready on ${port}.`));
        return;
      }
      const probe = new WebSocket(`ws://127.0.0.1:${port}`);
      probe.on('open', () => {
        probe.close();
        resolve(proc);
      });
      probe.on('error', () => setTimeout(() => tryConnect(attempts + 1), 200));
    };
    tryConnect();
  });
}

/** Opens a WebSocket connection, optionally with a custom Origin header. */
function connect(port, origin) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: origin ? { Origin: origin } : undefined,
    });
    const timer = setTimeout(() => { socket.terminate(); reject(new Error('connect timeout')); }, 5000);
    socket.on('open', () => { clearTimeout(timer); resolve(socket); });
    socket.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

/** Resolves with the close code of a socket. */
function waitClose(socket) {
  return new Promise((resolve) => {
    socket.on('close', (code) => resolve(code));
    socket.on('error', () => resolve(null));
  });
}

describe('Hardening round 2: origin check', () => {
  let proc;

  beforeAll(async () => {
    proc = await startServer(ORIGIN_PORT, { ALLOWED_ORIGIN: 'http://good.example' });
  });

  afterAll(async () => {
    proc?.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 200));
  });

  it('accepts a connection with the allowed Origin', async () => {
    const socket = await connect(ORIGIN_PORT, 'http://good.example');
    expect(socket.readyState).toBe(WebSocket.OPEN);
    socket.close();
  });

  it('rejects a connection with a foreign Origin (close 1008)', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${ORIGIN_PORT}`, {
      headers: { Origin: 'http://evil.example' },
    });
    const code = await waitClose(socket);
    expect(code).toBe(1008);
  });

  it('rejects a forged chat message with non-string ip/uid (coerced, no crash)', async () => {
    const listener = await connect(ORIGIN_PORT, 'http://good.example');
    const socket = await connect(ORIGIN_PORT, 'http://good.example');
    const nextMessage = new Promise((resolve) => {
      listener.on('message', (d) => resolve(JSON.parse(d.toString())));
    });
    // ip/uid as objects — must be coerced to '' and still broadcast safely.
    socket.send(JSON.stringify({ type: 'chat', ip: { evil: true }, uid: 42, message: 'hi' }));
    const msg = await nextMessage;
    expect(msg.type).toBe('chat');
    expect(msg.message).toBe('hi');
    expect(msg.ip).toBe('');
    expect(msg.uid).toBe('');
    socket.close();
    listener.close();
  });
});

describe('Hardening round 2: per-IP connection cap', () => {
  let proc;

  beforeAll(async () => {
    proc = await startServer(PERIP_PORT, { MAX_CLIENTS_PER_IP: '2' });
  });

  afterAll(async () => {
    proc?.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 200));
  });

  it('rejects connections beyond MAX_CLIENTS_PER_IP (close 1013)', async () => {
    const a = await connect(PERIP_PORT);
    const b = await connect(PERIP_PORT);

    const third = new WebSocket(`ws://127.0.0.1:${PERIP_PORT}`);
    const code = await waitClose(third);
    expect(code).toBe(1013);

    a.close();
    b.close();
  });

  it('accepts new connections again after a client frees a slot', async () => {
    const a = await connect(PERIP_PORT);
    a.close();
    await waitClose(a);
    // Give the server a moment to process the close.
    await new Promise((r) => setTimeout(r, 300));
    const b = await connect(PERIP_PORT);
    expect(b.readyState).toBe(WebSocket.OPEN);
    b.close();
  });
});
