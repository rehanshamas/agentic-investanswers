// The reconnect test (M1-05 done-check): a fake feed drops mid-minute. The
// half-built bar is not written, the lost minutes are recorded as a gap,
// reconnects back off, and bars resume after the reconnect.

import type { Bar, Instrument } from '@aia/shared-kernel';
import { barTime, barTimeFromUtcParts, price, volume } from '@aia/shared-kernel';
import { describe, expect, it } from 'vitest';

import type { LiveGap, LiveTrade } from '../domain/live-minutes.js';
import type { LiveRawStorePort } from './live-raw-store-port.js';
import { LiveMinuteAlreadyStoredError } from './live-raw-store-port.js';
import type { Cancel, LiveEvent, Scheduler } from './live-stream.js';
import { LiveStream } from './live-stream.js';
import type { LiveConnection, LiveSink, LiveTradesPort } from './live-trades-port.js';
import type { RawDayRef } from './raw-bar-store-port.js';

const BTC: Instrument = { symbol: 'BTCUSD', kind: 'crypto', venue: 'TEST', timeZone: 'UTC', priceScale: 2, volumeScale: 8 };
const T0 = barTimeFromUtcParts(2026, 11, 10, 12, 0) * 1000;
const at = (minute: number, second: number): number => T0 + minute * 60_000 + second * 1000;
const minute = (m: number) => barTime(T0 / 1000 + m * 60);

class FakeClock implements Scheduler {
  time = T0;
  private timers: Array<{ due: number; every?: number; run: () => void; live: boolean }> = [];
  now(): number {
    return this.time;
  }
  every(ms: number, run: () => void): Cancel {
    const timer = { due: this.time + ms, every: ms, run, live: true };
    this.timers.push(timer);
    return () => (timer.live = false);
  }
  after(ms: number, run: () => void): Cancel {
    const timer = { due: this.time + ms, run, live: true };
    this.timers.push(timer);
    return () => (timer.live = false);
  }
  /** Move to `to`, firing timers in order as their time comes. */
  advance(to: number): void {
    for (;;) {
      const next = this.timers.filter((t) => t.live && t.due <= to).sort((a, b) => a.due - b.due)[0];
      if (next === undefined) break;
      this.time = next.due;
      if (next.every === undefined) next.live = false;
      else next.due += next.every;
      next.run();
    }
    this.time = to;
  }
}

class FakeFeed implements LiveTradesPort {
  readonly name = 'fake';
  connects: number[] = [];
  sink: LiveSink | undefined;
  closed = 0;
  constructor(private readonly clock: FakeClock) {}
  connect(_instruments: readonly Instrument[], sink: LiveSink): LiveConnection {
    this.connects.push(this.clock.now());
    this.sink = sink;
    return { close: () => this.closed++ };
  }
  trade(timeMs: number, p: number, seq: number): void {
    const trade: LiveTrade = { timeMs, seq, price: price(p), size: volume(1) };
    this.sink?.onTrade('BTCUSD', trade);
  }
}

class MemoryLiveStore implements LiveRawStorePort {
  readonly minutes = new Map<string, Bar>();
  readonly gaps: Array<{ ref: RawDayRef; gap: LiveGap }> = [];
  putLiveMinute(ref: RawDayRef, bar: Bar): Promise<void> {
    const key = `${ref.provider}/${ref.symbol}/${ref.date}/${bar.time}`;
    if (this.minutes.has(key)) return Promise.reject(new LiveMinuteAlreadyStoredError(key));
    this.minutes.set(key, bar);
    return Promise.resolve();
  }
  getLiveMinutes(): Promise<Bar[]> {
    return Promise.resolve([...this.minutes.values()]);
  }
  putLiveGap(ref: RawDayRef, gap: LiveGap): Promise<void> {
    this.gaps.push({ ref, gap });
    return Promise.resolve();
  }
  getLiveGaps(): Promise<LiveGap[]> {
    return Promise.resolve(this.gaps.map((g) => g.gap));
  }
  times(): number[] {
    return [...this.minutes.values()].map((b) => b.time).sort((a, b) => a - b);
  }
}

