import assert from 'node:assert/strict';
import test from 'node:test';

import { createWakeupChannel, wakeupSocketUrl } from '../src/lib/wakeup.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeWebSocket {
  constructor(url, options) {
    this.url = url;
    this.options = options;
    this.readyState = 0;
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.readyState = 1;
    this.onopen?.();
  }

  message(data) {
    this.onmessage?.({ data });
  }

  send(data) {
    this.sent.push(data);
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({});
  }
}
FakeWebSocket.instances = [];

const FAST_TIMINGS = {
  heartbeatIntervalMs: 5,
  idleTimeoutMs: 30,
  backoffStartMs: 1,
  backoffMaxMs: 4,
  backoffResetAfterMs: 1,
  handshakeTimeoutMs: 30,
};

const config = { base_url: 'https://multica.example', pat: 'secret-pat' };

function channelHarness(overrides = {}) {
  FakeWebSocket.instances = [];
  const wakeups = [];
  const logs = [];
  const channel = createWakeupChannel({
    onWakeup: () => wakeups.push(Date.now()),
    log: (level, message) => logs.push(`${level} ${message}`),
    WebSocketImpl: FakeWebSocket,
    timings: FAST_TIMINGS,
    ...overrides,
  });
  return { channel, wakeups, logs, sockets: FakeWebSocket.instances };
}

test('wakeupSocketUrl maps schemes and carries the runtime id', () => {
  assert.equal(
    wakeupSocketUrl('https://multica.example', 'runtime-1'),
    'wss://multica.example/api/daemon/ws?runtime_ids=runtime-1',
  );
  assert.equal(
    wakeupSocketUrl('http://multica.example/base/', 'runtime-1'),
    'ws://multica.example/base/api/daemon/ws?runtime_ids=runtime-1',
  );
  assert.throws(() => wakeupSocketUrl('ftp://multica.example', 'runtime-1'), /http or https/);
});

test('start connects with the PAT header and heartbeats after open', async () => {
  const { channel, sockets } = channelHarness();
  channel.start(config, 'runtime-1');
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].url, 'wss://multica.example/api/daemon/ws?runtime_ids=runtime-1');
  assert.deepEqual(sockets[0].options, { headers: { Authorization: 'Bearer secret-pat' } });
  sockets[0].open();
  assert.deepEqual(JSON.parse(sockets[0].sent[0]), {
    type: 'daemon:heartbeat',
    payload: { runtime_id: 'runtime-1' },
  });
  await delay(12);
  assert.ok(sockets[0].sent.length >= 2, 'heartbeat must repeat on the interval');
  channel.stop();
});

test('wakeup hints fire the callback; other frames and noise do not', () => {
  const { channel, wakeups, sockets } = channelHarness();
  channel.start(config, 'runtime-1');
  const socket = sockets[0];
  socket.open();
  socket.message(JSON.stringify({ type: 'daemon:task_available', payload: { runtime_id: 'runtime-1', task_id: 't1' } }));
  socket.message(JSON.stringify({ type: 'daemon:pending_work', payload: { runtime_id: 'runtime-1' } }));
  socket.message(JSON.stringify({ type: 'daemon:heartbeat_ack', payload: { runtime_id: 'runtime-1' } }));
  socket.message('not json at all');
  assert.equal(wakeups.length, 2);
  channel.stop();
});

test('a dropped connection reconnects with backoff; stop() ends the loop', async () => {
  const { channel, sockets } = channelHarness();
  channel.start(config, 'runtime-1');
  sockets[0].open();
  sockets[0].close();
  await delay(20);
  assert.ok(sockets.length >= 2, 'must reconnect after a drop');
  channel.stop();
  const settled = sockets.length;
  await delay(20);
  assert.equal(sockets.length, settled, 'stop() must halt reconnection');
});

test('a silent connection hits the idle timeout and reconnects', async () => {
  const { channel, sockets, logs } = channelHarness();
  channel.start(config, 'runtime-1');
  sockets[0].open();
  await delay(45);
  assert.ok(logs.some((line) => line.includes('idle timeout')), logs.join('\n'));
  assert.ok(sockets.length >= 2, 'idle timeout must trigger a reconnect');
  channel.stop();
});

test('inbound frames keep the idle timer fed', async () => {
  const { channel, sockets } = channelHarness();
  channel.start(config, 'runtime-1');
  sockets[0].open();
  for (let i = 0; i < 4; i++) {
    await delay(15);
    sockets[0].message(JSON.stringify({ type: 'daemon:heartbeat_ack', payload: {} }));
  }
  assert.equal(sockets.length, 1, 'a live connection must not be recycled');
  channel.stop();
});

test('a handshake that never completes is abandoned and retried', async () => {
  const { channel, sockets, logs } = channelHarness();
  channel.start(config, 'runtime-1');
  await delay(45);
  assert.ok(logs.some((line) => line.includes('handshake timeout')), logs.join('\n'));
  assert.ok(sockets.length >= 2);
  channel.stop();
});

test('restarting for a new identity abandons the previous socket', () => {
  const { channel, wakeups, sockets } = channelHarness();
  channel.start(config, 'runtime-1');
  const first = sockets[0];
  first.open();
  channel.start(config, 'runtime-2');
  assert.equal(first.readyState, 3, 'old socket must be closed');
  first.message(JSON.stringify({ type: 'daemon:task_available', payload: {} }));
  assert.equal(wakeups.length, 0, 'stale socket frames must be ignored');
  assert.equal(sockets[1].url, 'wss://multica.example/api/daemon/ws?runtime_ids=runtime-2');
  channel.stop();
});

test('a runtime without WebSocket degrades to polling with one log line', () => {
  const { channel, logs } = channelHarness({ WebSocketImpl: null });
  assert.equal(channel.supported(), false);
  channel.start(config, 'runtime-1');
  channel.start(config, 'runtime-1');
  assert.equal(logs.filter((line) => line.includes('polling only')).length, 1);
  channel.stop();
});
