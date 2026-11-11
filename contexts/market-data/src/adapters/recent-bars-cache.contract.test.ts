// The same cases for every RecentBarsCachePort adapter: in memory always, and
// Redis when the local one from `docker compose up -d` is reachable (CI runs a
// Redis service, so it runs there too). Database 15, away from the default one.

import type { Bar } from '@aia/shared-kernel';
import { barTime, price, volume } from '@aia/shared-kernel';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type { RecentBarsCachePort } from '../application/recent-bars-cache-port.js';
import { MemoryRecentBarsCache } from './memory-recent-bars-cache.js';
import { RedisRecentBarsCache } from './redis-recent-bars-cache.js';

const T0 = 1_762_800_000;
const at = (minute: number) => barTime(T0 + minute * 60);
const CAPACITY = 3;

function bar(minute: number, close = 100_00): Bar {
  return {
    time: at(minute),
    open: price(close),
    high: price(close + 5),
    low: price(close - 5),
    close: price(close),
    // Large enough to catch any float or precision loss on the way through.
    volume: volume(9_007_199_254_740_000 + minute),
  };
}

async function redisOrUndefined(): Promise<RedisRecentBarsCache | undefined> {
  try {
    return await RedisRecentBarsCache.connect({ url: process.env['AIA_REDIS_TEST_URL'] ?? 'redis://127.0.0.1:6379/15', capacity: CAPACITY });
  } catch {
    return undefined;
  }
}

const redis = await redisOrUndefined();
if (redis === undefined) console.warn('Redis unreachable: skipping the Redis cache tests (run: docker compose up -d)');
afterAll(() => redis?.close());

let run = 0;
const adapters: Array<[string, () => RecentBarsCachePort | undefined]> = [
  ['memory', () => new MemoryRecentBarsCache(CAPACITY)],
  ['redis', () => redis],
];

describe.each(adapters)('%s recent-bars cache', (_name, make) => {
  const cache = make();
  // A fresh symbol per test keeps Redis runs independent of each other and of earlier runs.
  let symbol = '';
  beforeEach(() => {
    symbol = `TEST${Date.now()}x${run++}`;
  });

  it.skipIf(cache === undefined)('has no window until filled, and ignores updates to a cold key', async () => {
    const c = cache as RecentBarsCachePort;
    expect(await c.get(symbol, '5m')).toBeUndefined();
    const before = await c.version(symbol, '5m');
    await c.apply(symbol, '5m', bar(0));
    expect(await c.get(symbol, '5m')).toBeUndefined();
    expect(await c.version(symbol, '5m')).not.toBe(before);
  });

  it.skipIf(cache === undefined)('round-trips a window exactly, trimmed to capacity', async () => {
    const c = cache as RecentBarsCachePort;
    expect(await c.fill(symbol, '1m', { from: at(-1), bars: [bar(0), bar(1)] }, await c.version(symbol, '1m'))).toBe(true);
    expect(await c.get(symbol, '1m')).toEqual({ from: at(-1), bars: [bar(0), bar(1)] });

    await c.fill(symbol, '1m', { from: at(0), bars: [bar(0), bar(1), bar(2), bar(3)] }, await c.version(symbol, '1m'));
    expect(await c.get(symbol, '1m')).toEqual({ from: at(1), bars: [bar(1), bar(2), bar(3)] });
  });

  it.skipIf(cache === undefined)('refuses a fill if a bar changed since the version was read', async () => {
    const c = cache as RecentBarsCachePort;
    const version = await c.version(symbol, '1m');
    await c.apply(symbol, '1m', bar(5));
    expect(await c.fill(symbol, '1m', { from: at(0), bars: [bar(0)] }, version)).toBe(false);
    expect(await c.get(symbol, '1m')).toBeUndefined();
  });

  it.skipIf(cache === undefined)('replaces, inserts, appends and trims as the domain rules say', async () => {
    const c = cache as RecentBarsCachePort;
    await c.fill(symbol, '5m', { from: at(0), bars: [bar(0), bar(2)] }, await c.version(symbol, '5m'));

    await c.apply(symbol, '5m', bar(2, 101_00)); // forming bar extended
    await c.apply(symbol, '5m', bar(1)); // late bar
    expect(await c.get(symbol, '5m')).toEqual({ from: at(0), bars: [bar(0), bar(1), bar(2, 101_00)] });

    await c.apply(symbol, '5m', bar(3)); // over capacity: the start moves up
    expect(await c.get(symbol, '5m')).toEqual({ from: at(1), bars: [bar(1), bar(2, 101_00), bar(3)] });

    await c.apply(symbol, '5m', bar(0, 1)); // older than the window: ignored
    expect((await c.get(symbol, '5m'))?.bars).toEqual([bar(1), bar(2, 101_00), bar(3)]);
  });

  it.skipIf(cache === undefined)('drops the window on invalidate and changes the version', async () => {
    const c = cache as RecentBarsCachePort;
    await c.fill(symbol, '1h', { from: at(0), bars: [bar(0)] }, await c.version(symbol, '1h'));
    const version = await c.version(symbol, '1h');
    await c.invalidate(symbol, '1h');
    expect(await c.get(symbol, '1h')).toBeUndefined();
    expect(await c.version(symbol, '1h')).not.toBe(version);
  });

  it.skipIf(cache === undefined)('keeps timeframes and instruments apart', async () => {
    const c = cache as RecentBarsCachePort;
    await c.fill(symbol, '1m', { from: at(0), bars: [bar(0)] }, await c.version(symbol, '1m'));
    expect(await c.get(symbol, '5m')).toBeUndefined();
    expect(await c.get(`${symbol}B`, '1m')).toBeUndefined();
  });
});
