/**
 * Reconnect tests: verifies a client with a retry loop can recover when the
 * server process is killed and restarted on the same port (simulates deploy /
 * crash-restart under docker restart=unless-stopped).
 *
 * Uses its own server instance on port 8088.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import { spawn } from 'child_process';

const PORT = 8088;

/**
 * Spawns `node app.js` on PORT and waits for readiness.
 * @returns {Promise<import('child_process').ChildProcess>}
 */
function startServer() {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', ['app.js'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(PORT),
        HOST: '127.0.0.1',
        // Fast heartbeat so the restarted server reaps stale state quickly.
        HEARTBEAT_INTERVAL: '500',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout.resume();
    proc.stderr.resume();

    const tryConnect = (attempts = 0) => {
      if (attempts >= 25) {
        reject(new Error(`Server not ready on ${PORT}.`));
        return;
      }
      const probe = new WebSocket(`ws://127.0.0.1:${PORT}`);
      probe.on('open', () => {
        probe.close();
        resolve(proc);
      });
      probe.on('error', () => setTimeout(() => tryConnect(attempts + 1), 200));
    };
    tryConnect();
  });
}

/**
 * Minimal reconnect-capable client (mirrors the ui/app.js strategy):
 * on close, retries with a fixed delay until MAXms elapse.
 * @param {number} maxWaitMs
 * @returns {Promise<{ socket: WebSocket, attempts: number }>}
 */
function connectWithRetry(maxWaitMs = 15_000) {
  const started = Date.now();
  let attempts = 0;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      attempts++;
      const socket = new WebSocket(`ws://127.0.0.1:${PORT}`);
      socket.on('open', () => resolve({ socket, attempts }));
      socket.on('error', () => socket.terminate());
      socket.on('close', () => {
        if (Date.now() - started > maxWaitMs) {
          reject(new Error(`Reconnect failed after ${attempts} attempts`));
          return;
        }
        setTimeout(attempt, 250);
      });
    };
    attempt();
  });
}

describe('Reconnect: client recovers after server restart', () => {
  /** @type {import('child_process').ChildProcess|null} */
  let proc;

  beforeAll(async () => {
    proc = await startServer();
  });

  afterAll(async () => {
    proc?.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 200));
  });

  it('reconnects after the server is killed and restarted, then broadcasts', async () => {
    // 1. Establish the first session.
    const first = await connectWithRetry();
    expect(first.socket.readyState).toBe(WebSocket.OPEN);

    // 2. Kill the server abruptly (SIGKILL — no graceful close frame).
    proc.kill('SIGKILL');
    await new Promise((resolve) => {
      proc.on('exit', resolve);
    });
    first.socket.close();

    // 3. Restart the server on the same port.
    proc = await startServer();

    // 4. The client's retry loop must succeed against the new instance.
    const second = await connectWithRetry();
    expect(second.socket.readyState).toBe(WebSocket.OPEN);
    expect(second.attempts).toBeGreaterThanOrEqual(1);

    // 5. Broadcasting works again after recovery.
    const listener = await connectWithRetry();
    const received = new Promise((resolve) => {
      listener.socket.on('message', (d) => resolve(JSON.parse(d.toString())));
    });
    second.socket.send(
      JSON.stringify({ type: 'chat', ip: 'x', uid: 'reconnected', message: 'back online' })
    );
    const msg = await received;
    expect(msg.type).toBe('chat');
    expect(msg.message).toBe('back online');

    second.socket.close();
    listener.socket.close();
  }, 30_000);
});
