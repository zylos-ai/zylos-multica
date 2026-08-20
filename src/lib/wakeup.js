/**
 * Task-wakeup WebSocket channel.
 *
 * Mirrors the official daemon's taskWakeupLoop slice that this bridge needs:
 * a long-lived authenticated connection to GET /api/daemon/ws over which the
 * server pushes wakeup hints (`daemon:task_available`, `daemon:pending_work`).
 * Claiming stays on the existing HTTP claim path — the official protocol
 * documents the hint as exactly that ("The daemon still claims work through
 * the existing HTTP claim endpoint"), so a hint can never double-claim.
 *
 * Liveness is application-level: the channel sends `daemon:heartbeat` frames
 * and treats any inbound frame (normally the `daemon:heartbeat_ack`) as proof
 * of life; a silent connection is torn down and reconnected with jittered
 * exponential backoff, reset after a stably-connected period. HTTP polling in
 * the bridge's run loop continues untouched as the fallback delivery path.
 *
 * Uses the Node >=22 global WebSocket (undici), which accepts an options
 * object with custom headers; on runtimes without it the channel reports
 * itself unsupported and the bridge stays poll-only.
 */

import { isLoopbackHostname } from './config.js';

const WAKEUP_EVENTS = new Set(['daemon:task_available', 'daemon:pending_work']);

const DEFAULT_TIMINGS = Object.freeze({
  heartbeatIntervalMs: 15_000,
  idleTimeoutMs: 60_000,
  backoffStartMs: 1_000,
  backoffMaxMs: 30_000,
  backoffResetAfterMs: 10_000,
  handshakeTimeoutMs: 10_000,
});

export function wakeupSocketUrl(baseUrl, runtimeId) {
  const url = new URL('api/daemon/ws', `${baseUrl.replace(/\/+$/, '')}/`);
  if (url.protocol === 'http:') url.protocol = 'ws:';
  else if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (!['ws:', 'wss:'].includes(url.protocol)) {
    throw new Error('base_url must use http or https');
  }
  // Defense in depth behind validateBaseUrl: the authenticated wakeup
  // handshake must never ride cleartext ws: off the local machine.
  if (url.protocol === 'ws:' && !isLoopbackHostname(url.hostname)) {
    throw new Error('wakeup channel requires wss for non-loopback hosts');
  }
  url.searchParams.set('runtime_ids', String(runtimeId));
  return url.toString();
}

export function createWakeupChannel({
  onWakeup,
  log = () => {},
  WebSocketImpl = globalThis.WebSocket,
  timings = {},
} = {}) {
  const t = { ...DEFAULT_TIMINGS, ...timings };
  let target; // { config, runtimeId } while started
  let socket;
  let generation = 0;
  let backoffMs = t.backoffStartMs;
  let connectedAt = 0;
  let reconnectTimer;
  let heartbeatTimer;
  let idleTimer;
  let unsupportedLogged = false;

  function supported() {
    return typeof WebSocketImpl === 'function';
  }

  function clearTimers() {
    clearTimeout(reconnectTimer);
    clearInterval(heartbeatTimer);
    clearTimeout(idleTimer);
    reconnectTimer = heartbeatTimer = idleTimer = undefined;
  }

  function closeSocket() {
    if (!socket) return;
    const closing = socket;
    socket = undefined;
    try { closing.close(); } catch {}
  }

  function armIdleTimer(myGeneration) {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (myGeneration !== generation) return;
      log('WARN', 'wakeup websocket idle timeout; reconnecting');
      closeSocket();
      scheduleReconnect();
    }, t.idleTimeoutMs);
    idleTimer.unref?.();
  }

  function sendHeartbeat() {
    if (!socket || socket.readyState !== 1 || !target) return;
    try {
      socket.send(JSON.stringify({
        type: 'daemon:heartbeat',
        payload: { runtime_id: target.runtimeId },
      }));
    } catch (error) {
      log('WARN', 'wakeup websocket heartbeat send failed', { error: error.message });
    }
  }

  function scheduleReconnect() {
    if (!target || reconnectTimer) return;
    // Reset backoff after a stably-connected period, mirroring the official
    // daemon; jitter spreads reconnect storms across daemons.
    if (connectedAt && Date.now() - connectedAt >= t.backoffResetAfterMs) {
      backoffMs = t.backoffStartMs;
    }
    connectedAt = 0;
    const spread = backoffMs / 5;
    const delay = Math.max(0, Math.round(backoffMs + (Math.random() * 2 - 1) * spread));
    backoffMs = Math.min(backoffMs * 2, t.backoffMaxMs);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, delay);
    reconnectTimer.unref?.();
  }

  function handleMessage(myGeneration, data) {
    if (myGeneration !== generation) return;
    armIdleTimer(myGeneration);
    let message;
    try {
      message = JSON.parse(String(data));
    } catch {
      return;
    }
    if (message && WAKEUP_EVENTS.has(message.type)) {
      log('INFO', 'wakeup hint received', { event: message.type });
      onWakeup?.();
    }
  }

  function connect() {
    if (!target) return;
    const myGeneration = generation;
    const { config, runtimeId } = target;
    let ws;
    try {
      ws = new WebSocketImpl(wakeupSocketUrl(config.base_url, runtimeId), {
        headers: { Authorization: `Bearer ${config.pat}` },
      });
    } catch (error) {
      log('WARN', 'wakeup websocket connect failed; polling remains active', { error: error.message });
      scheduleReconnect();
      return;
    }
    socket = ws;
    const handshakeTimer = setTimeout(() => {
      if (myGeneration !== generation || socket !== ws) return;
      log('WARN', 'wakeup websocket handshake timeout; polling remains active');
      closeSocket();
      scheduleReconnect();
    }, t.handshakeTimeoutMs);
    handshakeTimer.unref?.();
    ws.onopen = () => {
      if (myGeneration !== generation || socket !== ws) return;
      clearTimeout(handshakeTimer);
      connectedAt = Date.now();
      log('INFO', 'wakeup websocket connected', { runtime_id: runtimeId });
      armIdleTimer(myGeneration);
      sendHeartbeat();
      clearInterval(heartbeatTimer);
      heartbeatTimer = setInterval(sendHeartbeat, t.heartbeatIntervalMs);
      heartbeatTimer.unref?.();
    };
    ws.onmessage = (event) => handleMessage(myGeneration, event.data);
    ws.onerror = () => {};
    ws.onclose = () => {
      if (myGeneration !== generation || socket !== ws) return;
      clearTimeout(handshakeTimer);
      clearInterval(heartbeatTimer);
      clearTimeout(idleTimer);
      socket = undefined;
      log('WARN', 'wakeup websocket disconnected; polling remains active');
      scheduleReconnect();
    };
  }

  function start(config, runtimeId) {
    if (!supported()) {
      if (!unsupportedLogged) {
        unsupportedLogged = true;
        log('WARN', 'wakeup websocket unavailable on this Node runtime; polling only');
      }
      return;
    }
    generation += 1;
    clearTimers();
    closeSocket();
    target = { config, runtimeId };
    backoffMs = t.backoffStartMs;
    connectedAt = 0;
    connect();
  }

  function stop() {
    generation += 1;
    target = undefined;
    clearTimers();
    closeSocket();
  }

  return { start, stop, supported };
}
