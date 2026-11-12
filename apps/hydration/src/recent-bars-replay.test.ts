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

import { CoinbaseTrades, LiveStream, RawMinuteSource } from '@aia/hydration';
import type { RecentBarsCachePort } from '@aia/market-data';
import { CookIntraday, MemoryRecentBarsCache, RecentBars, RedisRecentBarsCache, barClosedEvents } from '@aia/market-data';
import type { BarTime, Instrument } from '@aia/shared-kernel';
import { barTime } from '@aia/shared-kernel';
import { afterAll, describe, expect, it } from 'vitest';

import {
  INSTRUMENTS,
  MemoryCookedStore,
  MemoryLiveStore,
  ReplayClock,
  ReplaySocket,
  TIMEFRAMES,
  recording,
  seconds,
} from './replay-support.js';


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
