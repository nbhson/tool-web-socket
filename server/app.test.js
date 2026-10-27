import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import { spawn } from 'child_process';

const PORT = 8081;

/** @type {import('child_process').ChildProcess | null} */
let serverProcess;

/** @type {WebSocket | null} */
let _socketHolder = null;

/**
 * Starts the server process and waits until it is truly ready to accept connections.
 * @returns {Promise<import('child_process').ChildProcess>}
 */
function startServer() {
  return new Promise((resolve, reject) => {
    serverProcess = spawn('node', ['app.js'], {
      cwd: process.cwd(),
      env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';

    serverProcess.stdout.on('data', (data) => {
      output += data.toString();
    });

    serverProcess.stderr.on('data', (data) => {
      output += data.toString();
    });

    serverProcess.on('error', (err) => {
      reject(new Error(`Server process error: ${err.message}\nOutput: ${output}`));
    });

    serverProcess.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        console.warn(`[Test] Server exited with code ${code}\nOutput: ${output}`);
      }
    });

    // Try to connect to verify the server is ready, up to 5 seconds
    const tryConnect = (attempts = 0) => {
      if (attempts >= 25) {
        reject(new Error(`Server did not become ready.\nOutput: ${output}`));
        return;
      }
      try {
        const probe = new WebSocket(`ws://127.0.0.1:${PORT}`);
        probe.on('open', () => {
          probe.close();
          resolve(serverProcess);
        });
        probe.on('error', () => {
          setTimeout(() => tryConnect(attempts + 1), 200);
        });
      } catch {
        setTimeout(() => tryConnect(attempts + 1), 200);
      }
    };

    tryConnect();
  });
}

beforeAll(async () => {
  serverProcess = await startServer();
});

afterAll(async () => {
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 400));
  }
});

/**
 * Opens a WebSocket connection and resolves once ready.
 * @returns {Promise<WebSocket>}
 */
function connect() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${PORT}`);
    _socketHolder = socket;

    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('Connection timed out'));
    }, 5000);

    socket.on('open', () => {
      clearTimeout(timer);
      resolve(socket);
    });

    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Waits for the next JSON message on a socket.
 * @param {WebSocket} socket
 * @returns {Promise<object>}
 */
function nextMessage(socket) {
  return new Promise((resolve) => {
    const handler = (data) => {
      socket.removeListener('message', handler);
      resolve(JSON.parse(data.toString()));
    };
    socket.on('message', handler);
  });
}

/**
 * Closes a socket and nullifies the holder.
 * @param {WebSocket} socket
 */
async function closeSocket(socket) {
  if (!socket) return;
  return new Promise((resolve) => {
    socket.on('close', resolve);
    socket.on('error', resolve);
    socket.close();
  });
}

describe('WebSocket Server', () => {
  it('should accept a client connection', async () => {
    const socket = await connect();
    expect(socket.readyState).toBe(WebSocket.OPEN);
    await closeSocket(socket);
  });

  it('should broadcast a chat message to other clients', async () => {
    const sender = await connect();
    const receiver = await connect();

    const receivedPromise = nextMessage(receiver);
    sender.send(JSON.stringify({ type: 'chat', ip: '127.0.0.1', uid: 'test-uid', message: 'hello world' }));

    const msg = await receivedPromise;
    expect(msg.type).toBe('chat');
    expect(msg.message).toBe('hello world');
    expect(msg.uid).toBe('test-uid');

    await closeSocket(sender);
    await closeSocket(receiver);
  });

  it('should not echo the message back to the sender', async () => {
    const socket = await connect();
    socket.send(JSON.stringify({ type: 'chat', ip: 'x', uid: 'u', message: 'self-test' }));

    const result = await Promise.race([
      nextMessage(socket),
      new Promise((r) => setTimeout(() => r(null), 600)),
    ]);
    expect(result).toBeNull();
    await closeSocket(socket);
  });

  it('should reject invalid JSON payloads', async () => {
    const socket = await connect();
    const errorPromise = nextMessage(socket);
    socket.send('not-a-valid-json');
    const msg = await errorPromise;
    expect(msg.type).toBe('error');
    expect(msg.message).toMatch(/invalid json/i);
    await closeSocket(socket);
  });

  it('should reject messages without a message field', async () => {
    const socket = await connect();
    const errorPromise = nextMessage(socket);
    socket.send(JSON.stringify({ type: 'chat', ip: 'x', uid: 'u' }));
    const msg = await errorPromise;
    expect(msg.type).toBe('error');
    expect(msg.message).toMatch(/message field is required/i);
    await closeSocket(socket);
  });

  it('should broadcast a system message when a client joins', async () => {
    const listener = await connect();
    const joiner = await connect();

    const systemPromise = nextMessage(listener);
    joiner.send(JSON.stringify({ type: 'join', ip: '1.2.3.4', uid: 'uid-join' }));

    const msg = await systemPromise;
    expect(msg.type).toBe('system');
    expect(msg.message).toMatch(/joined the chat/i);

    await closeSocket(listener);
    await closeSocket(joiner);
  });
});
