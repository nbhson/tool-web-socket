/**
 * Protocol message types exchanged between client and server.
 * @description Single source of truth for the `type` field of JSON payloads.
 *              Legacy types (join / chat / system / error) are kept for
 *              backward compatibility with existing clients.
 * @module server/protocol
 */

'use strict';

/** @type {Readonly<{ PING: string, PONG: string, DATA: string }>} Core transport-level types */
const MESSAGE_TYPES = Object.freeze({
  /** Application-layer liveness probe sent by a client. */
  PING: 'ping',
  /** Server response to a ping. */
  PONG: 'pong',
  /** Generic data payload. */
  DATA: 'data',
});

/**
 * All message types understood or emitted by the server.
 * @type {Readonly<{ PING: string, PONG: string, DATA: string, JOIN: string, CHAT: string, SYSTEM: string, ERROR: string }>}
 */
const SERVER_MESSAGE_TYPES = Object.freeze({
  ...MESSAGE_TYPES,
  /** Client announces itself. */
  JOIN: 'join',
  /** Broadcast chat message. */
  CHAT: 'chat',
  /** Server-generated informational message. */
  SYSTEM: 'system',
  /** Server-generated error message. */
  ERROR: 'error',
});

module.exports = { MESSAGE_TYPES, SERVER_MESSAGE_TYPES };
