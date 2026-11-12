// M2-04: live updates for charts, end to end on the recorded Coinbase stream.
//
// The recording (BTC-USD and ETH-USD, 32 minutes) is replayed through the real
// adapter, LiveStream and `pnpm live`'s own LivePipeline (raw, cooking, the
// recent-bars cache, FormingBars), and every announcement is captured from the
// bus. It checks the safety rules:
// - a stored bar is announced only after the cache has it;
// - a chart applying every announcement in order ends equal to the store for
//   every bar but the newest of each timeframe (which may still be forming);
// - a forming 1m bar never follows its stored one, and the partial first
//   minute never forms;
// - forming bars go out at most once a tick (4 a second) per instrument.

import { CoinbaseTrades, LiveStream, RawMinuteSource } from '@aia/hydration';
import type { LiveBarUpdate, LiveBatch, RecentBarsCachePort } from '@aia/market-data';
import { MemoryLiveBarsBus, MemoryRecentBarsCache } from '@aia/market-data';
import type { Bar, Timeframe } from '@aia/shared-kernel';
import { describe, expect, it } from 'vitest';

import { LivePipeline } from './live-pipeline.js';
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

type Logged = { readonly kind: 'cached'; readonly key: string } | { readonly kind: 'announced'; readonly batch: LiveBatch };

const slot = (symbol: string, timeframe: Timeframe, bar: Bar) => `${symbol}:${timeframe}:${JSON.stringify(bar)}`;

async function replay() {
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

  // One log for cache writes and announcements, in the order they happen.
  const log: Logged[] = [];
  const memory = new MemoryRecentBarsCache();
  const cache: RecentBarsCachePort = {
    get: (s, tf) => memory.get(s, tf),
    version: (s, tf) => memory.version(s, tf),
    fill: (s, tf, w, v) => memory.fill(s, tf, w, v),
    invalidate: (s, tf) => memory.invalidate(s, tf),
    apply: async (s, tf, bar) => {
      await memory.apply(s, tf, bar);
      log.push({ kind: 'cached', key: slot(s, tf, bar) });
    },
  };
  const bus = new MemoryLiveBarsBus();
  await bus.subscribe({ batch: (batch) => log.push({ kind: 'announced', batch }), lost: () => {} });
  // `pnpm live`'s own pipeline: forming bars at once; per symbol in order,
  // cook the minute, update the cache, then announce the stored bars.
  const pipeline = new LivePipeline({
    instruments: INSTRUMENTS,
    raw: { getDay: () => Promise.resolve(undefined), getLiveMinutes: (ref) => raw.getLiveMinutes(ref) },
    rawProviderOf: () => undefined,
    liveProviderOf: () => 'coinbase',
    cooked,
    cache,
    bus,
    publisher: 'replay',
    log: () => {},
  });
  const stream = new LiveStream(
    {
      feed: new CoinbaseTrades({ socket: () => socket, now: () => clock.now() }),
      store: raw,
      scheduler: clock,
      onEvent: (event) => {
        if (event.kind === 'forming') pipeline.formingChanged(event.symbol, event.bars);
        if (event.kind === 'minute') void pipeline.minute('coinbase', event.symbol, event.bar);
      },
    },
    INSTRUMENTS,
  );

  stream.start();
  socket.onopen?.({});
  for (const { t, m } of messages) {
    clock.advance(t);
    socket.onmessage?.({ data: m });
    await new Promise((resolve) => setImmediate(resolve));
  }
  clock.advance((messages.at(-1)?.t ?? 0) + 3_000);
  await stream.stop();
  await pipeline.settled();
  const seconds_ = ((messages.at(-1)?.t ?? 0) - (messages[0]?.t ?? 0)) / 1000;
  return { log, cooked, minutes, end: seconds(clock.now()), seconds: seconds_ };
}

const updatesOf = (log: readonly Logged[]): LiveBarUpdate[] =>
  log.flatMap((entry) => (entry.kind === 'announced' ? entry.batch.updates : []));

