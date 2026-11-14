// Runs the DataAccess contract (M1-16) against the in-process data layer:
// fully in memory, and with the real Redis cache and live bus when the local
// Redis is reachable (CI runs one).

import type { Bar, BarTime, Timeframe } from '@aia/shared-kernel';
import { LiveAnnouncer, PARITY_INSTRUMENTS, RedisLiveBarsBus, RedisRecentBarsCache, rollUp } from '@aia/market-data';

import { MemoryDataLayer } from '../adapters/memory-data-layer.js';
import { dataAccessContract } from './data-access.contract.js';
import { InProcessDataLayer } from './in-process-data-layer.js';

/** Cooked bars as the roll-up of the given minutes (what a settled store plus tail gives). */
function sources(minutes: readonly Bar[]) {
  const btc = PARITY_INSTRUMENTS.find((i) => i.symbol === 'BTCUSD');
  return {
    minutes: { read: (s: string, from: BarTime, until: BarTime) => Promise.resolve(s === 'BTCUSD' ? minutes.filter((b) => b.time >= from && b.time <= until) : []) },
    cooked: {
      getRange: (s: string, tf: Timeframe, from: BarTime, until: BarTime) =>
        Promise.resolve(s === 'BTCUSD' && btc !== undefined ? rollUp(btc, tf, minutes).filter((b) => b.time >= from && b.time <= until) : []),
    },
  };
}

dataAccessContract('in process, in memory', (minutes, earliest) => {
  const layer = new MemoryDataLayer({ instruments: PARITY_INSTRUMENTS, ...sources(minutes), earliest });
  return Promise.resolve({ data: layer, announcer: (p) => layer.announcer(p), cleanup: () => layer.close() });
});

const url = process.env['AIA_REDIS_TEST_URL'] ?? 'redis://127.0.0.1:6379/15';
const redisUp = await RedisRecentBarsCache.connect({ url }).then(
  async (c) => (await c.close(), true),
  () => false,
);
if (!redisUp) console.warn('Redis unreachable: skipping the DataAccess contract on Redis (run: docker compose up -d)');

let run = 0;
if (redisUp) {
  dataAccessContract('in process, Redis cache and bus', async (minutes, earliest) => {
    const cache = await RedisRecentBarsCache.connect({ url });
    const bus = await RedisLiveBarsBus.connect({ url: url.replace(/\/\d+$/, ''), channel: `test:data:${Date.now()}:${run++}` });
    // A fresh cache window per run: invalidate what an earlier run left.
    for (const tf of ['1m', '5m', '15m', '1h', '4h'] as const) await cache.invalidate('BTCUSD', tf);
    const layer = new InProcessDataLayer({ instruments: PARITY_INSTRUMENTS, earliest: () => earliest, ...sources(minutes), cache, bus, nowMs: () => 0, onClose: () => cache.close() });
    return { data: layer, announcer: (p) => new LiveAnnouncer(bus, p), cleanup: () => layer.close() };
  });
}
