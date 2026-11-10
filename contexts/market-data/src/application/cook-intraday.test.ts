import type { Bar, BarTime, Instrument, Timeframe } from '@aia/shared-kernel';
import {
  barTimeFromUtcParts,
  nyseCalendar,
  parseScaled,
  price,
  sessionOn,
  volume,
} from '@aia/shared-kernel';
import { beforeEach, describe, expect, it } from 'vitest';

import { partitionOf } from '../domain/cooked-partition.js';
import type { CookedBarStorePort } from './cooked-bar-store-port.js';
import { CookIntraday, CookIntradayError } from './cook-intraday.js';
import type { OneMinuteBarSourcePort } from './one-minute-bar-source-port.js';

const BTC: Instrument = {
  symbol: 'BTCUSD', kind: 'crypto', venue: 'COINBASE',
  timeZone: 'UTC', priceScale: 2, volumeScale: 8,
};
const NVDA: Instrument = {
  symbol: 'NVDA', kind: 'stock', venue: 'NASDAQ',
  timeZone: 'America/New_York', priceScale: 2, volumeScale: 0,
};
const nyse = nyseCalendar();

/** 1-minute source held in memory, so these tests need no S3 at all. */
class MemorySource implements OneMinuteBarSourcePort {
  readonly reads: Array<{ from: BarTime; until: BarTime }> = [];
  private bars: Bar[] = [];

  add(...bars: Bar[]): void {
    this.bars = [...this.bars, ...bars].sort((a, b) => a.time - b.time);
  }

  read(_symbol: string, from: BarTime, until: BarTime): Promise<Bar[]> {
    this.reads.push({ from, until });
    return Promise.resolve(this.bars.filter((b) => b.time >= from && b.time <= until));
  }
}

/** Records what was written, so "only the affected bars" can be asserted. */
class RecordingStore implements CookedBarStorePort {
  readonly writes: Array<{ timeframe: Timeframe; bars: Bar[] }> = [];
  private readonly held = new Map<string, Bar[]>();

  put(symbol: string, timeframe: Timeframe, bars: readonly Bar[]): Promise<void> {
    this.writes.push({ timeframe, bars: [...bars] });
    const key = `${symbol}/${timeframe}`;
    const existing = new Map((this.held.get(key) ?? []).map((b) => [b.time, b]));
    for (const bar of bars) existing.set(bar.time, bar);
    this.held.set(key, [...existing.values()].sort((a, b) => a.time - b.time));
    return Promise.resolve();
  }

  getRange(symbol: string, timeframe: Timeframe, from: BarTime, until: BarTime): Promise<Bar[]> {
    const all = this.held.get(`${symbol}/${timeframe}`) ?? [];
    return Promise.resolve(all.filter((b) => b.time >= from && b.time <= until));
  }

  getPartition(): Promise<Bar[] | undefined> {
    return Promise.resolve(undefined);
  }

  held_(symbol: string, timeframe: Timeframe): Bar[] {
    return this.held.get(`${symbol}/${timeframe}`) ?? [];
  }
}

const t0 = barTimeFromUtcParts(2024, 3, 15);
const at = (minutes: number): BarTime => (t0 + minutes * 60) as BarTime;

function m(time: BarTime, close: string, vol = '1.00000000', scale = 8): Bar {
  const p = price(parseScaled(close, 2));
  return { time, open: p, high: p, low: p, close: p, volume: volume(parseScaled(vol, scale)) };
}

