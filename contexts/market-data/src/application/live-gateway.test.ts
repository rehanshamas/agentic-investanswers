import type { Bar, Instrument, Timeframe } from '@aia/shared-kernel';
import { barTime, price, volume } from '@aia/shared-kernel';
import { beforeEach, describe, expect, it } from 'vitest';

import { MemoryLiveBarsBus } from '../adapters/memory-live-bars-bus.js';
import { BTCUSD, ETHUSD, NVDA } from '../domain/parity-instruments.js';
import type { LiveBarUpdate } from '../domain/live-update.js';
import { LiveAnnouncer } from './live-announcer.js';
import type { LiveSocket } from './live-gateway.js';
import { LIVE_CLOSE_TOO_SLOW, LiveGateway } from './live-gateway.js';
import type { LiveServerMessage } from './live-protocol.js';
import { parseClientMessage } from './live-protocol.js';

const T0 = 1_762_800_000;

function bar(minute: number, cents = 7_000_000): Bar {
  return {
    time: barTime(T0 + minute * 60),
    open: price(cents),
    high: price(cents + 25),
    low: price(cents - 25),
    close: price(cents + 1),
    volume: volume(123_456_789),
  };
}

const update = (symbol: string, timeframe: Timeframe, b: Bar, forming = false): LiveBarUpdate => ({ symbol, timeframe, bar: b, forming });

class FakeSocket implements LiveSocket {
  readonly sent: LiveServerMessage[] = [];
  buffered = 0;
  closed: { code: number; reason: string } | undefined;
  send(text: string): void {
    this.sent.push(JSON.parse(text) as LiveServerMessage);
  }
  bufferedBytes(): number {
    return this.buffered;
  }
  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }
  take(): LiveServerMessage[] {
    return this.sent.splice(0);
  }
}

let flush: () => void = () => {};
let gateway: LiveGateway;
let announcer: LiveAnnouncer;

function setup(options = {}, instruments: readonly Instrument[] = [BTCUSD, ETHUSD, NVDA]) {
  gateway = new LiveGateway({
    instruments,
    every: (_ms, run) => {
      flush = run;
      return () => (flush = () => {});
    },
    options,
  });
  const bus = new MemoryLiveBarsBus();
  void bus.subscribe(gateway);
  announcer = new LiveAnnouncer(bus, 'test-run');
}

async function connect(allow: (symbol: string, tf: Timeframe) => boolean = () => true) {
  const socket = new FakeSocket();
  const session = gateway.open(socket, (s, tf) => Promise.resolve(allow(s, tf)));
  const say = (op: string, instrument: string, tf: string) => session.receive(JSON.stringify({ op, instrument, tf }));
  return { socket, session, say };
}

beforeEach(() => setup());

describe('parseClientMessage', () => {
  it.each([
    ['not json', 'messages must be JSON'],
    ['[]', 'a message must be a JSON object'],
    ['{"op":"watch","instrument":"BTCUSD","tf":"5m"}', '"op" must be'],
    ['{"op":"subscribe","tf":"5m"}', '"instrument" is required'],
    ['{"op":"subscribe","instrument":"BTCUSD","tf":"2m"}', '"tf" must be one of'],
    ['{"op":"subscribe","instrument":"BTCUSD","tf":"5m","x":1}', 'unknown field "x"'],
    [`{"op":"subscribe","instrument":"${'B'.repeat(300)}","tf":"5m"}`, 'at most 256 characters'],
  ])('refuses %s', (text, message) => {
    const parsed = parseClientMessage(text);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.message).toContain(message);
  });

  it('accepts subscribe and unsubscribe', () => {
    expect(parseClientMessage('{"op":"unsubscribe","instrument":"BTCUSD","tf":"1h"}')).toEqual({
      ok: true,
      message: { op: 'unsubscribe', instrument: 'BTCUSD', tf: '1h' },
    });
  });
});

