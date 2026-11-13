// The same cases for every IndicatorOutputCachePort adapter: in memory always,
// and Redis when the local one from `docker compose up -d` is reachable (CI
// runs a Redis service). Database 15, away from the default one.

import { afterAll, describe, expect, it } from 'vitest';

import type { IndicatorOutputCachePort } from '../application/indicator-output-cache-port.js';
import { MemoryIndicatorOutputCache } from './memory-indicator-output-cache.js';
import { RedisIndicatorOutputCache } from './redis-indicator-output-cache.js';

async function redisOrUndefined(): Promise<RedisIndicatorOutputCache | undefined> {
  try {
    return await RedisIndicatorOutputCache.connect({ url: process.env['AIA_REDIS_TEST_URL'] ?? 'redis://127.0.0.1:6379/15' });
  } catch {
    return undefined;
  }
}

const redis = await redisOrUndefined();
if (redis === undefined) console.warn('Redis unreachable: skipping the Redis indicator cache tests (run: docker compose up -d)');
afterAll(() => redis?.close());

const adapters: Array<[string, () => IndicatorOutputCachePort | undefined]> = [
  ['memory', () => new MemoryIndicatorOutputCache()],
  ['redis', () => redis],
];
const run = `${process.pid}-${Math.random().toString(36).slice(2)}`;

describe.each(adapters)('%s indicator output cache', (name, make) => {
  const cache = make();

  it.skipIf(cache === undefined)('misses a key never set', async () => {
    expect(await cache?.get(`ind|test|${run}|${name}|missing`)).toBeUndefined();
  });

  it.skipIf(cache === undefined)('round-trips text exactly, including control characters and large values', async () => {
    const key = `ind|test|${run}|${name}|value`;
    const value = JSON.stringify({ s: '\u0000num:NaN', big: 'x'.repeat(200_000), n: 9_007_199_254_740_991 });
    await cache?.set(key, value, 60);
    expect(await cache?.get(key)).toBe(value);
  });

  it.skipIf(cache === undefined)('replaces a value', async () => {
    const key = `ind|test|${run}|${name}|replace`;
    await cache?.set(key, 'a', 60);
    await cache?.set(key, 'b', 60);
    expect(await cache?.get(key)).toBe('b');
  });
});

describe('memory cache expiry', () => {
  it('forgets an entry once its time to live has passed', async () => {
    let now = 0;
    const cache = new MemoryIndicatorOutputCache(() => now);
    await cache.set('k', 'v', 10);
    now = 9_999;
    expect(await cache.get('k')).toBe('v');
    now = 10_000;
    expect(await cache.get('k')).toBeUndefined();
  });
});
