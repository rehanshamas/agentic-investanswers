import type { Bar, BarTime, Instrument, Timeframe } from '@aia/shared-kernel';
import { barTime, price, volume } from '@aia/shared-kernel';
import { describe, expect, it } from 'vitest';

import { MemoryRecentBarsCache } from '../adapters/memory-recent-bars-cache.js';
import type { CookedBarStorePort } from './cooked-bar-store-port.js';
import type { OneMinuteBarSourcePort } from './one-minute-bar-source-port.js';
import { RecentBars, RecentBarsError } from './recent-bars.js';

const BTC: Instrument = {
  symbol: 'BTCUSD', kind: 'crypto', venue: 'COINBASE',
  timeZone: 'UTC', priceScale: 2, volumeScale: 8,
};
const T0 = 1_762_800_000; // a whole 5m boundary
const at = (minute: number) => barTime(T0 + minute * 60);

function bar(minute: number, close = 100): Bar {
  return { time: at(minute), open: price(close), high: price(close), low: price(close), close: price(close), volume: volume(1) };
}

/** Counts every read, so a cache hit can be proved to read nothing. */
class CountingStore implements Pick<CookedBarStorePort, 'getRange'>, OneMinuteBarSourcePort {
  reads = 0;
  constructor(public bars: Bar[]) {}
  getRange(_symbol: string, _tf: Timeframe, from: BarTime, until: BarTime): Promise<Bar[]> {
    return this.read('', from, until);
  }
  read(_symbol: string, from: BarTime, until: BarTime): Promise<Bar[]> {
    this.reads++;
    return Promise.resolve(this.bars.filter((b) => b.time >= from && b.time <= until));
  }
}

function setup(bars: Bar[], capacity = 100) {
  const store = new CountingStore(bars);
  const cache = new MemoryRecentBarsCache(capacity);
  const recent = new RecentBars({ cache, store, minutes: store, capacity });
  return { store, cache, recent };
}

// Five-minute bars at minutes 0, 5, ... 45; "now" is in the last one.
const fiveMinute = Array.from({ length: 10 }, (_, i) => bar(i * 5));
const now = at(47);

describe('RecentBars', () => {
  it('serves a second read from the cache, with no store read (cache hit)', async () => {
    const { store, recent } = setup(fiveMinute);
    const first = await recent.read(BTC, '5m', { limit: 4, now });
    expect(store.reads).toBe(1);

    const second = await recent.read(BTC, '5m', { limit: 4, now });
    expect(store.reads).toBe(1);
    expect(second).toEqual(first);
    expect(second.map((b) => b.time)).toEqual([at(30), at(35), at(40), at(45)]);
  });

  it('serves an older page from the window when it holds it', async () => {
    const { store, recent } = setup(fiveMinute);
    await recent.read(BTC, '5m', { limit: 4, now });
    const page = await recent.read(BTC, '5m', { limit: 3, before: at(30), now });
    expect(page.map((b) => b.time)).toEqual([at(15), at(20), at(25)]);
    expect(store.reads).toBe(1);
  });

  it('reads the store, and leaves the cache alone, for a page older than the window', async () => {
    const { store, cache, recent } = setup(fiveMinute, 3);
    await recent.read(BTC, '5m', { limit: 3, now });
    const window = await cache.get('BTCUSD', '5m');

    const page = await recent.read(BTC, '5m', { limit: 2, before: at(35), now });
    expect(page.map((b) => b.time)).toEqual([at(25), at(30)]);
    expect(store.reads).toBe(2);
    expect(await cache.get('BTCUSD', '5m')).toEqual(window);
  });

  it('keeps the window current on BarClosed, so the next read sees the new bar without the store', async () => {
    const { store, recent } = setup(fiveMinute);
    await recent.read(BTC, '5m', { limit: 2, now });
    // The store is written first, then the cache is told.
    store.bars = [...fiveMinute.slice(0, -1), bar(45, 101), bar(50)];
    await recent.onBarClosed([
      { symbol: 'BTCUSD', timeframe: '5m', bar: bar(45, 101) },
      { symbol: 'BTCUSD', timeframe: '5m', bar: bar(50) },
    ]);
    const reads = store.reads;
    expect(await recent.read(BTC, '5m', { limit: 2, now: at(51) })).toEqual([bar(45, 101), bar(50)]);
    expect(store.reads).toBe(reads);
  });

  it('reads 1m from the 1-minute source, since 1m is not cooked', async () => {
    const minutes = new CountingStore([bar(0), bar(1)]);
    const cooked = new CountingStore([]);
    const recent = new RecentBars({ cache: new MemoryRecentBarsCache(), store: cooked, minutes });
    expect(await recent.read(BTC, '1m', { limit: 5, now: at(1) })).toEqual([bar(0), bar(1)]);
    expect(cooked.reads).toBe(0);
  });

  it('does not keep a window that missed a bar written while the store was being read', async () => {
    const store = new CountingStore(fiveMinute);
    const cache = new MemoryRecentBarsCache();
    const recent = new RecentBars({ cache, store, minutes: store });
    const read = store.read.bind(store);
    store.read = async (symbol, from, until) => {
      const bars = await read(symbol, from, until);
      await cache.apply('BTCUSD', '5m', bar(50)); // a writer, mid-read
      return bars;
    };
    await recent.read(BTC, '5m', { limit: 2, now });
    expect(await cache.get('BTCUSD', '5m')).toBeUndefined();
  });

  it('drops a window whose update failed, so it is refilled rather than served stale', async () => {
    const { cache, recent } = setup(fiveMinute);
    await recent.read(BTC, '5m', { limit: 2, now });
    cache.apply = () => Promise.reject(new Error('connection lost'));
    await recent.onBarClosed([{ symbol: 'BTCUSD', timeframe: '5m', bar: bar(50) }]);
    expect(await cache.get('BTCUSD', '5m')).toBeUndefined();
  });

  it('says so when the window could not be dropped either', async () => {
    const { cache, recent } = setup(fiveMinute);
    cache.apply = () => Promise.reject(new Error('down'));
    cache.invalidate = () => Promise.reject(new Error('down'));
    await expect(recent.onBarClosed([{ symbol: 'BTCUSD', timeframe: '5m', bar: bar(50) }])).rejects.toThrow(
      RecentBarsError,
    );
  });

  it('drops windows on invalidate (after a re-cook)', async () => {
    const { store, recent } = setup(fiveMinute);
    await recent.read(BTC, '5m', { limit: 2, now });
    await recent.invalidate('BTCUSD', ['5m']);
    await recent.read(BTC, '5m', { limit: 2, now });
    expect(store.reads).toBe(2);
  });

  it('reads the store when the cache cannot be reached', async () => {
    const { cache, recent } = setup(fiveMinute);
    const down = () => Promise.reject(new Error('ECONNREFUSED'));
    cache.get = down;
    cache.version = down;
    cache.fill = down;
    expect((await recent.read(BTC, '5m', { limit: 2, now })).map((b) => b.time)).toEqual([at(40), at(45)]);
  });

  it('refuses a limit that is not a positive whole number', async () => {
    const { recent } = setup(fiveMinute);
    await expect(recent.read(BTC, '5m', { limit: 0, now })).rejects.toThrow(RecentBarsError);
  });
});