function setup(heartbeatTimeoutMs = 60 * 60_000) {
  const clock = new FakeClock();
  const feed = new FakeFeed(clock);
  const store = new MemoryLiveStore();
  const events: LiveEvent[] = [];
  const stream = new LiveStream({ feed, store, scheduler: clock, onEvent: (e) => events.push(e) }, [BTC], {
    random: () => 1, // no jitter: delays are exactly 1 s, 2 s, 4 s, ...
    // The fake feed sends no heartbeats; only the silence test uses the real timeout.
    heartbeatTimeoutMs,
  });
  return { clock, feed, store, events, stream };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('LiveStream', () => {
  it('writes each whole minute once it closes, skipping the partial first minute', async () => {
    const { clock, feed, store, stream } = setup();
    clock.time = at(0, 30);
    stream.start();
    feed.sink?.onOpen();
    feed.trade(at(0, 40), 100, 1); // 12:00 is partial: dropped
    clock.advance(at(1, 10));
    feed.trade(at(1, 10), 101, 2);
    clock.advance(at(1, 50));
    feed.trade(at(1, 50), 102, 3);
    clock.advance(at(2, 3));
    await flush();

    expect(store.times()).toEqual([minute(1)]);
    expect([...store.minutes.values()][0]).toMatchObject({ open: 101, close: 102, volume: 2 });
    expect([...store.minutes.keys()][0]).toMatch(/^fake\/BTCUSD\/2026-11-10\//);
    await stream.stop();
  });

  it('on a drop mid-minute: no half bar, a gap for the lost minutes, backoff, then bars resume', async () => {
    const { clock, feed, store, events, stream } = setup();
    clock.time = at(0, 0);
    stream.start();
    feed.sink?.onOpen();
    feed.trade(at(0, 10), 100, 1);
    clock.advance(at(1, 5)); // 12:00 closes and is written
    feed.trade(at(1, 20), 105, 2); // 12:01 forming...
    clock.advance(at(1, 30));
    feed.sink?.onClose('socket closed'); // ...and lost

    // Reconnect attempts back off: the first fails to open and drops again.
    clock.advance(at(1, 31)); // +1 s: second connect
    expect(feed.connects).toEqual([at(0, 0), at(1, 31)]);
    feed.sink?.onClose('refused');
    clock.advance(at(1, 33)); // +2 s: third connect
    expect(feed.connects).toEqual([at(0, 0), at(1, 31), at(1, 33)]);

    // Opens at 12:03:20. 12:01 to 12:03 are the gap; 12:04 is the first whole minute.
    clock.advance(at(3, 20));
    feed.sink?.onOpen();
    feed.trade(at(3, 25), 110, 3); // partial minute: dropped
    clock.advance(at(4, 1));
    feed.trade(at(4, 1), 111, 4);
    clock.advance(at(5, 3));
    await flush();

    expect(store.times()).toEqual([minute(0), minute(4)]);
    expect(store.gaps.map((g) => [g.gap.from, g.gap.until])).toEqual([[minute(1), minute(4)]]);
    expect(events.filter((e) => e.kind === 'disconnected').map((e) => e.kind === 'disconnected' && e.retryInMs)).toEqual([
      1000, 2000,
    ]);
    await stream.stop();
  });

  it('treats silence as a dead connection and reconnects', async () => {
    const { clock, feed, events, stream } = setup(30_000);
    clock.time = at(0, 0);
    stream.start();
    feed.sink?.onOpen();
    clock.advance(at(0, 20));
    feed.sink?.onAlive();
    clock.advance(at(0, 50)); // 30 s since the heartbeat: still alive
    expect(events.some((e) => e.kind === 'disconnected')).toBe(false);
    clock.advance(at(0, 51)); // the first tick past 30 s, at 30.25 s, drops it
    expect(events.find((e) => e.kind === 'disconnected')).toMatchObject({ reason: 'no message for 30 s' });
    expect(feed.closed).toBe(1);
    clock.advance(at(0, 53));
    expect(feed.connects).toHaveLength(2);
    await stream.stop();
  });

  it('caps the delay, and resets it after a healthy connection', async () => {
    const { clock, feed, events, stream } = setup();
    stream.start();
    for (let i = 0; i < 8; i++) {
      feed.sink?.onClose('refused');
      clock.advance(clock.now() + 60_000);
    }
    const delays = () => events.flatMap((e) => (e.kind === 'disconnected' ? [e.retryInMs] : []));
    expect(delays()).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);

    feed.sink?.onOpen();
    for (let s = 0; s < 6 * 60; s += 10) {
      clock.advance(clock.now() + 10_000);
      feed.sink?.onAlive();
    }
    feed.sink?.onClose('socket closed');
    expect(delays().at(-1)).toBe(1000);
    await stream.stop();
  });

  it('ignores a stale connection after it was replaced', async () => {
    const { clock, feed, store, stream } = setup();
    stream.start();
    const first = feed.sink;
    first?.onClose('socket closed');
    clock.advance(clock.now() + 1000);
    first?.onOpen(); // the old socket must not resurrect the stream
    first?.onTrade('BTCUSD', { timeMs: clock.now(), seq: 1, price: price(1), size: volume(1) });
    clock.advance(clock.now() + 120_000);
    await flush();
    expect(store.times()).toEqual([]);
    await stream.stop();
  });

  it('splits a gap across midnight into one record per UTC day', async () => {
    const { clock, feed, store, stream } = setup();
    const lateEvening = barTimeFromUtcParts(2026, 11, 10, 23, 58) * 1000;
    clock.time = lateEvening;
    stream.start();
    feed.sink?.onOpen();
    clock.advance(lateEvening + 30_000);
    feed.sink?.onClose('socket closed');
    clock.advance(lateEvening + 31_000);
    clock.advance(lateEvening + 5 * 60_000 + 10_000); // 00:03:10 next day
    feed.sink?.onOpen();
    await flush();
    expect(store.gaps.map((g) => g.ref.date)).toEqual(['2026-11-10', '2026-11-11']);
    await stream.stop();
  });
});
