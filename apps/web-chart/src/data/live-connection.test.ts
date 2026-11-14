import type { LiveServerMessage, LiveWireUpdate } from '@aia/client-contract';
import { beforeEach, describe, expect, it } from 'vitest';

import type { LiveListener, SocketLike, Timers } from './live-connection.js';
import { LiveConnection } from './live-connection.js';

class FakeSocket implements SocketLike {
  readonly sent: unknown[] = [];
  closed: number | undefined;
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: ((event: { readonly code: number }) => void) | null = null;
  constructor(readonly url: string) {}
  send(text: string): void {
    this.sent.push(JSON.parse(text));
  }
  close(code = 1000): void {
    this.closed = code;
  }
  // The server's side
  accept(): void {
    this.onopen?.();
  }
  deliver(message: LiveServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  drop(code = 1006): void {
    this.onclose?.({ code });
  }
}

class FakeTimers implements Timers {
  readonly pending: { run: () => void; ms: number }[] = [];
  set(run: () => void, ms: number): unknown {
    const timer = { run, ms };
    this.pending.push(timer);
    return timer;
  }
  clear(handle: unknown): void {
    const i = this.pending.indexOf(handle as { run: () => void; ms: number });
    if (i >= 0) this.pending.splice(i, 1);
  }
  fire(): number {
    const timer = this.pending.shift();
    timer?.run();
    return timer?.ms ?? -1;
  }
}

class Recorder implements LiveListener {
  readonly got: (readonly LiveWireUpdate[])[] = [];
  resyncs = 0;
  readonly errors: string[] = [];
  updates(updates: readonly LiveWireUpdate[]): void {
    this.got.push(updates);
  }
  resync(): void {
    this.resyncs++;
  }
  error(code: string): void {
    this.errors.push(code);
  }
}

const update = (instrument: string, timeframe: '1m' | '5m', time: number, close: number): LiveWireUpdate => ({
  instrument,
  timeframe,
  forming: true,
  bar: { time, open: close, high: close, low: close, close, volume: 1 },
});

let sockets: FakeSocket[];
let timers: FakeTimers;
let states: string[];
let token: string | undefined;
let live: LiveConnection;

beforeEach(() => {
  sockets = [];
  timers = new FakeTimers();
  states = [];
  token = 'abc';
  live = new LiveConnection({
    url: () => `ws://host/live${token === undefined ? '' : `?token=${token}`}`,
    open: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    timers,
    random: () => 0.5,
    onState: (s) => states.push(s),
  });
});

const socket = () => sockets[sockets.length - 1] as FakeSocket;

describe('LiveConnection', () => {
  it('opens one socket on the first subscription and sends every subscription once it is open', () => {
    expect(sockets).toHaveLength(0);
    live.subscribe('BTCUSD', '1m', new Recorder());
    live.subscribe('ETHUSD', '5m', new Recorder());
    expect(sockets).toHaveLength(1);
    expect(socket().url).toBe('ws://host/live?token=abc');
    socket().accept();
    expect(socket().sent).toEqual([
      { op: 'subscribe', instrument: 'BTCUSD', tf: '1m' },
      { op: 'subscribe', instrument: 'ETHUSD', tf: '5m' },
    ]);
    expect(states).toEqual(['connecting', 'open']);
  });

  it('ref-counts: one subscribe per instrument and timeframe, and unsubscribe when the last listener leaves', () => {
    live.subscribe('BTCUSD', '1m', new Recorder());
    socket().accept();
    const stopA = live.subscribe('BTCUSD', '5m', new Recorder());
    const stopB = live.subscribe('BTCUSD', '5m', new Recorder());
    stopA();
    stopB();
    stopB();
    expect(socket().sent.slice(1)).toEqual([
      { op: 'subscribe', instrument: 'BTCUSD', tf: '5m' },
      { op: 'unsubscribe', instrument: 'BTCUSD', tf: '5m' },
    ]);
  });

  it('routes updates to the listeners of their instrument and timeframe, in order', () => {
    const btc = new Recorder();
    const eth = new Recorder();
    live.subscribe('BTCUSD', '1m', btc);
    live.subscribe('ETHUSD', '1m', eth);
    socket().accept();
    socket().deliver({ type: 'bars', updates: [update('BTCUSD', '1m', 60, 1), update('ETHUSD', '1m', 60, 2), update('BTCUSD', '1m', 120, 3)] });
    expect(btc.got).toEqual([[update('BTCUSD', '1m', 60, 1), update('BTCUSD', '1m', 120, 3)]]);
    expect(eth.got).toEqual([[update('ETHUSD', '1m', 60, 2)]]);
  });

  it('sends resync to everyone, and an error to its own subscription or to all when it names none', () => {
    const btc = new Recorder();
    const eth = new Recorder();
    live.subscribe('BTCUSD', '1m', btc);
    live.subscribe('ETHUSD', '1m', eth);
    socket().accept();
    socket().deliver({ type: 'resync' });
    socket().deliver({ type: 'error', code: 'forbidden', message: 'no', instrument: 'ETHUSD', timeframe: '1m' });
    socket().deliver({ type: 'error', code: 'bad_parameter', message: 'no' });
    expect([btc.resyncs, eth.resyncs]).toEqual([1, 1]);
    expect(btc.errors).toEqual(['bad_parameter']);
    expect(eth.errors).toEqual(['forbidden', 'bad_parameter']);
  });

  it('ignores a message that is not JSON', () => {
    const btc = new Recorder();
    live.subscribe('BTCUSD', '1m', btc);
    socket().accept();
    socket().onmessage?.({ data: 'not json' });
    expect(btc.got).toEqual([]);
  });

  it('reconnects with backoff, resubscribes, tells every listener to resync, and picks up a new token', () => {
    const btc = new Recorder();
    live.subscribe('BTCUSD', '1m', btc);
    socket().accept();
    socket().drop(1013);
    expect(states.at(-1)).toBe('reconnecting');
    expect(timers.fire()).toBe(500);
    // The retry itself fails: the wait doubles.
    socket().drop();
    token = 'new';
    expect(timers.fire()).toBe(1000);
    socket().accept();
    expect(socket().url).toBe('ws://host/live?token=new');
    expect(socket().sent).toEqual([{ op: 'subscribe', instrument: 'BTCUSD', tf: '1m' }]);
    expect(btc.resyncs).toBe(1);
    expect(states.at(-1)).toBe('open');
  });

  it('caps the backoff at 30 s and starts over once a connection gets a message', () => {
    live.subscribe('BTCUSD', '1m', new Recorder());
    const waits: number[] = [];
    for (let i = 0; i < 8; i++) {
      socket().drop();
      waits.push(timers.fire());
    }
    expect(waits).toEqual([500, 1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    socket().accept();
    socket().deliver({ type: 'subscribed', instrument: 'BTCUSD', timeframe: '1m' });
    socket().drop();
    expect(timers.fire()).toBe(500);
  });

  it('applies jitter to the wait', () => {
    const jittered = new LiveConnection({
      url: () => 'ws://host/live',
      open: (url) => {
        const s = new FakeSocket(url);
        sockets.push(s);
        return s;
      },
      timers,
      random: () => 0,
    });
    jittered.subscribe('BTCUSD', '1m', new Recorder());
    socket().drop();
    expect(timers.fire()).toBe(400);
  });

  it('stops for good on dispose', () => {
    live.subscribe('BTCUSD', '1m', new Recorder());
    socket().accept();
    const first = socket();
    live.dispose();
    first.drop(1000);
    expect(first.closed).toBe(1000);
    expect(timers.pending).toHaveLength(0);
    expect(sockets).toHaveLength(1);
    expect(states.at(-1)).toBe('closed');
  });
});
