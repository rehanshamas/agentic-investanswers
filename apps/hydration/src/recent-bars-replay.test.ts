// M2-02 done-check: "cache equals the store after replay."
//
// The real Coinbase recording M1-05 saved (BTC-USD and ETH-USD, 32 minutes,
// 2026-11-10, in contexts/hydration/test-data/) is replayed through the real
// adapter and LiveStream into raw, each closed minute is cooked as `pnpm live`
// does, and the BarClosed events go to the recent-bars cache. Afterwards every
// cached window must equal what the store holds over the same span, bar for
// bar, for 1m, 5m, 15m, 1h and 4h.
//
// Two ways in: windows warmed before the first minute (every update applied),
// and windows warmed halfway (updates before that ignored, the window then
// filled from the store). Each runs on the in-memory cache, and on Redis when
// the local one is reachable.

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

import type { Cancel, LiveRawStorePort, RawDayRef, Scheduler, SocketLike } from '@aia/hydration';
import { CoinbaseTrades, LiveStream } from '@aia/hydration';
import type { CookedBarStorePort, RecentBarsCachePort } from '@aia/market-data';
import {
  CookIntraday,
  INTRADAY_ROLLUPS,
  MemoryRecentBarsCache,
  RecentBars,
  RedisRecentBarsCache,
  barClosedEvents,
  parityInstrument,
  partitionOf,
} from '@aia/market-data';
import type { Bar, BarTime, Instrument, Timeframe } from '@aia/shared-kernel';
import { barTime } from '@aia/shared-kernel';
import { afterAll, describe, expect, it } from 'vitest';

import { RawMinuteSource } from './raw-minute-source.js';

// The recording belongs to the hydration context's tests; read as data, not imported.
const RECORDING = new URL('../../../contexts/hydration/test-data/coinbase-matches-2026-11-10.jsonl.gz', import.meta.url);
const INSTRUMENTS = ['BTCUSD', 'ETHUSD'].map((s) => parityInstrument(s) as Instrument);
const TIMEFRAMES: readonly Timeframe[] = ['1m', ...INTRADAY_ROLLUPS];

