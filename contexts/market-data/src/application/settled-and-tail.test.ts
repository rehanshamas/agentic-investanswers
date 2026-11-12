// M1-15: cooked bars as settled store plus tail. Live minutes cooked in
// memory (LiveCook) give what cooking into the store gave; the compactor
// writes settled days and moves the watermark; readers (CookedReader) see
// exactly a roll-up of every raw minute, wherever the watermark is; the
// rebuild check covers the settled part.

import type { Bar, BarTime, Instrument, Timeframe } from '@aia/shared-kernel';
import { barTime, barTimeFromUtcParts, price, volume } from '@aia/shared-kernel';
import { describe, expect, it } from 'vitest';

import { MemoryCookedWatermarks } from '../adapters/memory-cooked-watermarks.js';
import { partitionOf } from '../domain/cooked-partition.js';
import { rollUp } from '../domain/roll-up.js';
import { CookIntraday, INTRADAY_ROLLUPS } from './cook-intraday.js';
import { CookedCompactor } from './cooked-compactor.js';
import type { CookedBarStorePort } from './cooked-bar-store-port.js';
import { CookedReader } from './cooked-reader.js';
import { LiveCook } from './live-cook.js';
import type { OneMinuteBarSourcePort } from './one-minute-bar-source-port.js';
import { RebuildCheck } from './rebuild-check.js';

const BTC: Instrument = { symbol: 'BTCUSD', kind: 'crypto', venue: 'COINBASE', timeZone: 'UTC', priceScale: 2, volumeScale: 8 };
const DAY = 86_400;
const D0 = barTimeFromUtcParts(2026, 11, 10); // a UTC midnight

/** Repeatable wandering minutes, with holes so a missing minute is covered too. */
function minutes(from: number, count: number): Bar[] {
  const out: Bar[] = [];
  for (let i = 0; i < count; i++) {
    if (i % 97 === 13) continue; // a minute with no trades
    const t = from + i * 60;
    const base = 7_000_000 + ((t / 60) * 7_919) % 20_000;
    out.push({
      time: barTime(t),
      open: price(base),
      high: price(base + 30 + (i % 7)),
      low: price(base - 25 - (i % 5)),
      close: price(base + (i % 11) - 5),
      volume: volume(100_000_000 + i),
    });
  }
  return out;
}

class MemorySource implements OneMinuteBarSourcePort {
  reads = 0;
  constructor(public bars: Bar[] = []) {}
  read(_symbol: string, from: BarTime, until: BarTime): Promise<Bar[]> {
    this.reads++;
    return Promise.resolve(this.bars.filter((b) => b.time >= from && b.time <= until));
  }
}

class PartitionStore implements CookedBarStorePort {
  readonly partitions = new Map<string, Bar[]>();
  puts = 0;
  failPut: (() => boolean) | undefined;
  put(symbol: string, timeframe: Timeframe, bars: readonly Bar[]): Promise<void> {
    if (this.failPut?.() === true) return Promise.reject(new Error('S3 is down'));
    this.puts++;
    const groups = new Map<string, Bar[]>();
    for (const bar of bars) {
      const key = `${symbol}/${timeframe}/${partitionOf(timeframe, bar.time)}`;
      groups.set(key, [...(groups.get(key) ?? []), bar]);
    }
    for (const [key, group] of groups) this.partitions.set(key, group);
    return Promise.resolve();
  }
  getPartition(symbol: string, timeframe: Timeframe, partition: string): Promise<Bar[] | undefined> {
    return Promise.resolve(this.partitions.get(`${symbol}/${timeframe}/${partition}`));
  }
  getRange(symbol: string, timeframe: Timeframe, from: BarTime, until: BarTime): Promise<Bar[]> {
    const bars = [...this.partitions]
      .filter(([key]) => key.startsWith(`${symbol}/${timeframe}/`))
      .flatMap(([, group]) => group)
      .filter((b) => b.time >= from && b.time <= until);
    return Promise.resolve(bars.sort((a, b) => a.time - b.time));
  }
}

function setup(raw: Bar[]) {
  const source = new MemorySource(raw);
  const store = new PartitionStore();
  const watermarks = new MemoryCookedWatermarks();
  const cook = new CookIntraday({ source, store });
  const compactor = new CookedCompactor({ cook, watermarks, initialDays: 3 });
  let now = 0;
  const reader = new CookedReader({ store, watermarks, minutes: source, instruments: [BTC], nowMs: () => now, watermarkTtlMs: 0 });
  return { source, store, watermarks, cook, compactor, reader, tick: () => now++ };
}