describe('LiveGateway: subscriptions', () => {
  it('confirms a subscription and refuses bad ones with the same rules as GET /bars', async () => {
    const { socket, session, say } = await connect();
    await say('subscribe', 'BTCUSD', '5m');
    await say('subscribe', 'DOGE', '5m');
    await say('subscribe', 'BTCUSD', '1D');
    await say('subscribe', 'NVDA', '1m');
    await session.receive('{oops');
    expect(socket.take()).toEqual([
      { type: 'subscribed', instrument: 'BTCUSD', timeframe: '5m' },
      { type: 'error', code: 'unknown_instrument', message: expect.stringContaining('unknown instrument "DOGE"') as string, instrument: 'DOGE', timeframe: '5m' },
      { type: 'error', code: 'timeframe_not_served', message: expect.any(String) as string, instrument: 'BTCUSD', timeframe: '1D' },
      { type: 'error', code: 'timeframe_not_served', message: expect.any(String) as string, instrument: 'NVDA', timeframe: '1m' },
      { type: 'error', code: 'bad_parameter', message: expect.stringContaining('JSON') as string },
    ]);
    expect(gateway.stats).toEqual({ sessions: 1, subscriptions: 1 });
  });

  it('checks the plan on every subscription', async () => {
    const { socket, say } = await connect((symbol) => symbol === 'BTCUSD');
    await say('subscribe', 'ETHUSD', '5m');
    await say('subscribe', 'BTCUSD', '5m');
    expect(socket.take()).toEqual([
      { type: 'error', code: 'forbidden', message: 'your plan does not include ETHUSD 5m', instrument: 'ETHUSD', timeframe: '5m' },
      { type: 'subscribed', instrument: 'BTCUSD', timeframe: '5m' },
    ]);
  });

  it('caps subscriptions per connection; repeating one does not count twice', async () => {
    setup({ maxSubscriptions: 2 });
    const { socket, say } = await connect();
    await say('subscribe', 'BTCUSD', '1m');
    await say('subscribe', 'BTCUSD', '1m');
    await say('subscribe', 'BTCUSD', '5m');
    await say('subscribe', 'ETHUSD', '5m');
    await say('unsubscribe', 'BTCUSD', '1m');
    await say('subscribe', 'ETHUSD', '5m');
    expect(socket.take().map((m) => (m.type === 'error' ? m.code : m.type))).toEqual([
      'subscribed',
      'subscribed',
      'subscribed',
      'too_many_subscriptions',
      'unsubscribed',
      'subscribed',
    ]);
  });

  it('handles a connection’s messages in order, even when the plan check is slow', async () => {
    const socket = new FakeSocket();
    let release = (): void => {};
    const session = gateway.open(socket, () => new Promise((resolve) => (release = () => resolve(true))));
    const subscribing = session.receive('{"op":"subscribe","instrument":"BTCUSD","tf":"5m"}');
    const unsubscribing = session.receive('{"op":"unsubscribe","instrument":"BTCUSD","tf":"5m"}');
    await Promise.resolve();
    release();
    await Promise.all([subscribing, unsubscribing]);
    expect(socket.take().map((m) => m.type)).toEqual(['subscribed', 'unsubscribed']);
    expect(gateway.stats.subscriptions).toBe(0);
  });
});