describe('CookIntraday', () => {
  let source: MemorySource;
  let store: RecordingStore;
  let cook: CookIntraday;

  beforeEach(() => {
    source = new MemorySource();
    store = new RecordingStore();
    cook = new CookIntraday({ source, store });
  });

  it('refuses calendar timeframes, which belong to M1-08', async () => {
    for (const timeframe of ['1D', '1W', '1M'] as const) {
      await expect(cook.applyNewMinutes(BTC, timeframe, [m(at(0), '1.00')])).rejects.toThrow(
        CookIntradayError,
      );
    }
  });

  describe('only the affected bars', () => {
    beforeEach(() => {
      // A full hour of minutes already stored.
      source.add(...Array.from({ length: 60 }, (_, i) => m(at(i), '100.00')));
    });

    it('writes exactly one bar per timeframe for one new minute', async () => {
      source.add(m(at(60), '101.00'));
      const result = await cook.applyNewMinutesToAll(BTC, [m(at(60), '101.00')]);

      for (const timeframe of ['5m', '15m', '1h', '4h'] as const) {
        expect(result.get(timeframe)).toHaveLength(1);
      }
      // One write per timeframe, each carrying a single bar.
      expect(store.writes).toHaveLength(4);
      for (const write of store.writes) expect(write.bars).toHaveLength(1);
    });

    it('rebuilds the bucket the minute lands in, not its neighbours', async () => {
      source.add(m(at(62), '105.00'));
      const written = await cook.applyNewMinutes(BTC, '5m', [m(at(62), '105.00')]);
      expect(written).toHaveLength(1);
      expect(written[0]?.time).toBe(at(60));
    });

    it('reads the whole bucket, not just the new minute', async () => {
      // A bar is only correct if built from every minute it covers, so the
      // read must span the bucket rather than the arriving minute. Minute 67
      // is past the 60 already stored, so nothing is duplicated.
      const arriving = m(at(67), '109.00');
      source.add(arriving);
      source.reads.length = 0;
      await cook.applyNewMinutes(BTC, '5m', [arriving]);
      expect(source.reads).toHaveLength(1);
      expect(source.reads[0]?.from).toBe(at(65));
      expect(source.reads[0]?.until).toBe((at(70) - 1) as BarTime);
    });

    it('does nothing when the new minutes belong to no bar', async () => {
      const weekend = m(barTimeFromUtcParts(2024, 1, 20, 15, 0, 0), '1.00', '1', 0);
      const stockCook = new CookIntraday({ source, store, calendar: nyse });
      expect(await stockCook.applyNewMinutes(NVDA, '1h', [weekend])).toEqual([]);
      expect(store.writes).toHaveLength(0);
    });
  });

  describe('incremental equals a full re-cook', () => {
    it('agrees bar for bar over a day of crypto minutes', async () => {
      const day = Array.from({ length: 1440 }, (_, i) =>
        m(at(i), (100 + (i % 7)).toFixed(2), '0.00100000'),
      );

      // Minute by minute, as the live stream would deliver them.
      const incremental = new RecordingStore();
      const incrementalCook = new CookIntraday({ source, store: incremental });
      for (const minute of day) {
        source.add(minute);
        await incrementalCook.applyNewMinutes(BTC, '15m', [minute]);
      }

      // One pass over the whole range, as a rebuild would.
      const full = new RecordingStore();
      const fullCook = new CookIntraday({ source, store: full });
      await fullCook.cookRange(BTC, '15m', at(0), at(1439));

      expect(incremental.held_('BTCUSD', '15m')).toEqual(full.held_('BTCUSD', '15m'));
      expect(full.held_('BTCUSD', '15m')).toHaveLength(96);
    });

    it('agrees for a stock session, including the short last 1h bar', async () => {
      const open = sessionOn(NVDA, nyse, '2024-01-16')?.open ?? (0 as BarTime);
      const session = Array.from({ length: 390 }, (_, i) =>
        m((open + i * 60) as BarTime, (500 + (i % 5)).toFixed(2), '10', 0),
      );

      const incremental = new RecordingStore();
      const incCook = new CookIntraday({ source, store: incremental, calendar: nyse });
      for (const minute of session) {
        source.add(minute);
        await incCook.applyNewMinutes(NVDA, '1h', [minute]);
      }

      const full = new RecordingStore();
      const fullCook = new CookIntraday({ source, store: full, calendar: nyse });
      await fullCook.cookRange(NVDA, '1h', open, (open + 389 * 60) as BarTime);

      expect(incremental.held_('NVDA', '1h')).toEqual(full.held_('NVDA', '1h'));
      expect(full.held_('NVDA', '1h')).toHaveLength(7);
    });
  });

  describe('late-arriving minutes', () => {
    it('corrects an already-cooked bucket and leaves the others alone', async () => {
      const minutes = [at(0), at(1), at(3), at(4), at(5), at(6)].map((t) => m(t, '100.00'));
      source.add(...minutes);
      await cook.cookRange(BTC, '5m', at(0), at(9));
      const before = store.held_('BTCUSD', '5m');
      expect(before).toHaveLength(2);

      // Minute 2 shows up late, with a new extreme inside the first bucket.
      const late: Bar = {
        time: at(2),
        open: price(parseScaled('100.00', 2)),
        high: price(parseScaled('150.00', 2)),
        low: price(parseScaled('100.00', 2)),
        close: price(parseScaled('100.00', 2)),
        volume: volume(parseScaled('1.00000000', 8)),
      };
      source.add(late);
      store.writes.length = 0;
      const written = await cook.applyNewMinutes(BTC, '5m', [late]);

      expect(written).toHaveLength(1);
      expect(written[0]?.time).toBe(at(0));
      expect(written[0]?.high).toBe(parseScaled('150.00', 2));
      // The second bucket was neither read nor rewritten.
      expect(store.writes.flatMap((w) => w.bars.map((b) => b.time))).toEqual([at(0)]);
      expect(store.held_('BTCUSD', '5m')[1]).toEqual(before[1]);
    });
  });
});