const truth = (raw: readonly Bar[], tf: Timeframe, from: number, until: number) =>
  rollUp(BTC, tf, raw).filter((b) => b.time >= from && b.time <= until);

describe('LiveCook', () => {
  it('gives the same bars as cooking into the store, minute after minute, across 4h boundaries, from a mid-bucket start', async () => {
    // 2 hours already stored before the process started, then 6 live hours.
    const stored = minutes(D0 + 3 * 3_600, 120);
    const live = minutes(D0 + 5 * 3_600, 360);
    const source = new MemorySource([...stored]);
    const reference = new CookIntraday({ source, store: new PartitionStore() });
    const cook = new LiveCook({ instrument: BTC, timeframes: INTRADAY_ROLLUPS, source });
    for (const minute of live) {
      source.bars.push(minute); // the live stream stored it
      expect(await cook.apply(minute)).toEqual(await reference.applyNewMinutesToAll(BTC, [minute]));
    }
  });

  it('still matches when a minute older than its bucket in memory arrives (re-reads the source)', async () => {
    const all = minutes(D0, 600);
    const source = new MemorySource([]);
    const reference = new CookIntraday({ source, store: new PartitionStore() });
    const cook = new LiveCook({ instrument: BTC, timeframes: INTRADAY_ROLLUPS, source });
    // Hours 5 to 8 arrive first, then a stored minute from hour 1 shows up.
    for (const minute of all.filter((m) => m.time >= D0 + 4 * 3_600 && m.time < D0 + 8 * 3_600)) {
      source.bars.push(minute);
      await cook.apply(minute);
    }
    const late = all.find((m) => m.time === D0 + 3_600) as Bar;
    source.bars = [...source.bars, ...all.filter((m) => m.time < D0 + 3_600), late].sort((a, b) => a.time - b.time);
    expect(await cook.apply(late)).toEqual(await reference.applyNewMinutesToAll(BTC, [late]));
  });

  it('reads the source once to start, then cooks from memory', async () => {
    const source = new MemorySource(minutes(D0, 30));
    const cook = new LiveCook({ instrument: BTC, timeframes: INTRADAY_ROLLUPS, source });
    for (const minute of minutes(D0 + 1_800, 200)) await cook.apply(minute);
    expect(source.reads).toBe(1);
  });
});

describe('CookedCompactor', () => {
  it('writes each settled day once and moves the watermark a day at a time', async () => {
    const raw = minutes(D0 - 3 * DAY, 4 * 1_440);
    const { store, watermarks, compactor } = setup(raw);
    expect(await compactor.compact(BTC, barTime(D0))).toBe(3); // initialDays: 3
    expect(await watermarks.getWatermark('BTCUSD')).toBe(D0);
    expect(store.puts).toBe(3 * INTRADAY_ROLLUPS.length);
    expect(await compactor.compact(BTC, barTime(D0))).toBe(0); // up to date: nothing to do
    for (const tf of INTRADAY_ROLLUPS) {
      expect(await store.getRange('BTCUSD', tf, barTime(D0 - 3 * DAY), barTime(D0 - 1))).toEqual(truth(raw, tf, D0 - 3 * DAY, D0 - 1));
    }
  });

  it('after a crash mid-way, leaves the watermark at the last whole day and finishes on the next run', async () => {
    const raw = minutes(D0 - 3 * DAY, 3 * 1_440);
    const { store, watermarks, compactor } = setup(raw);
    let puts = 0;
    store.failPut = () => ++puts === 6; // during the second day
    await expect(compactor.compact(BTC, barTime(D0))).rejects.toThrow('S3 is down');
    expect(await watermarks.getWatermark('BTCUSD')).toBe(D0 - 2 * DAY);
    store.failPut = undefined;
    expect(await compactor.compact(BTC, barTime(D0))).toBe(2);
    expect(await watermarks.getWatermark('BTCUSD')).toBe(D0);
  });
});