describe('RecentBars.page', () => {
  // Five-minute bars in two runs with a long hole between: minutes 0-45, then 2000-2045.
  const early = Array.from({ length: 10 }, (_, i) => bar(i * 5));
  const late = Array.from({ length: 10 }, (_, i) => bar(2_000 + i * 5));
  const all = [...early, ...late];
  const earliest = at(-60);
  const now = at(2_047);

  it('gives a full page and points next at its oldest bar', async () => {
    const { recent } = setup(all);
    const page = await recent.page(BTC, '5m', { limit: 4, now, earliest });
    expect(page.bars.map((b) => b.time)).toEqual([at(2_030), at(2_035), at(2_040), at(2_045)]);
    expect(page.next).toBe(at(2_030));
  });

  it('widens across a hole longer than one lookback to fill the page', async () => {
    const { recent } = setup(all);
    // 12 bars want 60 minutes of lookback; the hole is about 1,950 minutes.
    const page = await recent.page(BTC, '5m', { limit: 12, now, earliest });
    expect(page.bars.map((b) => b.time)).toEqual([at(40), at(45), ...late.map((b) => b.time)]);
    expect(page.next).toBe(at(40));
  });

  it('walks every bar once, oldest page last, then reports the end', async () => {
    const { recent } = setup(all);
    const seen: number[] = [];
    let before: BarTime | undefined;
    for (let pages = 0; pages < 50; pages++) {
      const page = await recent.page(BTC, '5m', { limit: 3, now, earliest, ...(before === undefined ? {} : { before }) });
      seen.unshift(...page.bars.map((b) => b.time));
      if (page.next === null) break;
      before = page.next;
    }
    expect(seen).toEqual(all.map((b) => b.time));
  });

  it('stops at where history starts, with next null', async () => {
    const { recent } = setup(all);
    const page = await recent.page(BTC, '5m', { limit: 3, before: at(5), now, earliest });
    expect(page.bars.map((b) => b.time)).toEqual([at(0)]);
    expect(page.next).toBeNull();
  });

  it('never reads a range twice when the window reaches further back than the widening (found in the M1-15 smoke run)', async () => {
    // The window was filled long ago, so it starts far back and holds fewer bars than the page asks for;
    // the newer bars reached it through BarClosed. The widening must not re-read what the window gave.
    const { cache, recent } = setup(early, 100);
    await recent.read(BTC, '5m', { limit: 4, now: at(47) });
    await recent.onBarClosed(late.map((b) => ({ symbol: 'BTCUSD', timeframe: '5m' as const, bar: b })));
    expect((await cache.get('BTCUSD', '5m'))?.bars).toHaveLength(20);

    const page = await recent.page(BTC, '5m', { limit: 25, now, earliest });
    const times = page.bars.map((b) => b.time);
    expect(times).toEqual(all.map((b) => b.time)); // each bar once, ascending
    expect(page.next).toBeNull();
  });

  it('keeps one request bounded over a very long hole, and says where to resume', async () => {
    const { store, recent } = setup([bar(0), ...late]);
    const page = await recent.page(BTC, '5m', { limit: 1, before: at(2_000), now, earliest: at(-1_000_000) });
    expect(page.bars).toEqual([]);
    expect(page.next).not.toBeNull();
    expect(page.next as number).toBeLessThan(at(2_000));
    expect(store.reads).toBeLessThanOrEqual(8);
  });
});
