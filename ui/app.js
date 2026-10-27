/**
 * WebSocket Chat Client
 * @description Handles connection, message display, dark mode, notifications,
 *              and auto-reconnect for the chat UI.
 */

// ─── Constants ────────────────────────────────────────────────────────────────

/** @type {string} WebSocket server URL. Override with `window.WS_URL` before loading. */
const WS_URL = window.WS_URL || 'ws://localhost:8080';

/** @type {number} Initial reconnect delay in milliseconds. */
const RECONNECT_BASE_DELAY_MS = 1000;

/** @type {number} Maximum reconnect delay in milliseconds. */
const RECONNECT_MAX_DELAY_MS = 30000;

/** @type {number} Maximum reconnect attempts before giving up. */
const MAX_RECONNECT_ATTEMPTS = 10;

/** @type {string} Default server address used in join messages (fetched from external API). */
const DEFAULT_IP = '0.0.0.0';

// ─── State ─────────────────────────────────────────────────────────────────────

/** @type {WebSocket|null} */
let socket = null;

/** @type {string} */
let clientIP = DEFAULT_IP;

/** @type {string} Unique client identifier (UUID v4). */
let clientUid = '';

/** @type {number} Current reconnect attempt count. */
let reconnectAttempts = 0;

/** @type {ReturnType<typeof setTimeout>|null} Pending reconnect timer. */
let reconnectTimer = null;

/** @type {boolean} Whether the client initiated a clean disconnect. */
let intentionallyClosed = false;

// ─── DOM references ────────────────────────────────────────────────────────────

/** @type {HTMLInputElement|null} */
const messageInput = document.getElementById('message-input');

/** @type {HTMLButtonElement|null} */
const sendButton = document.getElementById('send-button');

/** @type {HTMLDivElement|null} */
const chatBox = document.getElementById('chat-box');

/** @type {HTMLDivElement|null} */
const connStatus = document.getElementById('connection-status');

/** @type {HTMLSpanElement|null} */
const connStatusText = document.getElementById('conn-status-text');

/** @type {HTMLElement|null} */
const loadingOverlay = document.getElementById('loading-overlay');

/** @type {HTMLDivElement|null} */
const errorBanner = document.getElementById('error-banner');

/** @type {HTMLSpanElement|null} */
const errorMessage = document.getElementById('error-message');

/** @type {HTMLButtonElement|null} */
const errorDismiss = document.getElementById('error-dismiss');

/** @type {HTMLButtonElement|null} */
const themeToggle = document.getElementById('theme-toggle');

/** @type {HTMLElement|null} */
const themeIcon = document.getElementById('theme-icon');

// ─── Utilities ─────────────────────────────────────────────────────────────────

/**
 * Generates a random UUID v4 string.
 * @returns {string}
 */
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Formats a Unix timestamp (ms) as a local HH:mm string.
 * @param {number} timestamp
 * @returns {string}
 */
function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ─── Dark mode ─────────────────────────────────────────────────────────────────

/**
 * Applies the saved theme preference from localStorage,
 * or falls back to the OS `prefers-color-scheme` media query.
 */
function initTheme() {
  const saved = localStorage.getItem('theme');
  if (saved) {
    document.documentElement.setAttribute('data-theme', saved);
    updateThemeIcon(saved);
  } else if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
    document.documentElement.setAttribute('data-theme', 'dark');
    updateThemeIcon('dark');
  }
}

/**
 * Updates the theme toggle icon to match the current theme.
 * @param {string} theme - `'light'` or `'dark'`
 */
function updateThemeIcon(theme) {
  if (!themeIcon) return;
  themeIcon.className =
    theme === 'dark' ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
}

/**
 * Toggles between light and dark themes, persisting the choice.
 */
function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('theme', next);
  updateThemeIcon(next);
}

// ─── Connection status ─────────────────────────────────────────────────────────

/**
 * @typedef {'connected'|'reconnecting'|'disconnected'} ConnectionState
 */

/**
 * Updates the connection status badge UI.
 * @param {ConnectionState} state
 * @param {string} [label]
 */
function setConnectionStatus(state, label) {
  if (!connStatus || !connStatusText) return;

  connStatus.className = `conn-status conn-status--${state}`;
  connStatusText.textContent = label ?? {
    connected: 'Đã kết nối',
    reconnecting: 'Đang kết nối lại...',
    disconnected: 'Đã ngắt kết nối',
  }[state];
}