describe('CookedReader', () => {
  const raw = minutes(D0 - 2 * DAY, 2 * 1_440 + 600); // two settled days and ten hours of today
  const ranges = (tf: Timeframe): Array<[number, number]> => {
    const span = { '5m': 300, '15m': 900, '1h': 3_600, '4h': 14_400 }[tf as '5m'] ?? 300;
    return [
      [D0 - 2 * DAY, D0 + 600 * 60], // everything
      [D0 - 3 * 3_600, D0 + 3 * 3_600], // across the watermark
      [D0 - DAY, D0 - 1], // settled only
      [D0 + 3 * 3_600, D0 + 9 * 3_600], // tail only
      [D0 + span * 2 + 60, D0 + span * 5 - 60], // starting and ending mid-bar
    ];
  };

  it('equals a roll-up of every raw minute, settled or not, for every timeframe and range', async () => {
    const { compactor, reader } = setup(raw);
    await compactor.compact(BTC, barTime(D0));
    for (const tf of INTRADAY_ROLLUPS) {
      for (const [from, until] of ranges(tf)) {
        expect(await reader.getRange('BTCUSD', tf, barTime(from), barTime(until)), `${tf} ${from}-${until}`).toEqual(truth(raw, tf, from, until));
      }
    }
  });

  it('stays exact when the compactor is behind, and when stale bars sit past the watermark', async () => {
    const { compactor, store, reader, watermarks } = setup(raw);
    await compactor.compact(BTC, barTime(D0 - DAY)); // a day behind
    expect(await watermarks.getWatermark('BTCUSD')).toBe(D0 - DAY);
    // A wrong bar past the watermark (as old per-minute cooking could leave) is never read.
    const wrong = { ...(truth(raw, '1h', D0, D0)[0] as Bar), close: price(1) };
    const partition = (await store.getPartition('BTCUSD', '1h', '2026-11')) ?? [];
    await store.put('BTCUSD', '1h', [...partition.filter((b) => b.time !== wrong.time), wrong].sort((a, b) => a.time - b.time));
    for (const tf of INTRADAY_ROLLUPS) {
      for (const [from, until] of ranges(tf)) {
        expect(await reader.getRange('BTCUSD', tf, barTime(from), barTime(until))).toEqual(truth(raw, tf, from, until));
      }
    }
  });

  it('reads the store alone for an instrument with no watermark yet (as before M1-15)', async () => {
    const { store, reader } = setup(raw);
    const bars = truth(raw, '5m', D0 - DAY, D0 - 1);
    await store.put('BTCUSD', '5m', bars);
    expect(await reader.getRange('BTCUSD', '5m', barTime(D0 - DAY), barTime(D0 + 3_600))).toEqual(bars);
  });

  it('reuses a watermark read for a while; a stale one only makes the tail longer', async () => {
    const source = new MemorySource(raw);
    const store = new PartitionStore();
    const watermarks = new MemoryCookedWatermarks();
    let reads = 0;
    let now = 0;
    const counting = { getWatermark: (s: string) => (reads++, watermarks.getWatermark(s)) };
    const reader = new CookedReader({ store, watermarks: counting, minutes: source, instruments: [BTC], nowMs: () => now });
    const compactor = new CookedCompactor({ cook: new CookIntraday({ source, store }), watermarks, initialDays: 2 });
    await compactor.compact(BTC, barTime(D0 - DAY));
    await reader.getRange('BTCUSD', '5m', barTime(D0), barTime(D0 + 3_600));
    await compactor.compact(BTC, barTime(D0)); // moves on; the reader still holds the older mark
    now = 1_000;
    expect(await reader.getRange('BTCUSD', '1h', barTime(D0 - DAY), barTime(D0 + 3_600))).toEqual(truth(raw, '1h', D0 - DAY, D0 + 3_600));
    expect(reads).toBe(1);
    now = 31_000;
    await reader.getRange('BTCUSD', '5m', barTime(D0), barTime(D0 + 3_600));
    expect(reads).toBe(2);
  });
});

describe('RebuildCheck with a watermark', () => {
  it('checks only settled bars, and still finds a wrong one', async () => {
    const raw = minutes(D0 - 2 * DAY, 2 * 1_440 + 600);
    const { compactor, store, watermarks, source } = setup(raw);
    await compactor.compact(BTC, barTime(D0));
    const check = new RebuildCheck({ source, store, watermarks });
    const clean = await check.run(BTC, ['2026-11']);
    expect(clean.length).toBe(INTRADAY_ROLLUPS.length);
    expect(clean.every((r) => r.kind === 'compared' && r.diff.differing + r.diff.missingFromStore + r.diff.notRebuildable === 0)).toBe(true);

    const [first] = truth(raw, '15m', D0 - DAY, D0 - DAY);
    const stored = (await store.getPartition('BTCUSD', '15m', '2026-11')) ?? [];
    await store.put('BTCUSD', '15m', stored.map((b) => (b.time === first?.time ? { ...b, close: price(1) } : b)));
    const dirty = await check.run(BTC, ['2026-11'], ['15m']);
    expect(dirty[0]?.diff.differing).toBe(1);
  });
});