/** Fires timers in order as the recording's arrival times pass (as in M1-05's replay test). */
class ReplayClock implements Scheduler {
  time = 0;
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

class ReplaySocket implements SocketLike {
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  send(): void {}
  close(): void {}
}

const dayKey = (ref: RawDayRef): string => `${ref.symbol}/${ref.date}`;

class MemoryLiveStore implements LiveRawStorePort {
  private readonly bars = new Map<string, Bar[]>();
  putLiveMinute(ref: RawDayRef, bar: Bar): Promise<void> {
    this.bars.set(dayKey(ref), [...(this.bars.get(dayKey(ref)) ?? []), bar]);
    return Promise.resolve();
  }
  getLiveMinutes(ref: RawDayRef): Promise<Bar[]> {
    return Promise.resolve([...(this.bars.get(dayKey(ref)) ?? [])]);
  }
  putLiveGap(): Promise<void> {
    return Promise.resolve();
  }
  getLiveGaps(): Promise<never[]> {
    return Promise.resolve([]);
  }
}

class MemoryCookedStore implements CookedBarStorePort {
  private readonly partitions = new Map<string, Bar[]>();
  put(symbol: string, timeframe: Timeframe, bars: readonly Bar[]): Promise<void> {
    const touched = new Map<string, Bar[]>();
    for (const bar of bars) {
      const key = `${symbol}/${timeframe}/${partitionOf(timeframe, bar.time)}`;
      touched.set(key, [...(touched.get(key) ?? []), bar]);
    }
    for (const [key, group] of touched) this.partitions.set(key, group);
    return Promise.resolve();
  }
  getRange(symbol: string, timeframe: Timeframe, from: BarTime, until: BarTime): Promise<Bar[]> {
    const bars = [...this.partitions]
      .filter(([key]) => key.startsWith(`${symbol}/${timeframe}/`))
      .flatMap(([, group]) => group)
      .filter((b) => b.time >= from && b.time <= until);
    return Promise.resolve(bars.sort((a, b) => a.time - b.time));
  }
  getPartition(symbol: string, timeframe: Timeframe, partition: string): Promise<Bar[] | undefined> {
    return Promise.resolve(this.partitions.get(`${symbol}/${timeframe}/${partition}`));
  }
}

function recording(): Array<{ t: number; m: string }> {
  return gunzipSync(readFileSync(RECORDING))
    .toString('utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as { t: number; m: string });
}

const seconds = (ms: number): BarTime => barTime(Math.floor(ms / 1000));

async function replay(cache: RecentBarsCachePort, warmAt: 'start' | 'halfway') {
  const messages = recording();
  const clock = new ReplayClock();
  clock.time = messages[0]?.t ?? 0;
  const socket = new ReplaySocket();
  const raw = new MemoryLiveStore();
  const minutes = new RawMinuteSource(
    { getDay: () => Promise.resolve(undefined), getLiveMinutes: (ref) => raw.getLiveMinutes(ref) },
    () => undefined,
    () => 'coinbase',
  );
  const cooked = new MemoryCookedStore();
  const cook = new CookIntraday({ source: minutes, store: cooked });
  const recent = new RecentBars({ cache, store: cooked, minutes });

  const warm = async (now: BarTime) => {
    for (const instrument of INSTRUMENTS) {
      for (const tf of TIMEFRAMES) await recent.read(instrument, tf, { limit: 2_000, now });
    }
  };
  for (const instrument of INSTRUMENTS) await recent.invalidate(instrument.symbol, TIMEFRAMES);
  if (warmAt === 'start') await warm(seconds(clock.now()));

  // As `pnpm live`: per symbol in order, cook the minute, then tell the cache.
  let chain: Promise<void> = Promise.resolve();
  let seen = 0;
  let warmedWith = 0;
  const halfway = 30; // of about 60 minute events (two symbols)
  const stream = new LiveStream(
    {
      feed: new CoinbaseTrades({ socket: () => socket, now: () => clock.now() }),
      store: raw,
      scheduler: clock,
      onEvent: (event) => {
        if (event.kind !== 'minute') return;
        const instrument = INSTRUMENTS.find((i) => i.symbol === event.symbol) as Instrument;
        const now = seconds(clock.now());
        const n = ++seen;
        chain = chain
          .then(() => cook.applyNewMinutesToAll(instrument, [event.bar]))
          .then((rebuilt) => recent.onBarClosed(barClosedEvents(event.symbol, event.bar, rebuilt)))
          .then(async () => {
            if (warmAt !== 'halfway' || n !== halfway) return;
            warmedWith = (await minutes.read(instrument.symbol, barTime(now - 7_200), now)).length;
            await warm(now);
          });
      },
    },
    INSTRUMENTS,
  );

  stream.start();
  socket.onopen?.({});
  for (const { t, m } of messages) {
    clock.advance(t);
    socket.onmessage?.({ data: m });
    // Let the raw writes, cooking and cache updates keep pace with the feed,
    // so "halfway" really is halfway through the stored minutes.
    await new Promise((resolve) => setImmediate(resolve));
  }
  clock.advance((messages.at(-1)?.t ?? 0) + 3_000);
  await stream.stop();
  await chain;
  expect(seen).toBeGreaterThan(halfway);
  if (warmAt === 'halfway') {
    // Warmed with part of the minutes stored, and many more applied after.
    expect(warmedWith).toBeGreaterThan(5);
    expect(warmedWith).toBeLessThan(seen / 2 - 5);
  }

  return { recent, cooked, minutes, end: seconds(clock.now()) };
}

const redis = await RedisRecentBarsCache.connect({
  url: process.env['AIA_REDIS_TEST_URL'] ?? 'redis://127.0.0.1:6379/15',
}).catch(() => undefined);
if (redis === undefined) console.warn('Redis unreachable: skipping the Redis replay (run: docker compose up -d)');
afterAll(() => redis?.close());

const cases: Array<[string, 'start' | 'halfway', () => RecentBarsCachePort | undefined]> = [
  ['memory, warmed at the start', 'start', () => new MemoryRecentBarsCache()],
  ['memory, warmed halfway', 'halfway', () => new MemoryRecentBarsCache()],
  ['redis, warmed at the start', 'start', () => redis],
  ['redis, warmed halfway', 'halfway', () => redis],
];

describe('recent-bars cache after a replay of the recorded Coinbase stream (M2-02 done-check)', () => {
  it.each(cases)('%s: every window equals the store', async (_name, warmAt, make) => {
    const cache = make();
    if (cache === undefined) return;
    const { cooked, minutes, end } = await replay(cache, warmAt);

    for (const instrument of INSTRUMENTS) {
      for (const tf of TIMEFRAMES) {
        const window = await cache.get(instrument.symbol, tf);
        expect(window, `${instrument.symbol} ${tf} has a window`).toBeDefined();
        const { from, bars } = window as NonNullable<typeof window>;
        const stored =
          tf === '1m'
            ? await minutes.read(instrument.symbol, from, end)
            : await cooked.getRange(instrument.symbol, tf, from, end);
        expect(bars, `${instrument.symbol} ${tf}`).toEqual(stored);
        // The replay covers about 30 minutes, so every timeframe has bars.
        expect(stored.length, `${instrument.symbol} ${tf} bars`).toBeGreaterThanOrEqual(tf === '1m' ? 25 : 1);
      }
    }
  }, 30_000);

  it('serves the newest bars after the replay from the cache alone', async () => {
    const cache = new MemoryRecentBarsCache();
    const { recent, cooked, minutes, end } = await replay(cache, 'start');
    let storeReads = 0;
    const counting = new RecentBars({
      cache,
      store: { getRange: (...args) => (storeReads++, cooked.getRange(...args)) },
      minutes: { read: (...args) => (storeReads++, minutes.read(...args)) },
    });
    for (const instrument of INSTRUMENTS) {
      expect(await counting.read(instrument, '5m', { limit: 3, now: end })).toEqual(
        (await cooked.getRange(instrument.symbol, '5m', barTime(end - 3_600), end)).slice(-3),
      );
      expect(await counting.read(instrument, '1m', { limit: 10, now: end })).toEqual(
        await recent.read(instrument, '1m', { limit: 10, now: end }),
      );
    }
    expect(storeReads).toBe(0);
  }, 30_000);
});