describe('LiveGateway: updates', () => {
  it('sends only subscribed pairs, batched, in display units', async () => {
    const a = await connect();
    const b = await connect();
    await a.say('subscribe', 'BTCUSD', '5m');
    await b.say('subscribe', 'ETHUSD', '1m');
    a.socket.take();
    b.socket.take();

    await announcer.publish([update('BTCUSD', '1m', bar(0)), update('BTCUSD', '5m', bar(0))]);
    await announcer.publish([update('ETHUSD', '1m', bar(0, 300_000), true)]);
    expect(a.socket.sent).toEqual([]); // nothing until the batch flushes
    flush();
    expect(a.socket.take()).toEqual([
      {
        type: 'bars',
        updates: [
          { instrument: 'BTCUSD', timeframe: '5m', forming: false, bar: { time: T0, open: 70_000, high: 70_000.25, low: 69_999.75, close: 70_000.01, volume: 1.23456789 } },
        ],
      },
    ]);
    // ETH has 3 price decimals: 300,000 is 300.000.
    expect(b.socket.take()).toEqual([
      { type: 'bars', updates: [{ instrument: 'ETHUSD', timeframe: '1m', forming: true, bar: expect.objectContaining({ open: 300 }) as object }] },
    ]);
    flush();
    expect(a.socket.sent).toEqual([]); // nothing pending, nothing sent
  });

  it('keeps one value per bar in a batch: its first position, its newest value', async () => {
    const { socket, say } = await connect();
    await say('subscribe', 'BTCUSD', '1m');
    socket.take();
    // The grace overlap: minute 0 still open while minute 1 forms, then 0 is stored.
    await announcer.publish([update('BTCUSD', '1m', bar(0, 100), true), update('BTCUSD', '1m', bar(1, 200), true)]);
    await announcer.publish([update('BTCUSD', '1m', bar(0, 101), true), update('BTCUSD', '1m', bar(1, 201), true)]);
    await announcer.publish([update('BTCUSD', '1m', bar(0, 102))]);
    flush();
    const [message] = socket.take();
    expect(message?.type === 'bars' && message.updates.map((u) => [u.bar.time, u.bar.open, u.forming])).toEqual([
      [T0, 1.02, false],
      [T0 + 60, 2.01, true],
    ]);
  });

  it('never lets a forming 1m bar replace a stored one', async () => {
    const { socket, say } = await connect();
    await say('subscribe', 'BTCUSD', '1m');
    socket.take();
    await announcer.publish([update('BTCUSD', '1m', bar(3, 500))]);
    await announcer.publish([update('BTCUSD', '1m', bar(3, 400), true), update('BTCUSD', '1m', bar(2, 400), true)]);
    flush();
    const [message] = socket.take();
    expect(message?.type === 'bars' && message.updates.map((u) => [u.bar.time, u.forming])).toEqual([[T0 + 180, false]]);
  });

  it('stops sending a pair once unsubscribed, and nothing after the connection closes', async () => {
    const { socket, session, say } = await connect();
    await say('subscribe', 'BTCUSD', '1m');
    await announcer.publish([update('BTCUSD', '1m', bar(0))]);
    await say('unsubscribe', 'BTCUSD', '1m');
    await announcer.publish([update('BTCUSD', '1m', bar(1))]);
    flush();
    expect(socket.take().map((m) => m.type)).toEqual(['subscribed', 'unsubscribed']);
    await say('subscribe', 'BTCUSD', '1m');
    session.close();
    await announcer.publish([update('BTCUSD', '1m', bar(2))]);
    flush();
    expect(gateway.stats).toEqual({ sessions: 0, subscriptions: 0 });
  });
});

describe('LiveGateway: gaps and slow clients', () => {
  it('sends resync on a jump in the sequence, a new publisher, a lost bus, or a publisher’s request', async () => {
    const { socket, say } = await connect();
    await say('subscribe', 'BTCUSD', '1m');
    socket.take();
    const events: string[] = [];
    const record = () => events.push(socket.take().map((m) => m.type).join(',') || '-');

    gateway.batch({ publisher: 'p', seq: 1, updates: [] });
    record(); // the first announcement seen: no resync
    gateway.batch({ publisher: 'p', seq: 2, updates: [] });
    record();
    gateway.batch({ publisher: 'p', seq: 4, updates: [update('BTCUSD', '1m', bar(0))] }); // 3 went missing
    record();
    gateway.batch({ publisher: 'q', seq: 1, updates: [] }); // hydration restarted
    record();
    gateway.lost();
    record();
    gateway.batch({ publisher: 'q', seq: 7, updates: [] }); // first after the loss: accepted
    record();
    gateway.batch({ publisher: 'q', seq: 8, updates: [], resync: true });
    record();
    gateway.batch({ publisher: 'maintenance', seq: 1, updates: [], resync: true }); // pnpm cook rewrote bars
    record();
    gateway.batch({ publisher: 'q', seq: 9, updates: [] }); // the live sequence carries on: no second resync
    record();
    expect(events).toEqual(['-', '-', 'resync', 'resync', 'resync', '-', 'resync', 'resync', '-']);
    // The update that came with the jump is still delivered, after the resync.
    gateway.batch({ publisher: 'q', seq: 10, updates: [update('BTCUSD', '1m', bar(1))] });
    flush();
    expect(socket.take().map((m) => m.type)).toEqual(['bars']);
  });

  it('closes a connection that cannot keep up, without affecting others', async () => {
    const slow = await connect();
    const fast = await connect();
    await slow.say('subscribe', 'BTCUSD', '1m');
    await fast.say('subscribe', 'BTCUSD', '1m');
    slow.socket.buffered = 2 << 20;
    await announcer.publish([update('BTCUSD', '1m', bar(0))]);
    flush();
    expect(slow.socket.closed?.code).toBe(LIVE_CLOSE_TOO_SLOW);
    expect(fast.socket.take().map((m) => m.type)).toEqual(['subscribed', 'bars']);
    expect(gateway.stats).toEqual({ sessions: 1, subscriptions: 1 });
  });

  it('closes every connection on stop', async () => {
    const { socket } = await connect();
    gateway.stop();
    expect(socket.closed?.code).toBe(1001);
    expect(gateway.stats.sessions).toBe(0);
  });
});
