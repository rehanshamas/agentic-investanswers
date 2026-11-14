// The same cases for every rate counter: memory always, and Redis when the
// local one from `docker compose up -d` is reachable (CI runs it).

import { afterAll, describe, expect, it } from 'vitest';

import type { RateCounterPort } from '../application/rate-limiter.js';
import { MemoryRateCounter } from './memory-rate-counter.js';
import { RedisRateCounter } from './redis-rate-counter.js';

const redis = await RedisRateCounter.connect({ url: process.env['AIA_REDIS_TEST_URL'], reconnect: 'briefly' }).catch(() => undefined);
if (redis === undefined) console.warn('Redis unreachable: skipping the Redis rate counter tests (run: docker compose up -d)');
afterAll(() => redis?.close());

const run = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const counters: Array<[string, RateCounterPort | undefined]> = [
  ['memory', new MemoryRateCounter()],
  ['redis', redis],
];

describe.each(counters)('%s rate counter', (name, counter) => {
  it.skipIf(counter === undefined)('counts up per key', async () => {
    const key = `rl|test|${name}|${run}`;
    expect(await counter?.hit(key, 60)).toBe(1);
    expect(await counter?.hit(key, 60)).toBe(2);
    expect(await counter?.hit(`${key}-other`, 60)).toBe(1);
  });

  it.skipIf(counter === undefined)('starts again once a key expires', async () => {
    const key = `rl|test-expiry|${name}|${run}`;
    expect(await counter?.hit(key, 1)).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(await counter?.hit(key, 1)).toBe(1);
  });
});