describe('live updates after a replay of the recorded Coinbase stream (M2-04)', async () => {
  const { log, cooked, minutes, end, seconds: duration } = await replay();
  const updates = updatesOf(log);

  it('announces stored and forming bars for every instrument and timeframe, in sequence', () => {
    for (const { symbol } of INSTRUMENTS) {
      for (const tf of TIMEFRAMES) {
        const mine = updates.filter((u) => u.symbol === symbol && u.timeframe === tf);
        expect(mine.some((u) => u.forming), `${symbol} ${tf} forming`).toBe(true);
        expect(mine.some((u) => !u.forming), `${symbol} ${tf} stored`).toBe(true);
      }
    }
    const seqs = log.flatMap((e) => (e.kind === 'announced' ? [e.batch.seq] : []));
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
  });

  it('announces a stored bar only after the cache has it', () => {
    const cached = new Set<string>();
    for (const entry of log) {
      if (entry.kind === 'cached') {
        cached.add(entry.key);
        continue;
      }
      for (const u of entry.batch.updates) {
        if (!u.forming) expect(cached.has(slot(u.symbol, u.timeframe, u.bar)), `${u.symbol} ${u.timeframe} ${u.bar.time}`).toBe(true);
      }
    }
  });

  it('leaves a chart equal to the store, except the newest bar of each timeframe, which may still be forming', async () => {
    for (const { symbol } of INSTRUMENTS) {
      for (const tf of TIMEFRAMES) {
        const chart = new Map<number, LiveBarUpdate>();
        for (const u of updates) if (u.symbol === symbol && u.timeframe === tf) chart.set(u.bar.time, u);
        const times = [...chart.keys()].sort((a, b) => a - b);
        const from = times[0] as number;
        const stored = tf === '1m' ? await minutes.read(symbol, from as never, end) : await cooked.getRange(symbol, tf, from as never, end);
        const storedByTime = new Map(stored.map((b) => [b.time as number, b]));
        const newest = times.at(-1);
        let compared = 0;
        for (const time of times) {
          const last = chart.get(time) as LiveBarUpdate;
          if (last.forming) {
            expect(time, `${symbol} ${tf}: only the newest bar may end forming`).toBe(newest);
            continue;
          }
          expect(last.bar, `${symbol} ${tf} ${time}`).toEqual(storedByTime.get(time));
          compared++;
        }
        // Every stored bar since the chart's first was announced.
        expect(compared, `${symbol} ${tf}`).toBe(stored.filter((b) => b.time !== newest || !(chart.get(newest)?.forming ?? false)).length);
        // 32 minutes: about 30 stored 1m bars and 6 5m ones; one 4h bar, the newest, which may end forming.
        expect(compared).toBeGreaterThanOrEqual({ '1m': 25, '5m': 4, '15m': 1 }[tf as string] ?? 0);
      }
    }
  });

  it('never sends a forming 1m bar after its stored one, and never forms the partial first minute', () => {
    for (const { symbol } of INSTRUMENTS) {
      const mine = updates.filter((u) => u.symbol === symbol && u.timeframe === '1m');
      const firstStored = Math.min(...mine.filter((u) => !u.forming).map((u) => u.bar.time));
      const storedSoFar = new Set<number>();
      for (const u of mine) {
        if (!u.forming) storedSoFar.add(u.bar.time);
        else {
          expect(storedSoFar.has(u.bar.time)).toBe(false);
          expect(u.bar.time).toBeGreaterThanOrEqual(firstStored);
        }
      }
    }
  });

  it('sends forming bars at most 4 times a second per instrument', () => {
    for (const { symbol } of INSTRUMENTS) {
      const formingAnnouncements = log.filter(
        (e) => e.kind === 'announced' && e.batch.updates.every((u) => u.forming) && e.batch.updates[0]?.symbol === symbol,
      ).length;
      expect(formingAnnouncements).toBeGreaterThan(duration / 2); // it ticks with trades: the recording has about one a second
      expect(formingAnnouncements).toBeLessThanOrEqual(Math.ceil(duration * 4) + 1);
    }
  });
});