/**
 * A store with S3CookedBarStore's semantics: `put` replaces each partition it
 * touches whole. The merging RecordingStore above cannot show a lost
 * partition; this one can (found in M1-10).
 */
class PartitionStore implements CookedBarStorePort {
  readonly files = new Map<string, Bar[]>();

  put(symbol: string, timeframe: Timeframe, bars: readonly Bar[]): Promise<void> {
    const groups = new Map<string, Bar[]>();
    for (const bar of bars) {
      const key = `${symbol}/${timeframe}/${partitionOf(timeframe, bar.time)}`;
      groups.set(key, [...(groups.get(key) ?? []), bar]);
    }
    for (const [key, group] of groups) this.files.set(key, group);
    return Promise.resolve();
  }

  getRange(symbol: string, timeframe: Timeframe, from: BarTime, until: BarTime): Promise<Bar[]> {
    const all = [...this.files.entries()]
      .filter(([key]) => key.startsWith(`${symbol}/${timeframe}/`))
      .flatMap(([, bars]) => bars);
    return Promise.resolve(
      all.filter((b) => b.time >= from && b.time <= until).sort((a, b) => a.time - b.time),
    );
  }

  getPartition(symbol: string, timeframe: Timeframe, partition: string): Promise<Bar[] | undefined> {
    return Promise.resolve(this.files.get(`${symbol}/${timeframe}/${partition}`));
  }
}

describe('CookIntraday against a store that replaces whole partitions', () => {
  const day = (n: number): BarTime => barTimeFromUtcParts(2024, 3, n);
  const minutesOn = (d: number, count: number): Bar[] =>
    Array.from({ length: count }, (_, i) => m((day(d) + i * 60) as BarTime, '100.00'));

  it('one new minute leaves the rest of the month intact', async () => {
    const source = new MemorySource();
    const store = new PartitionStore();
    const cook = new CookIntraday({ source, store });
    source.add(...minutesOn(10, 30), ...minutesOn(20, 30));
    await cook.cookRange(BTC, '5m', day(1), day(31));
    expect(await store.getRange('BTCUSD', '5m', day(1), day(31))).toHaveLength(12);

    const late = m((day(20) + 30 * 60) as BarTime, '101.00');
    source.add(late);
    await cook.applyNewMinutes(BTC, '5m', [late]);

    const after = await store.getRange('BTCUSD', '5m', day(1), day(31));
    expect(after).toHaveLength(13);
    expect(after.filter((b) => b.time < day(11))).toHaveLength(6);
  });

  it('cooking part of a month keeps the bars outside that part', async () => {
    const source = new MemorySource();
    const store = new PartitionStore();
    const cook = new CookIntraday({ source, store });
    source.add(...minutesOn(10, 30), ...minutesOn(20, 30));
    await cook.cookRange(BTC, '5m', day(1), day(31));

    await cook.cookRange(BTC, '5m', day(20), day(21));

    expect(await store.getRange('BTCUSD', '5m', day(1), day(31))).toHaveLength(12);
  });
});