// ─── Loading overlay ────────────────────────────────────────────────────────────

/**
 * Shows the loading/connecting overlay.
 */
function showLoading() {
  if (loadingOverlay) {
    loadingOverlay.classList.remove('is-hidden');
    loadingOverlay.setAttribute('aria-hidden', 'false');
  }
}

/**
 * Hides the loading/connecting overlay.
 */
function hideLoading() {
  if (loadingOverlay) {
    loadingOverlay.classList.add('is-hidden');
    loadingOverlay.setAttribute('aria-hidden', 'true');
  }
}

// ─── Error banner ──────────────────────────────────────────────────────────────

/**
 * Displays the error banner with the given message.
 * @param {string} message
 */
function showError(message) {
  if (errorBanner && errorMessage) {
    errorMessage.textContent = message;
    errorBanner.removeAttribute('hidden');
  }
}

/**
 * Hides the error banner.
 */
function hideError() {
  if (errorBanner) {
    errorBanner.setAttribute('hidden', '');
  }
}

// ─── Reconnect logic ────────────────────────────────────────────────────────────

/**
 * Calculates the next reconnect delay with exponential backoff,
 * capped at RECONNECT_MAX_DELAY_MS, and jittered ±20%.
 * @returns {number} Delay in milliseconds.
 */
function getNextDelay() {
  const exponential = Math.min(
    RECONNECT_BASE_DELAY_MS * Math.pow(2, reconnectAttempts),
    RECONNECT_MAX_DELAY_MS
  );
  // Add ±20% jitter to prevent thundering herd
  const jitter = exponential * (0.8 + Math.random() * 0.4);
  return Math.round(jitter);
}

/**
 * Schedules the next reconnection attempt if allowed.
 * Uses exponential backoff and respects MAX_RECONNECT_ATTEMPTS.
 */
function scheduleReconnect() {
  if (intentionallyClosed) return;
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    setConnectionStatus('disconnected', 'Kết nối thất bại — vui lòng tải lại trang.');
    showError('Mất kết nối. Vui lòng tải lại trang để thử lại.');
    return;
  }

  setConnectionStatus('reconnecting');
  const delay = getNextDelay();
  reconnectAttempts++;

  console.log(
    `[Client] Reconnecting in ${delay}ms (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`
  );

  reconnectTimer = setTimeout(() => {
    connect();
  }, delay);
}

/**
 * Cancels any pending reconnect timer.
 */
function clearReconnectTimer() {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

// ─── WebSocket connection ──────────────────────────────────────────────────────

/**
 * Opens a WebSocket connection to WS_URL and sets up all event handlers.
 */
function connect() {
  if (socket && socket.readyState <= WebSocket.OPEN) {
    // Already connecting or open
    return;
  }

  intentionallyClosed = false;
  clearReconnectTimer();
  showLoading();
  hideError();

  try {
    socket = new WebSocket(WS_URL);
  } catch (err) {
    console.error('[Client] Failed to create WebSocket:', err);
    scheduleReconnect();
    return;
  }

  // ── open ──────────────────────────────────────────────────────────────────
  socket.addEventListener('open', () => {
    console.log('[Client] Connected to', WS_URL);
    reconnectAttempts = 0;
    setConnectionStatus('connected');
    hideLoading();
    enableInput(true);

    // Announce join to the server so other clients are notified
    sendMessage({ type: 'join', ip: clientIP, uid: clientUid });
  });

  // ── message ────────────────────────────────────────────────────────────────
  socket.addEventListener('message', (event) => {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      console.warn('[Client] Received non-JSON message:', event.data);
      return;
    }

    const { type, message, ip, uid, error: errorMsg } = data;

    if (errorMsg) {
      displayMessage({ type: 'error', message: errorMsg });
      return;
    }

    switch (type) {
      case 'chat':
        displayMessage({ type: 'chat', message, ip, uid });
        if (ip !== clientIP) showBrowserNotification('Tin nhắn mới', message);
        break;

      case 'system':
        displayMessage({ type: 'system', message });
        break;

      default:
        // Backward-compat: treat as chat when type is missing
        if (message) displayMessage({ type: 'chat', message, ip, uid });
    }
  });

  // ── close ──────────────────────────────────────────────────────────────────
  socket.addEventListener('close', (event) => {
    console.log(`[Client] WebSocket closed (code: ${event.code}).`);
    setConnectionStatus('disconnected');
    enableInput(false);

    if (!intentionallyClosed && event.code !== 1001) {
      // 1001 = going away (server shutdown) — don't auto-reconnect for that
      scheduleReconnect();
    }
  });

  // ── error ──────────────────────────────────────────────────────────────────
  socket.addEventListener('error', (err) => {
    console.error('[Client] WebSocket error:', err);
    // The close event fires after error; reconnect is handled there
  });
}

