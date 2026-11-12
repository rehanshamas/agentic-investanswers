// The same cases for every LiveBarsBusPort adapter: in memory always, and
// Redis when the local one from `docker compose up -d` is reachable (CI runs a
// Redis service). Pub/sub channels are shared by every Redis database, so each
// test uses its own channel.

import { barTime, price, volume } from '@aia/shared-kernel';
import { createClient } from 'redis';
import { afterEach, describe, expect, it } from 'vitest';

import type { LiveBarsBusPort } from '../application/live-bars-bus-port.js';
import type { LiveBatch } from '../domain/live-update.js';
import { MemoryLiveBarsBus } from './memory-live-bars-bus.js';
import { RedisLiveBarsBus, decode, encode } from './redis-live-bars-bus.js';

const URL = process.env['AIA_REDIS_TEST_URL'] ?? 'redis://127.0.0.1:6379/15';

async function redisReachable(): Promise<boolean> {
  try {
    await (await RedisLiveBarsBus.connect({ url: URL })).close();
    return true;
  } catch {
    return false;
  }
}
const hasRedis = await redisReachable();
if (!hasRedis) console.warn('Redis unreachable: skipping the Redis live bus tests (run: docker compose up -d)');

const batch = (seq: number, minute = seq): LiveBatch => ({
  publisher: 'run-1',
  seq,
  updates: [
    {
      symbol: 'BTCUSD',
      timeframe: '5m',
      forming: seq % 2 === 0,
      bar: {
        time: barTime(1_762_800_000 + minute * 60),
        open: price(7_000_000),
        high: price(7_000_100),
        low: price(6_999_900),
        close: price(7_000_050),
        // Large enough to catch any float or precision loss on the way through.
        volume: volume(9_007_199_254_740_000 + seq),
      },
    },
  ],
});

let run = 0;
const open: LiveBarsBusPort[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((bus) => bus.close()));
});

const adapters: Array<[string, boolean, () => Promise<LiveBarsBusPort>]> = [
  ['memory', true, () => Promise.resolve(new MemoryLiveBarsBus())],
  ['redis', hasRedis, () => RedisLiveBarsBus.connect({ url: URL, channel: `test:live:${Date.now()}:${run++}` })],
];

function listen() {
  const batches: LiveBatch[] = [];
  const lost: string[] = [];
  return { batches, lost, listener: { batch: (b: LiveBatch) => batches.push(b), lost: (r: string) => lost.push(r) } };
}

async function until(check: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe.each(adapters)('%s live bars bus', (_name, available, make) => {
  it.skipIf(!available)('delivers every announcement, exactly, in publish order', async () => {
    const bus = await make();
    open.push(bus);
    const { batches, lost, listener } = listen();
    await bus.subscribe(listener);
    const sent = Array.from({ length: 200 }, (_, i) => batch(i + 1));
    // Not awaited one by one: order must hold even when publishes overlap.
    await Promise.all(sent.map((b) => bus.publish(b)));
    await until(() => batches.length === sent.length);
    expect(batches).toEqual(sent);
    expect(lost).toEqual([]);
  });

  it.skipIf(!available)('carries resync', async () => {
    const bus = await make();
    open.push(bus);
    const { batches, listener } = listen();
    await bus.subscribe(listener);
    await bus.publish({ publisher: 'run-1', seq: 1, updates: [], resync: true });
    await until(() => batches.length === 1);
    expect(batches).toEqual([{ publisher: 'run-1', seq: 1, updates: [], resync: true }]);
  });
});

describe.skipIf(!hasRedis)('redis live bars bus: losses', () => {
  it('reports a lost connection once it is back, then delivers again', async () => {
    const bus = await RedisLiveBarsBus.connect({ url: URL, channel: `test:live:${Date.now()}:${run++}` });
    open.push(bus);
    const { batches, lost, listener } = listen();
    await bus.subscribe(listener);
    const admin = createClient({ url: URL });
    await admin.connect();
    await admin.sendCommand(['CLIENT', 'KILL', 'TYPE', 'pubsub']);
    await admin.close();
    await until(() => lost.length === 1);
    expect(lost[0]).toContain('lost');
    // Reported on 'ready', just before node-redis subscribes again: allow a moment.
    await new Promise((resolve) => setTimeout(resolve, 100));
    await bus.publish(batch(1));
    await until(() => batches.length === 1);
  });

  it('reports a malformed message as lost', async () => {
    const channel = `test:live:${Date.now()}:${run++}`;
    const bus = await RedisLiveBarsBus.connect({ url: URL, channel });
    open.push(bus);
    const { lost, listener } = listen();
    await bus.subscribe(listener);
    const admin = createClient({ url: URL });
    await admin.connect();
    await admin.publish(channel, '{"p":"x","s":1,"u":[["BTCUSD","5m",0,1.5,1,1,1,1,1]]}');
    await admin.close();
    await until(() => lost.length === 1);
  });
});

describe('redis live bars bus: encoding', () => {
  it('round-trips an announcement', () => {
    const b = batch(4);
    expect(decode(encode(b))).toEqual(b);
  });

  it.each([
    ['not json'],
    ['{"p":1,"s":1,"u":[]}'],
    ['{"p":"x","s":1.5,"u":[]}'],
    ['{"p":"x","s":1,"u":[["BTCUSD","2m",0,1,1,1,1,1,1]]}'],
    ['{"p":"x","s":1,"u":[["BTCUSD","5m",2,1,1,1,1,1,1]]}'],
    ['{"p":"x","s":1,"u":[["BTCUSD","5m",0,1,1,1,1,1]]}'],
  ])('refuses %s', (message) => {
    expect(decode(message)).toBeUndefined();
  });
});