// ─── Message sending ──────────────────────────────────────────────────────────

/**
 * Sends a structured JSON payload over the WebSocket.
 * @param {object} data
 */
function sendMessage(data) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(data));
  } else {
    showError('Không thể gửi — chưa kết nối.');
  }
}

// ─── Message display ───────────────────────────────────────────────────────────

/**
 * Renders a message in the chat box.
 * @param {{ type: string, message: string, ip?: string, uid?: string, timestamp?: number }} msg
 */
function displayMessage({ type, message, ip = '', uid = '', timestamp }) {
  if (!chatBox) return;

  const el = document.createElement('div');
  el.className = 'message';

  if (type === 'system') {
    el.classList.add('message--system');
    el.textContent = message;
  } else if (type === 'error') {
    el.classList.add('message--error');
    el.textContent = message;
  } else if (uid && uid === clientUid) {
    el.classList.add('message--mine');
    el.textContent = message;
  } else {
    el.classList.add('message--other');
    el.textContent = `${ip ? `[${ip}] ` : ''}${message}`;
  }

  // Add timestamp for chat messages
  if ((type === 'chat') && timestamp) {
    const meta = document.createElement('span');
    meta.className = 'message__meta';
    meta.textContent = formatTime(timestamp);
    el.appendChild(meta);
  }

  chatBox.appendChild(el);
  chatBox.scrollTop = chatBox.scrollHeight;
}

// ─── Input handling ────────────────────────────────────────────────────────────

/**
 * Sends the current input value as a chat message.
 */
function handleSend() {
  if (!messageInput || !messageInput.value.trim()) return;

  const text = messageInput.value.trim();
  messageInput.value = '';

  sendMessage({
    type: 'chat',
    ip: clientIP,
    uid: clientUid,
    message: text,
  });

  hideError();
}

/**
 * Enables or disables the input controls based on connection state.
 * @param {boolean} enabled
 */
function enableInput(enabled) {
  if (messageInput) messageInput.disabled = !enabled;
  if (sendButton) sendButton.disabled = !enabled;
}

// ─── Browser notifications ────────────────────────────────────────────────────

/**
 * Requests notification permission from the browser.
 */
function requestNotificationPermission() {
  if (!('Notification' in window)) return;

  if (Notification.permission !== 'granted') {
    Notification.requestPermission();
  }
}

/**
 * Shows a browser notification, respecting permission settings.
 * @param {string} title
 * @param {string} body
 */
function showBrowserNotification(title, body) {
  if (!('Notification' in window)) return;

  if (document.visibilityState === 'visible') return; // Tab is already visible
  if (Notification.permission !== 'granted') return;

  try {
    new Notification(title, { body });
  } catch (err) {
    // Notification API may throw in some browsers/contexts
    console.warn('[Client] Notification error:', err);
  }
}

// ─── IP fetching ───────────────────────────────────────────────────────────────

/**
 * Fetches the client's public IP address from ipify.
 * Falls back gracefully on failure.
 * @returns {Promise<string>}
 */
async function fetchClientIP() {
  try {
    const resp = await fetch('https://api.ipify.org?format=json');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    return data.ip;
  } catch (err) {
    console.warn('[Client] Could not fetch public IP, using default:', err);
    return DEFAULT_IP;
  }
}

// ─── Event listeners ───────────────────────────────────────────────────────────

function initEventListeners() {
  // Send on button click
  sendButton?.addEventListener('click', handleSend);

  // Send on Enter key (without Shift)
  messageInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });

  // Dismiss error banner
  errorDismiss?.addEventListener('click', hideError);

  // Theme toggle
  themeToggle?.addEventListener('click', toggleTheme);

  // Re-enable input when window regains focus
  window.addEventListener('focus', () => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      enableInput(true);
    }
  });
}

// ─── Initialisation ────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  // Generate UUID and fetch IP in parallel
  clientUid = generateUUID();
  const [ip] = await Promise.all([fetchClientIP()]);
  clientIP = ip;

  initTheme();
  initEventListeners();
  requestNotificationPermission();

  // Connect to WebSocket server
  connect();
});
